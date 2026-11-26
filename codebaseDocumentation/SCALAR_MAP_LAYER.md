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
one file**: an `.npz` with one float array per location (`xy{XY}_z{Z}_t{Time}`).
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
- Each map shows its name and statistic · property · radius. The checkbox
  shows it in the viewer. While shown, the card offers opacity, colormap
  (viridis, magma, inferno, gray), a color bar, the display range (with
  Reset), and a threshold preview.
- **Threshold preview.** Pick a side (Above / Below) and set the cutoff either
  as a share of tissue ("% of tissue") or as a value. The readout gives both,
  e.g. "Value ≥ 160 µm² · ≈ top 20% of tissue (all positions)"; the share is
  an estimate over every position of the map. Pixels on the other side are
  dimmed. Below it are the two forms the worker accepts (`Threshold type` +
  `Threshold`), ready to copy.
- **Refresh** (header) lists the maps again. The list also refreshes on its
  own whenever a dataset is opened, when the palette is shown, and shortly
  after any job on the dataset ends, whatever its outcome.
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
| `GET scalar_map?datasetId=` | READ on the folder | `[{itemId, updated, revision, meta}]`, oldest first. One `Item().find` on the folder plus one batched `File().find` (`$in`). Items whose metadata does not validate, or that do not hold exactly one file, are skipped. |
| `GET scalar_map/{itemId}/tiles/{z}/{x}/{y}` | READ, cookie auth (GeoJS loads tiles through `<img>`); share links send `token=` | PNG. Params: `location`, `sizeX`, `sizeY`, `maxLevel`, `tileSize` (256/512/1024), `colormap`, `min`, `max`, `threshold?`, `thresholdSide?`. |
| `DELETE scalar_map/{itemId}` | WRITE | Removes the item and drops its cached arrays. 400 for an item that is not a map. |

`revision` (`scalarMapRevision`) is
`<file id>-<size>-<file created, %Y%m%d%H%M%S%f>[-<sha512 prefix>]-<geometry digest>`.
The first part is the **file identity** (`scalarMapFileIdentity`): a re-upload
gets a new file id, and Girder's in-place content replacement
(`Upload.finalizeUpload` with a `fileId`) rewrites `created` and `size`, so a
same-size replacement on an assetstore without checksums still changes it.
The geometry digest is a short sha1 of `originPx`, `gridSpacingPx` and
`shape`, the metadata that places the array on the image, so a metadata-only
correction changes it too. `revision` starts the tile ETag and goes in the
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
  the one both checked (header: 2-D float, the metadata's shape, within the
  cell cap) and decoded, and only as many bytes as the checked header allows
  are read. Fortran-order arrays are supported. An encrypted member or an
  unknown compression method (zipfile's `RuntimeError` /
  `NotImplementedError`) is a 400 like any other bad file.
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
  key differs and the old array is never served.
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
  of poisoning a valid pixel, so the support keeps its cell edges.
- **Color.** The colormap's anchor table from `server/helpers/colormaps.py`
  (the same tables color-by-property uses) is interpolated to a 256-entry
  LUT; values clamp to `[min, max]`. Omitted `min`/`max` default to
  `valueRange`, widened to `[v - 0.5, v + 0.5]` for a constant map; `min >=
  max` is a 400.
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
  (`mapsDatasetId`). An empty list and a failed list stay distinct (`error`).
- **When the list is fetched.** `refreshScalarMaps()` runs when a dataset is
  opened in the viewer (a new dataset, a reload, or a return to it), when the
  palette is shown, about a second after any job on the open dataset ends,
  and from Refresh/Retry (forced). A non-forced call shares the request
  already in flight for the same dataset.
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
  and finished job. A retry of a listed dataset keeps its error (and so the
  button) until the answer lands.
- **A failed re-list keeps the last good list.** A network blip must not wipe
  the maps or their display settings; only `error` is set.
- **Sequence guard.** Every request claims a generation before any early
  return; a successful delete bumps it too (and re-lists if a list was
  pending), so no response captured earlier can land afterwards.
- `setScalarMaps` skips entries that fail `isValidScalarMap` (logged), so one
  bad map never loses the list. A map whose `revision` changed keeps
  visible/opacity/colormap and gets fresh range and threshold defaults.
- Display defaults: hidden, opacity 0.7, viridis, range = `valueRange`
  (widened when constant), threshold off but preset to the worker's default
  (top 20%).

