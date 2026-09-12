# Snapshot dimension downloads branch review

## Overall Assessment

Frontend-only XY/T/Z expansion preserves crops and uses existing image-region requests. Initial validation passed 175 tests, type checking, lint, and a browser export of 22 TIFFs from 11 Z slices and two channels. The findings below were fixed and retested. Final verification: all 3,981 frontend tests pass; type checking, zero-warning lint, production build, and skill parity pass. Browser artifact checks cover raw Z, scaled Z, combined T/Z, a valid saved crop, and an invalid saved crop. The initial local review findings are resolved; the external review and its backend follow-up are recorded below.

## External Codex review (94eaf6e)

- P1, `Snapshots.vue:2251`: batch expanded region requests. **Status: deferred** — backend work tracked in https://github.com/arjunrajlaboratory/NimbusImage/issues/1350; this PR is explicitly frontend-only.
- P2, `screenshot.ts:101`: slider indices passed to image lookups keyed by dataset coordinate values. **Status: fixed (coordinate translation follow-up)** — confirmed in scaled validation, downstream `getBandOption`, and the raw-channel sibling path. Spatial/time indices now map through dataset arrays; layers reuse `getLayerImages` for both validation and styles, while raw selectors retain their existing channel IDs.

The generalized pattern was treating a UI index as a metadata key. The sweep
covered raw channels, scaled validation, style/histogram lookup, projection
handling, and the overview caller. Filenames still use one-based slider
positions; no location or selection contract changed. All 17 new cases failed
against the pre-fix code (using git stash), then passed after restoration.
The full suite passes 3,998 tests across 219 files; type checking, lint, and
production build pass. Browser verification used a temporary local Vite fixture
that remapped metadata to XY=3, T=4/7/10/..., Z=10/20/30/..., channels=2/7,
without modifying stored datasets. The real snapshot UI exported 11 scaled and
22 raw TIFFs; all decoded to 128×96 and matched the original-coordinate
exports pixel-for-pixel. The sparse-coordinate fixture is test-only.

## Findings

### Finding 2: Missing scaled-layer planes silently use the default frame
- Severity: High
- Category: Empty-state contract
- Location: `src/utils/screenshot.ts`, `getLayersDownloadUrls`
- Status: fixed 9239bcc5
- Current: `getBandOption` can return a style without a frame when no image exists; the region endpoint can interpret that as frame zero. An empty layer selection also yields an empty-band composite.
- Suggested: Reject missing planes and empty layer selections before requesting styles. Abort a saved-snapshot batch if any snapshot cannot be prepared.
- Rationale: Incomplete multidimensional datasets must never produce a believable image labeled with the wrong coordinates or a silently partial archive.

### Finding 5: Empty saved crops produce zero-byte archive entries
- Severity: High
- Category: Error handling
- Location: `src/utils/screenshot.ts`, `getDownloadParameters`; `src/store/GirderAPI.ts`, `getSnapshotImage`
- Status: fixed 9239bcc5
- Current (before fix): An existing saved snapshot with an empty crop downloaded eleven zero-byte files, even though the download action completed.
- Suggested / implemented: Reject nonfinite, inverted, empty, and out-of-image crops before download; reject empty binary responses. Propagate errors to the panel and abort the archive.
- Rationale: ZIP completion is not evidence of image validity. Tests and browser checks now reject the invalid crop; a valid temporary saved snapshot produced 22 readable TIFFs and was removed after verification.

### Finding 6: Single-file downloads omit the authentication header
- Severity: High
- Category: Symmetric paths / access control
- Location: `src/components/Snapshots.vue`, `downloadUrls`
- Status: fixed 44f95349
- Current (before fix): A single image without a canvas scalebar used direct URL navigation, while ZIP entries used the authenticated REST client. Disabling the TIFF scalebar exposed that asymmetric path for single scaled TIFFs.
- Suggested / implemented: Fetch both single files and ZIP entries through `GirderAPI.getSnapshotImage`, then download a local Blob and release its object URL.
- Rationale: Header-based authentication must work in both export paths. The new test failed before the fix, and a browser retest downloaded a readable 128×96 scaled TIFF with all dimension checkboxes off.

### Finding 1: Export inputs can change during asynchronous preparation
- Severity: Medium
- Category: Stale derived state
- Location: `src/components/Snapshots.vue`, current and saved snapshot download handlers
- Status: fixed 9239bcc5
- Current: Scalebar settings and export options are read after awaits; saved snapshot records and layer objects remain live references.
- Suggested: Capture settings, crop geometry, layers, names, and per-crop scalebar specifications before asynchronous work.
- Rationale: A long Z/T export must remain consistent when a user edits or navigates during it. Disabled controls alone do not protect against other panels or state updates.

### Finding 4: Crop fields concatenate numeric input strings
- Severity: Medium
- Category: Type safety
- Location: `src/components/Snapshots.vue`, `bboxWidth` and `bboxHeight`
- Status: fixed 9239bcc5
- Current (before fix): Typed origins could concatenate with dimensions; numeric setters interpreted width/height as absolute right/bottom coordinates. At left 100, entering width 128 could yield width 100028.
- Suggested / implemented: Normalize both operands to numbers and always add dimensions to the origin. Use numeric model bindings for left/top.
- Rationale: Both coordinate-entry paths must describe the same crop. Three regression cases failed before this fix and passed afterward; the browser retest confirmed a 128×96 crop at (100,120).

### Finding 3: Expanded downloads need API-layer ownership and progress
- Severity: Low
- Category: API calls in Vue components
- Location: `src/components/Snapshots.vue`, `downloadUrls`
- Status: fixed 9239bcc5
- Current: The expanded download loop calls the REST client directly, with only an indeterminate spinner for a current-location stack.
- Suggested: Move binary region fetching to GirderAPI, retain bounded processing, and report completed files. Clean up progress on failure.
- Rationale: Each region requires a separate existing endpoint request; serial processing bounds transient memory, while progress makes long exports understandable. A true server batch/streaming endpoint would require backend work outside this frontend-only request.

## Findings Summary

| # | Severity | Category | Location | Summary |
|---|---|---|---|---|
| 5 | High | Error handling | screenshot.ts / GirderAPI.ts | Reject invalid crops and empty responses |
| 2 | High | Empty-state contract | screenshot.ts | Reject missing image planes and incomplete batches |
| 6 | High | Access control | Snapshots.vue | Authenticate single-file downloads |
| 1 | Medium | Stale derived state | Snapshots.vue | Capture immutable export inputs |
| 4 | Medium | Type safety | Snapshots.vue | Normalize numeric crop fields |
| 3 | Low | API calls in Vue components | Snapshots.vue | Centralize binary fetches and show progress |

## Checklist Coverage

| Category | Status | Findings |
|---|---|---|
| Pattern consistency / factorization / naming | pass | #3 |
| Performance / looped API calls | warn | #3; backend batch export deferred to issue #1350 |
| Type safety / defaults | pass | #4 fixed; existing defaults preserved |
| Error handling / empty-state contracts | pass | #2 and #5 fixed |
| API calls in Vue components | pass | #3 |
| Stale state / symmetric paths | pass | #1 |
| Selection scope / access control | pass | #6 fixed; existing selected-snapshot scope guard retained |
| Backend layers / PyMongo / validation | n/a | No backend changes |
| Store actions / partial persistence | n/a | No new store actions or persistence |
| Hidden-mounted work / stacking | pass | Work runs only after download clicks; controls remain in existing palette |
| Documentation / comments | pass | Feature regression checklist accompanies the fixes |
