# Snapshot downloads across XY, T, and Z

The Snapshots panel offers independent XY, T, and Z checkboxes. All default to
unchecked, preserving single-location behavior. They apply to the current,
all-snapshots, and selected-snapshots image download buttons. Movies, viewport
screenshots, and annotated screenshots retain their existing behavior.

For each snapshot, checked dimensions expand to all slider positions in that
snapshot's dataset. Unchecked dimensions retain that snapshot's saved location.
The crop rectangle is identical at every exported position. Multiple images use
the existing ZIP archive workflow; TIFF exports contain a separate TIFF per
position and channel/layer, not a multipage TIFF. Names include one-based
`XY1_T19_Z3` coordinates whenever any dimension checkbox is checked.

Raw channels keep the server's TIFF bytes. TIFF and tiled TIFF bypass canvas
scalebars; the panel explains this. Scaled layers retain colors and contrast
settings, but use individual planes on checked dimensions, overriding fixed,
offset, or projection settings on those dimensions for the export only. Other
layer dimension settings remain intact. Viewer position and shared layers are
not changed by export.

Export settings, nested layer settings, crop geometry, and scalebar specs are
captured before asynchronous preparation. Missing image planes, empty layer
selections, and invalid crops produce an error instead of mislabeled images or
partial archives. Oversized raw crops still use the existing size-limit dialog.

Binary region requests use GirderAPI and run sequentially, with completed-file
progress and cleanup on failure. Each image requires its own existing region
request. A true batched/streamed export endpoint is outside this frontend-only
change. The compressed ZIP remains in browser memory until download; the change
bounds transient decoded-image memory, not the final archive size.

## Regression checklist

### Dimensions and geometry

- All eight axis combinations produce the unique Cartesian product and retain unchecked coordinates: `snapshotDimensions.test.ts` — *"exports exactly the selected Cartesian product"*.
- Each dataset supplies its own dimensions: `snapshotDimensions.test.ts` — *"expands each snapshot against its own dataset"*.
- Projected/fixed layers become individual planes on checked axes without mutating shared settings: `snapshotDimensions.test.ts` — *"exports individual planes without mutating projection or offset settings"*.
- Raw and scaled Z downloads retain the crop and name each position: `Snapshots.test.ts` — *"expands Z with a fixed crop and distinct names"*.
- All/selected saved snapshots use saved crops and locations: `Snapshots.test.ts` — *"expands %s saved snapshots using their saved crop and location"*.
- Both numeric and string dimensions are sizes relative to the origin: `Snapshots.test.ts` — *"sets bboxWidth as number updates bboxRight"*, *"sets bboxHeight as number updates bboxBottom"*, and *"adds entered widths and heights numerically when origins are strings"*.

### Artifact fidelity and asynchronous state

- TIFF/tiled TIFF bytes bypass canvas even when the scalebar is checked: `Snapshots.test.ts` — *"preserves %s bytes when scalebar is checked"*.
- In-flight exports retain their initial settings: `Snapshots.test.ts` — *"captures scalebar geometry before asynchronous URL preparation"* and *"freezes options and nested layer settings before loading a saved dataset"*.
- Missing/offset-out-of-range planes and empty layer selections never default to frame zero: `screenshot.test.ts` — *"rejects missing planes instead of exporting default frame zero"*, *"rejects empty layer selections"*, and *"rejects offset layers outside the dataset"*.
- Empty/nonfinite/inverted crops are rejected: `screenshot.test.ts` — *"rejects an empty or invalid crop"*.
- Empty binary responses are rejected: `GirderAPI.snapshot.test.ts` — *"rejects an empty server response instead of archiving a zero-byte image"*.
- A rejected crop prevents a partial saved-snapshot download: `Snapshots.test.ts` — *"does not download a partial saved-snapshot batch when a crop is invalid"*.

### Cost and cleanup

- ZIP requests run serially and preserve deterministic filenames/bytes: `Snapshots.test.ts` — *"downloadUrls assigns sanitized duplicate zip filenames in input order"*.
- Download failures clear progress and produce no archive: `Snapshots.test.ts` — *"cleans up ZIP progress without downloading on a network failure"* and *"reports failed exports and resets the download lock"*.
- Completed archives release object URLs: `Snapshots.test.ts` — TIFF byte-preservation cases assert `revokeObjectURL`.
- Binary requests use the authenticated API client and propagate failures: `GirderAPI.snapshot.test.ts` — *"fetches binary bytes with the authenticated client and propagates failures"*.

- Single-file exports use authenticated binary fetches too: `Snapshots.test.ts` — *"downloadUrls authenticates single-file downloads without a scalebar"*.

## Browser verification

On a fresh page served from this worktree at localhost:5174, a local dataset with
11 Z slices, 40 time points, and two channels produced:

- One readable scaled TIFF with all dimension checkboxes off (authenticated single-file path).
- 22 raw TIFFs across Z, retaining T19 and a 128×96 crop at (100,120).
- 11 scaled composite TIFFs with 11 distinct pixel arrays and the same crop.
- 880 readable raw TIFFs across T×Z (XY was also checked; this dataset has one XY position), covering all 440 positions with identical crop dimensions.
- 22 readable TIFFs from a valid saved snapshot with that crop.
- A visible error and no new archive for an existing saved snapshot with an empty crop.

The viewer remained at Z6/T19. Files were decoded using tifffile, rather than
inferring correctness from download completion. The temporary valid snapshot
was removed after verification. Multiple-XY expansion is covered by the unit
matrix. Review findings and resolution are in `SNAPSHOT_DIMENSIONS_REVIEW.md`.
