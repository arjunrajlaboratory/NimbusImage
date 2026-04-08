# Zenodo Upload Integration

Publish NimbusImage projects to [Zenodo](https://zenodo.org/) for permanent archival with DOI minting.

## Overview

The Zenodo integration allows users to upload an entire project (image files, annotation data, collection configs) to Zenodo as a dataset deposition. The workflow is:

1. **Configure** a Zenodo API token (stored encrypted in user metadata)
2. **Upload** a project to Zenodo as a draft deposition
3. **Review** the draft on Zenodo's web interface
4. **Publish** to mint a permanent DOI (irreversible)
5. **New versions** can be created by re-uploading a published project

## Architecture

All Zenodo communication happens **server-side** (Girder plugin), not in the browser. This is necessary because:
- Image files live in Girder's assetstore — streaming server-to-Zenodo avoids downloading to the browser
- Files can be multi-GB
- The Zenodo API token is kept encrypted server-side
- Long-running uploads run as Girder local jobs with progress tracking via SSE

### Job System

The upload runs as a **Girder local job** (same pattern as `cacheMaxMerge` in `system.py`). This provides:
- **SSE-based progress** — notifications flow through `/notification/stream` automatically
- **Job tracking** — visible in the Girder job list and frontend job logs
- **Race condition safety** — status is set to `uploading` synchronously before the job starts
- **Consistency** — matches the existing job patterns for histogram caching and max-merge

The job is created with `createLocalJob(module=..., asynchronous=True)`, which runs the upload in a daemon thread via `events.daemon.trigger`. Progress is reported as JSON log lines via `Job().updateJob(log=...)`, which triggers SSE notifications that the frontend parses.

### What Gets Uploaded

For each project, the deposition contains:

| File | Source | Format |
|------|--------|--------|
| `{dataset}--{filename}` | Source image files from each dataset | Original format (OME-TIFF, .nd2, etc.) |
| `{dataset}_annotations.json` | Annotation export per dataset | JSON (same format as the Export endpoint) |
| `{collection}_config.json` | Collection configuration | JSON |
| `manifest.json` | Project structure and metadata | JSON |

Filenames use `--` as a folder separator because Zenodo's bucket API does not support `/` in filenames.

## API Endpoints

### Credential Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/zenodo_credentials` | Check if token exists (`hasToken`, `sandbox`) |
| `PUT` | `/api/v1/zenodo_credentials` | Store token (encrypted with Fernet) |
| `DELETE` | `/api/v1/zenodo_credentials` | Remove stored token |

Tokens are encrypted at rest using Fernet symmetric encryption. The encryption key is read from the `ZENODO_ENCRYPTION_KEY` environment variable. In production mode (determined by Girder's `getServerMode()`), the key is **required** — the endpoint will return a 500 error if it's not set. In development/testing mode, a hardcoded dev key is used with a warning logged.

### Upload/Publish Workflow

| Method | Endpoint | Description | Access |
|--------|----------|-------------|--------|
| `POST` | `/api/v1/zenodo/upload` | Start uploading a project to Zenodo | ADMIN |
| `GET` | `/api/v1/zenodo/status/:projectId` | Get upload progress (fallback for diagnostics) | READ |
| `POST` | `/api/v1/zenodo/publish/:projectId` | Publish draft, mint DOI | ADMIN |
| `POST` | `/api/v1/zenodo/discard/:projectId` | Discard unpublished draft | ADMIN |

The upload endpoint returns a `jobId` that the frontend uses for SSE-based progress tracking.

### Upload Flow Detail

1. **Pre-flight validation**: Checks total size < 50GB and file count < 100 (Zenodo limits)
2. **Status lock**: Sets `project.meta.zenodo.status` to `uploading` synchronously (prevents concurrent uploads)
3. **Job creation**: Creates a Girder local job via `createLocalJob(module='...zenodo_job', asynchronous=True)`
4. **Deposition creation**: Creates a new deposition (or new version if previously published)
5. **File upload**: Streams each file from Girder's assetstore to Zenodo's bucket API
6. **Annotation export**: Generates JSON export per dataset
7. **Metadata**: Maps project metadata to Zenodo's schema (title, creators, license, keywords, etc.)
8. **Completion**: Sets job status to `SUCCESS`, updates `project.meta.zenodo.status` to `draft`

### Progress Tracking

Progress flows through two channels:
- **SSE (primary)**: Job log lines contain JSON like `{"progress": 0.5, "current": 3, "total": 7, "message": "Uploading file.tiff..."}`. The frontend parses these in the `eventCallback` passed to `jobs.addJob()`.
- **Project metadata (persistent)**: `project.meta.zenodo.progress` is updated every 5 files (and always on the first/last file) to reduce MongoDB write load, serving as a recovery source if the user navigates away and returns.

On page mount, if `zenodoStatus === 'uploading'`, the component queries for active `zenodo_upload` jobs matching this project's ID and re-subscribes via `jobs.addJob()`.

**Note on app-wide progress UI:** The `ZenodoPublish` component manages its own progress display locally rather than using the shared `ProgressType.ZENODO_UPLOAD` / progress store used by other long-running jobs (histogram caching, max-merge, etc.). This was an intentional design choice because the Zenodo progress UI is self-contained within the ProjectInfo page. A future update should integrate Zenodo upload progress into the app-wide progress manager so uploads remain visible when navigating away from ProjectInfo. See GitHub issue for tracking.

## Data Model

### Project Zenodo Metadata (`project.meta.zenodo`)

```typescript
interface IProjectZenodo {
  depositionId?: number;      // Zenodo deposition ID
  depositionUrl?: string;     // Link to Zenodo draft/record
  doi?: string;               // Set after publish
  status: "none" | "uploading" | "draft" | "published" | "error";
  sandbox: boolean;           // Whether using sandbox.zenodo.org
  progress?: {                // Upload progress (null when not uploading)
    current: number;
    total: number;
    message: string;
  } | null;
  error?: string | null;      // Error message if upload failed
  lastPublished?: string;     // ISO date of last publish
}
```

### Metadata Mapping

| Project Field | Zenodo Field | Notes |
|--------------|-------------|-------|
| `metadata.title` | `title` | Direct mapping |
| `metadata.description` | `description` | Falls back to project description |
| `metadata.license` | `license` | Mapped: CC-BY-4.0 → cc-by-4.0, etc. |
| `metadata.keywords` | `keywords` | Direct (array of strings) |
| `metadata.authors` | `creators` | Comma-separated → `[{name: "..."}]` |
| `metadata.doi` | `doi` | Only if pre-existing |
| `metadata.publicationDate` | `publication_date` | Defaults to today |
| `metadata.funding` | `notes` | Stored as "Funding: ..." |
| — | `upload_type` | Always `"dataset"` |
| — | `access_right` | Always `"open"` |

## Files

### Backend

All paths relative to `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/`.

| File | Purpose |
|------|---------|
| `server/helpers/zenodo_client.py` | Zenodo REST API wrapper (create, upload, publish, new version) |
| `server/helpers/zenodo_job.py` | Local job `run(job)` entry point — contains all upload logic and `batch_load_project_data()` shared helper |
| `server/api/zenodo.py` | REST endpoints for upload/publish/status/discard |
| `server/api/zenodo_credentials.py` | Token CRUD with Fernet encryption |

### Frontend

| File | Purpose |
|------|---------|
| `src/store/ZenodoAPI.ts` | API client (extends existing import API with publish methods) |
| `src/store/model.ts` | `IProjectZenodo`, `TZenodoStatus`, `ProgressType.ZENODO_UPLOAD` |
| `src/components/ZenodoPublish.vue` | Main card component in ProjectInfo (SSE-based progress) |
| `src/components/ZenodoTokenDialog.vue` | Token entry/management dialog |

## Zenodo API Notes

### Sandbox vs Production

- **Sandbox**: `https://sandbox.zenodo.org` — separate account/token, test DOIs (`10.5072`), data can be wiped
- **Production**: `https://zenodo.org` — real DOIs (`10.5281`), permanent records

### Limits

- **50 GB** per record (total and per file) via bucket API
- **100 files** per record
- Quota increase to 200 GB available on request from Zenodo

### Bucket API

File uploads use `PUT {bucket_url}/{filename}` with:
- `Content-Type: application/octet-stream` (required — other content types return 415)
- No `/` in filenames (returns 404 — use `--` separator instead)
- Streams binary data directly, supports up to 50GB per file

### Publishing

- Publishing is **irreversible** — mints a permanent DOI
- Published records cannot be deleted, only new versions created
- `POST /api/deposit/depositions/:id/actions/newversion` creates a new draft version
- New versions get a new deposition ID but share a concept DOI

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ZENODO_ENCRYPTION_KEY` | Fernet key or passphrase for encrypting stored tokens. Set in `girder.env` alongside `ANTHROPIC_API_KEY`. | **Required** in production mode (error if missing). In dev/testing mode, falls back to a hardcoded dev key. |

Server mode is determined by Girder's `getServerMode()` from `girder.utility.config` (see [Girder source](https://github.com/girder/girder/blob/master/girder/api/rest.py)). The local Docker setup runs in `production` mode by default, so you'll need to set this key even locally if you want to test Zenodo credential storage. Alternatively, Girder tests run in `testing` mode, so `tox` tests work without it.

### Dependencies

Added to `setup.py`:
- `cryptography` — Fernet encryption for token storage
- `requests` — HTTP client for Zenodo API

## Testing

### Sandbox Setup

1. Create an account on `https://sandbox.zenodo.org`
2. Create a personal access token with scopes: `deposit:write`, `deposit:actions`
3. Store the token via the UI or API with `sandbox: true`
4. Upload and publish — DOIs are test-only (`10.5072`)

**Current sandbox account:** `arjunraj` on `https://sandbox.zenodo.org`

### Test Projects

| Project ID | Name | Datasets | Notes |
|-----------|------|----------|-------|
| `69ae998ca50fdb5e668f0fc5` | NewProject | 2 | Primary test project. Published v1 (20 files, ~20MB), then uploaded new version (7 files, ~118MB) after adding data. Deposition 468740 (v1 published), 468742 (v2 draft). |
| `69af3552a50fdb5e668f0ff9` | NewProject2 | 1 | Clean project, no Zenodo uploads yet. Good for fresh upload testing. |
| `696432f5b1d3a82bb70f5719` | Test Project | 1 | Previously used for testing. Has zenodo draft status. |
| `6964325fb1d3a82bb70f5718` | Test Project 2 | 0 | Empty project (0 datasets). Good for testing edge cases. |
| `69641417b1d3a82bb70f5717` | Test Project | 2 | Has a deleted dataset folder — upload will fail with "No such folder". Useful for error handling testing. |

### E2E Test Scenarios

#### 1. Fresh Upload (First Time)

```bash
# Authenticate
TOKEN=$(curl -s -u admin:password http://localhost:8080/api/v1/user/authentication | python3 -c "import json,sys; print(json.load(sys.stdin)['authToken']['token'])")

# Verify credentials are configured
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo_credentials
# Expected: {"hasToken": true, "sandbox": true}

# Start upload
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId": "PROJECT_ID"}' \
  http://localhost:8080/api/v1/zenodo/upload
# Expected: {"message": "Upload started", "projectId": "...", "jobId": "...", "totalFiles": N, "totalSize": N}

# Monitor job progress (poll until status changes from 2)
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/job/JOB_ID
# Job status codes: 0=inactive, 1=queued, 2=running, 3=success, 4=error, 5=cancelled
# Log lines contain JSON: {"progress": 0.5, "current": 3, "total": 7, "message": "Uploading file.tiff..."}

# Verify project status after completion
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo/status/PROJECT_ID
# Expected: {"status": "draft", "depositionId": N, "depositionUrl": "https://sandbox.zenodo.org/deposit/N", ...}
```

**Expected behavior:**
- Upload endpoint returns immediately with `jobId`
- Job runs asynchronously, progress visible via job log lines
- Project status transitions: `none` → `uploading` → `draft`
- Draft visible on Zenodo at the `depositionUrl`

#### 2. Publish (Mint DOI)

```bash
# Publish the draft (irreversible on production!)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
  http://localhost:8080/api/v1/zenodo/publish/PROJECT_ID
# Expected: {"message": "Published successfully", "doi": "10.5072/zenodo.NNNNNN", "url": "https://sandbox.zenodo.org/record/NNNNNN"}

# Verify status
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo/status/PROJECT_ID
# Expected: {"status": "published", "doi": "10.5072/zenodo.NNNNNN", ...}
```

**Expected behavior:**
- Status transitions: `draft` → `published`
- DOI is minted (test DOI `10.5072/...` on sandbox)
- Project status also set to `exported` via `updateStatus()`

#### 3. New Version (Re-upload After Publish)

```bash
# Upload again — creates a new version of the published deposition
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId": "PROJECT_ID"}' \
  http://localhost:8080/api/v1/zenodo/upload
# Expected: new jobId, upload starts

# After completion, check status
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo/status/PROJECT_ID
# Expected: {"status": "draft", "depositionId": NEW_ID, "doi": "ORIGINAL_DOI", ...}
# Note: depositionId changes (new version), but doi is preserved from the first publish
```

**Expected behavior:**
- Zenodo `newversion` API creates a new draft linked to the original
- New deposition ID, but concept DOI is preserved
- Old files are cleared and replaced with current project files
- Status transitions: `published` → `uploading` → `draft`

#### 4. Discard Draft

```bash
# Discard an unpublished draft
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
  http://localhost:8080/api/v1/zenodo/discard/PROJECT_ID
# Expected: {"message": "Draft discarded"}

# Verify status
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo/status/PROJECT_ID
# If was first upload: status → "none"
# If was new version of published: status → "published" (preserves original DOI)
```

#### 5. Error Cases

- **No token configured**: Upload returns 400 "No Zenodo token configured"
- **Invalid token**: Upload returns 400 "Zenodo token validation failed"
- **Concurrent upload**: Upload returns 409 "An upload is already in progress"
- **Missing dataset folder**: Job fails, status → `error` with message in `zenodo.error`
- **Over 50GB / 100 files**: Upload returns 400 with size/count limit message
- **Publish without draft**: Returns 400 "No draft deposition to publish"

### curl Quick Reference

```bash
# Authenticate
TOKEN=$(curl -s -u admin:password http://localhost:8080/api/v1/user/authentication | python3 -c "import json,sys; print(json.load(sys.stdin)['authToken']['token'])")

# Store Zenodo sandbox token
curl -X PUT -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"token": "YOUR_ZENODO_PAT", "sandbox": true}' \
  http://localhost:8080/api/v1/zenodo_credentials

# Check credentials
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo_credentials

# List projects
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/project?limit=10"

# Start upload
curl -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId": "PROJECT_ID"}' \
  http://localhost:8080/api/v1/zenodo/upload

# Check job status
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/job/JOB_ID

# Check project zenodo status
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo/status/PROJECT_ID

# Publish (irreversible on production!)
curl -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
  http://localhost:8080/api/v1/zenodo/publish/PROJECT_ID

# Discard draft
curl -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
  http://localhost:8080/api/v1/zenodo/discard/PROJECT_ID

# Delete credentials
curl -X DELETE -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/zenodo_credentials
```

### Verified Test Results

The following scenarios have been verified end-to-end against `sandbox.zenodo.org`:

| Scenario | Project | Result |
|----------|---------|--------|
| Fresh upload (20 files, ~20MB) | `69ae998ca50fdb5e668f0fc5` | Deposition 468740 created as draft |
| Publish draft | `69ae998ca50fdb5e668f0fc5` | DOI `10.5072/zenodo.468740` minted |
| New version after publish (7 files, ~118MB) | `69ae998ca50fdb5e668f0fc5` | Deposition 468742 created as draft, original DOI preserved |
| Job progress tracking | all | JSON log lines parsed correctly (0% → 25% → 50% → 100%) |
| SSE-based frontend tracking | all | `jobs.addJob()` receives progress events in real time |
| Recovery on page reload | all | `recoverActiveJob()` re-subscribes to active job on mount |
