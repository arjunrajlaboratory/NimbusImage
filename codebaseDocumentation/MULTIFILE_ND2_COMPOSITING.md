# Compositing tiles from many single-position ND2 files

> **Status:** A (composite from per-file stage positions), C (sanity
> checks) and D (scale) are implemented; B (guessing XY from stage
> positions) is still open. Code: `src/utils/ND2Compositing.ts` ↔
> `helpers/multi_source.py` (`_can_composite`, `_compositing_positions`,
> `compositing_check`, `composite_transcode_default`,
> `slim_internal_metadata`), the `GET /dataset/:id/source_metadata` batch
> endpoint, and goldens `parity_fixtures/nd2_compositing_{multifile,
> duplicate,sparse}.json`. The motivating case is optical pooled screening
> (OPS) data from the Shalem lab, where every field of view is its own `.nd2`
> file.

## As built

Where the implementation differs from, or settles, the proposal below:

- **Which stage position a frame uses.** Entry
  `floor(frameIdx / channelsInFile)` of its own file's `nd2_frame_metadata`,
  where `channelsInFile` is that file's `IndexRange.IndexC` (1 if absent),
  not `IndexXY` and not the dataset's channel list. ND2 records one entry per
  camera frame (P×Z×T) and large_image lists the file's channels fastest
  within it, so on real files this is the old `floor(sourceIdx / channels)`
  mapping (the 49-position × 7 Z × 5 C Asmus file is byte-identical), and it
  stays right for files holding one channel each and for files large_image
  truncates. The synthetic `nd2_compositing_{identity,flipped}` fixtures had
  one entry per *frame* (8 for 4 positions), which no ND2 records and which
  put two XY positions on one spot; their inputs now carry one entry per
  position, and their expected layouts are proper 2×2 grids.
- **The gate** also requires: a finite stage position on every entry, a
  positive `sizeX`/`sizeY`/`mm_x`/`mm_y`, an entry for every camera frame the
  file's frames use, and the same camera orientation (within 0.01) for every
  file, because the mosaic's extent is computed from the first file's. A
  channel without a `volume` is the identity. These matter because the check
  below runs whenever compositing is *possible*: metadata it cannot use must
  make compositing unavailable, never fail an import that did not ask for it.
- **Duplicates (C).** Two stage entries with *different* XY values closer
  than 10% of a tile in both x and y refuse compositing; entries sharing an XY
  value there (a Z stack, or channels split across files) count as one tile.
  To stay linear, each tolerance-sized grid cell keeps one bounding box per
  XY value covering every point merged there, so a long stack is one entry
  and a duplicate near *any* merged point is still caught (not only one
  near a single representative point, which a chain of merges could evade).
  The check walks every stage entry the sources use, not one per XY value, so
  files whose XY values repeat (XY from frame order) are all checked. A ticked
  Composite unticks itself when a duplicate appears. The UI disables Composite with the reason; the
  API reports `compositingCheck.error`, uses it as the dry run's
  `validationError`, and a real run that asked for compositing returns 400
  rather than quietly configuring every tile as its own position (which
  could not be redone: a second call is a 409).
- **Sparse layouts (C).** Tiles covering less than 25% of the mosaic's
  bounding box (one position per XY value) produce `compositingCheck.warning`
  and a warning under the assignments; compositing still happens. On real
  data, the four corner tiles of the 5×5 block cover 16%.
- **Overlap (C).** Unchanged: later sources draw on top.
- **Metadata fetching (D).** The configuration screen fetches
  `GET /dataset/:id/source_metadata?itemIds=[…]` for 50 items at a time
  (endpoint cap 100), four requests in flight, instead of `getTiles` +
  `getTilesInternalMetadata` per item. Internal metadata is slimmed to what
  the configuration reads (`nd2_experiment`, stage positions, the camera
  matrix): 6.7 KB → 271 B per phenotyping tile. Items that are not large
  images yet come back as `{itemId, error}` and only those are retried.
  Items that are not large images yet come back with `notReady: true` (a
  structured flag, checked on the item before opening it, not a message
  match) and only those are retried. A failed request is retried on a
  network error or 5xx and stops at once on a 4xx, naming its batch. `createMultiSource` slims each item's internal metadata as it
  reads it.