### Overlay

- Layers come from `createImageTileOverlayLayer`: the image pyramid at tile
  size 256, `keepLower = false`, `crossDomain = "use-credentials"`, z-index of
  the annotation layer (under the outlines), created hidden with a blank URL.
- Showing/hiding, the XY/Z/Time location, the file revision and the
  share-link token re-sync immediately. Colormap, range and threshold change
  the existing layer's URL after a 150 ms debounce. Opacity is
  `layer.opacity()` only.
- A hidden map's layer is deleted. A location the map has no array for hides
  the layer and requests nothing. Layers of deleted maps or another dataset
  are deleted on the next sync; all are deleted on unmount, and only while
  the map still holds them (an unroll toggle replaces the map).
- Disabled while unrolled, like the transcript overlay.
- **Layer order.** The util registers every overlay layer (the scalar maps,
  and the transcript heat maps and point layer). `ImageViewer.draw()` calls
  `orderLayersAboveImages` to keep image layers at the bottom, then the
  registered overlays in their order, then the annotation stack. GeoJS
  creates a new layer on top, so when a display layer was added while a map
  was shown, the new image layers covered it (hidden in the Normal blend);
  only the annotation stack used to be raised.
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
- **Ties.** The selection is inclusive, so a value shared by many cells counts
  with the selected side. Only when the cutoff sits on a run of equal
  percentiles and that makes the selected share differ from the request does
  the readout add "50% requested, more selected because of ties at the
  cutoff".
- **Worker forms.** The value form prints the cutoff with 9 significant digits
  (round-trips float32). The percent form is exact only when it is a whole
  percentile whose stored value is the cutoff (the worker thresholds `Top
  percent N` at `percentiles[100 - N]`); otherwise it is marked approximate.
- **Legend** gradients come from the server's tables through
  `GET upenn_annotation/color_by_property/options`, loaded once; there is no
  client copy to drift.
- The panel lists maps only while visible (palette content is always
  mounted).
- **Delete confirmations are sessions.** The palette lives as long as the
  app, so a dialog can outlive its dataset (browser Back/Forward) and a
  request can outlive its dialog (Escape while deleting). Closing the dialog
  or switching datasets ends the session; a request's result applies only to
  the session that started it; and only a map of the dataset on screen can be
  confirmed.
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
- [ ] **One malformed map never loses the list.** Percentiles are required (101 finite, non-decreasing) on both sides. — *"skips a malformed map instead of losing the list"*, *"rejects %s"*, *"testMetaValidation"*
- [ ] **Delete beats an in-flight list.** A list response captured before a delete must not bring the map back. — *"does not let a list captured before a delete bring the map back"*
- [ ] **Display state resets with the dataset, survives a re-list, and is re-derived for a rewritten file.** — *"resets with the dataset and keeps display settings across a re-list"*, *"re-derives range and threshold when a map's file changes, keeping how it is shown"*

### List freshness

- [ ] **The list is fetched on every dataset (re)open, not once per id.** With no maps listed, the button that would reveal a new one is hidden. — *"offers Map Layers only with saved maps, and keeps it reachable after a failed lookup"*
- [ ] **Any job ending on the open dataset re-lists, failed and canceled included** (the worker deletes the old map before uploading; a run that dies in between still removed it); another dataset's job does not. — *"lists the open dataset's maps again when a job on it %s"*, *"does not list for another dataset's job"*
- [ ] **A burst of finished jobs is one GET** (trailing 1 s debounce). — *"lists once for a burst of finished jobs"*
- [ ] **The button does not flash.** `loading` counts as available only during the first list for a dataset; a re-list of a dataset known to have no maps keeps the button hidden. A failed re-list keeps the last good list, and a retry keeps the error (and the button) until it lands. — *"offers the palette during the first list only, not on a re-list of a dataset with no maps"*, *"keeps the last good list and stays offered while a failed re-list is retried"*
- [ ] **The palette lists only while shown.** — *"lists maps only while shown, and again for a new dataset"*
- [ ] **Concurrent callers share one request.** Opening a dataset with the palette open must not send two. — *"shares a request in flight for the same dataset unless forced"*, *"lists again for every call once the previous one finished"*

### Access

