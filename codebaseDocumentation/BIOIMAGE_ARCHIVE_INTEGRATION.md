# BioImage Archive Integration — Analysis & Design Notes

Status: **research / design** (no code shipped yet). This document captures
everything learned while scoping an integration between NimbusImage and the
[BioImage Archive](https://www.ebi.ac.uk/bioimage-archive/) (BIA), EMBL-EBI's
repository for life-sciences microscopy data.

It covers **both directions**:

- **Writing / publishing** (NimbusImage → BIA) — the primary focus, analogous
  to the existing [Zenodo upload integration](./ZENODO_UPLOAD.md).
- **Reading / importing** (BIA → NimbusImage) — secondary, but documented here
  because it is genuinely useful and easier than publishing.

> **Verification caveat.** Much of the detail below was gathered from BIA /
> BioStudies documentation, the BioStudies backend source, and the Python
> reference client. The exact live endpoints (and whether portal upload is
> REST vs FTP-only) should be confirmed against the **BioStudies DEV server**
> with a real account before building. EBI and gitbook hosts block automated
> fetching, so the live API could not be exercised during research.

---

## 1. Background: BIA is built on BioStudies

The BioImage Archive does not have its own bespoke submission/serving stack. It
is a **collection within [BioStudies](https://www.ebi.ac.uk/biostudies/)**
(EMBL-EBI's general-purpose study database). Practical consequences:

- The **read API** is the BioStudies API (`https://www.ebi.ac.uk/biostudies/api/v1/`),
  scoped to the `BioImages` collection.
- **Submission** is the BioStudies submission workflow; starting a BIA
  submission redirects into the BioStudies submission portal.
- Studies are identified by **accession** `S-BIADxxxx` (not numeric IDs like
  Zenodo).
- Metadata follows **REMBI** (Recommended Metadata for Biological Images),
  encoded as **PageTab** (the `accno` / `attributes` / `section` /
  `subsections` JSON structure).

### Comparison with Zenodo

| | **Zenodo** (already integrated) | **BioImage Archive** |
|---|---|---|
| Host | CERN | EMBL-EBI, built on BioStudies |
| Read auth | None for public records | **None** (fully anonymous) |
| Write auth | Long-lived scoped **PAT** | **Username/password → session token** (no API key) |
| Unit | "record" / deposition (numeric id) | "study" / accession `S-BIADxxxx` |
| Publish | REST create → bucket PUT → publish, **instant DOI**, irreversible | Upload to dropbox → submit PageTab → **curation → release**, DOI on release |
| Metadata | ~6 flat fields | **REMBI** (structured study/component/acquisition) + per-file File-List |
| Per-file size | MB–low GB | **GB–TB** (whole-slide, volume EM, OME-Zarr) |
| Cloud-optimized format | rare | **OME-Zarr / OME-NGFF on public S3** for a subset |

---

## 2. Writing / Publishing (NimbusImage → BIA)

**This is *not* a clean analog of the Zenodo publish flow.** Zenodo is a 4-step
REST dance (create deposition → PUT files to bucket → set metadata → publish,
DOI minted instantly). BIA is a **curated, metadata-heavy, multi-stage**
workflow:

```
authenticate
  → upload files to YOUR personal dropbox (FTP / Aspera / HTTP drag-drop)
  → build PageTab metadata + File-List
  → POST submission (references the already-uploaded files)
  → validation
  → EBI curation
  → release (+ DOI), optionally on a future embargo date
```

Two facts shape the whole design:

1. **Files must land in your personal dropbox *before* the submission
   references them.** There is no per-deposition upload bucket. Submit-before-
   upload fails.
2. **There is no instant DOI and it is not a one-click irreversible publish.**
   A submission is created (`S-BIADxxxx`), goes through validation + curation,
   and is *released* (optionally with a future embargo date), at which point
   the DOI is assigned. The NimbusImage UX is therefore "**submit for curation
   / release on date X**," not "publish now."

### 2.1 Authentication

- Requires an **EBI BioStudies account**
  (signup: `https://www.ebi.ac.uk/biostudies/submissions/#/signup`). There is a
  **DEV/test server** that mirrors production — the BioStudies equivalent of
  the Zenodo sandbox. Use it for all testing.
- REST flow:
  - `POST .../auth/login` with `{ login, password }` → returns a **session
    token**.
  - Pass the token as the **`X-SESSION-TOKEN`** header on every subsequent
    request.
  - The token is **reusable until it expires** (re-login to refresh).

**There is no long-lived API key.** This was verified against the BioStudies
submission backend's own config
([`application.yml`](https://github.com/EBIBioStudies/biostudies-backend-services/blob/master/submission/submission-webapp/src/main/resources/application.yml)):
the security section is a **custom hash-token scheme** (`tokenHash`,
`instanceKeys` for dev/beta/prod) — **no Webin, no JWT, no OAuth/AAP, no
API-key mechanism**. EBI's *other* systems (ENA/Webin, BioSamples) have moved
to JWT bearer tokens with a `ttl` long-validity option, but **BioStudies/BIA
has not adopted Webin**.

**Implication for NimbusImage credential storage** (more sensitive than Zenodo,
which uses a scoped PAT):

- **Option A (recommended): store EBI username + password encrypted** (Fernet,
  reusing the `zenodo_credentials.py` pattern) and re-login to mint a fresh
  session token at each job start.
- **Option B: store only a pasted session token** and handle expiry / re-prompt.

Whichever is chosen, the UI must clearly state that it stores EBI credentials.

### 2.2 File upload — to a personal dropbox, by size tier

| Total size | Channel |
|---|---|
| < 50 GB total / < 20 GB per file | Portal drag-and-drop (HTTP upload API) |
| up to ~1 TB | **FTP** to your dropbox |
| > 1 TB | **Aspera** (`ascp`) |

Dropbox credentials come from the submission interface. For a backend job
streaming multi-GB NimbusImage projects, **FTP/FTPS is the realistic channel**
(covers up to ~1 TB via Python `ftplib`, streaming straight from Girder File
objects). Aspera (>1 TB) needs the `ascp` binary bundled — defer.

There is **no S3-to-S3 ingest** (see §4 for the full S3 / egress analysis).

### 2.3 Metadata — REMBI (the real work)

Zenodo needs ~6 fields. BIA expects **REMBI**, a structured model:

- **Study** level: title, description, authors (with **ORCID**), license,
  links, publications.
- **Study Components** — groupings of experimental units (best practice: one
  upload folder per component).
- **REMBI experimental modules**: biosample / specimen / preparation, **image
  acquisition** (microscope, modality, channels), **image analysis /
  processing**.
- **File-List** — a `.tsv` / `.xlsx` (one row per file) carrying per-file
  metadata, **linked to a Study Component**. The portal auto-generates a
  template of file paths that the submitter enriches.

All encoded as **PageTab JSON**. NimbusImage's `project.meta` has almost none of
these fields today, so the integration's center of gravity is **collecting /
mapping REMBI metadata**, not the file transfer.

**Recommended v1 scope:** collect a *minimal valid* study + one study component
+ a basic File-List, submit to the **DEV server**, and direct the user to the
portal to finish curation. Do not attempt to model all of REMBI in NimbusImage
initially.

### 2.4 Submission & lifecycle

- `POST` the PageTab submission (with `X-SESSION-TOKEN`).
- **No accession provided → a new `S-BIADxxxx` is minted. Accession provided →
  resubmission / update** (maps neatly onto the existing Zenodo "new version"
  concept).
- The returned PageTab is always JSON.
- Lifecycle: **validation → curation → release**. A future **release date**
  gives an embargo. DOI is assigned on release.

### 2.5 How it maps onto the existing Zenodo publish code

The Zenodo publish architecture is **~70% reusable structurally**. The
job/SSE/progress/credential scaffolding transfers; the *contents* of three
areas change (auth, upload ordering, metadata).

| Existing Zenodo file | BIA analog | Reuse | What changes |
|---|---|---|---|
| `server/api/zenodo_credentials.py` (Fernet) | `bioarchive_credentials.py` | High | Store EBI creds or session token, not a PAT |
| `server/helpers/zenodo_client.py` | `bioarchive_client.py` | Medium | `login()`→token; **FTP upload to dropbox**; `submit(pagetab)`; `get_submission(accession)`. No bucket PUT. |
| `server/helpers/zenodo_job.py` | `bioarchive_job.py` | High | Same local-job + SSE pattern; step order = *upload-then-submit*; must **build PageTab + File-List** |
| `server/api/zenodo.py` | `bioarchive.py` | Medium | `submit`/`status`; "publish" → "set release date"; "discard" → delete pre-release draft |
| `src/store/ZenodoAPI.ts` | `BioArchiveAPI.ts` | High | Same client shape |
| `src/components/ZenodoPublish.vue` | `BioArchivePublish.vue` | Medium | Status states: `uploading → submitted → in_curation → released` |
| `ZenodoTokenDialog.vue` | `BioArchiveCredentialsDialog.vue` | High | username/password (+ DEV-server toggle) instead of PAT |
| — | **`RembiMetadataForm.vue`** (NEW) | — | **The new, largest piece** — collect REMBI fields |
| `IProjectZenodo` in `model.ts` | `IProjectBioArchive` | High | New status enum, accession, releaseDate |

Add a parallel `project.meta.bioarchive` field alongside `project.meta.zenodo`.
The "upload N files with progress, recover job on reload" machinery
(`createLocalJob`, JSON log lines, `findActiveUploadJob`, `jobs.addJob()`) is
directly reusable. Consider the BioStudies Python **reference client**
([`ebi-ait/biostudies-client`](https://github.com/ebi-ait/biostudies-client))
either as a crib or as a backend dependency.

### 2.6 Recommended phased approach

- **Phase 0 — Spike (do first):** Get a DEV-server account; manually push one
  small NimbusImage export through the full flow (login → FTP upload → minimal
  PageTab + File-List → submit). Validates exact endpoints/headers and the
  minimal-required REMBI set before any code.
- **Phase 1 — Backend:** `bioarchive_client.py` (login + FTP upload + submit)
  and `bioarchive_job.py` (reuse the Zenodo job scaffold), plus encrypted
  credentials and a `bioarchive.py` API with a DEV/prod toggle.
- **Phase 2 — Frontend:** credentials dialog + `BioArchivePublish.vue` with the
  new status lifecycle; map existing `project.meta` → PageTab.
- **Phase 3 — REMBI form:** `RembiMetadataForm.vue` to collect the structured
  metadata NimbusImage doesn't currently store.

### 2.7 Key risks & open decisions

1. **Credential sensitivity** — store EBI password vs. paste session token vs.
   (not available) API key. See §2.1.
2. **REMBI scope** — minimal-valid + finish-on-portal (recommended) vs. full
   in-app form.
3. **FTP-from-backend** — streaming FTP/FTPS from Girder File objects with SSE
   progress (`ftplib`); covers ≤1 TB. Aspera (>1 TB) deferred.
4. **No instant DOI / embargo semantics** — UX and status model must reflect
   submit → curate → release with a release-date picker.
5. **Verify live endpoints** — confirm the current submission endpoint path and
   whether portal upload is REST vs FTP-only against the DEV server.

---

## 3. Reading / Importing (BIA → NimbusImage)

Secondary to publishing, but **easier** — the read API needs **no auth, no
tokens, no encryption**. The main challenge is **scale** (see §3.4).

### 3.1 Access methods overview

BIA offers five ways to get data out:

| Method | Endpoint / location | NimbusImage relevance |
|---|---|---|
| **REST API** (BioStudies) | `https://www.ebi.ac.uk/biostudies/api/v1/` (no auth) | Discovery & metadata |
| **HTTPS direct download** | `https://ftp.ebi.ac.uk/biostudies/{mode}/{relPath}/Files/{path}` | Fetch the bytes |
| **FTP** | `ftp://ftp.ebi.ac.uk/biostudies/...` (anonymous) | Same tree; less convenient from a backend |
| **Aspera / Globus** | `ascp` CLI; Globus "planned/partial" | Bulk multi-TB only |
| **S3 + OME-Zarr** | `https://uk1s3.embassy.ebi.ac.uk`, bucket `bia-integrator-data` | ⭐ Cloud-optimized tiled reads (see §3.5) |

### 3.2 REST API (discovery & metadata)

Base: `https://www.ebi.ac.uk/biostudies/api/v1/` — **no auth**.

- **Search** (scoped to images):
  `GET /search?query=<text>&collection=BioImages&pageSize=20&page=1`
  → JSON `{ page, pageSize, totalHits, sortBy, hits: [{ accession, title,
  author, type, links, ... }], facets, query }`.
- **Study metadata (PageTab JSON):**
  `GET /studies/{accession}` → full submission: `accno`, `attributes` (Title,
  ReleaseDate, License…), nested `section` (type `Study`) containing `files`,
  `links`, `subsections` (authors, etc.). File entries look like
  `{ "path": "img.ome.tiff", "size": 12345, "type": "file", "attributes": [...] }`.
- **Study info:**
  `GET /studies/{accession}/info` → `{ accession, version, files: <count>,
  ftpLink, relPath, ... }`. **Key call** — `ftpLink`/`relPath` is how you turn
  a file's `path` into a download URL.
- **File lists:** large studies reference external file-list files; fetch via
  `/studies/{accession}/files/{fileListName}` (paginated). Must be handled —
  studies can have thousands of files.

### 3.3 Download URL construction

Files are served over plain HTTPS (no auth) at:

```
https://ftp.ebi.ac.uk/biostudies/{mode}/{relPath}/Files/{filePath}
```

where `{mode}` is `fire` or `nfs` and `{relPath}` (e.g. `S-BIAD/144/S-BIAD144`)
comes from the `/info` response. Do **not** hand-derive `relPath`; read it from
`/info` (the `ftpLink` field gives the base).

### 3.4 The scale problem

The Zenodo importer (`ZenodoAPI.importDataset()`) does
`downloadFile()` (blob into browser memory) → `uploadFile()` back to Girder, per
file. Fine for MB-scale Zenodo records; **will OOM the browser on a 50 GB BIA
image.** Two options:

1. **Server-side streaming import job (recommended).** A Girder local job that
   mirrors `zenodo_job.py` in reverse: stream from `https://ftp.ebi.ac.uk/...`
   directly into the assetstore with SSE progress. Reuses every piece of the
   existing job pattern. New files would be
   `server/api/bioimage_archive.py` (e.g. `POST /bioimage_archive/import` →
   `jobId`), `server/helpers/bia_client.py`, `server/helpers/bia_import_job.py`.
2. **Client-side, size-gated.** Keep the Zenodo-style browser loop but only for
   small studies. Fast to ship, sharp UX cliff — acceptable only for a v0 demo.

### 3.5 OME-Zarr fast path (high payoff, optional)

A growing subset of BIA images are converted to **OME-Zarr / OME-NGFF** and
hosted on EMBL-EBI's public Embassy S3 (`s3://bia-integrator-data` at
`https://uk1s3.embassy.ebi.ac.uk`, anonymous). The **bia-integrator** metadata
model maps study → image → representations, including the OME-Zarr S3 URI.

OME-Zarr is **cloud-optimized and tiled** — the same model as NimbusImage's
tile-serving pipeline. For these images you could **register the remote Zarr as
a `large_image` tile source and stream tiles, never downloading the whole
file** — turning "wait an hour for 200 GB" into "view instantly." This is the
strongest reason to do BIA reads well rather than as a Zenodo clone. Gated on
confirming the `large_image` build has a zarr/OME-NGFF source. Worth a spike
before committing to the streaming-import design.

### 3.6 Read-side integration shape (mirrors the Zenodo importer)

- Frontend `src/store/BioImageArchiveAPI.ts`: `searchStudies`, `getStudy`,
  `getStudyInfo`, `listFiles`, `buildDownloadUrl`, `filterImageFiles`. No
  credential methods (no auth) — simpler than `ZenodoAPI`.
- `src/components/BioImageArchiveImporter.vue`: clone of `ZenodoImporter.vue`,
  wired into `Home.vue`.
- Instantiate alongside `zenodoAPI` in `src/store/index.ts`.
- New `model.ts` interfaces for the BioStudies response shapes (they differ
  from `IZenodoRecord` — `hits[].accession` vs `hits.hits[].id`, file lists vs
  inline `files[]` with download links).

---

## 4. S3, direct transfer, and egress

A common question: "all our big data is on S3 — can we transfer directly to
BIA, and do we avoid egress charges?" Short answer: **no direct S3-to-S3 path
for submission, and you still pay your own AWS egress — but the EBI side is
free.**

- **Is BIA on S3?** Yes, but the wrong kind for ingest. BIA's S3
  (`s3://bia-integrator-data` at `https://uk1s3.embassy.ebi.ac.uk`) is
  **EMBL-EBI Embassy Cloud** — an S3-*compatible* Ceph/OpenStack store, **not
  AWS**. It is **read-only and derivative** (OME-Zarr conversions of
  *already-published* data), **not a submission ingress.** (The separate
  "OME-Zarr Open SciVis" set on AWS Open Data is a different project, not BIA.)
- **Direct S3→S3 for submission?** **No.** Submission ingest is HTTP drag-drop
  / FTP / Aspera into your personal BioStudies dropbox only. There is no
  "hand us an S3 URI" mechanism. The backend job must *read* bytes from the
  assetstore and *push* them to EBI — no zero-copy shortcut.
- **Egress accounting:**
  - **EBI side: free.** EMBL-EBI is publicly funded; ingest is free, and even
    downloading from Embassy S3 has **no requester-pays and no egress fees**.
  - **Your side: you pay AWS egress.** Because EBI is not on AWS, data must
    leave AWS over the public internet → **AWS data-transfer-OUT (~$0.09/GB
    after free tier)**, regardless of FTP vs Aspera. ~$90/TB. In-region S3
    reads are cheap/free; the WAN hop to EBI is the charged part.
  - This is **not new**: the existing Zenodo upload has the identical egress
    profile (CERN/Zenodo also isn't on AWS). BIA is no worse.
- **Premise caveat:** the assetstore in *this* repo is a **filesystem**
  assetstore (`/assetstore`, per `devops/girder/provision.py` and
  `docker-compose.yaml`), not S3. The S3 backing is the production AWSDeploy
  config.

**Net:** there is no S3 fast-path to dodge the transfer — BIA isn't on AWS and
won't pull from your bucket. The receiving side costs nothing; your exposure is
standard AWS egress already incurred for Zenodo. The only lever to avoid egress
entirely would be archiving to an AWS-resident repository instead of BIA, which
defeats the purpose.

---

## 5. Summary recommendations

- **Publishing is the priority but the harder direction.** Reuse the Zenodo
  publish scaffolding; the genuinely new work is (a) upload-to-dropbox-then-
  submit ordering with FTP streaming, (b) PageTab + File-List generation, and
  (c) a REMBI metadata form. Accept a curation/release lifecycle instead of an
  instant DOI.
- **Start with a Phase 0 DEV-server spike** to lock down live endpoints and the
  minimal-required REMBI set before writing code.
- **Auth: no API key exists** — store EBI credentials encrypted (Fernet) and
  mint session tokens per job, or store a pasted session token.
- **Reading is easy and worth doing**, especially the **OME-Zarr tile-source
  fast path**, which would let NimbusImage view TB-scale BIA data without
  downloading. Spike that before designing a streaming importer.
- **No S3 shortcut and unavoidable AWS egress** — but identical to the existing
  Zenodo situation, and the EBI side is free.

---

## 6. References

- [BioImage Archive — home](https://www.ebi.ac.uk/bioimage-archive/)
- [Submitting data to the BioImage Archive](https://www.ebi.ac.uk/bioimage-archive/submit)
- [BioImage Archive submission — Lab Guide (REMBI)](https://www.ebi.ac.uk/bioimage-archive/rembi-help-lab)
- [BioImage Archive File-List help](https://www.ebi.ac.uk/bioimage-archive/help-file-list/)
- [How to access the data — BioImage Archive (Embassy S3)](https://www.ebi.ac.uk/bioimage-archive/galleries/access_data_help.html)
- [BioImage Archive download help](https://www.ebi.ac.uk/bioimage-archive/help-download)
- [OME-Zarr submissions — BioImage Archive](https://www.ebi.ac.uk/bioimage-archive/help-zarr/)
- [bia-integrator-data on Embassy S3](https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/pages/visualisation.html)
- [BioStudies API docs (gitbook)](https://biostudies.gitbook.io/biostudies-api) ·
  [Search](https://biostudies.gitbook.io/biostudies-api/search-submissions) ·
  [Submissions](https://biostudies.gitbook.io/biostudies-api/perform-submissions) ·
  [Security/Auth](https://biostudies.gitbook.io/biostudies-api/security)
- [biostudies-backend-services — submission auth config (application.yml)](https://github.com/EBIBioStudies/biostudies-backend-services/blob/master/submission/submission-webapp/src/main/resources/application.yml)
- [ebi-ait/biostudies-client (Python reference client)](https://github.com/ebi-ait/biostudies-client)
- [EBIBioStudies/BioStudyUISub (official submission app)](https://github.com/EBIBioStudies/BioStudyUISub)
- [Euro-BioImaging FAIR101 — Data deposition into BioImage Archive (workshop)](https://github.com/Euro-BioImaging/FAIR101-Workshop-on-data-deposition-into-BioImage-Archive)
- [Webin authentication (EMBL-EBI) — JWT/ttl model used by ENA, *not* BioStudies](https://www.ebi.ac.uk/about/news/service-news/webin-authentication)
- [AWS S3 Requester Pays / egress model (for contrast)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RequesterPaysBuckets.html)
- [The BioImage Archive — home of life-sciences microscopy data (bioRxiv)](https://www.biorxiv.org/content/10.1101/2021.12.17.473169v1.full)
- NimbusImage internal: [`ZENODO_UPLOAD.md`](./ZENODO_UPLOAD.md)