- **Transcode (D).** On by default when compositing more than 16 *tiles*
  (distinct stage positions, `compositingCheck.tileCount`), in both the UI
  and the API (`transcodeDefault`). The spec said files; counting tiles
  also covers one multi-position ND2, whose zoomed-out views cost the same
  per source — so composited multi-position files now transcode by default
  too. In the UI `transcode` is a
  computed: an explicit choice (the checkbox, or a saved strategy) wins,
  otherwise it follows the default. Saved upload strategies also record the
  Composite choice, so a batch of tile folders composites every folder
  rather than transcoding uncomposited ones.
- **XY labels.** A composite has one XY position, so `dimensionLabels.xy`
  is null rather than one label per tile (which named the whole mosaic after
  its first tile).
- **Measured scale (D).** large_image multi source, N single-tile ND2 files
  (2304², 2 channels; distinct paths), in the Girder container on a laptop:

  | Tiles | Sources | Mosaic | Open + metadata | 1024² overview | Full-res tile | Peak RSS |
  | --- | --- | --- | --- | --- | --- | --- |
  | 100 | 200 | 23k² | 1.2 s | 1.9 s | 38 ms | 0.8 GB |
  | 784 | 1,568 | 65k² | 1.3 s | 6.4 s | 25 ms | 0.45 GB |
  | 2,500 | 5,000 | 115k² | 2.0 s | 28.6 s | 23 ms | 0.47 GB |
  | 6,400 | 12,800 | 184k² | 3.8 s | 77.7 s | 27 ms | 0.52 GB |

  Zoomed-in viewing stays fast and memory flat; zoomed-out views of an
  untranscoded composite grow linearly (~12 ms per tile). Transcoding cost
  ~1.3 s per tile (100 tiles: 127 s, 2.1 GB TIFF), so a full well is a
  multi-hour, ~140 GB one-time job, against 78 s for every zoomed-out view
  without it.

## Goal

Stitch a folder of single-position ND2 files into one image, placing each
file by the stage position recorded in its own metadata. Today the
**Composite** checkbox only works when a single multi-position ND2 file holds
all the positions.

## Symptom

We uploaded 144 phenotyping tiles from an OPS well, one 40x field per file
with 2 channels (CTG FISH + DAPI), named like
`Well1_Point1_2753_ChannelCTGFISH_TYE665,DAPI-WF_Seq2753.nd2`. The dataset
was created, but as separate positions: the **Composite** checkbox never
appeared on the XY row.

## How compositing works today

Compositing has two implementations, and they must stay in lockstep:

| Layer | Where |
| --- | --- |
| Frontend | `src/views/dataset/MultiSourceConfiguration.vue`: `canDoCompositing`, `shouldDoCompositing`, and the `if (shouldDoCompositing.value)` branch of the JSON generator |
| Backend (pure-Python port) | `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/helpers/multi_source.py`: `generate_multi_source_config()` and `_compositing_positions()` |
| API | `server/api/dataset.py`: the `enableCompositing` body option. Its docstring says compositing "requires a single source with ND2 frame metadata". When compositing applies, `xyCount` is forced to 1. |
| Parity tests | `test/test_multi_source_parity.py` + `test/parity_fixtures/nd2_compositing_{identity,flipped}.json`. The goldens are generated from the real component by `src/views/dataset/MultiSourceConfigParity.test.ts`. |

The algorithm is the same in both layers:

1. **Gate:**
   ```ts
   canDoCompositing =
     tilesInternalMetadata.length === 1 &&
     tilesInternalMetadata[0].nd2_frame_metadata &&
     tilesMetadata.length === 1
   ```
