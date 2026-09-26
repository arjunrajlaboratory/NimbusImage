# Stitch Position Refinement + Illumination Correction Worker

**Status (2026-08-30):** investigation complete, design ready, nothing implemented.
This doc records (1) the verified findings on ND2 compositing geometry, (2) the
requirements and strategy for correlation-based position refinement, and (3) the
strategy for the worker that performs refinement + flat-field correction. The
flat-field algorithms themselves already exist (Arjun has them) and are out of
scope here except for how they plug in.

## 1. Problem

Composited ND2 datasets show visible seams between tiles (example: dataset view
`6a94208ad233ea7fbc4328f9`, dataset folder `6a941e20d233ea7fbc4328e1`, source
file `tmp/stitching_examples/Data_AHN_to_Arjun/In vitro/unstiched/Well_2/…Seq0000.nd2`,
a 7×7 grid, 5 channels, 6 z). The seams show both a geometric jump (content
misaligned across the seam) and a brightness line (vignetting).

## 2. Verified findings — the compositing math is CORRECT

Do not "fix" the geometry in `MultiSourceConfiguration.vue`. It was measured to
be correct to within ~1 px of what the stage metadata allows. The seams are
**real microscope calibration error**, invisible to any metadata-only stitcher.

Evidence (measured 2026-08-30, harness scripts in `tmp/stitching_examples/`):

- All 84 adjacent tile pairs of the Well_2 file were cross-correlated (NCC on
  raw ND2 pixels, DAPI max-z; every pair matched at NCC 0.91–0.96). Residual =
  deployed `multi-source2.json` placement delta minus measured-truth delta:
  - Horizontal neighbors: constant **(−7.0 ± 0.8, −3.9 ± 0.6) px**
  - Vertical neighbors: **(−2.7 ± 1.4, −2…+10) px**, y drifting by row
- Decomposition into physical causes:
  - ~0.75% mismatch between reported pixel size (0.21667 µm) and actual stage
    travel → the constant −7 px per 200 µm step
  - ~0.25° rotation between camera axes and stage axes → the constant ~−4 px
    cross-axis terms (present in BOTH files below — it is this scope's standing
    calibration)
  - ±1.5 µm row-to-row stage positioning error (serpentine backlash) → the
    drifting vertical term
- The "working" reference file (`tmp/stitching_examples/Laura_composite_test.nd2`,
  4×4 grid, 0.325 µm px) has the same convention and the same ~0.25° rotation
  signature, but ~2–6 px residuals — below the visibility threshold. Same code,
  better-calibrated acquisition.
- Visual proof: `tmp/stitching_examples/seam_json.png` (deployed positions —
  reproduces the reported artifact) vs `seam_refined.png` (positions shifted by
  the measured correction — seam disappears except for the illumination line).

### 2.1 The geometry contract (reference)

Frontend compositing math: `src/views/dataset/MultiSourceConfiguration.vue:1684-1779`.

- Stage µm → px: divide by `mm_x * 1000` (= voxel size in µm).
- Per-tile transform: `s = −I` when `cameraTransformationMatrix ≈ −I`
  (`:1705-1724`), else the matrix itself; snapping to exactly −I is deliberate.
- Normalization (`:1729-1774`): transformed-corner offsets, then
  `x = round(coord.x − minX)`, `y = round(maxY − coord.y)` (global y-flip).
- large_image multi-source applies `M = [[s11,s12,x],[s21,s22,y]]` to source
  pixel coordinates (`_sourceBoundingBox`, girder container
  `/src/large_image/sources/multi/large_image_source_multi/__init__.py:726`).
  With `s = −I` a tile at (x, y) renders rot-180 occupying `[x−W, x] × [y−H, y]`.
- Alignment requirement between two tiles both carrying `s = −I`: placement
  delta `ΔP = −S`, where S is the content shift such that
  `tileB[r, c] ≈ tileA[r+Sy, c+Sx]`.
- Measured convention (both files): `S = (−Δstage_x, +Δstage_y) / pixel_size`.
  The frontend produces `ΔP = (+Δstage_x, −Δstage_y)` = −S. Correct.
