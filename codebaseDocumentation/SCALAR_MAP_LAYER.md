# Scalar Map Layer

> **Status:** Implemented (branch `feat/scalar-map-layer`).
> **Spec:** `HOTSPOT_REGIONS_WORKER.md` §8 (Part B). The map file and its
> metadata are defined in §5.8 of that spec; this doc does not repeat them.

## Overview

The Hotspot Regions worker smooths a per-cell property (or plain cell density)
over the tissue and can save the smoothed map next to the dataset. The scalar
map layer draws a saved map over the image as a heat map, with a live
threshold preview, so a user can pick the radius and threshold by eye before
running the worker again to create regions.

A saved map is a Girder **item directly in the dataset folder** whose metadata
key `nimbusScalarMap` describes it (version 1, §5.8) and which holds **exactly
one file**, stored in an assetstore (not a Girder link file): an `.npz` with one float32 array per location (`xy{XY}_z{Z}_t{Time}`).
There is no model and no collection: the items are the records. The worker
writes them; the layer only reads them (and can delete one).

The resource lives in the core annotation plugin, so it is available on every
deployment. Unlike the spatial plugin's routes, the client does not check
`system/loaded_plugins` before calling it.

## User guide

- The **Map Layers** app-bar button (`mdi-gradient`) appears on a dataset with
  at least one saved map. It is also offered while a dataset's first list
  loads and after listing failed, so a network blip does not hide the
  feature; without maps it is not offered (nor is its command-palette entry),
  and a later re-list of such a dataset does not flash it.
- **Show objects**, at the top, is the viewer's own object switch (hotkey A,
  `store.drawAnnotations`): cells are drawn above the maps, as vectors or as
  the overview raster, and this hides both. It is a second control for the
  same state as the Object display settings, not a setting of its own.
- Each map shows its name and statistic · property · radius. The checkbox
  shows it in the viewer. While shown, the card offers opacity, colormap
  (viridis, magma, inferno, gray), a color bar, the display range (with
  Reset), and a threshold preview.
- **Order.** Maps shown together stack in the list's order: the first map is
  drawn on top, the last at the bottom, whichever was turned on last. With
  more than one map, each card has a drag handle (`mdi-drag-vertical`, left
  of its checkbox) and a caption says "Drag to reorder. The top map is drawn
  on top."; dragging a card by its handle reorders the list and the stacking
  follows at once. The order lasts for the session, like the display
  settings: it is not saved, survives a re-list of the same dataset, and
  starts in the server's order on another dataset.
- **Threshold preview.** Pick a side (Above / Below) and set the cutoff either
  as a share of tissue ("% of tissue") or as a value. The readout gives both,
  e.g. "Value ≥ 160 µm² · ≈ top 20% of tissue (all positions)"; the share is
  an estimate over every position of the map. Pixels on the other side are
  dimmed. Below it are the two forms the worker accepts (`Threshold type` +
  `Threshold`), ready to copy.
- **Refresh** (header) lists the maps again and requests again any tile
  that failed to load (a map with such tiles says so on its card; hiding and
  showing the map also retries them). The list also refreshes on its own
  whenever a dataset is opened, when the palette is shown, and shortly after
  any job on the dataset ends, whatever its outcome.
- **Delete** (with confirmation) is hidden for logged-out sessions and share
  links; the server enforces WRITE and its message is shown on refusal.
- A map with no array for the current XY/Z/Time shows a note and draws
  nothing.

## Backend

Files: `server/api/scalarMap.py` (routes), `server/helpers/scalarMap.py`
(validation, loading, cache, rendering, all raising `ValueError`), tests in
`test/test_scalar_map.py`, all under
`devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/`.

### Routes

| Route | Access | Returns |
|---|---|---|
| `GET scalar_map?datasetId=` | READ on the folder | `[{itemId, updated, revision, meta}]`, oldest first. One `Item().find` on the folder plus one batched `File().find` (`$in`). Items whose metadata does not validate, or that do not hold exactly one assetstore-backed file (a Girder link file, `assetstoreId: null` plus `linkUrl`, cannot be opened), are skipped. The file query projects `assetstoreId` so the list and `_mapFile` share one predicate, `isScalarMapFileSet`. |
| `GET scalar_map/{itemId}/tiles/{z}/{x}/{y}` | READ, cookie auth (GeoJS loads tiles through `<img>`); share links send `token=` | PNG. Params: `location`, `sizeX`, `sizeY`, `maxLevel`, `tileSize` (256/512/1024), `colormap`, `min`, `max`, `threshold?`, `thresholdSide?`. |
| `DELETE scalar_map/{itemId}` | WRITE | Removes the item and drops its cached arrays. 400 for an item the list would skip: invalid metadata, or not exactly one stored file (the same check and message as the tile route, `_mapFile`). |

`revision` (`scalarMapRevision`) is
`<file id>-<size>-<file created, %Y%m%d%H%M%S%f>[-<sha512 prefix>]-<metadata digest>`.
The first part is the **file identity** (`scalarMapFileIdentity`): a re-upload
gets a new file id, and Girder's in-place content replacement
(`Upload.finalizeUpload` with a `fileId`) rewrites `created` and `size`, so a
same-size replacement on an assetstore without checksums still changes it.
The metadata digest is a short sha1 of the whole validated `nimbusScalarMap`
object as canonical JSON (sorted keys), so any metadata-only edit changes it:
the geometry that places the array on the image, and also `locations`,
`valueRange` and `percentiles`, which the client derives its layers, range
and cutoff from. `revision` starts the tile ETag and goes in the
client's tile URLs; the array cache is keyed by the file identity alone.

### Metadata validation

`validateScalarMapMeta` checks structure with a JSON schema (fastjsonschema)
and the rest by hand: version 1, `gridSpacingPx > 0`, finite numbers,
`valueRange` with `min <= max`, **`percentiles` required, exactly 101 finite
non-decreasing values**, at least one location with a `xy\d+_z\d+_t\d+` key,
unique keys, and `rows * cols <= MAX_SCALAR_MAP_CELLS` (32M cells, 128 MiB as
float32). The descriptive fields (name, property, statistic, units, ...) are
not constrained.

### Reading the file

