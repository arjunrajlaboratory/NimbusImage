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
  at least one saved map. It also stays visible while the list is loading or
  after listing failed, so a network blip does not hide the feature; without
  maps it is not offered (nor is its command-palette entry).
- Each map shows its name and statistic · property · radius. The checkbox
  shows it in the viewer. While shown, the card offers opacity, colormap
  (viridis, magma, inferno, gray), a color bar, the display range (with
  Reset), and a threshold preview.
- **Threshold preview.** Pick a side (Above / Below) and set the cutoff either
  as a share of tissue ("% of tissue") or as a value. The readout gives both,
  e.g. "Value ≥ 160 µm² · top 20% of tissue". Pixels on the other side are
  dimmed. Below it are the two forms the worker accepts (`Threshold type` +
  `Threshold`), ready to copy.
- **Refresh** (header) lists the maps again. The list also refreshes on its
  own whenever a dataset is opened, when the palette is shown, and after any
  worker job on the dataset succeeds.
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

`revision` (`scalarMapRevision`) is `<file id>-<size>[-<sha512 prefix>]`: a
re-upload gets a new file id and an in-place replacement changes size or
checksum. It keys the tile ETag, the array cache and the client's tile URLs.

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
  are read. Fortran-order arrays are supported.
- **Chunked read.** Girder's `FileHandle` refuses a single `read()` above
  `core.filehandle_max_size` (16 MiB by default), so the file is read in
  chunks of `min(8 MiB, that setting)`. A map file above 16 MiB failed every
  tile before this. Files above `MAX_SCALAR_MAP_FILE_BYTES` (512 MB) are
  refused.

### Array cache

A process-wide LRU of decoded float32 arrays bounded by
`MAX_SCALAR_MAP_CACHE_BYTES` (512 MiB), keyed `(file id, revision,
location)`.

- **Single-flight cold loads.** Concurrent requests for an uncached array
  share one per-key lock: one thread reads and decodes, the others wait and
  then read the cache. A newly shown map otherwise issues one full file read
  per visible tile.
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
  palette is shown, after a worker job on the open dataset succeeds (`jobs.ts`,
  forced), and from Refresh/Retry (forced). A non-forced call shares the
  request already in flight for the same dataset.
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

### Panel semantics

- **Sliders use integer positions** (0–1000) mapped linearly to values.
  Vuetify rounds a slider value to the decimals of `step.toString()`, which is
  zero for a step in exponent notation (below 1e-6), so a float step on a
  tiny range rounded everything to 0.
- **Percent vs value.** `thresholdPercent` holds the share the user picked in
  percent mode, and the value is derived from it (`valueAtPercentile`,
  interpolating the stored whole percentiles). Setting a value clears it.
  Switching side keeps the picked share.
- **Ties.** The selection is inclusive, so a value shared by many cells counts
  with the selected side. `selectedTissueShare` reports what the cutoff
  actually selects, and when that differs from the request the readout says
  so ("bottom 50% requested, 60% selected (ties)").
- **Worker forms.** The value form prints the cutoff with 9 significant digits
  (round-trips float32). The percent form is exact only when it is a whole
  percentile whose stored value is the cutoff (the worker thresholds `Top
  percent N` at `percentiles[100 - N]`); otherwise it is marked approximate.
- **Legend** gradients come from the server's tables through
  `GET upenn_annotation/color_by_property/options`, loaded once; there is no
  client copy to drift.
- The panel lists maps only while visible (palette content is always
  mounted).

## Regression checklist

Every item below was a real defect found in review or live testing, or an
invariant a later fix could undo. Each line names the invariant and the test
that holds it.

Run `pnpm test src/utils/scalarMap.test.ts src/store/scalarMaps.test.ts src/store/ScalarMapAPI.test.ts src/store/__tests__/scalarMapsNameCollisions.test.ts src/store/jobs.test.ts src/components/ScalarMapOverlay.test.ts src/components/ScalarMapsPanel.test.ts src/components/TranscriptOverlay.test.ts src/App.test.ts`, and `tox` in `devops/girder/plugins/AnnotationPlugin` (`test_scalar_map.py`).

### Store

- [ ] **Mutation and action names are unique across store modules.** Found live: the store's `setMaps` cross-fired into the main store's GeoJS `setMaps` (`TypeError: maps.map is not a function`) and every list reported failure. Isolated module tests could not see it. — *"declares no mutation, action or getter another store module declares"*, *"documents why: an un-namespaced mutation name runs in every module declaring it"*
- [ ] **A response from an older request never lands**, including across a dataset switch or clear. The sequence token is claimed before any early return. — *"ignores an answer that lands after a newer (forced) request"*, *"does not let a request for the previous dataset land after the dataset is cleared"*, *"drops a failure for a request that was superseded"*
- [ ] **"Could not ask" is not "no maps".** — *"keeps 'could not ask' distinct from 'no maps', and retries"*
- [ ] **One malformed map never loses the list.** Percentiles are required (101 finite, non-decreasing) on both sides. — *"skips a malformed map instead of losing the list"*, *"rejects %s"*, *"testMetaValidation"*
- [ ] **Delete beats an in-flight list.** A list response captured before a delete must not bring the map back. — *"does not let a list captured before a delete bring the map back"*
- [ ] **Display state resets with the dataset, survives a re-list, and is re-derived for a rewritten file.** — *"resets with the dataset and keeps display settings across a re-list"*, *"re-derives range and threshold when a map's file changes, keeping how it is shown"*

