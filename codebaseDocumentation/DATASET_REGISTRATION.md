# Registering one dataset onto another

**Status (2026-10-09):** prototype works end to end, outside Nimbus (scripts)
and inside Nimbus (a hand-written multi-source document). No product code has
been written yet. This doc records what was measured, how the registration
was done, how it was served through Nimbus, and an implementation plan with
options.

Motivating case: optical pooled screening (OPS) from the Shalem lab (Ophir).
Their main pain point is lining up the 40x phenotyping images with the 10x
in-situ-sequencing (ISS) barcoding cycles. They currently match by hand.
Lining up even barcode cycle 1 with phenotyping would help them. The feature
we want is general, though: "register dataset B onto dataset A".

Related docs:
- `MULTIFILE_ND2_COMPOSITING.md`: how the per-position ND2 files are
  composited into one mosaic.
- `STITCH_REFINEMENT_WORKER.md`: the same family of calibration error (a
  pixel-size mismatch of about 0.7% plus a small camera rotation) seen within
  a single dataset.

---

## 1. Data

Location: `/Users/arjunraj/code/Ophir-OPS-DM1ExampleWell/` (local, not in
the repo). Stage positions were indexed on 2026-10-03 to
`mind-map/outputs/ops/2026-10-03-stage-positions.csv`.

| | ISS cycles (barcoding) | Phenotyping |
|---|---|---|
| Objective | 10x | 40x |
| Pixel size | 0.666909 µm | 0.166397 µm |
| Tiles | 406 per cycle | 6,524 |
| Tile size | 2304² | 2304² |
| Channels | G, T, A, C, DAPI-WF (DAPI = frame 4) | CTGFISH_TYE665, DAPI-WF (DAPI = frame 1) |

- Pixel ratio is about 4.008.
- Tiles do not overlap, so there are no seams to stitch against within a
  dataset.
- The camera matrix is about −I. Its off-diagonal terms are 0.00122, and
  Nimbus snaps the matrix to exactly −I.
- Pixel ↔ stage convention, the same for both datasets, with H = 1152:

  ```
  col = H − (x − X_tile) / px
  row = H + (y − Y_tile) / px
  ```

- In the Nimbus phenotyping mosaic, `X = A + x/PP` and `Y = B − y/PP`. A and
  B are fitted from the `multi-source2.json` source positions. The sources use
  s11 = s22 = −1, so each tile is rotated 180° and its centre pixel lands at
  `position − (H, H)`.

The key fact: **both datasets carry stage coordinates in one shared stage
frame.** Stage coordinates alone predict the overlay to within about 25 µm,
which is around 25 µm of error, or 14 to 20 10x px. That is far off at the
cell level, but it is an excellent starting guess for the search.

## 2. Findings

All measurements are image-based: 40x DAPI matched against cycle-1 10x DAPI.

1. **Stage-only placement is wrong by a constant offset.** The offset is
   (−13.8, +20.4) 10x px, about (−9.2, +13.6) µm. Across 6,123 tiles with
   NCC above 0.7, the spread is about 2.5 px (std). Matching is very reliable:
   median NCC is 0.91, and 96% of tiles score above 0.7.
2. **There is a slow tilt across the well**, of about 2 px per 10 mm. It is
   modelled as linear terms in ISS stage position.
3. **The 10x objective has lens distortion within each ISS tile.** A
   degree-5 polynomial in the normalized in-tile position (u, v) captures it.
   Its magnitude is a few px at the corners. A model fitted on interior tiles
   only extrapolated badly at corners, so the corner and edge tiles must be
   measured (§3.1).
4. **The 40x tiles are not at their nominal scale.** They are 0.65% (row) to
   0.74% (col) larger than nominal and rotated by 0.124°. This only showed up
   with dense patch matches (3×3 patches per 40x tile). With a 10x-only model,
   the residuals had a clear pattern by patch position inside the 40x tile.
   Two consequences:
   - **The Nimbus phenotyping mosaic itself has seams of about 3 µm**, because
     compositing snaps the camera matrix to −I. This is the same mismatch that
     `STITCH_REFINEMENT_WORKER.md` found on another scope.
   - Any registration that treats the 40x tiles as rigid at nominal scale
     tops out at about 1.5 to 2 px (10x) of error.
5. **There is no per-tile jitter.** A single global model fits the whole well.
   That makes the problem much easier than it first looks: there are about 20
   to 30 parameters per (scope, objective pair, well), not a free offset for
   each of thousands of tiles.