- **Strict ZIP, one explicit member.** The bytes are opened only as a ZIP; a
  bare `.npy` is refused without being decoded. The member `<location>.npy` is
  the one both checked (header: 2-D float16 or float32, the metadata's
  shape, within the cell cap) and decoded, and only as many bytes as the
  checked header allows are read. **float64 (and anything wider) is
  refused** with a 400 that says to save float32, not rounded: the cache
  holds float32, so a float64 cell of 0.7 became 0.699999988 and a
  threshold of 0.7 dimmed it.
  Thresholds are compared against the float32 values (as doubles, exactly).
  **Cells must be finite or NaN.** A member holding `+-inf` is refused (one
  `np.isinf` pass over the raw buffer, before the float32 copy and before
  caching): bilinear sampling multiplies a zero weight by its neighbors, and
  `0 * inf` is NaN, so an accepted inf cell blanked the pixels next to it.
  The worker never writes infinities.
  Fortran-order arrays are supported. Only `ZIP_STORED` and
  `ZIP_DEFLATED` members are read (what `np.savez` and
  `np.savez_compressed` write), checked before the member is opened: bzip2
  and LZMA decompress a chunk without an output bound, before the shape and
  cell caps apply. An encrypted member (zipfile's `RuntimeError`) is a 400
  like any other bad file.
- **Every read before the caps is bounded.** Deflate is bounded only by the
  size asked for, so the reads that precede the shape and cell checks cap
  their own size:
  - *The `.npy` header.* numpy's header readers read and decode the length
    the file declares (a uint32 in `.npy` v2/v3) before applying their own
    10,000-byte limit; a 260 KB deflated member declaring a 256 MiB header
    made one tile request allocate over 256 MiB. `_readNpyHeader` reads the
    magic and the length field itself, refuses a length above
    `NPY_MAX_HEADER_BYTES` (10,000, numpy's limit; a 2-D float header is
    ~128 bytes) before reading the header, and hands numpy only those bytes.
  - *The central directory.* Opening a ZIP parses its whole central directory
    (one `ZipInfo` per entry) first; a 47 MB file with a million entries cost
    357 MiB and 1.9 s per request. `_checkCentralDirectory` reads the end
    record with zipfile's own `_EndRecData` (private but long stable; a zip64
    end record's 64-bit fields are what it returns, so zip64 is bounded the
    same way) and refuses more than `MAX_SCALAR_MAP_ENTRIES` (16,384) entries
    or a directory above `MAX_CENTRAL_DIRECTORY_BYTES` (2 MiB, 128 bytes per
    entry; a map entry is ~70) before `ZipFile` is constructed. The byte cap
    is the binding one, since zipfile walks the directory by its size.

  Failures are not cached, so either read would otherwise repeat on every
  tile request.
- **Storage failures are server errors.** An `OSError` from the file handle
  (disk, or S3 and other network assetstores; `requests` exceptions are
  `OSError`s) is re-raised by `_BoundedReads` as `ScalarMapStorageError`,
  which the format-error mapping does not catch, so it surfaces as a 500
  instead of blaming the file with a 400.
- **Streamed, never buffered.** zipfile reads straight from Girder's
  `FileHandle` (it is seekable), through `_BoundedReads`, which splits every
  read into pieces of `min(8 MiB, core.filehandle_max_size)`: the handle
  refuses one read above that setting (16 MiB by default), and zipfile asks
  for a member's whole compressed size at once. Only the requested member is
  decompressed, into one preallocated buffer, so a load holds the decoded
  array, not the archive. A map file above 16 MiB failed every tile before
  the bounded reads. Files above `MAX_SCALAR_MAP_FILE_BYTES` (512 MiB) are
  refused.

### Array cache

A process-wide LRU of decoded float32 arrays bounded by
`MAX_SCALAR_MAP_CACHE_BYTES` (512 MiB), keyed `(file id, file identity,
location)`. A hit is re-checked against the metadata's `shape`, since the
metadata can change under a cached array.

- **One load per file at a time.** Cold loads take a lock per **file**, not
  per location: one thread opens the archive and decodes its member, and
  requests for the same or another location of that file (a Z or Time scrub
  starts several) wait, then re-check the cache. A newly shown map otherwise
  issues one full file read per visible tile.
- **Invalidation.** Delete calls `invalidateScalarMapFiles`, which drops the
  file's arrays and bumps a per-file epoch; a load that started before the
  bump does not cache its result. A replaced file has a new revision, so its
  key differs and the old array is never served. A map deleted through
  Girder's own item or folder routes is not invalidated: its arrays stay
  cached until LRU eviction, bounded by the cache budget.
- **At most `MAX_CONCURRENT_SCALAR_MAP_DECODES` (2) archive reads across
  files.** A decode holds its member's raw bytes and the float32 copy (up to
  2 x 128 MiB) before the cache budget counts any of it, so several maps
  shown at once each held that in parallel. A `BoundedSemaphore` is taken
  around the file read and decode only: after the per-file lock (waiters for
  one file still single-flight, and a cache hit never waits on it), never
  while holding the cache lock, and released before the result is cached and
  on any exception. A holder waits on nothing else, so the order cannot
  deadlock.
- The cache lock is never held during I/O.

### Rendering

