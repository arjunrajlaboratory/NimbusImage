# Compositing tiles from many single-position ND2 files

> **Status:** spec, not yet implemented. It's written so an agent can pick it
> up cold. The motivating case is optical pooled screening (OPS) data from the
> Shalem lab, where every field of view is its own `.nd2` file.

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

- `src/views/dataset/MultiSourceConfiguration.vue`: the gate, the per-source
  coordinates, and the default XY/composite UX.
- `src/views/dataset/MultiSourceConfiguration.test.ts`: `canDoCompositing`
  cases for N single-position files and for mismatched sizes.
- `src/views/dataset/MultiSourceConfigParity.test.ts` plus a new golden
  `parity_fixtures/nd2_compositing_multifile.json`, for example 4
  single-position files in a 2×2 grid with a −I camera matrix and 2 channels.
- `server/helpers/multi_source.py`: the mirror of the above.
- `server/api/dataset.py`: update the `enableCompositing` docstring ("a
  single multi-position ND2" → "ND2 files with stage positions").
- `test/test_multi_source_parity.py`: run the new fixture, plus a test that
  `compositing` is True for the multi-file case.
- `devops/girder/plugins/girder-claude-chat/girder_claude_chat/help/file-formats-and-upload.md`:
  mention that a folder of tiles composites.
- Optionally `src/utils/parsing.ts` + `helpers/filename_parsing.py` for
  change B.

## Test data

There's a local subset: 144 phenotyping tiles forming a 12×12 grid, about
4.6 mm square and 2.9 GB, with 2 channels at 2304² uint16 each. Ask Arjun for
access; it isn't in the repo. **Expected result:** one XY position, a
27,648 × 27,648 px mosaic, and no visible gaps or overlaps at the seams
beyond a ~1 µm stage error.