2. **Sources:** one per (item, frame), each with `frames: [frameIdx]` and
   `xySet/zSet/tSet/cSet` from the assignments.
3. **Coordinates:** one per entry of
   `tilesInternalMetadata[0].nd2_frame_metadata`, as
   `stagePositionUm / (mm_x * 1000)`. The rotation and flip come from
   `nd2.channels[...].volume.cameraTransformationMatrix`; a matrix within
   0.01 of −I is snapped to exactly −I.
4. The coordinates are normalized to a min/max box built from the transformed
   tile corners: `x = X − minX` and `y = maxY − Y`, so y is flipped.
5. **Attaching positions:**
   `source.position = finalCoordinates[floor(sourceIdx / channels.length)]`,
   and every `xySet = 0`, so the result has one XY position.

## Why a folder of single-position files fails

**1. The gate requires exactly one file.** Steps 1 and 3 read only item 0.
This is the blocker. The data needed to composite is already there: large_image
returns `nd2_frame_metadata` for every ND2 file, single-position files
included. Verified on a tile from this dataset:

```text
getInternalMetadata()['nd2_frame_metadata'] ==
  [{'position': {'stagePositionUm': [41444.4, -22301.6, 2948.16]}, ...}]   # one entry
getInternalMetadata()['nd2_experiment'] is None                             # no XYPosLoop
getMetadata(): sizeX = sizeY = 2304, mm_x = mm_y = 1.664e-4, 2 frames (= channels)
cameraTransformationMatrix ≈ (-1, 0.0012, -0.0012, -1)                     # snaps to -I
```

**2. Attaching positions by `floor(sourceIdx / channels.length)` assumes one
position per `channels.length` sources.** That holds for one multi-position
file with C varying fastest. It also happens to hold for N single-position
files that each have C frames. It breaks as soon as files have Z or T frames,
or their frame counts differ. Positions should be keyed explicitly by
(item, XY frame), not inferred from the source's place in the list.

**3. (Not a blocker) The filename parser guesses the tile index as Channel,
not XY.**
`collect_filename_metadata()` on these 144 names returns a single variable,
`{guess: 'C', values: ['2753', …]}`. The spanning token is a bare number,
`2753`. Its common substring hits no trigger, so `_categorize_substring` falls
back to `"chan"`. `Point`, `Seq`, `tile`, `field`, `fov` and `site` aren't in
the `xy` trigger list, and the parser reads the bare-number column before the
`Seq2753` column anyway.

This is only a wrong default. In Advanced Import, the user can drag the
filename variable from C to XY in a couple of seconds, and nobody has to
rename files. Expect real tile exports to look like this: Nikon NIS writes
`…_Point1_0000_…_Seq0000.nd2`, and labs won't rename thousands of files. The
real blocker is #1: even after the variable is moved to XY, the Composite
checkbox never appears, because the gate looks at the number of files rather
than at the assignment.

**4. (Minor) Non-image files in the folder aren't filtered.**
`initializeImplementation()` takes every item in the folder. Our first upload
folder also held two CSVs, which have no tiles. They now live outside the
folder, but the configuration screen should skip or warn on items that
large_image can't open.

## Proposed change

### A. Composite from per-file stage positions (core fix)

In both `MultiSourceConfiguration.vue` and `multi_source.py`, replace the gate
and position source with:

```text
canDoCompositing =
  every item has nd2_frame_metadata with a stagePositionUm
  and every item has the same sizeX, sizeY, mm_x, mm_y
  and the XY assignment has size > 1   # i.e. there is something to lay out
```

**The gate must react to the user's assignments, not to the parser's guess.**
`canDoCompositing` has to recompute when the user reassigns a filename
variable from C to XY, so the checkbox appears right after that drag. With
that, the manual path works end to end with no filename changes:
1. Upload the folder.
2. Move the tile-index variable to XY.
3. Tick **Composite**.