- **Pyramid.** Tiles are cut on the **image's** pyramid: `scale = 2 ** (z -
  maxLevel)`, tile `(x, y)` covers image pixels `[x, x + 1) * tileSize /
  scale`, the same arithmetic as the annotation overview raster and the
  transcript density tiles. A tile outside the pyramid is a 400.
- **Sampling.** Each output pixel center is sampled bilinearly between cell
  centers, extended flat past the outer centers. NaN-aware: a pixel whose
  containing cell is NaN, or that lies outside the array or the image, is
  transparent; a NaN neighbor drops out of the weights (renormalized) instead
  of poisoning a valid pixel, so the support keeps its cell edges. The
  result is clamped to the range of its contributing samples: an
  interpolated value can never legitimately leave it, and the clamp makes a
  flat region sample exactly to its value (without it, a constant 100 map at
  12.5 px spacing came out a hair off 100 in 266 of 2,500 pixels, dimmed by a
  threshold of 100 on either side). Only finite samples with **positive**
  weight contribute, to the sum and to the clamp bounds: a zero-weight
  neighbor (a pixel level with a cell center on one axis, or in the half
  cell before the first center) used to widen the bounds, so a value next
  to a NaN came out one ULP off its cell. The invariant: a pixel whose
  contributing cells all equal v samples to exactly v.
- **Color.** The colormap's anchor table from `server/helpers/colormaps.py`
  (the same tables color-by-property uses) is interpolated to a 256-entry
  LUT; values clamp to `[min, max]`. Omitted `min`/`max` default to
  `valueRange`; a constant map is widened to `[v - pad, v + pad]` with
  `pad = max(0.5, abs(v) * 1e-6)` (a fixed 0.5 rounds back to `v` from
  2^53), the same rule as the client's `displayValueRange`; `min >= max` is
  a 400, and so is a finite pair whose difference overflows (`min=-1e308&
  max=1e308`), which would otherwise let a cell minus `min` overflow into
  `inf / inf` = NaN and a CPU-dependent LUT index (an `IndexError` on x86,
  color 0 on arm64). Cells are never infinite (refused at load).
- **Threshold.** Inclusive on both sides: `value >= threshold` is selected for
  `above`, `value <= threshold` for `below`, matching the worker's `Value at
  least` / `Value at most`. Unselected pixels are drawn at alpha 64.

### Caching and limits

- Tiles carry `Cache-Control: private, max-age=0, must-revalidate` and a weak
  ETag over the render version, file revision and every display parameter. A
  matching `If-None-Match` gets a body-less 304, **after** the READ check, so
  revoking a share link or switching users takes effect on the next tile.
- Every parameter is validated at the boundary (`helpers/validation.py`):
  finite floats, integer ranges, `maxLevel <= 30`, edges up to 131072, a known
  location key and colormap. Girder itself refuses a repeated query parameter
  with a 400.

## Frontend

| File | Role |
|---|---|
| `src/store/ScalarMapAPI.ts` | `listMaps`, `deleteMap`, `tileTemplateUrl` (`v=<revision>`, `token=` for share views, threshold params only when on). |
| `src/store/scalarMaps.ts` | The dataset's maps and per-map display state. |
| `src/utils/scalarMap.ts` | Pure helpers: validation, display range, slider positions, percent/value/tie math, worker forms, formatting. |
| `src/utils/imageTileOverlayLayer.ts` | GeoJS layer setup shared with `TranscriptOverlay.vue`. |
| `src/components/ScalarMapOverlay.vue` | One GeoJS `osm` layer per shown map, mounted per viewer by `ImageViewer.vue`. |
| `src/components/ScalarMapsPanel.vue` | The Map Layers palette. |

Registration: `panelRegistry.ts` (`scalarMapsPanel`), `paletteGeometry.ts`
(`RIGHT_PALETTE_WIDTHS.scalarMaps`), `App.vue` (button, palette, availability
rule shared with the command), `ImageViewer.vue` (overlay), `jobs.ts`
(re-list after a job).

### Store

- **Names are module-specific** (`setScalarMaps`, `refreshScalarMaps`,
  `deleteScalarMap`, ...). Store modules are registered without namespaces, so
  a mutation or action name is global: the first cut's `setMaps` also ran the
  main store's GeoJS `setMaps`, which threw, and every list "failed" in the
  live app while every unit test passed (see the nimbus-frontend skill).
- `currentMaps` is empty until the current dataset's list lands
  (`mapsDatasetId`). An empty list and a failed list stay distinct
  (`scalarMapsError`). The failure is stored with its dataset
  (`listErrorDatasetId`) and `scalarMapsError` is null for any other one, so
  a failure on dataset B never shows over dataset A's list after going back.
- **When the list is fetched.** `refreshScalarMaps()` runs when a dataset is
  opened in the viewer (a new dataset, a reload, or a return to it), when the
  palette is shown, about a second after any job on the open dataset ends,
  and from Refresh/Retry. Opening a dataset, a job's end and Refresh/Retry
  force a new request; only the palette being shown shares the request
  already in flight for the same dataset. Opening was not forced at first:
  leaving the viewer and reopening the same dataset before the earlier list
  settled joined that request, whose answer could predate a map saved since,
  and the Map Layers button stayed hidden.
- **After a job.** `jobs.ts` calls `scheduleScalarMapsRefresh()` on every
  terminal state, not only success: the worker deletes the previous map
  before uploading the new one, so a run that fails or is canceled in between
  has still removed a listed map, whose layer would otherwise keep requesting
  tiles for a missing item. The call is a trailing 1 s debounce, so a batch
  of jobs ending together is one forced GET.
- **Availability** (`scalarMapsAvailable`, used by the app-bar button and
  its command): with maps, after a failed lookup, or while the FIRST list for
  this dataset loads. A re-list of a dataset already known to have no maps
  does not count, or the button would appear and vanish on every dataset open
  and finished job. A request never clears the error up front: this dataset's
  failure (and so the button) stays until the answer lands.
- **A failed re-list keeps the last good list.** A network blip must not wipe
  the maps or their display settings; only the error is set.
- **Sequence guard.** Every request claims a generation before any early
  return; a successful delete bumps it too (and re-lists if a list was
  pending), so no response captured earlier can land afterwards.
- `setScalarMaps` skips entries that fail `isValidScalarMap` (logged), so one
  bad map never loses the list.
- **How a map is shown survives a re-list.** Same item and `revision`:
  everything. New `revision` (the server changes it on any file or metadata
  edit, including locations, `valueRange`, `percentiles` and name): visible,
  opacity and colormap are kept, and range and threshold are derived again;
  the overlay re-syncs, and if the current location was removed it hides the
  layer and requests nothing. A **worker re-run** deletes the item and
  uploads a new one: when exactly one dropped and one new item share
  `meta.toolId` (`replacementsByTool`), the new item inherits visible,
  opacity and colormap the same way, so the iterate loop (tweak, re-run,
  look) does not come back hidden. Ambiguous matches carry nothing.
- **The list order is the order of `maps`**, session-only like `display`
  (nothing is saved). `reorderScalarMaps(itemIds)` puts the maps in that
  order: unknown ids are ignored, listed maps left out keep their relative
  order after the named ones, and an unchanged order assigns nothing. A
  re-list of the same dataset keeps the user's order: a map keeps its
  position, a worker re-run's replacement (`replacementsByTool`) takes the
  position of the item it replaces, and maps not listed before go after, in
  the server's order. Another dataset starts in the server's order. A delete
  keeps the order of the rest.
- Display defaults: hidden, opacity 0.7, viridis, range = `valueRange`
  (widened when constant), threshold off but preset to the worker's default
  (top 20%).

### Overlay

- Layers come from `createImageTileOverlayLayer`: the image pyramid at tile
  size 256, `keepLower = false`, `crossDomain = "use-credentials"`, created
  hidden with a blank URL, and placed at once by the layer-order rule below.
  Each level is cropped to the image rounding a partial last pixel up
  (`Math.ceil`, as the image layer's tile bounds do). Master's transcript
  density layer rounded down, which cropped a rendered edge and, where the
  image is smaller than one coarse pixel (210 px at 256x), the whole overlay;
  the shared util fixes both layers.
- Showing/hiding, the XY/Z/Time location, the file revision and the
  share-link token re-sync immediately. Colormap, range and threshold change
  the existing layer's URL after a 150 ms debounce. Opacity is
  `layer.opacity()` only.
- **Failed tiles.** GeoJS keeps a rejected tile in its cache and never asks
  for it again, so a transient failure (a 500, a network blip) left a hole
  that the palette's Refresh did not fill (a re-list with the same revision
  leaves the URL as it was). `hookTileFailures` (shared util, opt-in; the
  transcript density layer does not use it) wraps `_getTileCached`, never
  the pre-cache `_getTile` (nimbus-geojs skill), hooks each tile once, and
  reports only a tile still in the layer's cache when it rejects (the fetch
  queue also rejects queued tiles a pan purged, which are simply created
  again). The overlay then marks the map in the store's `tileFailedMapIds`
  (the card shows a warning). Refresh commits `requestScalarMapTileRetry`;
  the overlay resets the cache of every marked layer and draws the map, so
  those tiles are requested again. The mark lives as long as the layer
  whose tile failed: it is cleared by the retry, a new tile URL, and the
  layer's deletion (hidden, deleted, unlisted, disabled, unmount), and the
  store prunes it on a re-list that drops the item, a delete, and another
  dataset's list. A deleted layer's late failure marks nothing.
- A hidden map's layer is deleted. A location the map has no array for hides
  the layer and requests nothing. Layers of deleted maps or another dataset
  are deleted on the next sync; all are deleted on unmount, and only while
  the map still holds them (an unroll toggle replaces the map).
- Disabled (layers deleted) while unrolled and while a dataset view loads
  (`sync.datasetLoading`): ImageViewer passes both through its
  `imageOverlaysDisabled` computed, and the layers are deleted in the same
  flush as the prop change (no debounce; a pending slider update cannot
  bring them back). The transcript overlay keeps the unrolled-only gate: it
  applies `disabled` through its 200 ms pan debounce, so this gate would
  leave its points up after the image hides. During a view load
  `setDatasetViewId` applies the incoming XY/Z/Time while `store.dataset`,
  and so `currentMaps` (keyed by `mapsDatasetId` against `store.dataset`),
  is still the outgoing dataset's; drawing then would request the outgoing
  map at the incoming position over hidden image tiles. Once the incoming
  dataset lands `currentMaps` is empty until its own list arrives, so the
  outgoing list can never be drawn against it.
- **Layer order.** The util registers every overlay layer (the scalar maps,
  and the transcript heat maps and point layer). `ImageViewer.draw()` calls
  `orderLayersAboveImages` to keep image layers at the bottom, then the
  registered overlays in their order, then the annotation stack (overview
  raster, worker preview, outlines, ...). GeoJS creates a new layer on top,
  so when a display layer was added while a map was shown, the new image
  layers covered it (hidden in the Normal blend); only the annotation stack
  used to be raised.
  - **Creation and redraw agree.** The util remembers each viewer map's stack
    from the last draw, and `registerImageOverlayLayer` runs the same
    ordering as soon as an overlay is created. Inserting it at the annotation
    layer's index instead put it above the overview raster and worker
    preview until the next draw, tinting a large dataset's cell raster.
    Before a map's first draw it falls back to just under the annotation
    layer.
  - **Relative, not absolute.** The check compares the z-sorted top of the
    map with "overlays, then stack". GeoJS's `deleteLayer` leaves a gap in
    the z-indices that `moveToTop` (which rotates existing values) never
    closes, so an absolute-index check failed on every draw after any overlay
    had been hidden, re-raising every layer for the life of the viewer.
    Nothing moves when the order is already right.
  - **Among the scalar maps, the list order.** GeoJS gives a new layer the
    top slot, so without more the map turned on last drew on top. At the end
    of every `sync()`, `orderOverlayLayersAmongThemselves` stacks the
    existing scalar map layers so the first listed map is topmost: it hands
    those layers the z-indices they already hold, sorted, with
    `zIndex(z, true)` (without `allowDuplicate` GeoJS bumps a sibling that
    holds the value, moving layers outside the group). Their slots relative
    to the transcript layers, the images and the annotation stack do not
    change, and `orderLayersAboveImages` keeps overlays in their current
    relative order, so the viewer's draws keep this order. It sets nothing
    when the order is already right, so steady-state syncs move no layer.
    `structureSignature` includes the list order, so a drag restacks at once
    (no layer recreated, no URL changed).
- **Location.** A map follows the viewer's global XY/Z/Time, as annotations
  do, not per-layer Z offsets or max-merge slices.
- **One renderer per map.** Each shown map is its own GeoJS layer with its
  own WebGL renderer (`autoshareRenderer = false`), like the per-gene
  transcript heat maps. Many maps shown at once therefore count against the
  browser's WebGL context limit. `_setupTileLayers()` budgets only image
  layers, when they are created (canvas renderer from 11 on), so it cannot
  account for overlays added later; the limit is left documented, not
  enforced.
- **Tile errors are not surfaced.** A map whose metadata disagrees with its
  file (a missing location member, a wrong shape) is listed, but every tile
  is a 400 and the layer stays blank.

### Panel semantics

- **Sliders use integer positions** (0–1000) mapped linearly to values.
  Vuetify rounds a slider value to the decimals of `step.toString()`, which is
  zero for a step in exponent notation (below 1e-6), so a float step on a
  tiny range rounded everything to 0.
- **The range thumbs never collapse.** Vuetify lets the two thumbs meet; the
  moved thumb is kept one position from the other
  (`separatedRangePositions`) instead of dropping the update, which left the
  thumbs together while tiles and labels kept the old range.
- **Percent vs value.** `thresholdPercent` holds the share the user picked in
  percent mode, and the value is derived from it (`valueAtPercentile`,
  interpolating the stored whole percentiles). Setting a value clears it.
  Switching side keeps the picked share. Percent-to-index arithmetic
  multiplies before dividing: `(p / 100) * 100` is not an integer for p = 7,
  14, 28, 29 and 55–58, which put "bottom 7%" a hair below `percentiles[7]`,
  marked it approximate, and could exclude a tie run starting there.
- **The share is an estimate.** It is read from the percentiles pooled over
  every position of the map, interpolated between whole percentiles, not
  counted on the plane on screen; the readout says so ("≈ top 20% of tissue
  (all positions)"). With two cells valued 0 and 1, "top 20%" is the cutoff
  0.8, which selects one cell of two; that is not a tie.
- **Reordering.** The cards render through `vuedraggable` (`item-key`
  `itemId`, `:model-value` the listed maps); a drop commits
  `reorderScalarMaps` with the new id order. Cards drag only by their handle
  (`handle: ".map-drag-handle"`), so the sliders, the checkbox and text
  selection inside a card keep working. The handle and the caption appear
  only with more than one map. Unit tests stub `draggable` with a component
  that renders its `#item` slot per element: `shallowMount`'s own stub
  renders no cards.