### Accuracy of the model (10x px, held-out ISS tiles)

| Model | p50 | p90 | p95 |
|---|---|---|---|
| Offset + tilt + 10x field (deg 5) | 1.58 | 2.28 | — |
| + 40x linear (scale/rotation per 40x tile), **final** | 0.59 | 1.38 | 1.85 |
| + 40x quadratic | 0.58 | 1.38 | 1.88 |
| + 40x cubic | 0.51 | 1.31 | — |

Served through Nimbus (§4), phase correlation of DAPI-WF against DAPI c1 at 16
regions gave a **median of 0.33 10x px and a max of 1.85**.

Biological validation (`validate.py`): this checks the fraction of
genotyped centroids that land on a nucleus.

| Placement | On a nucleus |
|---|---|
| Stage only | 1.7% |
| Constant offset | 97% |
| Full model | 96% |

So for coarse assignment of nuclei to barcodes, the constant offset alone
already does most of the work. The full model matters for spot-level
alignment and for cells near tile corners.

## 3. Algorithm

Scripts are in `Ophir-OPS-DM1ExampleWell/registration_cycle1/`. Run them with
`/Users/arjunraj/code/NimbusImage/.venv/bin/python`, which has `nd2` and
skimage.

### 3.1 Coarse: one shift per 40x tile (`measure_shifts.py`)

For each ISS tile:

1. Load cycle-N DAPI and normalize it (clip 1–99.8 percentile to [0, 1]).
2. Find the 40x tiles whose stage-predicted centre falls inside the ISS tile.
3. Downsample each 40x DAPI to the 10x grid. That makes 2304 / 4.008 =
   **575 px** (`SMALL`), using `skimage.transform.resize` with anti-aliasing.
4. **Crop a 50 px border from the template.** Without this, tiles at ISS
   edges and corners don't fit in the search window, and the model is never
   constrained there.
5. Run `match_template` (NCC) in a window of ±40 px around the stage
   prediction.
6. Refine to subpixel with a parabolic fit on the peak.
7. Record the residual (observed − predicted) in 10x px, together with the
   NCC score.

Output: `shifts_c1_all16.csv`, with 6,376 tile shifts from all 406 ISS tiles.
The run takes about a minute on 14 processes.

### 3.2 Dense: 3×3 patches per 40x tile (`patches.py`)

Split each downsampled 40x tile into 3×3 patches of about 191 px. Match each
patch in a ±10 px window around the position predicted by the coarse shift.
This yields 16,350 patch matches from every 3rd ISS tile, saved to
`patches_c1.csv`. These matches are what exposed the 40x scale and rotation
(finding 4).

### 3.3 Model fit (`fitfield2.py`, `fitjoint.py` → `joint_model.npy`)

Linear least squares with robust refitting: 4 rounds, dropping matches with
residual above 4 px. Only matches with NCC above 0.7 are used. The fit is
done separately for the row and column shift.

```
shift(row, col) = c0
                + c1·wx + c2·wy                  # tilt: ISS stage pos, /1e4 µm
                + Σ poly(u, v; deg 1..5)         # 10x field, u,v ∈ [-1,1] in ISS tile
                + c_s·s + c_w·w                  # 40x linear: pos inside 40x tile
```

The last two coefficients convert into a 2×2 Jacobian excess
`J = [[0.00653, −0.00214], [0.00218, 0.0074]]`. That J is the per-40x-tile
scale and rotation correction. Held-out validation uses 25% of the ISS tiles,
chosen at random.

### 3.4 Applying it (`add_iss2.py`)

There are two pieces, and both are expressible in a large_image multi-source
document:

- **Moving tiles (ISS) are warped.** For each ISS tile, a 9×9 grid of ISS
  pixel positions is mapped into mosaic coordinates. The mapping inverts
  `observed = predicted + shift(predicted)` with 3 fixed-point iterations,
  then converts stage → mosaic. The grid pairs become `position.warp`
  `{src, dst}` landmarks. With more than 3 points, large_image fits a thin
  plate spline. A `crop` limits each tile to the reference extent.
- **Reference tiles (40x) get their true affine.** The snapped −I is
  replaced by `S = −(I + Jᵀ)`, and the translation is recomputed so the tile
  centre stays fixed:

  ```
  S11 = −(1 + J11), S12 = −J10, S21 = −J01, S22 = −(1 + J00)
  x = cx − (S11·H + S12·H),  y = cy − (S21·H + S22·H),  (cx, cy) = pos − H
  ```

  This also removes the about 3 µm seams in the phenotyping mosaic itself.