The same holds for the API: an `assignments` override that puts the filename
variable on XY, together with `enableCompositing: true`, must composite.

Then build positions per source rather than per frame of item 0:

```text
for each source (itemIdx, frameIdx):
    meta   = internal_metadata[itemIdx]
    seqIdx = the ND2 sequence index for frameIdx. Use the frame's IndexXY
             (from tilesMetadata[itemIdx].frames[frameIdx]) for a
             multi-position file, and 0 when the file has a single position
             (len(meta.nd2_frame_metadata) == 1).
    stage  = meta.nd2_frame_metadata[seqIdx].position.stagePositionUm
    matrix = this item's camera matrix   # per item; don't reuse item 0's
    → raw coordinate (x, y, s11..s22)
```

- **Normalization (step 4):** keep it as-is, running over all raw
  coordinates.
- **Attaching positions:** use the source's own coordinate instead of
  `floor(sourceIdx / channels.length)`. Keep forcing `xySet = 0`.
- **Backward compatibility:** the single multi-position file is the
  `len(items) == 1` case of the same code and must produce byte-identical
  output. The existing `nd2_compositing_identity` and
  `nd2_compositing_flipped` goldens must still pass unchanged.

**Orientation check.** In this dataset, image column runs opposite to stage x,
image row runs with stage y, and the camera matrix is −I. With the existing
math, a pixel at tile-local (r, c) lands at mosaic `x = (X − Xmin)/px`,
`y = (Ymax − Y)/px`, where X and Y are that pixel's true stage coordinates.
So every pixel is placed consistently, and the mosaic as a whole comes out
rotated 180° relative to the camera's own view. That's fine, but annotation
imports that use stage coordinates have to use the same convention.

The geometry was confirmed independently by template-matching 40x tiles
against 10x tiles of the same well. The scripts are in the Raj lab vault's
OPS project, not in this repo.

### B. Guess XY when files carry distinct stage positions (nice to have)

Change B only saves the manual step from A. It isn't needed for correctness,
and A should ship first. When every file has exactly one `nd2_frame_metadata` entry and the stage
positions are distinct, the variable that distinguishes the files is almost
certainly XY. Two options:

- **Narrow:** add `point`, `seq`, `tile`, `field`, `fov` and `site` to the
  `xy` triggers. This doesn't fix the bare-number column on its own.
- **Better:** an ND2-aware override in `build_dimensions` and its TS
  counterpart. If the filename variable's size equals the number of distinct
  stage positions across items, guess `XY`, and default the Composite
  checkbox to on.

Either way, both layers and a parsing fixture need updating. The filename
parser is ported too (`helpers/filename_parsing.py` ↔ `src/utils/parsing.ts`).

### C. Sanity checks before compositing

- **Sparse layouts:** warn when the mosaic's bounding box is much larger than
  the sum of tile areas, for example two wells far apart on a plate. Compositing
  those wastes a huge empty canvas, and they should stay separate XY
  positions.
- **Duplicate positions:** if two items share a stage position (for example,
  the same field imaged twice), refuse to composite with a clear message.
- **Overlap:** when tiles overlap, large_image's multi source just draws later
  sources on top. Refining the stitch from overlapping image content is out of
  scope. This dataset has zero overlap: the tile step equals the field of
  view, 383.4 µm at 0.1664 µm/px.

### D. Scale (the full well is 6,524 files, ~140 GB)

- The frontend fetches `getTiles` + `getTilesInternalMetadata` per item at
  `pLimit(4)`. That's about 13k requests for a full well. Internal metadata
  for ND2 also includes `nd2_text`, `nd2_custom` and similar fields that
  compositing doesn't need.
  - Either move initialization for large folders onto the server path
    (`compute_configuration` already runs server-side for the API),
  - or add a slim endpoint that returns only `nd2_frame_metadata` positions
    and the camera matrix per item.