- **Ties.** The selection is inclusive, so a value shared by many cells counts
  with the selected side. Only when the cutoff sits on a run of equal
  percentiles and that makes the selected share differ from the request does
  the readout add "50% requested, more selected because of ties at the
  cutoff".
- **Worker forms.** The value form prints the cutoff in full precision, as
  the same string the tile URL's `threshold` carries (`exactNumberString`,
  JavaScript's shortest round-trip `String(n)`; very small or large values
  come out in exponent form, which `float()` and a number field accept). A
  rounded cutoff can miss a plateau: float32 0.3 is 0.30000001192092896, and
  the nine-digit "0.300000012" is above it, so the worker's inclusive `>=`
  would drop cells the preview selected. The percent form is exact only
  when it is a whole percentile whose stored value is the cutoff (the worker
  thresholds `Top percent N` at `percentiles[100 - N]`); otherwise it is
  marked approximate.
  A share the user set is shown as set (`formatRequestedShare`: "12.5", not
  "13", which is a different percentile than the one previewed), in both the
  readout and the copyable form; only a share estimated from a value is
  rounded (`formatShare`).
- **Legend** gradients come from the server's tables through
  `GET upenn_annotation/color_by_property/options`, loaded once; there is no
  client copy to drift.
- The panel lists maps only while visible (palette content is always
  mounted). Its "no data at the current position" check and the overlay's
  tile location both go through `scalarMapLocationKey`, an O(1) lookup in a
  position index built once per `locations` array (`scalarMapLocationIndex`),
  so an XY/Z/Time scrub never scans a map's locations. The card bodies (the
  only part that reads the position) render only while the palette is shown
  (`visible`), so a closed palette does no per-frame rendering; reopening it
  renders current values at once. The delete dialog is outside the cards.
