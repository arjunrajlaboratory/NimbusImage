# Hotspot Regions: Worker + Map Layer — Spec

Two parts, in two repos:

- **Part A, the worker** (§2–§7): **ImageAnalysisProject**,
  `workers/annotations/hotspot_regions/`. Computes the map, the region
  polygons, and membership. Useful on its own.
- **Part B, the map layer** (§8): **NimbusImage**. Shows the worker's saved map
  as a heat-map overlay, like the transcript density layer, with a live
  threshold preview. Builds on Part A's saved map; ship it second.

Status: Part B is implemented in NimbusImage (see `SCALAR_MAP_LAYER.md`,
which supersedes §8 where they differ); Part A is built in
ImageAnalysisProject and is not tracked here. Requested by Dale Brokaw (Shaffer lab), Slack
`#CKLU4RM18`, thread of 2026-11-06. His answers of 2026-11 are folded in (§10).

## 1. Problem

Users want to find **regions of tissue where cells, on average, share a quality**
("where are the large cells?", "where is marker X high?"), turn those regions
into objects, and then work with **every cell inside a region regardless of
that cell's own value**. Color by property cannot do this: it colors each cell
by its own value and never aggregates neighbors into a region.

Two concrete asks from the user:

1. **Property hotspots.** Smooth any per-cell metric (area, intensity, …) over
   space, threshold the smoothed map, and draw a polygon ("hotspot blob")
   around each hotspot. "All cells in the large-cell hotspot" is a different
   set from "all large cells", and the user wants the former.
2. **Proximity regions.** "I have bile duct cells but want all cells within
   100 µm of a bile duct cell AND a bile duct node drawn": a blob covering
   everything within *r* of cells with tag X, with member cells linked to it.

Both must be quick to re-run with different metrics, radii, and thresholds.
Today this is done by hand.

### Reference method