- `transcodeDefault` is off when every file is `.nd2`. For a composite of
  hundreds or thousands of sources, untranscoded reads open many ND2 files per
  viewport tile. **Default transcode on when compositing more than ~16
  files**, or at least warn.
- Test the large_image multi source with thousands of positioned sources for
  memory and time before promising full-well support. A 7×7 ISS-tile block
  (784 files, ~17 GB) is a sensible middle test.

## Files to touch

The logic change is small. It lives in `multi_source.py` and the Vue
component, and everything else is wording and tests. Several places
describe compositing as "a single multi-position ND2" or "a single source with
ND2 frame metadata". All of them need the new wording, or agents and users
will keep being told that a folder of tiles can't composite.

### Frontend

- `src/views/dataset/MultiSourceConfiguration.vue`:
  - the `canDoCompositing` gate, computed from the current XY assignment so
    the checkbox appears as soon as the user moves a variable to XY
  - the coordinates for each source
  - attaching positions to sources explicitly
  - (change B) defaulting XY and the Composite checkbox
- `src/views/dataset/MultiSourceConfiguration.test.ts`: `canDoCompositing`
  cases for:
  - N single-position files with XY assigned (true)
  - the same files with the variable still on C (false)
  - mismatched `sizeX`/`mm_x` (false)

### Backend: the pure-Python port, which the endpoint uses

- `server/helpers/multi_source.py`:
  - `generate_multi_source_config()`: the `can_do_compositing` gate, and
    attaching positions per source instead of `source_idx / len(channels)`
  - `_compositing_positions()`: take a list of (item, sequence-index) pairs,
    read each item's own `nd2_frame_metadata` and camera matrix, and keep the
    normalization exactly as it is
- `test/parity_fixtures/nd2_compositing_multifile.json`: a new golden, for
  example 4 single-position files in a 2×2 grid with a −I camera matrix and 2
  channels. It is generated by the frontend harness
  (`src/views/dataset/MultiSourceConfigParity.test.ts`), not written by hand.
  `nd2_compositing_identity.json` and `nd2_compositing_flipped.json` must
  still pass unchanged.
- `test/test_multi_source_parity.py`: run the new fixture, and extend
  `TestCompositingCollapsesXY` with a multi-file case where `compositing` is
  True and XY collapses to one position.
- (change B) `helpers/filename_parsing.py` ↔ `src/utils/parsing.ts`, plus a
  `parsing_*` fixture.

### Backend: the REST endpoint

- `server/api/dataset.py`, `createMultiSource`:
  - **No logic change is needed.** It already calls `getInternalMetadata()`
    for every item, so per-item stage positions reach `compute_configuration()`.
  - `_createDefaultCollection` already sets `xyCount = 1` whenever
    `result["compositing"]` is True.
  - Update the endpoint description. Both the `enableCompositing` option ("lay
    a single multi-position ND2 out by stage coordinates") and the `compositing`
    response field ("requires a single source with ND2 frame metadata") should
    read "ND2 files with stage positions (one multi-position file, or one file
    per tile), with XY assigned".
- `test/test_dataset_multi_source.py`: an endpoint test that uploads several
  single-position ND2 items, or mocks their metadata, and posts
  `enableCompositing: true` with an XY assignment override. Assert that
  `compositing` is True, that every source has a `position` and
  `xySet == 0`, and that the created collection has an XY count of 1.
- **Scale:** the endpoint fetches internal metadata for every item in turn,
  within a single request. That's fine for hundreds of files. For a full well
  (6,524 files), see section D.

### Python client (`nimbusimage/`)

The contract doesn't change: the client posts `enableCompositing` and reads
back `compositing`. No code changes are needed, but the documentation and
tests are out of date:
- `nimbusimage/nimbusimage/dataset.py`, the `configure()` docstring for
  `enable_compositing`: it says "Lay out a single multi-position ND2 … Only
  takes effect for a single source with ND2 frame metadata." Replace this with
  the new rule, and show the tile-folder recipe: a dry run, then an `assignments`
  override that moves the tile-index variable to `XY`, then
  `enable_compositing=True`.