- **Delete confirmations are sessions.** The palette lives as long as the
  app, so a dialog can outlive its dataset (browser Back/Forward) and a
  request can outlive its dialog (Escape while deleting); the dialog is
  teleported, so nothing else closes it with its context. Closing the dialog,
  a dataset view starting to load (`sync.datasetLoading`; `store.dataset`,
  and so `currentMaps`, is still the outgoing dataset's until the fetch
  completes), switching datasets, hiding the palette (navigating Home can do that with
  the dataset unchanged) and the target leaving the list (a job's re-list)
  each end the session; a request's result applies only to the session that
  started it; and only a map of the dataset on screen can be confirmed, never
  while a dataset view loads.
  Ending a session does not end the request: the store tracks each map's
  DELETE (`deletingMapIds`) from send until it settles, the dialog's
  `deleting` is read from it, and a second `deleteScalarMap` for the same
  map joins the request in flight. Escape and reopening the same map's
  confirmation therefore shows it still deleting and cannot send a second
  DELETE (which would fail for the item the first removed).
- **Descriptive fields are optional.** `name`, `statistic`, `property` and
  `radius` are not validated, so the card falls back to "Untitled map" and
  leaves out absent parts of the subtitle rather than printing "undefined".
- The worker forms are laid out as label/value rows (a small grid), so a
  phrase never wraps away from its number.

## Regression checklist

Every item below was a real defect found in review or live testing, or an
invariant a later fix could undo. Each line names the invariant and the test
that holds it.

Run `pnpm test src/utils/imageTileOverlayLayer.test.ts src/utils/scalarMap.test.ts src/store/scalarMaps.test.ts src/store/ScalarMapAPI.test.ts src/store/__tests__/scalarMapsNameCollisions.test.ts src/store/jobs.test.ts src/components/ScalarMapOverlay.test.ts src/components/ScalarMapsPanel.test.ts src/components/TranscriptOverlay.test.ts src/App.test.ts`, and `tox` in `devops/girder/plugins/AnnotationPlugin` (`test_scalar_map.py`).

### Store

- [ ] **Mutation and action names are unique across store modules.** Found live: the store's `setMaps` cross-fired into the main store's GeoJS `setMaps` (`TypeError: maps.map is not a function`) and every list reported failure. Isolated module tests could not see it. — *"declares no mutation, action or getter another store module declares"*, *"documents why: an un-namespaced mutation name runs in every module declaring it"*
- [ ] **A response from an older request never lands**, including across a dataset switch or clear. The sequence token is claimed before any early return. — *"ignores an answer that lands after a newer (forced) request"*, *"does not let a request for the previous dataset land after the dataset is cleared"*, *"drops a failure for a request that was superseded"*
- [ ] **"Could not ask" is not "no maps".** — *"keeps 'could not ask' distinct from 'no maps', and retries"*
- [ ] **A list error belongs to its dataset.** Dataset B's failure never shows over dataset A's list. — *"never shows another dataset's list error over this dataset's list"*
- [ ] **One malformed map never loses the list.** Percentiles are required (101 finite, non-decreasing) on both sides. — *"skips a malformed map instead of losing the list"*, *"rejects %s"*, *"testMetaValidation"*
- [ ] **Delete beats an in-flight list.** A list response captured before a delete must not bring the map back. — *"does not let a list captured before a delete bring the map back"*
- [ ] **One DELETE per map until it settles.** A second delete of a map whose DELETE is in flight joins it; `deletingMapIds` holds the map from send until success or failure, and other maps are independent. — *"sends one DELETE per map while it is in flight and tracks it until it settles"*
- [ ] **Display state resets with the dataset, survives a re-list, and is re-derived for a rewritten file or edited metadata** (the server's revision changes on any metadata edit). — *"resets with the dataset and keeps display settings across a re-list"*, *"re-derives range and threshold when a map's file changes, keeping how it is shown"*, *"re-derives a map's settings after a metadata edit removes a location"*
- [ ] **A worker re-run's replacement keeps how the map was shown** (visible, opacity, colormap) when exactly one dropped and one new item share `meta.toolId`, and the overlay shows it with no user action; an ambiguous or other-tool match carries nothing. — *"carries how a map is shown to its replacement from a worker re-run"*, *"carries nothing over when the replacement is ambiguous or another tool's"*, *"shows a worker re-run's replacement map without user action"*
- [ ] **The list order is session state that survives a re-list of the same dataset**: a map keeps its position, a re-run's replacement takes the replaced map's position, new maps go last in the server's order; another dataset uses the server's order; a delete keeps the rest in order. A reorder ignores unknown ids, keeps maps left out after the named ones, and assigns nothing when unchanged. — *"reorders the listed maps and assigns nothing when the order is unchanged"*, *"ignores unknown ids and keeps maps left out after the named ones"*, *"keeps the user's order across a re-list of the same dataset, a replacement taking the replaced map's place and new maps going last"*, *"uses the server's order for another dataset"*, *"keeps the order of the remaining maps after a delete"*

### List freshness

- [ ] **The list is fetched on every dataset (re)open, not once per id.** With no maps listed, the button that would reveal a new one is hidden. — *"offers Map Layers only with saved maps, and keeps it reachable after a failed lookup"*
- [ ] **Any job ending on the open dataset re-lists, failed and canceled included** (the worker deletes the old map before uploading; a run that dies in between still removed it); another dataset's job does not. — *"lists the open dataset's maps again when a job on it %s"*, *"does not list for another dataset's job"*
- [ ] **A burst of finished jobs is one GET** (trailing 1 s debounce). — *"lists once for a burst of finished jobs"*
- [ ] **The button does not flash.** `loading` counts as available only during the first list for a dataset; a re-list of a dataset known to have no maps keeps the button hidden. A failed re-list keeps the last good list, and a retry keeps the error (and the button) until it lands. — *"offers the palette during the first list only, not on a re-list of a dataset with no maps"*, *"keeps the last good list and stays offered while a failed re-list is retried"*
- [ ] **The palette lists only while shown.** — *"lists maps only while shown, and again for a new dataset"*
- [ ] **Concurrent callers share one request.** Opening a dataset with the palette open must not send two. — *"shares a request in flight for the same dataset unless forced"*, *"lists again for every call once the previous one finished"*
- [ ] **Reopening a dataset forces a fresh lookup**, never joining a request from before the viewer was left (its answer may predate a newly saved map). — *"forces a fresh map lookup when the viewer reopens a dataset, never joining a request from before it left"*, *"ignores an answer that lands after a newer (forced) request"*

### Access

- [ ] **List and tiles need READ; delete needs WRITE and refuses non-maps.** — *"testListReturnsOnlyValidMapsAndEnforcesRead"*, *"testTileEnforcesRead"*, *"testDeleteNeedsWriteAndRefusesNonMaps"*
- [ ] **Delete removes only what the list shows.** An item with map metadata but no file or a second file is refused with the tile route's 400 (one `_mapFile` check), not removed. — *"testDeleteRefusesAnItemTheListSkips"*
- [ ] **A map whose one file is a Girder link file is not listed, and its tile and delete are the same 400** (not a 500 from `File().open()`): the list's batched file query and `_mapFile` share `isScalarMapFileSet` (one assetstore-backed file). — *"testLinkFileMapIsNotListedAndItsTileAndDeleteAre400"*
- [ ] **Revalidated tiles re-check READ.** A 304 is answered only after the access check. — *"testTilesRevalidateWithEtag"*
- [ ] **Share views put their token on the tile URL.** — *"adds the threshold, version and share-view token only when set"*
- [ ] **Delete is offered only to sessions that can write.** — *"offers delete only to sessions that can write"*
- [ ] **Bad parameters are 400s, not 500s.** — *"testTileBadRequests"*, *"testRepeatedParamIs400"*

### Rendering

- [ ] **Sampling is bilinear and NaN-aware**, and off-array, off-image and NaN pixels are transparent. — *"testSamplingMatchesBruteForce"*, *"testNanNeighborDoesNotPoisonValidPixel"*, *"testOutsideArrayIsNan"*, *"testTileColorsNanAndOutside"*, *"testTileAtLowerLevel"*
- [ ] **The threshold comparison is inclusive on both sides**, matching the worker and the panel's tie readout. — *"testThresholdIsInclusive"*, *"testTileThresholdBothSides"*
- [ ] **A flat region equal to the threshold is selected on both sides.** Sampling clamps to the range of the contributing samples; without it a constant map came out a hair off its value and was dimmed. — *"testFlatRegionAtTheThresholdIsSelectedOnBothSides"*, *"testInterpolationStaysWithinItsSamples"*
- [ ] **A pixel whose finite, positive-weight neighbors all equal v samples to exactly v (bitwise)**, over integer and fractional spacings, several origins, NaN neighbors on each side and float32 values. A zero-weight neighbor must not widen the clamp bounds (it did, next to a NaN, at cell-center-aligned pixels and along the left and top half-cell band). — *"testPointWhoseContributingCellsAllEqualVIsExactlyV"*
- [ ] **A constant map renders.** Its range is widened to `[v - pad, v + pad]`, `pad = max(0.5, abs(v) * 1e-6)`, by the server's default and by the client's default and Reset (the client used to send `min == max`, a 400 on every tile; a fixed 0.5 pad is a no-op from 2^53). — *"testDefaultRangeOfConstantMap"*, *"testConstantMapDefaultRange"*, *"widens a constant map's range by the server's rule"*, *"widens a constant map's default range and its reset range"*, *"keeps a constant map's range open at large magnitudes"*
- [ ] **A replaced file is never served stale**, by the server cache, the ETag or the client URL. — *"testCacheNotStaleAfterFileReplaced"*, *"re-syncs at once when the file's revision or the share-view token changes"*
- [ ] **A same-size in-place replacement on an assetstore without checksums is not stale.** The file identity includes the file's `created`, which Girder rewrites on in-place replacement. — *"testSameSizeReplacementWithoutChecksumIsNotStale"*
- [ ] **Any metadata-only edit changes the revision and the ETag**: the geometry (so browsers do not revalidate onto misplaced tiles), and `locations`, `valueRange` and `percentiles` (so a re-list re-derives layers, range and cutoff). The digest covers the whole validated object as canonical JSON. — *"testMetadataOnlyEditChangesRevisionAndEtag"*, *"testRevisionCoversTheWholeMetadata"*
- [ ] **Infinite cells are refused at load** (finite or NaN only), so bilinear sampling never multiplies a zero weight by inf and blanks a neighbor. — *"testInfiniteCellsAreRefused"*
- [ ] **Overflowing ranges never reach the LUT as NaN**: finite `min`/`max` whose difference overflows are a 400. — *"testOverflowingRangeIsRefused"*, *"testTileBadRequests"*
- [ ] **A float32 plateau is selected by a cutoff taken from its own value** (the double's shortest round-trip string, compared against the float32 samples as doubles), on both sides. — *"testFloat32PlateauAtItsOwnValueIsSelected"*
- [ ] **The legend comes from the server's colormap tables**, the ones the tiles are rendered from. — *"draws the legend from the server's colormap table"*, *"loads the legend tables once and retries after a failure"*, *"testColormapEndpointsMatchAnchors"*

### Reading and cost

- [ ] **A file above Girder's 16 MiB single-read limit renders** (chunked read). — *"testFileOverGirderSingleReadLimit"*
- [ ] **Concurrent cold loads share one read**, and a load in flight during a delete does not cache its result. — *"testConcurrentColdLoadsShareOneRead"*, *"testLoadInFlightDuringInvalidateIsNotCached"*
- [ ] **Decodes across files are bounded** by `MAX_CONCURRENT_SCALAR_MAP_DECODES`, every load still succeeds, and a failed decode gives its slot back. — *"testDecodesAcrossFilesAreBounded"*
- [ ] **One archive read in flight per file**, even for different locations (a Z/Time scrub), and a load holds the decoded array, not the archive. — *"testDifferentLocationsOfOneFileLoadOneAtATime"*
- [ ] **The array cache stays within its byte budget.** — *"testCacheStaysWithinBudget"*
- [ ] **The file is read strictly as a ZIP with one explicit member**, checked and decoded from the same member. — *"testBareNpyIsRefusedWithoutDecoding"*, *"testChecksAndDecodesTheSameExplicitMember"*, *"testReadRejectsBadArrays"*, *"testFortranOrderMember"*
- [ ] **A crafted archive is a 400, not a 500**: an encrypted member or an unknown compression method. — *"testEncryptedMemberIsRefused"*, *"testUnsupportedCompressionIsRefused"*, *"testCraftedArchiveIs400"*
- [ ] **Only stored and deflated members are read**, checked before opening: bzip2 and LZMA expand without an output bound, before the header caps apply. — *"testOnlyNumpysCompressionMethodsAreRead"*
- [ ] **The `.npy` header length is checked before the header is read.** A deflated member declaring a 64 MiB header is refused with peak allocation under 1 MiB (numpy alone reads and decodes it all first). — *"testNpyHeaderLengthIsCappedBeforeItIsRead"*
- [ ] **The central directory is capped before ZipFile parses it** (16,384 entries, 2 MiB), and ordinary `np.savez` / `np.savez_compressed` files with several locations still load. — *"testOversizedCentralDirectoryIsRefusedBeforeParsing"*, *"testNumpyArchivesWithSeveralLocationsLoad"*
- [ ] **Only float16 and float32 arrays are read**; float64 (either byte order) and any long double are refused with "save scalar maps as float32", never rounded. Runs on every platform. — *"testWideFloatIsRefused"*
- [ ] **A storage failure is a server error, not a bad map**: an `OSError` from the file handle becomes `ScalarMapStorageError` (a 500), never "not a readable .npz". — *"testStorageFailureIsNotABadFile"*, *"testStorageFailureIsAServerError"*
- [ ] **A location without data requests nothing.** — *"never creates a layer for a map with no data at the current location"*, *"follows the viewer's location and requests nothing where the map has no data"*
- [ ] **A position lookup does not scan the map's locations** (index built once per `locations` array; a re-list or metadata edit gets a new one), since the panel checks it on every XY/Z/Time change even while hidden. — *"indexes a map's locations once and looks positions up without a scan"*
- [ ] **Opacity is a restyle only**: no URL change, no new layer. — *"only restyles on an opacity change"*
- [ ] **Slider-driven URL changes reuse the layer and are debounced.** — *"updates the URL of the same layer on range, colormap and threshold changes, debounced"*

### Overlay lifecycle

- [ ] **One layer per shown map, with the shared heat-map setup; deleted when hidden, deleted, or unmounted.** — *"creates one layer per visible map with the shared heat-map setup"*, *"removes a layer when its map is hidden or deleted, and on unmount"*
- [ ] **Layers are not deleted twice from a map that already exited them.** — *"does not delete layers again from a map that already exited them"*
- [ ] **A failed tile marks its map, and Refresh requests it again.** The hook is attached after GeoJS caches the tile, once per tile; the retry resets only marked layers and draws the map. — *"marks a map whose tile fails to load, and a retry request makes that tile load again"*, *"Refresh lists the maps again and requests failed tiles again"*, *"warns on a map's card when some of its tiles failed to load"*
- [ ] **No false or stale failed-tile marks.** Tiles that load never mark; a purged tile, a tile of a previous URL and a deleted layer's tile failing late mark nothing; a new URL, hiding and unmounting clear the mark; the store drops it with the item or the dataset. — *"never marks a map whose tiles load, and a retry request leaves its layer alone"*, *"ignores a failure from a tile the cache no longer holds (a new URL, or a purge)"*, *"clears the mark with a new URL, and when the map is hidden or the overlay unmounts"*, *"keeps a map's failed-tiles mark only while the map is listed"*
- [ ] **TranscriptOverlay is unchanged by the shared layer util** (apart from the edge rounding below). — *"creates heat-map layers that keep only the current level"*, *"draws one heat map per gene in its own color and deletes removed ones"*
- [ ] **Overlays stay above display layers added after them** (scalar maps and transcript heat maps and points), and under the annotation stack; nothing moves when the order is already right. — *"keeps overlays above display layers added after them"*, *"keeps several overlays in their order and any registered layer counts"*, *"does nothing when the order is already right"*, *"orders the annotation stack above the images as before when there is no overlay"*
- [ ] **A new overlay is placed below the overview raster and worker preview at once**, not only at the next viewer draw, and that draw then moves nothing. — *"places a new overlay below the overview raster at once, without a viewer draw"*, *"goes under the annotation layer before the viewer has ordered the map"*
- [ ] **The ordering compares relative order, so a deleted overlay's z-index gap does not make every later draw re-raise every layer.** — *"stops moving layers after an overlay is shown, hidden and drawn twice"*
- [ ] **Scalar maps stack in list order, the first on top, whichever was turned on last; a reorder restacks at once without recreating layers or changing URLs.** The restack only swaps the z-indices the map layers hold (`allowDuplicate`), so no other layer moves and the viewer's next draw keeps it; it sets nothing when already ordered, so steady-state syncs move no layer. — *"draws the first listed map on top, whichever was turned on last"*, *"restacks on a reorder without recreating layers or changing URLs"*, *"restacks the given overlays in their own slots and leaves every other layer alone"*, *"sets no z-index when the order is already right or there is one layer"*
- [ ] **Overlay levels keep a partial edge pixel** (rounded up like the image layer), so a coarse level never crops a rendered edge or a sub-pixel image to nothing; shared with the transcript density layer. — *"keeps a partial edge pixel at coarse levels instead of cropping it away"*
- [ ] **A metadata edit that removes the current location hides the layer and requests nothing.** — *"hides the layer and requests nothing when a metadata edit removes the current location"*
- [ ] **Disabled while a dataset view loads, not only while unrolled**, so the outgoing dataset's map is never requested at the incoming location (the transcript overlay keeps master's unroll-only gate), and the layers go in the same flush as the prop change. — *"disables the scalar map overlay while a dataset view loads, leaving transcripts to the unroll gate"*, *"deletes its layers as soon as it is disabled, and a pending slider update cannot redraw them"*

### Panel semantics

- [ ] **Sliders over map values use integer positions**, so a tiny range (1e-7) does not round to 0 in Vuetify. — *"maps integer positions over [%d, %d] without losing values"*, *"drives value sliders with integer positions, even on a tiny range"*, *"gives a constant map a usable slider range"*
- [ ] **The copyable worker threshold reproduces the preview.** The value form is exact; a percent form that is not a whole stored percentile is marked approximate. — *"gives a whole percentile exactly and the value at full precision"*, *"marks a fractional or derived percent as approximate"*, *"gives the worker the exact cutoff, and marks an inexact percent"*
- [ ] **The copied value cutoff is the exact string the tile URL sends** (full precision, one shared `exactNumberString`), so a float32 plateau selected by the preview is not excluded by the worker's inclusive `>=`. — *"copies the exact cutoff the tile route is sent, not a rounded one"*
- [ ] **A share the user set is shown and copied exactly as set** (12.5, never rounded to 13); only an estimated share is rounded. — *"shows and offers to copy a set share exactly as set"*
- [ ] **The picked share is state; the value is derived from it, never the reverse.** — *"keeps the requested share and derives the value; setting a value clears it"*, *"keeps the chosen share as state when set by percent"*
- [ ] **Ties are reported, not hidden, and only real ties.** The readout labels the share as an estimate over all positions, and mentions ties only when the cutoff sits on a run of equal percentiles. — *"counts tied values with the selected side, as the inclusive cutoff does"*, *"says when ties select more tissue than was asked for"*, *"calls a difference a tie only when the cutoff sits on a run of equal percentiles"*, *"reads the threshold as a value and as a share of tissue"*
- [ ] **Percent and value agree with the worker at whole percentiles.** — *"reads whole percentiles exactly, as the worker does"*, *"round-trips value -> share -> value without ties"*
- [ ] **Every whole percent maps exactly to its stored percentile, reported exact** (no float noise at 7, 14, 28, 29, 55–58), and a tie run starting there is included. — *"maps every whole percent to exactly its stored percentile, reported exact"*, *"includes a tie run that starts at a whole percentile"*
- [ ] **The range thumbs stay one position apart** instead of a collapsed range being dropped. — *"keeps the range thumbs at least one position apart instead of dropping the update"*, *"keeps the range one position wide instead of dropping a collapsed range"*
- [ ] **A delete confirmation belongs to its dataset, its palette and its session.** A dataset view starting to load, a dataset switch, hiding the palette or the target leaving the list closes it; nothing is deleted while a view loads (the outgoing dataset's maps are still listed then); a map not on screen is never deleted; and a late result never closes or writes into a later confirmation. — *"closes a pending confirmation when a dataset view starts loading and sends no DELETE while it loads"*, *"closes a pending confirmation on a dataset switch and never deletes the previous dataset's map"*, *"ends a confirmation when the palette is hidden"*, *"ends a confirmation when its map leaves the list"*, *"applies a delete's result only to the confirmation that started it"*
- [ ] **Closing a confirmation does not end its DELETE.** Reopening the same map's confirmation mid-delete shows it still deleting and cannot send a second DELETE. — *"sends one DELETE when the confirmation is closed mid-delete, reopened and confirmed"*
- [ ] **A closed palette does no per-frame rendering** (card bodies gated on `visible`), reopening shows current values at once, and the delete dialog still works. — *"does no per-frame rendering while hidden, and shows current values when reopened"*, *"keeps the delete confirmation working with the card bodies gated"*
- [ ] **Dragging a card commits the new order, by its handle only, and the handle and caption appear only with more than one map.** — *"commits the new order when a card is dropped"*, *"offers the drag handle and its hint only with more than one map"*
- [ ] **A map missing descriptive fields still shows sensibly** ("Untitled map", absent parts left out) and is not rejected. — *"falls back for a map missing its descriptive fields"*

### Symmetric pairs — change one, check the other

| Path | Twin |
|---|---|
| the client's default display range | its Reset, and the server's default when `min`/`max` are omitted |
| the range slider | the value-threshold slider (both on integer positions) |
| the percent slider | the value slider (which one owns `threshold`) |
| a delete's effect on the list | a list request already in flight |
| a delete confirmation's session (dialog open/closed) | the DELETE request it started (per item, in the store) |
| the tile URL's `threshold` | the copyable worker value (one `exactNumberString`) |
| ImageViewer hiding image tiles while a view loads | the scalar map overlay drawn over them (`imageOverlaysDisabled`; transcripts are gated on unroll only) |
| the tile ETag inputs | the client's URL inputs (revision, token, every display parameter) |
| `TranscriptOverlay` density layers | `ScalarMapOverlay` layers (one shared setup util; only the scalar map layer hooks tile failures) |
| a tile failure marking a map | every way its layer's cache empties (retry, new URL, layer deleted), each clearing the mark |
| the app-bar button's availability | the command-palette entry's `isAvailable` |
| a job that succeeds | a job that fails or is canceled (both re-list) |
| the annotation stack in the viewer's ordering step | the registered overlays (raised first) |
| the panel's card order | the overlay's stacking (one list, `maps`; first on top) |
| a re-list carrying display settings to a replacement | the same re-list carrying the list position to it |
| the range slider's low thumb | its high thumb (whichever moved is the one held back) |

### Process rules this feature proved

- [ ] **Verify in the live app, from a fresh page load, on a dataset that has a saved map.** Unit tests of an isolated store module cannot see a mutation name another module also declares; only the live app showed every list failing.
- [ ] **Confirm each new test fails without its fix** (revert only the fix, never the whole file) before trusting it. The name-collision, delete-vs-list and job-refresh tests were each checked this way.
- [ ] `pnpm tsc`, `pnpm lint:ci`, `pnpm test` (the frontend suite also checks this checklist's citations), `tox` for backend changes, and `python3 plugins/nimbusimage/scripts/sync_skills.py --check` if a skill changed.