Dale pointed at *Informed spatially aware patterns for multiplexed
immunofluorescence data* (ISPat, Sci Rep 2026,
https://www.nature.com/articles/s41598-026-35341-8). The relevant part is its
first step only:

- per cell type, a 2D isotropic Gaussian kernel density estimate of cell
  positions on a 70 × 70 µm grid, with bandwidth chosen by leave-one-out CV and
  edge correction;
- each tissue is partitioned into **five regions by density quantile**
  (Area 1 = 80–100th percentile … Area 5 = 0–20th).

The paper's Gaussian-process / interaction-network modeling is **out of
scope**. The worker generalizes step 1 from "density of one cell type" to "any
per-cell metric", and adds the proximity mode.

## 2. Deliverable overview

One **annotation worker**, `hotspot_regions`, with two modes:

| Mode | Map that is thresholded | Typical question |
|---|---|---|
| `Property hotspot` | smoothed neighborhood statistic of a per-cell property (or plain cell density) | where are cells large / bright / dense? |
| `Proximity to tag` | distance to the nearest cell carrying a seed tag | which cells are within 100 µm of a bile duct cell? |

Outputs (all optional except the polygons):

1. **Region polygons**: one polygon annotation per connected region, tagged.
2. **Membership connections**: region polygon (parent) → each member cell
   (child), via `createMultipleConnections`.
3. **Membership tag**: append a tag to every member cell, via bulk
   `PUT /upenn_annotation/multiple`.
4. **Saved map** (property mode): the smoothed map itself, uploaded as a file
   for the Nimbus map layer (§5.8, §8).

Because the outputs are ordinary annotations, tags, and connections, the
existing Nimbus features apply with no frontend work: filters, Selection
Summary, connection-based properties (e.g. children count), blob property
workers run on the region polygons, and CSV/JSON export.

## 3. Interface

Build with the conventions in ImageAnalysisProject `CLAUDE.md`
(`interface(image, apiUrl, token)`, `notes` first, `displayOrder` on every
field). The field names below are the exact keys that `compute` reads.

| Field | Type | Default | Notes |
|---|---|---|---|
| `Hotspot regions` | notes | — | One paragraph plus a docs link. |
| `Mode` | select | `Property hotspot` | `Property hotspot`, `Proximity to tag` |
| `Cell tags` | tags | — | **Required.** The cells to analyze, used as the population for smoothing and membership. Point and polygon annotations both count; centroid = point / polygon centroid. |
| `Property` | text | `""` | Property mode. Empty = plain cell density. Otherwise `Property name` or `Property name/sub/key` for nested values (e.g. `Blob metrics/Area`). Resolved by name; see §5.2. |
| `Statistic` | select | `Mean` | Property mode. `Mean` (are cells here large on average?), `Fraction above cutoff` (what fraction of cells here exceed `Cutoff`? e.g. "at least 75% of cells are positive"), `Sum` (is there a lot of total area here?), `Density` (cell count, ignores Property). |
| `Cutoff` | number | 0 | Only for `Fraction above cutoff`: a cell counts as positive when its value ≥ `Cutoff`. The map is then a fraction in [0, 1], so use `Value at least` with e.g. 0.75. |
| `Seed tags` | tags | — | Proximity mode. **Required** there. The "bile duct" cells. |
| `Radius (µm)` | number | 50 | Property mode: Gaussian σ of the smoothing kernel. Proximity mode: the distance threshold. Converted to pixels with `params['scales']['pixelSize']`; see §5.3. |
| `Threshold type` | select | `Top percent of tissue` | Property mode. `Top percent of tissue`, `Bottom percent of tissue`, `Value at least`, `Value at most`, `Quantile bands (5)` |
| `Threshold` | number | 20 | Percent for the percent types, absolute value for the value types, ignored for bands. |
| `Min seed cells per region` | number | 1 | Proximity mode. Drop regions containing fewer seed cells (suppresses isolated single seeds). |
| `Min region area (µm²)` | number | 0 | Drop smaller polygons. |
| `Connect members to region` | checkbox | true | Output 2. |
| `Tag members` | text | `""` | Output 3. Empty = do not tag members. Otherwise the tag appended to every member cell. |
| `Save map layer` | checkbox | true | Property mode. Upload the smoothed map for the Nimbus map layer; see §5.8. |
| `Create regions` | checkbox | true | Off = save the map only, to look at it in Nimbus and choose a threshold before making any polygons. |
| `Replace previous run` | checkbox | true | See §5.7. |

Use `annotation_tools.get_required_select()` for every `select` and validate
`tags` as lists, per the interface pitfalls in ImageAnalysisProject
`CLAUDE.md`. On invalid input: `sendError(...)` then **`raise`**, so the job
is recorded as ERROR, not SUCCESS.

Output polygon tags: `params['tags']` (the tool's own tags) plus an
automatic descriptive tag, e.g. `hotspot: Blob metrics/Area mean top 20%`, or
`within 100 µm of bile duct`. For quantile bands, add `band 1` … `band 5`
(band 1 = highest, matching the paper's "Area 1").

Docker labels: `isUPennContrastWorker`, `isAnnotationWorker`,
`isGPUWorker="false"`, `annotationShape="polygon"`,
`interfaceName="Hotspot Regions"`, `interfaceCategory="Spatial analysis"` (or
an existing category if one fits better), `description`, `defaultToolName`.
Base image: `nimbusimage/worker-base` (numpy/scipy/shapely/scikit-image;
add `rasterio` only if the contour route in §5.5 needs it).

## 4. Algorithm

Process each location group `(XY, Z, Time)` independently. Never mix XY
positions. Mirror `connect_to_nearest`'s grouping.

### 4.1 Property hotspot

Inputs per group: cell centroids `p_i` in pixels and values `v_i` (for
`Density`, `v_i = 1`).

1. **Grid.** Cell size `h = σ / 4` pixels, clamped so the grid is at most
   ~4096 cells on its long side. Extent = the image bounds (`sizeX`, `sizeY`
   from the tile metadata), not the cell bounding box, so polygons line up
   with the image.
2. **Bin.** `W = histogram2d(p, weights=1)` and `S = histogram2d(p, weights=v)`.
   Drop cells with missing or non-finite `v` and report how many with
   `sendWarning`.
3. **Smooth.** `Ŵ = gaussian_filter(W, σ/h, mode='constant')` and the same for
   `Ŝ`.
4. **Statistic.**
   - `Density`: `M = Ŵ / (h² · pixelArea)` → cells per µm².
   - `Sum`: `M = Ŝ / (h² · pixelArea)` → value per µm².
   - `Mean`: `M = Ŝ / Ŵ` (a Nadaraya–Watson kernel-weighted mean). The ratio
     cancels edge effects, which is the edge correction the paper does
     separately.
   - `Fraction above cutoff`: `Mean` with `v_i` replaced by
     `1 if v_i ≥ Cutoff else 0`.
5. **Support mask (tissue).** Grid cells where `Ŵ ≥ τ`, with
   `τ = 0.5 / (2πσ²/h²)`, i.e. at least about half a cell's worth of kernel
   mass nearby. Outside the mask `M` is undefined: empty background must not
   become a "low-density hotspot", and `Mean` must not divide by ~0. All
   percentiles are computed over masked grid cells only, so "top 20% of
   tissue" means top 20% of tissue *area*, matching the paper's partition.
6. **Threshold** → boolean map `B` (or five band maps), intersected with the
   support mask.

Bandwidth is user-chosen, not LOO-CV: users iterate on it, and a radius in
µm is easier to reason about. Auto-bandwidth can be added later (§9).

### 4.2 Proximity to tag

1. Seeds = cells in the group with any `Seed tags`. Geometry = the polygon if
   the seed is a polygon, otherwise its point.
2. `region = unary_union([g.buffer(r) for g in seeds])` with
   `r = radius in px`. For large seed counts, buffer in chunks and union
   pairwise, or use `shapely.union_all` (shapely ≥ 2). Measure on 10⁵ seeds.
3. Split into connected polygons. Drop those with fewer than
   `Min seed cells per region` seeds inside.

This mode needs no grid, so its polygons are exact.

Setting `Seed tags` equal to `Cell tags` gives **colonies**: every group of
cells chained together within *r* becomes one region, and its cells share a
connection and tag (the requester's organoid/colony case).

### 4.3 Polygons from a raster (property mode)

`skimage.measure.find_contours` on the padded boolean map, or
`rasterio.features.shapes`, then convert grid coordinates to image pixels
(`x = col · h + x0`, mind the 0.5-pixel and x/y conventions in
ImageAnalysisProject `CLAUDE.md`), then `shapely` `make_valid`, then
`simplify(h / 2)`, then drop polygons under `Min region area`.

**Holes.** Nimbus polygons are a single ring, with no interior rings. Emit
the exterior ring only, and compute membership against the full polygon
(holes included) so that a cell in a hole is **not** a member. Say this in the
worker doc: the drawn blob can visually cover a hole whose cells are not
connected.

### 4.4 Membership

A cell is a member of a region if its centroid lies in the region polygon
(with holes, §4.3). Use `shapely.STRtree` or `shapely.contains_xy`
vectorized. Do not loop `polygon.contains` per cell. Every cell in `Cell tags`
is eligible, not only cells above threshold. That is the point of the
feature.

In proximity mode, the seed cells themselves are members.

## 5. Implementation notes

### 5.1 Loading cells

`annotationClient.getAnnotationsByDatasetId(datasetId, shape=..., tags=json.dumps(cellTags))`
for `point` and `polygon`. Pass no `limit`: the client pages through the whole
dataset, while an explicit limit truncates. Filter again with
`annotation_tools.get_annotations_with_tags(..., exclusive=False)`.

### 5.2 Resolving `Property` to values

There is **no property-picker interface type** today: worker interface types
are number, text, tags, layer, select, channel, channelCheckboxes, checkbox,
and notes, and `interface()` has no dataset context, so a dynamic `select`
cannot list the dataset's properties. v1 uses a `text` field:

1. Load the configuration (`params['configurationId']`) and its `propertyIds`.
   Load those properties in **one** call (`POST /annotation_property/batch`
   with body `{ids: [...]}`), not one request per id.
2. Split the user string on `/`: the first segment matches property `name`
   (case-insensitive, trimmed), and the rest is the sub-key path into nested
   values.
3. No match, or more than one match → `sendError` listing the available
   property names, then `raise`.
4. Fetch values with `POST /annotation_property_values/batch`, body
   `{datasetId, annotationIds, propertyPaths: [[propertyId, *subkeys]]}`,
   chunked (e.g. 50K ids per request) to keep request and response sizes
   sane. The server's id cap is far higher. Do **not** use
   `getPropertyValuesForDataset`: it pages every property of every
   annotation, which is far too much on a 700K-cell dataset.
5. A value that is still a dict after the path is applied means the user
   stopped too early (e.g. `Blob intensity` without a channel key). Report the
   available sub-keys.

Follow-up in **NimbusImage**, not needed for v1: a `property` worker-interface
type, rendered as the existing property-path picker and returning
`[propertyId, ...subkeys]`. Once it exists, switch the field and keep
accepting the text form for saved tools.

### 5.3 Units

`params['scales']['pixelSize']` is `{'unit': 'mm' | 'µm' | 'nm' | ..., 'value': v}`.
Convert µm → px, reusing the unit logic of `convert_units` in
`blob_metrics_worker/entrypoint.py` (move it into `annotation_utilities` rather
than copying it). If the scale is missing or zero, `sendWarning` and treat the
radius as **pixels**. Put the unit actually used into the automatic output
tag, so a result is never silently in the wrong unit.

### 5.4 Writes, batched

- Polygons: one `createMultipleAnnotations` per job. Polygons get `channel`
  from `params['channel']` and `location` from their group.
- Connections: one `createMultipleConnections` (chunk it if it is large).
  Shape: `{parentId: regionId, childId: cellId, datasetId, tags: [...]}`.
  Copy the connection shape from `connect_to_nearest`.
- Member tags: `PUT /upenn_annotation/multiple` with
  `[{_id, tags: existing + [tag]}]`, chunked. Add a thin
  `updateMultipleAnnotations` method to `annotation_client` if none exists.

No per-item loops of single-object calls, per the repo-wide rule.

### 5.5 Progress, warnings, errors

`sendProgress` per location group. `sendWarning` when there are no cells,
no seeds, an empty threshold, or dropped non-finite values. `sendError` +
`raise` on misconfiguration.

### 5.6 Performance targets

- 700K cells, one location, σ = 50 µm: under 60 s end to end, excluding
  network fetch. The grid is ≤ 4096²; `gaussian_filter` on that is a few
  seconds.
- Proximity with 10⁵ seeds: measure the union. If it is slow, union per
  spatial tile.

### 5.7 Re-running

Re-running with new parameters must not pile up stale regions. Mark every
polygon this tool creates with a stable tag `hotspot-run:<toolId>` (from
`params['id']`). With `Replace previous run`, first delete polygons carrying
that tag, plus their connections, with `deleteMultipleAnnotations`, and
remove that run's member tag from cells. Use **only** that tag, never the
user-facing tags, so a user's own annotations are never deleted.

### 5.8 Saving the map (the contract with Part B)

In property mode with `Save map layer`, upload one file per run to the dataset
folder and describe it in the item's metadata. Part B reads only this.

- **File**: `hotspot_map_<toolId>.npz` (`numpy.savez_compressed`), holding one
  float32 array per location group, keyed `xy{XY}_z{Z}_t{Time}`. Values
  outside the support mask (§4.1 step 5) are `NaN`; every other value is
  finite (no `+-inf`). Save float32, not float64: the layer compares
  thresholds against the float32 values, and refuses float64 rather than
  round it (a float64 0.7 would become 0.699999988 and miss a 0.7 cutoff).
- **Not an image.** `GirderAPI.getImages()` treats every large-image item in
  the dataset folder as a source of the dataset, so a TIFF there would be
  picked up as dataset data. An `.npz` is not a large image. Verify after the
  first upload that the item has no `largeImage` field and the dataset still
  opens normally.
- **Item metadata**, key `nimbusScalarMap`:

  ```json
  {
    "version": 1,
    "toolId": "...", "name": "Blob metrics/Area mean, 50 µm",
    "property": "Blob metrics/Area", "statistic": "Mean", "cutoff": null,
    "cellTags": ["cell"], "radius": 50, "radiusUnit": "µm",
    "gridSpacingPx": 12.5, "originPx": [0, 0], "shape": [rows, cols],
    "locations": [{"XY": 0, "Z": 0, "Time": 0, "key": "xy0_z0_t0"}],
    "valueRange": [min, max],
    "percentiles": [p0, p1, ..., p100],
    "units": "µm²"
  }
  ```

  Geometry: `array[row, col]` covers image pixels
  `x ∈ [originPx[0] + col·gridSpacingPx, originPx[0] + (col+1)·gridSpacingPx)`
  and the same in `y` with `row` and `originPx[1]`. `shape` is `[rows, cols]`.

  `percentiles` are the 0th–100th percentiles of the masked values, pooled
  over locations, so the layer can convert "top 20% of tissue" to a value
  without loading the array. They are **required**: exactly 101 finite,
  non-decreasing numbers. Compute them and `valueRange` from the float32
  values that are saved, not from a float64 intermediate, so a cutoff at a
  stored percentile compares equal to the cells it came from.

  The server validates this object (`validateScalarMapMeta`): version 1,
  `gridSpacingPx > 0`, finite numbers, `valueRange` with min ≤ max, at least
  one location, unique keys matching `xy\d+_z\d+_t\d+`, and at most 32M
  cells. An item that fails, or that holds more or fewer than one file, is
  not listed. Each `.npz` member must be a 2-D float32 (or float16) array
  of exactly `shape`, finite or NaN, stored or deflated, with an
  `.npy` header of at most 10,000 bytes (anything `np.savez` writes). The
  archive may hold at most 16,384 entries and a 2 MiB central directory,
  and the file at most 512 MiB. See `SCALAR_MAP_LAYER.md`.
- `Replace previous run` deletes the tool's previous map item (match on
  `nimbusScalarMap.toolId`) before uploading.
- Upload with `gc.uploadFileToFolder` + `gc.addMetadataToItem`, as
  `histogram_matching` does.

Proximity mode saves no map: its regions are exact polygons, and there is
nothing to threshold.

## 6. Tests (pytest, mocked `annotation_client`, `tests/`)

Pure functions should take numpy/shapely in and return polygons/ids out, so
most tests need no mocks.

1. Two Gaussian blobs of large cells in a field of small cells, `Mean`
   statistic, top 20% → two polygons, centered on the blobs.
2. Uniform cell density with a dense patch, `Density` → one polygon over the
   patch. Empty background is **never** selected, even with `Bottom percent`.
3. Membership is independent of the cell's own value: a small cell inside the
   large-cell hotspot is a member, and a large cell outside is not.
4. Quantile bands: five disjoint band polygons whose masked areas are about
   20% each.
5. Proximity: two seed clusters farther apart than 2r → two regions. Closer
   than 2r → one. `Min seed cells per region = 2` drops a lone seed.
6. Hole: an annulus-shaped hotspot. The cell in the hole is not a member, and
   the drawn ring is the exterior.
7. Units: the same physical radius gives the same result at two pixel sizes.
   Missing scale → warning, radius in px.
8. Locations: cells at XY=0 and XY=1 never share a region.
9. Property resolution: nested path, unknown name (the error lists names),
   ambiguous name, and a path that stops at a dict.
10. Replace previous run deletes only `hotspot-run:<toolId>` polygons.
11. Interface pitfalls: null `select`, tags as a list, `raise` after
    `sendError` (job → ERROR).
12. `Fraction above cutoff`: a patch where 80% of cells exceed the cutoff is
    found by `Value at least 0.75`; a patch at 50% is not.
13. Colonies: `Seed tags` = `Cell tags` yields one region per chained group.
14. Saved map: array keys match `locations`, arrays are float32, NaN
    outside the mask and finite elsewhere, `percentiles[80]` equals the threshold used by `Top percent 20`, and
    `Create regions` off writes the map and no annotations.

Plus a live check on a real dataset: run it, then confirm in Nimbus that the
polygons overlay the expected tissue, the connections show on hover or
selection, and the member tag filters correctly.

## 7. Documentation

- `workers/annotations/hotspot_regions/HOTSPOT_REGIONS.md` following the
  repo's doc template (how it works, interface table, outputs, holes caveat,
  units, re-run behavior).
- Add a row to `REGISTRY.md`.
- Add an entry to `build_workers.sh` and the docker-compose test service.

## 8. Part B: the map layer (NimbusImage)

### 8.1 Why a layer as well as a worker

The worker alone makes the user choose a radius and threshold blind, then run
a job to see the result. The layer shows the smoothed map over the image
first, so the threshold is chosen by eye and regions are created once. It is
also the "density map overlaid in Nimbus" the requester asked for in so many
words. The worker stays the place where the map is computed and where
polygons and membership are written; the layer only displays.

The precedent is the transcript density heat map in the spatial plugin
(`SPATIAL_PLUGIN.md`, Phase 3; `TranscriptOverlay.vue`). This layer must
**not** depend on that plugin: it belongs in the annotation plugin and works
on any dataset.

### 8.2 Backend (`upenncontrast_annotation`)

New resource `scalar_map`, API file `server/api/scalarMap.py`, tile rendering
in a helper (`server/helpers/scalarMap.py`), no model: the items are the
records. Implemented; the details (validation, file reading, cache, sampling,
limits) are in `SCALAR_MAP_LAYER.md`.

| Route | Returns |
|---|---|
| `GET scalar_map?datasetId=` (READ on the dataset) | `[{itemId, updated, revision, meta}]` for every valid map item directly in the dataset folder that holds exactly one file. One `Item().find` plus one batched `File().find`. `revision` changes whenever the file changes; clients put it in tile URLs. |
| `GET scalar_map/{itemId}/tiles/{z}/{x}/{y}` (READ) | PNG tile. Params: `location` key, `sizeX`, `sizeY`, `tileSize` (256/512/1024), `maxLevel`, `colormap` (viridis/magma/inferno/gray), `min`, `max`, `threshold?`, `thresholdSide?` (`above`/`below`). `Cache-Control: private, max-age=0, must-revalidate` with an ETag; a 304 is sent only after the READ check. |
| `DELETE scalar_map/{itemId}` (WRITE) | removes the map item and its cached arrays; 400 for an item the list would skip (invalid metadata, or not exactly one file). |

Tile rendering:

- Arrays are decoded once into a process-wide byte-bounded LRU (512 MiB),
  keyed by file revision, with single-flight cold loads. The file is read in
  chunks, because Girder refuses a single read above 16 MiB.
- Render on the **image's** tile pyramid (`sizeX`/`sizeY`/`maxLevel` from the
  client, as the transcript density route does), sampling the map through
  `gridSpacingPx` and `originPx`, bilinear and NaN-aware. This keeps the
  GeoJS layer setup identical to the transcript heat map.
- Color: `colormap` between `min` and `max`; `NaN` is fully transparent.
  Without `min`/`max`, `valueRange` is used, widened to `[v - 0.5, v + 0.5]`
  for a constant map.
- With `threshold`: pixels on the selected side keep their color, the rest
  are drawn at low alpha. The comparison is inclusive (`>=` above, `<=`
  below), like the worker's `Value at least` / `Value at most`.
- Validate every param at the boundary (`server/helpers/validation.py`); a
  tile outside the pyramid is a 400. Shared views send their token on the
  tile URL, as the transcript route does.

### 8.3 Frontend

Implemented as described below; `SCALAR_MAP_LAYER.md` has the details and the
regression checklist.

- `src/store/scalarMaps.ts`: the dataset's maps (from the list route), and per
  map: visible, opacity, colormap, display range, threshold. API calls in
  `src/store/ScalarMapAPI.ts`, not in components. Its mutation and action
  names are module-specific (`setScalarMaps`, ...): store modules are not
  namespaced, and a shared name runs in every module that declares it.
- The list is fetched whenever a dataset is opened in the viewer, when the
  palette is shown, after any worker job on the open dataset succeeds, and
  from the palette's Refresh button, so a map the worker just saved appears
  without a reload.
- `ScalarMapOverlay.vue`, mounted by `ImageViewer` beside `TranscriptOverlay`:
  one GeoJS `osm` layer per visible map, under the annotation layer,
  `keepLower = false`, opacity as a restyle (never a refetch). Factor the
  shared layer setup out of `TranscriptOverlay.vue` instead of copying it.
  Follows the viewer's current XY/Z/Time; a map with no array for the current
  location shows nothing.
- `ScalarMapsPanel.vue`, the **Map Layers** palette: list of maps (name,
  statistic, radius), visibility, opacity, colormap, range, a threshold slider
  that can be read as a value or as "top N% of tissue" (from `percentiles`),
  a color bar legend, and delete. Fetch on `:visible`, not `onMounted`
  (palette content is always mounted). The app-bar button and its command
  are hidden when the dataset has no maps, but stay available while the list
  loads or after it failed.
- Ties: the cutoff is inclusive, so when many cells share the cutoff value
  the selected share can exceed the requested one; the panel then shows both
  ("bottom 50% requested, 60% selected (ties)"). A share picked in percent
  mode is kept as state and the value derived from it.
- The legend uses the server's colormap tables (via
  `color_by_property/options`), the same ones the tiles are rendered with.