`diag.py` confirmed that large_image's warp output matches an independent
numpy implementation of the same warp.

### 3.5 What is OPS-specific and what is general

The parametric model (offset, tilt, 10x poly, 40x linear) is **specific to
this acquisition**: tiled, non-overlapping, two objectives, one shared stage
frame. It is robust because there are so few parameters. A general feature
should not hard-code it. What carries over:

- **An initial guess from stage coordinates**, since both datasets usually
  share a stage frame. The fallback, when they don't, is a coarse global
  search: phase-correlate whole-mosaic thumbnails, then refine.
- **Matching at the coarser dataset's resolution**, using a nuclear channel
  in each dataset. The user picks the channel; default to a name matching
  /DAPI|Hoechst/.
- **Dense patch matching** (tile, then 3×3 patches), keeping matches with NCC
  above 0.7.
- Then one of:
  - **Non-parametric:** feed the patch matches straight in as TPS landmarks
    for each moving source. This needs no model choice and handles anything
    smooth. Its noise is the patch match noise (about 0.5 to 1 px), and
    it is not regularized.
  - **Parametric:** fit a global smooth model (the §3.3 form, with the
    polynomial degree configurable) and emit landmarks from the model. This
    is more robust where matches are sparse, such as empty regions or edges.
    It is the better default when the acquisition is tiled.
- **Per-tile affine correction of the reference tiles**, applied only when
  the reference is itself a multi-source composite.

## 4. Inside Nimbus (prototype)

### 4.1 What was done

1. `make_pheno.py` creates a dataset and uploads a 5×5 centre subset of the
   phenotyping tiles (`Phenotyping_5x5_center`). It configures the dataset
   through `POST dataset` with `enable_compositing=True` and assignments
   `{"XY":{"source":"filename","guess":"XY"},"C":{"source":"file","guess":"C"}}`.
   This produces `multi-source2.json`.
2. `add_iss2.py`:
   - Uploads cycle-1 ISS tiles 202, 203, 204, 223, 224 and 225 into **the
     same folder** as `Cycle1_<name>`.
   - Downloads `multi-source2.json` and fits A and B.
   - Appends 5 sources per ISS tile with `cSet` 2..6, `frames:[k]`, explicit
     `channels`, and `position: {crop, warp}`.
   - Corrects the pheno sources' affine.
   - Uploads the result as `multi-source-registered.json`.
3. Large image was created for the new item, and the item was transcoded
   (`POST item/:id/tiles` with `fileId`, `force=true`, `localJob=true`).
4. `selectedLargeImageId` was set on the folder, and `meta.layers` and
   `meta.compatibility.channels` were updated on the collection
   (`PUT upenn_collection/:id/metadata`).
5. `check_server.py` fetches regions (`encoding=pickle`) and phase-correlates
   frame 1 (DAPI-WF) against frame 6 (DAPI c1): median 0.33 px, max 1.85 px.

The prototype objects below are local only.

| Object | Id |
|---|---|
| Dataset folder | `6ac8c9b830443fc58e97ff5a` |
| Registered item | `6ac8cbaa30443fc58e97ffca` |
| Collection | `6ac8c9da30443fc58e97ffac` |
| View | `6ac8c9da30443fc58e97ffad` |

### 4.2 Traps hit (each cost a round)

- **`"uniformSources": true`** makes metadata come from the first source
  only, so the merged item showed 2 channels. Remove it when sources differ.
- **Channel names merge.** Both datasets call their DAPI `DAPI-WF`, so the
  ISS DAPI merged into the pheno DAPI channel. Each moving source needs an
  explicit `channels` list with distinct names. The prototype used a
  `c1` suffix, as in `DAPI c1`.
- **`crop` is applied before the transform**, in source pixel coordinates.
- **Warp `dst` is multiplied by the affine.** Give `dst` directly in
  mosaic coordinates with no s11..s22 on that source.
- The running Girder image predated multi-file compositing. Rebuild it; a
  restart is not enough (`docker compose build girder && up -d girder`).
- Transcoding added `bandCount: 2` to the item metadata. This was harmless
  here, but it is worth checking.

### 4.3 Security note on cross-dataset references

large_image's Girder multi source resolves `girder://<itemId>` paths with
`ImageItem().load(force=True)`, which skips the access check. The prototype
avoided the issue by uploading the moving files into the reference folder.
A real feature that *references* another dataset's items must handle three
cases:

- Check that the requesting user can READ every referenced item when the
  document is written.
- Accept that anyone who can read the reference dataset will see the moving
  dataset's pixels through the combined item. Is that sharing-through
  acceptable, or should the combined item be copied or resampled instead?
  This is a product decision; see §6.
- Reject `girder://` paths in user-uploaded multi-source JSON that the
  uploader cannot read. This may already be a latent issue today, so check
  it independently of this feature.

## 5. Ingest: how the moving data gets in

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Two datasets + "register onto"** (recommended) | Each cycle is ingested and composited normally as its own dataset. Then "Register dataset B onto this dataset" is run. | Each dataset stays usable on its own (spot calling on ISS, segmentation on pheno). Registration can be redone without re-upload. Generalizes to N cycles and to non-OPS cases. | Cross-dataset references (§4.3). Two uploads. |
| B. Add as channels via API | Upload moving files into the reference folder and append sources, as the prototype did. | Simplest, no cross-dataset access issues. | Moving data is not a dataset of its own. Channel count grows with every cycle. Hard to redo. |

Option B is what the prototype did manually. Option A can reuse it
internally: the "apply" step produces exactly the prototype's combined
document, just with `girder://` paths instead of copied files.

## 6. Output options: what "registered" produces

1. **Combined multi-source item in the reference dataset** (the prototype).
   - Only a document is written; no pixel copy.
   - It needs a transcode for speed, and the transcode copies pixels anyway.
   - It shows up as another entry in the large-image dropdown, so it is
     non-destructive.
   - It adds channels to the configuration.
2. **Resampled moving dataset.** A worker writes B's pixels, warped into A's
   grid, as a new pyramidal TIFF.
   - It could live in its own dataset that shares A's geometry, or be added
     as an item in A.
   - Portable, and analysis workers see aligned pixels without understanding
     warps.
   - It costs storage, and resampling 10x up to 40x inflates it about 16×,
     so crop to the overlap region.
3. **Transform only, no pixels.** Store the model or landmarks on the pair,
   and use it to map *annotations* (for example ISS spot calls → phenotyping
   coordinates).
   - For OPS, the end product is "barcode per cell", which may be all Ophir
     really needs.
   - This is cheap and avoids every pixel and sharing question.
   - It still benefits from option 1 for visual QC.

**Recommendation:** build 1 and 3 together. Both are cheap and come from one
stored transform. Add 2 only if a downstream worker needs aligned pixels.

## 7. Architecture: Girder job vs worker

The work splits into two parts with different costs.

| Part | Cost | Where |
|---|---|---|
| **Measure + fit**: read both datasets, match thousands of patches, fit the model | Heavy I/O and CPU. Full well: 6,524 40x tiles plus 406 ISS tiles per cycle; raw ND2 is about 140 GB for pheno alone. Even from the pyramid it is minutes of CPU. | **Docker worker** (cpu queue) |
| **Apply**: validate access, write the combined multi-source document, kick transcode and caches, update the collection's layers | Cheap, and it is exactly the security-sensitive part | **Girder endpoint** |

Why the matching should not be a Girder local job:

- It shares memory and CPU with the API server.
  `STITCH_REFINEMENT_WORKER.md` §4.3 already established "do not run this
  class of work as a local job". Transcode is already the one heavy thing
  running in-process.
- The worker contract gives progress reporting, cancellation, and the
  standard tool UI for free (`runJobRequest`, `server/helpers/tasks.py`,
  `annotation_client` `sendProgress`).
- The Girder image does have numpy, scipy, skimage, `nd2` and large_image
  (no cv2), so a local job is *possible*. It would also be fine for a small
  subset like the prototype. It would not scale to a whole well with several
  cycles.

The worker should read **pyramid regions through the tile API**
(`item/:id/tiles/region` at the matching resolution), not raw files. That
makes it format-agnostic: anything Nimbus can display, it can register. It
also means the worker never sees more than the user can read, since it uses
the user's token. Use the moving dataset's native-resolution region and the
reference at the matching downsample. For 40x→10x that is pyramid level −2
plus a small resize.

A worker cannot write the cross-dataset multi-source document safely itself
(§4.3), so the endpoint has to exist anyway.

### Proposed endpoints

