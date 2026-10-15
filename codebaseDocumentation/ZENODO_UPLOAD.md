# Zenodo Upload Integration

Publish NimbusImage projects to [Zenodo](https://zenodo.org/) for permanent archival with DOI minting.


> **Spatial data is included.** The uploader sends every file in every dataset folder, so a
> dataset with a registered `spatial.zarr.zip` (expression table) and `transcripts.zarr.zip`
> (molecules) ships both with the record — the DOI carries the matrix and the molecules, not
> only the images. They are listed with `type: "spatial"` in the pre-flight file list.
> Re-importing them from a DOI (download + `POST spatial/{dataset}/register`) is not built.

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
| `POST` | `/api/v1/zenodo/upload` | Start uploading a project to Zenodo | ADMIN on the project and on every dataset and collection it lists; configurations reached only through views are exported only if the uploader owns them |
| `GET` | `/api/v1/zenodo/status/:projectId` | Get upload progress (fallback for diagnostics) | READ |
| `POST` | `/api/v1/zenodo/publish/:projectId` | Publish draft, mint DOI | ADMIN on the project and on every resource the draft recorded at upload (`uploadedResources`) |
| `POST` | `/api/v1/zenodo/discard/:projectId` | Discard unpublished draft (409 while the project's upload job is live; `force=true` overrides for a job orphaned by a restart) | ADMIN |

Publishing hands out every file in the project, so upload and publish need ADMIN on
each dataset and collection the project lists, not only on the project
(`requireProjectContentsAccess` in `server/helpers/access_helpers.py`). Project ADMIN
alone is not enough: a dataset can be added to a project by someone with only WRITE on
it, and a co-admin of the project may not be able to read it at all. Configurations
reached only through a dataset's views contribute their property definitions only if
the uploader owns them; otherwise they are left out, along with those properties'
values, instead of refusing the upload (anyone can create a view naming any dataset
and make it public). Only views the uploader can edit count, so a stranger's view
cannot choose what the export contains either. The upload job repeats the check on the project it reloads, and again
immediately before reading any data (after its Zenodo calls), and
the annotation export uses the configurations the check returned instead of querying
views again. The finished draft records what the job actually uploaded in
`meta.zenodo.uploadedResources`, and publish checks those resources (a draft without
that record, uploaded before these checks, is refused with 409: discard it and upload
again), since datasets can be removed from the project between upload and publish. A
recorded resource deleted after the upload, including during the upload itself,
blocks publishing (409). Tests: `test/test_share_escalation.py`
(`TestZenodoRequiresOwnership`).

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

Whenever `zenodoStatus` becomes `'uploading'` (including on mount) and the card isn't already following a job, it asks `GET zenodo/status/:projectId` for the project's `jobId` (its own project copy may be stale), reads that job (`GET job/:id`), and subscribes via `jobs.addJob()` if the job is still live (inactive, queued or running: a local job stays INACTIVE until its thread runs). The upload endpoint records `meta.zenodo.jobId` before scheduling the job because the job's kwargs can't identify it: Girder stores them serialized and exposes them only to site admins, so a kwargs-based lookup found nothing for regular users. If there is no live job this user can read, the project copy is stale (a refresh landed out of order, or the page re-read it a moment ago) or the upload is a co-owner's: Girder lets only a job's owner read it or receive its SSE events. The card then asks `ProjectInfo` to re-read the project and shows indeterminate progress (a failed lookup does the same).

Separately, whenever an upload is running as far as the card knows (the project says `uploading`, or the card follows a job, since its project copy can lag behind a just-started upload or a 409), it polls `GET zenodo/status/:projectId` every 10 s. Once that reports another status, the card releases the job (only the job it asked about: a newer upload started while the request was out is left alone, and a released job's late SSE events are ignored) and re-reads the project. While its project copy still reads `uploading` it keeps polling, in case that re-read fails. This is the one signal that always says when an upload ends: SSE events add live progress and an earlier end, but a co-owner never gets them, and the notification socket gives up after repeated errors. The poll stops on unmount.

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
  jobId?: string | null;      // The upload's Girder job (set when an upload starts)
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
| `src/components/ZenodoPublish.vue` | Main card component in ProjectInfo (SSE-based progress, server refusal messages) |
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
- **Discard during a live upload**: Returns 409 "An upload is in progress for this project." Discard still accepts `uploading` so a project whose job died can be reset, but not while an upload may be using the deposition: `meta.zenodo.jobId` names a live job, or no job is recorded yet. The upload endpoint's `uploading` write clears the previous `jobId` in the same update and records the new one before scheduling, so the window in between fails closed rather than reading the previous upload's ended job. Without this, a stale card in another tab could delete the deposition the job is using. A job whose thread died stays live-looking only if it never reached ERROR, which is what a Girder restart mid-upload leaves (Girder never sweeps local jobs: the job stays RUNNING, or INACTIVE if the restart came before its thread started). For that, and for a project stuck in `uploading` from before job ids were recorded, `POST zenodo/discard/:projectId?force=true` resets the project anyway.
- **Not the owner of a dataset or collection in the project**: Upload and publish return
  403 "Admin access denied for folder <id> ..." or "... for upenn_collection <id> ..." (Girder names
  the model by its collection name; the ownership check added by PR #1410,
  `requireProjectContentsAccess`)

In the UI, `ZenodoPublish.vue` shows the server's `response.data.message` for every
refused request, one error per request so a request never hides or relabels another's:
upload and discard errors in alerts on the card, and publish errors inside the publish
confirmation dialog, which stays open. Upload, publish and discard all change the
same deposition and `meta.zenodo`, so only one may run at a time: every action button
checks one `requestInFlight` flag (any request pending, or an upload this card is
following), and the publish dialog can't be dismissed while publishing. A 403 naming a folder or collection on upload/publish also says that
publishing needs owner access to every dataset and collection in the project; a
project-level 403, and any discard error, is shown as the server sent it. A 409 also
refreshes the project. Saving a token or retrying clears the alert.

The card subscribes to an upload's job whenever the project reports `uploading` and it
is not already following one: on load, after a 409, or when another tab starts an
upload. It subscribes once per job (`jobs.addJob` adds a listener per call), and drops the subscription when the project leaves `uploading` or the status poll says the upload ended, even if the job's terminal event was lost (see "Progress Tracking" above). On failure
the job helper writes `status: error` to the project before marking the job ERROR (as
the success path writes `draft` before SUCCESS), because the card re-reads the project
when the terminal status arrives. `ProjectInfo.vue` keys the card by project id: the
route reuses the view across projects, and errors, progress and the job subscription
belong to one project.
The tests for each of these are listed in the regression checklist at the end of this
document.

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
| Recovery on page reload | all | `recoverActiveJob()` re-subscribes to the active job when the status is `uploading` (on mount, or after a refresh) |

## Regression checklist

Each item was a review finding on the error-display and upload-tracking work (PR #1414),
and several were **consequences of an earlier round's fix**: making the 409 refresh the
project exposed mount-only job tracking; tracking a job in the shared in-flight flag
needed the lost-terminal-event release. Change any of this code and re-check the list.

Run `pnpm test src/components/ZenodoPublish.test.ts src/store/ZenodoAPI.test.ts src/views/project/ProjectInfo.test.ts`, plus `tox -- upenncontrast_annotation/test/test_zenodo.py` from `devops/girder/plugins/AnnotationPlugin`.

### Error display

- [ ] **The server's message reaches the user**, on the card for upload and discard, inside the dialog for publish (which stays open). — *"shows the server's message when the upload is refused"*, *"shows the server's message in the publish dialog"*
- [ ] **The owner-access hint only follows an upload/publish 403 that names a folder or collection.** A project-level 403 and every discard error are shown as sent. — *"explains owner access when a dataset refuses the upload"*, *"shows the server's message in the publish dialog"* (an `upenn_collection` refusal), *"shows a project-level 403 without the dataset hint"*, *"shows a discard refusal without the publishing hint"*
- [ ] **One error per request.** A request starting or failing never hides or relabels another's. — *"keeps each request's error in its own place"*
- [ ] **Stale errors clear** on retry and on saving a token. — *"clears the error on retry and after saving a token"*

### Concurrency

- [ ] **Only one request at a time.** Every action checks the single `requestInFlight` flag; pairwise guards missed a direction three rounds running. — *"does not let publish and discard overlap"*, *"can't upload while a discard is running"*, *"can't discard while an upload is starting"*, *"can't discard an upload that started before the refresh lands"*
- [ ] **A lost terminal job event can't leave the actions disabled**: leaving `uploading`, or the status poll seeing the upload end, releases the subscription, and the poll runs for tracked uploads too. — *"re-enables the actions when the upload ends without its job event"*, *"polls a tracked upload too, in case its job events stop"*, *"releases the actions when the server says the upload ended"*, *"a slow poll doesn't release a newer upload"*, *"a late event from an ended job doesn't touch a newer upload"*

### Upload tracking

- [ ] **Tracking follows the reported status, not the mount**: on load, after a 409, and after another tab starts an upload; once per job. — *"follows an upload already running when it mounts"*, *"refreshes the project when an upload is already in progress"*, *"tracks an upload once, and again after it ends"*
- [ ] **The upload's job is found by the id the project records**, not by job kwargs (serialized, and admin-only). A just-started INACTIVE job counts; a job this user can't read (a co-owner's) is treated as invisible. — *"test_upload_records_job_id"*, *"returns the job while it is %s"*, *"returns null for a job this user can't read"*, *"returns null for a job that no longer exists"*, *"returns null once the job has ended"*
- [ ] **After a 409 the card follows the running job before releasing the in-flight flag**, so a stale `error` card can't discard the other tab's upload in the window before the refresh lands. — *"keeps the actions locked after a 409 until the refresh lands"*
- [ ] **The server refuses a discard while an upload may be running** (its job is live, or the upload is still starting and has no job recorded), still resets a project whose job ended in error, and `force=true` resets one whose job a restart orphaned at RUNNING. — *"test_discard_refused_while_upload_job_live"*, *"test_discard_refused_while_upload_initializing"*, *"test_upload_clears_previous_job_id_with_status"*, *"test_discard_resets_stuck_upload"*, *"test_discard_force_resets_orphaned_job"*
- [ ] **`uploading` with no visible job is re-read, and the status poll covers it** (a stale cached project, or a co-owner's upload), and the poll stops on a status change or unmount, including mid-lookup; a failed lookup falls back to the poll. — *"re-reads the project when the reported upload has no job"*, *"keeps re-reading while the upload's job is invisible"*, *"keeps checking when the job lookup fails"*, *"stops polling when unmounted"*, *"schedules nothing if unmounted while looking up the job"*
- [ ] **Project status is written before the job's terminal status** on failure as on success, because the card re-reads the project on that event. — *"test_fail_writes_project_status_before_job_status"*

- [ ] **An older project read can't overwrite a newer state.** The card triggers overlapping refreshes (409, job end, status poll), and selecting a project re-reads it in the background. `projects.fetchProject` commits only if no newer fetch started and no mutation wrote that project since it began (every project mutation stamps it), so a stale `draft` can't release a later upload, a read can't undo a metadata save, and a deleted or unshared project can't come back. It returns the stored copy, not a response it discarded. — *"keeps the newest snapshot when refreshes resolve out of order"*, *"doesn't let a re-read that started before a save replace it"*, *"doesn't bring back a project deleted while a re-read was out"*, *"doesn't bring back a project a list refresh dropped"*, *"returns the stored project, not a response it discarded"*
- [ ] **Showing a project re-reads it.** The store keeps a cached copy across navigation and the card is keyed by project, so leaving mid-operation drops its refresh. `ProjectInfo` re-reads the project whenever it starts showing one (on entry from any route, and on an in-place switch), not `setSelectedProject`, which isn't called when the user leaves and returns to the same project. An unchanged re-read keeps the cached object. — *"re-reads the project it shows, on entry and on switch"*, *"keeps the cached object when a re-read finds no change"*

### Project switch

- [ ] **Each project gets its own card instance**, so errors, progress and the job subscription never carry over. — *"gives each project its own ZenodoPublish instance"*