- [ ] **List and tiles need READ; delete needs WRITE and refuses non-maps.** — *"testListReturnsOnlyValidMapsAndEnforcesRead"*, *"testTileEnforcesRead"*, *"testDeleteNeedsWriteAndRefusesNonMaps"*
- [ ] **Revalidated tiles re-check READ.** A 304 is answered only after the access check. — *"testTilesRevalidateWithEtag"*
- [ ] **Share views put their token on the tile URL.** — *"adds the threshold, version and share-view token only when set"*
- [ ] **Delete is offered only to sessions that can write.** — *"offers delete only to sessions that can write"*
- [ ] **Bad parameters are 400s, not 500s.** — *"testTileBadRequests"*, *"testRepeatedParamIs400"*

### Rendering

- [ ] **Sampling is bilinear and NaN-aware**, and off-array, off-image and NaN pixels are transparent. — *"testSamplingMatchesBruteForce"*, *"testNanNeighborDoesNotPoisonValidPixel"*, *"testOutsideArrayIsNan"*, *"testTileColorsNanAndOutside"*, *"testTileAtLowerLevel"*
- [ ] **The threshold comparison is inclusive on both sides**, matching the worker and the panel's tie readout. — *"testThresholdIsInclusive"*, *"testTileThresholdBothSides"*
- [ ] **A constant map renders.** Its range is widened to `[v - 0.5, v + 0.5]` by the server's default and by the client's default and Reset (the client used to send `min == max`, a 400 on every tile). — *"testDefaultRangeOfConstantMap"*, *"widens a constant map's range by the server's rule"*, *"widens a constant map's default range and its reset range"*
- [ ] **A replaced file is never served stale**, by the server cache, the ETag or the client URL. — *"testCacheNotStaleAfterFileReplaced"*, *"re-syncs at once when the file's revision or the share-view token changes"*
- [ ] **A same-size in-place replacement on an assetstore without checksums is not stale.** The file identity includes the file's `created`, which Girder rewrites on in-place replacement. — *"testSameSizeReplacementWithoutChecksumIsNotStale"*
- [ ] **A metadata-only correction of the geometry changes the revision and the ETag**, so browsers do not revalidate onto misplaced tiles. — *"testMetadataOnlyEditChangesRevisionAndEtag"*
- [ ] **The legend comes from the server's colormap tables**, the ones the tiles are rendered from. — *"draws the legend from the server's colormap table"*, *"loads the legend tables once and retries after a failure"*, *"testColormapEndpointsMatchAnchors"*

### Reading and cost

- [ ] **A file above Girder's 16 MiB single-read limit renders** (chunked read). — *"testFileOverGirderSingleReadLimit"*
- [ ] **Concurrent cold loads share one read**, and a load in flight during a delete does not cache its result. — *"testConcurrentColdLoadsShareOneRead"*, *"testLoadInFlightDuringInvalidateIsNotCached"*
- [ ] **One archive read in flight per file**, even for different locations (a Z/Time scrub), and a load holds the decoded array, not the archive. — *"testDifferentLocationsOfOneFileLoadOneAtATime"*
- [ ] **The array cache stays within its byte budget.** — *"testCacheStaysWithinBudget"*
- [ ] **The file is read strictly as a ZIP with one explicit member**, checked and decoded from the same member. — *"testBareNpyIsRefusedWithoutDecoding"*, *"testChecksAndDecodesTheSameExplicitMember"*, *"testReadRejectsBadArrays"*, *"testFortranOrderMember"*
- [ ] **A crafted archive is a 400, not a 500**: an encrypted member or an unknown compression method. — *"testEncryptedMemberIsRefused"*, *"testUnsupportedCompressionIsRefused"*, *"testCraftedArchiveIs400"*
- [ ] **A location without data requests nothing.** — *"never creates a layer for a map with no data at the current location"*, *"follows the viewer's location and requests nothing where the map has no data"*
- [ ] **Opacity is a restyle only**: no URL change, no new layer. — *"only restyles on an opacity change"*
- [ ] **Slider-driven URL changes reuse the layer and are debounced.** — *"updates the URL of the same layer on range, colormap and threshold changes, debounced"*

### Overlay lifecycle