- `POST dataset/:id/registration` with body
  `{movingDatasetId, referenceChannel, movingChannel, model: "parametric"|"landmarks", options}`.
  - Requires WRITE on `:id` and READ on the moving dataset.
  - Validates channels and queues the worker. Returns the job.
- The worker uploads its result, a **registration record**, as JSON on the
  reference folder (or as its own item):
  - moving dataset id and source item ids
  - the transform: model coefficients plus per-source landmarks
  - QC: match count, NCC distribution, held-out residual percentiles
  - a version
- `POST dataset/:id/registration/:regId/apply` with `{output: "combined"}`.
  - Re-checks READ on the moving items.
  - Writes the combined multi-source document with `girder://` paths and
    distinct channel names (`<name> (<moving dataset name>)`).
  - Creates the large image, transcodes, schedules caches, and updates the
    collection's layers and compatibility channels.
- Annotation mapping, either `POST .../registration/:regId/map_annotations`
  or a nimbusimage helper: copy or transform annotations from B to A through
  the stored transform.

Splitting measure and apply also gives a **QC gate**. The user sees residual
stats, and possibly an overlay preview, before anything is written into their
dataset.

## 8. Implementation plan

**Phase 0: harden the algorithm (scripts only).**

- Run the prototype on the full well, not the 5×5 subset, and on cycles 2
  and 12. Each cycle is re-imaged at the same XY, and the remaining cycles
  were never indexed.
- Measure transcode time on a full-well combined item.
- Questions to answer:
  - Is the model stable across cycles? If it is, fit once per well and reuse
    it.
  - Can the 10x field be fitted once per scope and reused?
- Port the scripts from raw ND2 reads to tile-API region reads. This is the
  worker's I/O layer.

**Phase 1: worker (measure + fit).**

- Build a CPU worker image that takes `--datasetId --movingDatasetId --apiUrl
  --token` plus channel and model options.
- It does tile matching, then patch matching, then a robust fit (parametric
  by default).
- It writes the registration record and a QC overlay PNG.
- Label it `isGPUWorker=false`.

**Phase 2: Girder endpoints + combined output.**

- Add `registration` and `apply` on the dataset resource, with the model
  logic in `server/models/` or `server/helpers/`.
- Include the access checks from §4.3 and pytest coverage for them (READ
  required on moving items; reject an unreadable `girder://` path).
- Reuse the existing compositing and transcode path.

**Phase 3: frontend.**

- Add a "Register another dataset onto this one" entry in the dataset
  view. It needs:
  - a dataset picker
  - channel pickers
  - job progress
  - a QC summary with accept/reject that calls `apply`
- The combined item appears in the existing large-image dropdown.

**Phase 4: annotation mapping (option 3).**

- Map annotations from B to A through the stored transform.
- For OPS: call spots on the ISS dataset, map them into phenotyping
  coordinates, and assign them to segmented cells, giving barcode per cell.

**Side-fix (independent).** Feed the measured 40x scale and rotation
correction back into compositing. This could be a per-dataset "objective
calibration" override, or the stitch-refinement worker could fix it. It
removes the about 3 µm seams in the phenotyping mosaic regardless of
registration.

### Open questions

- Should registration be cycle-to-cycle (each ISS cycle onto cycle 1, then
  cycle 1 onto pheno), or should every cycle go straight onto pheno?
  Cycle-to-cycle is same-objective and easier to match, but errors compose.
- Is sharing-through (§4.3) acceptable, or must the combined output be
  copied?
- Is a polynomial the right default model for generic users? The
  alternatives are TPS on a regular grid of matched landmarks, or a B-spline
  field.
- How should regions without nuclei be handled? Currently they rely on the
  model; in landmark mode they would be unconstrained.

## 9. Reproduce

```bash
cd /Users/arjunraj/code/Ophir-OPS-DM1ExampleWell/registration_cycle1
P=/Users/arjunraj/code/NimbusImage/.venv/bin/python
$P measure_shifts.py 1 shifts_c1_all16.csv all   # coarse, 14 procs
$P patches.py 1                                  # dense → patches_c1.csv
$P fitjoint.py                                   # → joint_model.npy, held-out stats
$P validate.py                                   # nucleus-hit rates
$P make_pheno.py                                 # Nimbus dataset (needs tmp/local_api_key.txt)
$P add_iss2.py <datasetFolderId>                 # registered multi-source item
$P check_server.py <itemId>                      # served alignment check
```

Run the nimbusimage scripts from outside the NimbusImage repo root, because
the in-repo package directory shadows the installed one.