- Source→position indexing (`:1775-1778`): `finalCoordinates[floor(sourceIdx /
  nChannels)]` is correct because `nd2_frame_metadata` is one entry per CAMERA
  frame (P×Z×T; C lives inside the frame — nd2 source `getInternalMetadata`,
  container `/src/large_image/sources/nd2/large_image_source_nd2/__init__.py:296`)
  and large_image frame order is C-fastest. Verified on the deployed JSON: 49
  distinct positions, 30 sources each, each tile matched to its own stage point.

### 2.2 Pipeline facts the design depends on (verified)

- **Originals survive transcode.** The transcoded TIFF is uploaded into the
  `multi-source2.json` item; source ND2 items only lose their `largeImage`
  record (metadata-only delete — `girder_large_image/models/image_item.py:331-374`
  removes a generated file only when `originalId` exists, never the original).
  So the raw tiles are always available to a worker, no upload-flow change needed.
- `multi-source2.json` is downloadable and contains the full stitch (paths +
  per-tile `position`) — a worker can reuse it instead of re-deriving geometry.
- Transcode is a Girder **local** job inside the girder container
  (`src/store/index.ts:1994`, `src/store/GirderAPI.ts:271-275` →
  `POST item/{id}/tiles?force=true&localJob=true`). Don't add heavy compute there.
- Existing pattern for workers that produce a new image: any new large-image
  item in the dataset folder is picked up after a job by `loadLargeImages(true)`
  (`src/store/annotation.ts:2255-2266`) and exposed in
  `src/components/LargeImageDropdown.vue` (labels `multi-source2.json` as
  "Original image", allows deleting derived ones).
- Server-side derived-image precedent: `cacheMaxMerge`
  (`upenncontrast_annotation/system.py:201-312`) writes a derived multi-source
  YAML and calls `ImageItem().convertImage(...)`.
- PR #1225 (`server/api/dataset.py`, backend multi_source endpoint) ports the
  same math to Python with parity fixtures. **No changes needed there** — the
  refinement design leaves config-time geometry untouched.

## 3. Position refinement — requirements and strategy

### 3.1 Requirements

- R1. Reduce seam misalignment from ~10 px to ≤2 px on confident pairs.
- R2. Metadata-seeded: search only a small window (±24 px) around the
  stage-predicted offset. Never do blind global registration.
- R3. Robust to low-texture overlaps: a pair with NCC below threshold (~0.5)
  contributes nothing (the Laura file has such pairs; trusting them injects
  ~28 px errors — measured).
- R4. Global consistency: solve all positions jointly, not pair-by-pair.
- R5. Minimal coordinate drift: keep the refined mosaic as close as possible to
  the original coordinates (existing annotations shift by at most the ~10 px
  correction; see R8).
- R6. Never modify the `s11..s22` transform — refinement adjusts translations only.
- R7. Deterministic and reportable: emit per-pair (offset, NCC) and final
  residual stats so a job log can say "84/84 pairs matched, max residual 1.4 px".
- R8. If the dataset already has annotations, surface a warning that mosaic
  coordinates shift slightly (an upload-time run has no such issue).
- R9. v1 scope: single-file ND2 compositing sources (the only kind the frontend
  produces — `canDoCompositing` requires exactly one file with
  `nd2_frame_metadata`, `MultiSourceConfiguration.vue:721`).

### 3.2 Algorithm (validated in this session's harness)

1. **Reference image per tile:** one channel (default channel 0 / DAPI;
   configurable), max-projected over z, float32. 49 tiles × 1022×1024 ≈ 200 MB.
2. **Adjacency graph** from the stage grid (bin stage x/y with a >50 µm gap
   rule; 4-connectivity).
3. **Pairwise measurement:** for each edge, NCC over the overlap region,
   coarse-to-fine search seeded at the stage prediction (radius 24 px step 3,
   then radius 4 step 1). FFT phase correlation on overlap strips is an
   optional speedup; keep the NCC verification either way. Record (Sx, Sy, ncc).
4. **Global solve:** least squares over per-tile positions `p_i` with residuals
   `(p_j − p_i) − (−S_ij)`, weights from NCC (drop pairs with ncc < 0.5), plus
   a zero-mean-shift constraint against the original positions (satisfies R5).
   Optionally IRLS/Huber for stragglers. This is a tiny sparse system (49
   unknowns × 2).