### List freshness

- [ ] **The list is fetched on every dataset (re)open, not once per id.** With no maps listed, the button that would reveal a new one is hidden. — *"offers Map Layers only with saved maps, and keeps it reachable after a failed lookup"*
- [ ] **A succeeded job on the open dataset re-lists** (a new or replaced map appears, a replaced item id disappears); a failed job or another dataset's does not. — *"lists the open dataset's maps again when a job on it succeeds"*, *"does not list for a failed job or another dataset's job"*
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
- [ ] **The legend comes from the server's colormap tables**, the ones the tiles are rendered from. — *"draws the legend from the server's colormap table"*, *"loads the legend tables once and retries after a failure"*, *"testColormapEndpointsMatchAnchors"*

### Reading and cost

- [ ] **A file above Girder's 16 MiB single-read limit renders** (chunked read). — *"testFileOverGirderSingleReadLimit"*
- [ ] **Concurrent cold loads share one read**, and a load in flight during a delete does not cache its result. — *"testConcurrentColdLoadsShareOneRead"*, *"testLoadInFlightDuringInvalidateIsNotCached"*
- [ ] **The array cache stays within its byte budget.** — *"testCacheStaysWithinBudget"*
- [ ] **The file is read strictly as a ZIP with one explicit member**, checked and decoded from the same member. — *"testBareNpyIsRefusedWithoutDecoding"*, *"testChecksAndDecodesTheSameExplicitMember"*, *"testReadRejectsBadArrays"*, *"testFortranOrderMember"*
- [ ] **A location without data requests nothing.** — *"never creates a layer for a map with no data at the current location"*, *"follows the viewer's location and requests nothing where the map has no data"*
- [ ] **Opacity is a restyle only**: no URL change, no new layer. — *"only restyles on an opacity change"*
- [ ] **Slider-driven URL changes reuse the layer and are debounced.** — *"updates the URL of the same layer on range, colormap and threshold changes, debounced"*

### Overlay lifecycle

- [ ] **One layer per shown map, with the shared heat-map setup; deleted when hidden, deleted, or unmounted.** — *"creates one layer per visible map with the shared heat-map setup"*, *"removes a layer when its map is hidden or deleted, and on unmount"*
- [ ] **Layers are not deleted twice from a map that already exited them.** — *"does not delete layers again from a map that already exited them"*
- [ ] **TranscriptOverlay is unchanged by the shared layer util.** — *"creates heat-map layers that keep only the current level"*, *"draws one heat map per gene in its own color and deletes removed ones"*

### Panel semantics

- [ ] **Sliders over map values use integer positions**, so a tiny range (1e-7) does not round to 0 in Vuetify. — *"maps integer positions over [%d, %d] without losing values"*, *"drives value sliders with integer positions, even on a tiny range"*, *"gives a constant map a usable slider range"*
- [ ] **The copyable worker threshold reproduces the preview.** The value form is exact; a percent form that is not a whole stored percentile is marked approximate. — *"gives a whole percentile exactly and the value at full precision"*, *"marks a fractional or derived percent as approximate"*, *"gives the worker the exact cutoff, and marks an inexact percent"*
- [ ] **The picked share is state; the value is derived from it, never the reverse.** — *"keeps the requested share and derives the value; setting a value clears it"*, *"keeps the chosen share as state when set by percent"*
- [ ] **Ties are reported, not hidden.** The readout shows the share the inclusive cutoff selects when it differs from the request. — *"counts tied values with the selected side, as the inclusive cutoff does"*, *"says when ties select more tissue than was asked for"*
- [ ] **Percent and value agree with the worker at whole percentiles.** — *"reads whole percentiles exactly, as the worker does"*, *"round-trips value -> share -> value without ties"*

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

### Process rules this feature proved

- [ ] **Verify in the live app, from a fresh page load, on a dataset that has a saved map.** Unit tests of an isolated store module cannot see a mutation name another module also declares; only the live app showed every list failing.
- [ ] **Confirm each new test fails without its fix** (revert only the fix, never the whole file) before trusting it. The name-collision, delete-vs-list and job-refresh tests were each checked this way.
- [ ] `pnpm tsc`, `pnpm lint:ci`, `pnpm test` (the frontend suite also checks this checklist's citations), `tox` for backend changes, and `python3 plugins/nimbusimage/scripts/sync_skills.py --check` if a skill changed.