- `nimbusimage/nimbusimage/models.py`, the `compositing` field comment on
  `MultiSourceConfiguration`, which carries the same "single source" wording.
- `nimbusimage/tests/test_dataset.py`: `test_compositing_is_reported` mocks the
  response, so it still passes. Add a case that checks `configure()` sends both
  the `assignments` override and `enableCompositing: true` in the same body.

### Agent skills for Claude Code and Codex, and in-app help

Skills ship in three trees, and the copies have to be kept in sync:
- `plugins/nimbusimage/skills/`: the installable Claude Code plugin
  (`/nimbus-skills:*`)
- `.claude/skills/`: Claude Code skills for working in this repo
- `.agents/skills/`: the Codex copies of both (`$nimbusimage:*`)

Update the same wording in each copy:

| Skill file | Claude Code | Codex | What to change |
| --- | --- | --- | --- |
| nimbusimage client skill: the `enable_compositing` row in the `configure()` options table (line ~205), plus the `configure()` walkthrough above it | `plugins/nimbusimage/skills/nimbusimage/SKILL.md` | `.agents/skills/nimbusimage/SKILL.md` | Replace "Only applies to a single source with ND2 frame metadata" with the new rule. Add the tile-folder recipe: a dry run, then an `assignments` override that puts the tile-index variable on `XY`, then `enable_compositing=True`, then check `result.compositing`. |
| Local-ops endpoint reference: the `multi_source` section (lines ~136 and ~176) | `.claude/skills/nimbus-local-ops/references/api-endpoints.md` | `.agents/skills/nimbus-local-ops/references/api-endpoints.md` | The `compositing` description ("needs a single source with ND2 frame metadata"). Add a curl example with an XY assignment override plus `enableCompositing: true`. |
| Branch-review documentation index | `.claude/skills/branch-review/references/feature-documentation-index.md` | `.agents/skills/branch-review/references/feature-documentation-index.md` | Add a row so reviews load this spec. Under the feature-area table: "Dataset configuration, multi-source, compositing" → `codebaseDocumentation/MULTIFILE_ND2_COMPOSITING.md`. Under the file-pattern table: `MultiSourceConfiguration.vue`, `helpers/multi_source.py`, `helpers/filename_parsing.py`, `utils/parsing.ts`, `api/dataset.py` `multi_source`. |

The `images`, `analyze`, `annotations` and `workers` skills and their
`references/gotchas.md` mention "composite", but they mean an RGB blend of
channels (`get_composite`), not tile stitching. Leave them alone.

In-app help and history:
- `devops/girder/plugins/girder-claude-chat/girder_claude_chat/help/file-formats-and-upload.md`:
  say that a folder of tiles composites once the tile variable is on XY.
  `help/managing-files.md` already describes compositing generically and is
  fine.
- `codebaseDocumentation/DATASET_MULTI_SOURCE_ENDPOINT-REVIEW.md` is a
  historical review, so leave it as it is.

## Test data

There's a local subset: 144 phenotyping tiles forming a 12×12 grid, about
4.6 mm square and 2.9 GB, with 2 channels at 2304² uint16 each. Ask Arjun for
access; it isn't in the repo. **Expected result:** one XY position, a
27,648 × 27,648 px mosaic, and no visible gaps or overlaps at the seams
beyond a ~1 µm stage error.

## Regression checklist

Change one of these, re-check the rest. Every rule exists in both
`src/utils/ND2Compositing.ts` and `helpers/multi_source.py`; the parity
fixtures (`nd2_compositing_*`) are what keep the two in lockstep, so
regenerate them from the frontend (`UPDATE_PARITY_GOLDENS=1`) rather than by
hand.