- [ ] **One layer per shown map, with the shared heat-map setup; deleted when hidden, deleted, or unmounted.** — *"creates one layer per visible map with the shared heat-map setup"*, *"removes a layer when its map is hidden or deleted, and on unmount"*
- [ ] **Layers are not deleted twice from a map that already exited them.** — *"does not delete layers again from a map that already exited them"*
- [ ] **TranscriptOverlay is unchanged by the shared layer util.** — *"creates heat-map layers that keep only the current level"*, *"draws one heat map per gene in its own color and deletes removed ones"*
- [ ] **Overlays stay above display layers added after them** (scalar maps and transcript heat maps and points), and under the annotation stack; the ordering step is a no-op when nothing moved. — *"keeps overlays above display layers added after them"*, *"keeps several overlays in their order and any registered layer counts"*, *"does nothing when the order is already right"*, *"orders the annotation stack above the images as before when there is no overlay"*

### Panel semantics

- [ ] **Sliders over map values use integer positions**, so a tiny range (1e-7) does not round to 0 in Vuetify. — *"maps integer positions over [%d, %d] without losing values"*, *"drives value sliders with integer positions, even on a tiny range"*, *"gives a constant map a usable slider range"*
- [ ] **The copyable worker threshold reproduces the preview.** The value form is exact; a percent form that is not a whole stored percentile is marked approximate. — *"gives a whole percentile exactly and the value at full precision"*, *"marks a fractional or derived percent as approximate"*, *"gives the worker the exact cutoff, and marks an inexact percent"*
- [ ] **The picked share is state; the value is derived from it, never the reverse.** — *"keeps the requested share and derives the value; setting a value clears it"*, *"keeps the chosen share as state when set by percent"*
- [ ] **Ties are reported, not hidden, and only real ties.** The readout labels the share as an estimate over all positions, and mentions ties only when the cutoff sits on a run of equal percentiles. — *"counts tied values with the selected side, as the inclusive cutoff does"*, *"says when ties select more tissue than was asked for"*, *"calls a difference a tie only when the cutoff sits on a run of equal percentiles"*, *"reads the threshold as a value and as a share of tissue"*
- [ ] **Percent and value agree with the worker at whole percentiles.** — *"reads whole percentiles exactly, as the worker does"*, *"round-trips value -> share -> value without ties"*
- [ ] **Every whole percent maps exactly to its stored percentile, reported exact** (no float noise at 7, 14, 28, 29, 55–58), and a tie run starting there is included. — *"maps every whole percent to exactly its stored percentile, reported exact"*, *"includes a tie run that starts at a whole percentile"*
- [ ] **The range thumbs stay one position apart** instead of a collapsed range being dropped. — *"keeps the range thumbs at least one position apart instead of dropping the update"*, *"keeps the range one position wide instead of dropping a collapsed range"*
- [ ] **A delete confirmation belongs to its dataset and its session.** A dataset switch closes it, a previous dataset's map is never deleted, and a late result never closes or writes into a later confirmation. — *"closes a pending confirmation on a dataset switch and never deletes the previous dataset's map"*, *"applies a delete's result only to the confirmation that started it"*
- [ ] **A map missing descriptive fields still shows sensibly** ("Untitled map", absent parts left out) and is not rejected. — *"falls back for a map missing its descriptive fields"*

### Symmetric pairs — change one, check the other

| Path | Twin |
|---|---|
| the client's default display range | its Reset, and the server's default when `min`/`max` are omitted |
| the range slider | the value-threshold slider (both on integer positions) |
| the percent slider | the value slider (which one owns `threshold`) |
| a delete's effect on the list | a list request already in flight |
| the tile ETag inputs | the client's URL inputs (revision, token, every display parameter) |
| `TranscriptOverlay` density layers | `ScalarMapOverlay` layers (one shared setup util) |
| the app-bar button's availability | the command-palette entry's `isAvailable` |
| a job that succeeds | a job that fails or is canceled (both re-list) |
| the annotation stack in the viewer's ordering step | the registered overlays (raised first) |
| the range slider's low thumb | its high thumb (whichever moved is the one held back) |

### Process rules this feature proved

- [ ] **Verify in the live app, from a fresh page load, on a dataset that has a saved map.** Unit tests of an isolated store module cannot see a mutation name another module also declares; only the live app showed every list failing.
- [ ] **Confirm each new test fails without its fix** (revert only the fix, never the whole file) before trusting it. The name-collision, delete-vs-list and job-refresh tests were each checked this way.
- [ ] `pnpm tsc`, `pnpm lint:ci`, `pnpm test` (the frontend suite also checks this checklist's citations), `tox` for backend changes, and `python3 plugins/nimbusimage/scripts/sync_skills.py --check` if a skill changed.