- The panel shows the threshold in the form the worker takes (`Threshold
  type` + `Threshold`), so the user can copy it into the tool. The value is
  printed in full precision; a percent that is not a whole stored percentile
  is marked approximate. Launching the worker from the panel is a follow-up
  (§9).

### 8.4 Tests and docs

Backend (tox): list returns only map items and honors READ; tile PNG has
transparent NaN, colors at known values, threshold dimming, 400s on bad
params and out-of-pyramid tiles; delete needs WRITE. Frontend (vitest): the
overlay creates/removes layers with visibility, changes URL on
range/threshold/location change and only restyles on opacity; percent ↔ value
conversion. Live check with real clicks on a dataset that has a saved map.
Done: `codebaseDocumentation/SCALAR_MAP_LAYER.md` (with the regression
checklist) and the `scalar_map` row in `CLAUDE.md`'s endpoint table.

## 9. Out of scope / later

- **Create regions from the panel**: a button that runs the worker with the
  map's parameters and the previewed threshold.
- **Region math** (requested): AND / OR / NOT of region polygons, selected by
  tag, written as new polygons (e.g. the zone between two hotspots). A
  separate small annotation worker built on shapely set operations; it works
  on any polygons, not only hotspot regions.
- **Combining metrics** ("any combination of blob metrics"): v2 adds a
  `Property` list; each metric is z-scored over the population, then combined
  with mean, min (AND-like), or max (OR-like), then smoothed. Ask the user
  which combination they mean before building it.
- **Per-cell neighborhood score property**: a companion *property* worker
  that samples the saved map at each cell. Color by property then shows the
  smooth map, and users can threshold it in filters. Cheap once §4.1 exists:
  share the code.
- Automatic bandwidth (LOO-CV as in the paper), Getis-Ord or other formal
  hotspot statistics, 3D (across Z) smoothing.
- The paper's interaction-network modeling.

## 10. Decisions from the requester (2026-11)

1. Default statistic is **mean**. He also asked for "percentage positive"
   hotspots, now the `Fraction above cutoff` statistic.
2. Proximity regions are **one blob per connected cluster** of seed cells. He
   also wants colonies/organoids handled the same way (§4.2).
3. One metric per run is fine for v1. He asked for region math (§9).