**Gate and layout**
- A folder of single-position files composites only once XY tells the files
  apart, and with the same tile geometry —
  *"returns true for single-position files once XY is assigned"*,
  *"returns false for several files until XY distinguishes them"*,
  *"returns false for several files when the tile geometry differs"*.
- The API composites the same folder from an `assignments` override —
  *"testFolderOfSingleTileND2FilesComposites"*,
  *"test_folder_does_not_composite_until_xy_is_assigned"*.
- A frame's stage position comes from its own file, by that file's channel
  count — *"uses the file's own channel count, not the dataset's"*,
  *"maps camera frames of a multi-position file (C fastest)"*,
  *"keeps channel pairs together in a truncated file"*,
  *"test_truncated_file_keeps_channel_pairs_together"*. A real
  multi-position file must stay byte-identical: re-run the Asmus comparison
  (old vs new `multi_source.py` on its real metadata) after touching this.

- Metadata compositing cannot use makes it unavailable instead of failing
  the import — *"test_missing_pixel_size_does_not_raise"*,
  *"refuses frames past the file's stage entries"*,
  *"refuses files whose camera orientations differ"*,
  *"treats a channel without a volume as the identity"*, and no spread into
  `Math.min` — *"handles more frames than Math.min can take as arguments"*,
  *"treats a malformed camera matrix as the identity"*,
  *"test_malformed_camera_matrix_is_the_identity"*,
  *"test_non_object_frame_entry_does_not_raise"*,
  *"returns false while the metadata belongs to other items"*.
- The duplicate check stays linear on long Z/T stacks, and an error
  suppresses the coverage warning —
  *"checks long stacks at one position in linear time"*,
  *"test_long_stacks_at_one_position_are_checked_quickly"*,
  *"reports no coverage warning alongside a duplicate"*,
  *"test_duplicate_reports_no_sparse_warning"*.
- A composite carries no per-tile XY labels —
  *"test_composited_xy_has_no_per_tile_labels"*.

**Sanity checks**
- Two XY positions at one stage position refuse compositing, in the UI and as
  a 400 on a real API run that asked for it —
  *"refuses compositing when two files share a stage position"*,
  *"testDuplicateStagePositionRefusesRequestedCompositing"*.
- Heavy but intended overlap is not a duplicate, nor are entries sharing an
  XY value; files with repeating XY values are all checked —
  *"does not call heavily overlapping neighbours duplicates"*,
  *"treats stage entries sharing an XY value as one tile"*,
  *"checks every file when XY repeats across files"*,
  *"catches a duplicate next to any merged point, not just the first"*,
  *"test_duplicate_next_to_any_merged_point_is_caught"*,
  *"unticks Composite when a reassignment creates a duplicate"*.
- A sparse layout warns but still composites —
  *"warns about, but still composites, far-apart tiles"*.

**Scale**
- Metadata loads in batches, retrying only items that are not large images
  yet, and a failed request stops at once —
  *"loads source metadata in batches of at most 50 items"*,
  *"retries only the items that are not large images yet"*,
  *"stops at once when a metadata request is refused"*,
  *"retries a metadata request that fails transiently"*,
  *"asks about the folder the items came from when the id changes mid-load"*,
  *"testSourceMetadataIsBatchedAndSlim"*.
- Slimming internal metadata never changes a configuration —
  *"test_slim_internal_metadata_changes_nothing"*.
- Compositing more than 16 tiles transcodes by default, in both layers,
  counting a multi-position file's positions —
  *"turns transcode on when compositing more than 16 tiles"*,
  *"leaves transcode alone when compositing 16 tiles"*,
  *"counts a multi-position file's positions toward transcode"*,
  *"counts a multi-position file's positions as tiles"*,
  *"test_multi_position_file_counts_tiles_for_transcode"*,
  *"keeps an explicitly chosen transcode when compositing changes"*,
  *"saves and restores the Composite choice with the strategy"*,
  *"testCompositingManyTilesTranscodesByDefault"*.