5. **Sparse-graph fallback:** if too few confident pairs to constrain a tile,
   fit a global similarity (scale + rotation, the two systematic terms measured
   in §2) to the confident pairs and apply it to the metadata positions of
   unconstrained tiles. This handles mostly-empty wells gracefully.
6. **Output:** refined integer positions, same shape as the current
   `position` records.

Prior art if we want a library instead: MIST (NIST) and ASHLAR implement exactly
steps 3–5; our harness already does 1–3 and is ~100 lines of numpy.

### 3.3 Reproduction / measurement harness

`tmp/stitching_examples/` (local, untracked) holds the session scripts:
`nd2_geometry.py` (metadata dump), `pairs_vs_stage.py` (residuals vs stage for
any ND2), `all_pairs.py` (residuals vs a deployed multi-source2.json). Re-run
with the repo `.venv` (`pip install nd2 numpy`). Gotcha: `nd2.ND2File.asarray(p)`
returns a leading singleton P axis, and `frame_metadata()` takes a raw sequence
index (`p * Z`), not a P index.

## 4. Worker strategy

One Docker worker, two phases, plus an optional light mode:

### 4.1 Full mode — "Corrected image" (refine + flat-field → new large image)

1. Inputs via the standard worker contract (`--datasetId --apiUrl --token`,
   dispatched by `runJobRequest`, `server/helpers/tasks.py:21`).
2. Download the dataset's `multi-source2.json` + the original ND2 item (resolve
   by the JSON's `sources[].path`; fail with a clear message if the user
   deleted the original — that's the only way it disappears).
3. Run position refinement (§3.2).
4. Apply flat-field correction per raw tile (existing algorithms; per channel).
5. Assemble output: write corrected tiles to a scratch multi-frame TIFF, emit a
   multi-source document with the refined positions pointing at it, and convert
   to a pyramidal TIFF with `large_image_converter` (streams via tile iterator —
   never materialize the full mosaic).
6. Upload the result as a **new item** in the dataset folder (girder_client;
   note `annotation_client` has no image-upload helper) with `meta.tool` and
   the refinement/flat-field parameters recorded in item metadata. The existing
   `loadLargeImages(true)` pickup and `LargeImageDropdown` UI handle the rest —
   non-destructive, retroactive, deletable.

### 4.2 Light mode — refinement only (rewrite the stitch, no new pixels)

Replace the contents of `multi-source2.json` with refined positions, then
re-run tile generation (and re-transcode if the dataset was transcoded) and
re-schedule the derived caches (tile-frames / max-merge / histogram — the same
three scheduled at config time, `MultiSourceConfiguration.vue:1906-1908`).
Cheaper (no pixel rewrite) but destructive-ish (the stitch changes in place)
and requires cache invalidation care. **Recommendation: ship 4.1 first**; add
4.2 only if the storage cost of corrected copies matters in practice.

### 4.3 Plumbing gotchas (all verified in this repo)

- Queue routing fails safe to **gpu** for unlabeled images
  (`server/helpers/workerQueues.py`) — label the image `isGPUWorker=false` so
  it lands on the cpu queue.
- Tool template goes in `public/config/templates.json`; job progress via
  `annotation_client` `sendProgress`.
- Do NOT run any of this as a Girder local job — transcode already runs inside
  the girder container and shares memory with the API server; this workload
  belongs on the worker service.
- Upload-time convenience later: a checkbox in the upload flow (or a
  `postProcess` option on the PR #1225 endpoint) that just queues this worker
  after dataset creation. One implementation, both entry points.

## 5. Verification plan / regression seeds

- Unit: synthetic tiles with known injected shifts + vignetting → refinement
  recovers shifts to ≤1 px; low-texture pair is dropped, not trusted (R3).
- Integration: run on the Well_2 dataset; assert reported max residual ≤2 px;
  eyeball the P24/P31 seam (the worst measured: (−4, +10) px) before/after.
- Laura file as the "already good" control: refinement must not make it worse.
- Coordinate stability: refined mosaic bounds within ±16 px of original (R5).
