# Annotation Raster Overview — Implementation Specification

**Status: implemented on `claude/annotation-raster-overview-pgci93`.** This
document began as the implementation work order. It now also records the
review corrections and regression coverage for the implementation; the
numbers quoted in §6 are measured, not estimated.

Implementation review and live verification corrected eight details from the
original draft:

- the GeoJS layer is allocated lazily only after the feature is enabled;
- point/line candidate lookup pads tile bounds by their tile-pixel width so
  markers crossing a seam are not culled;
- cached invalid annotation colors retain a validity bit so each request can
  apply its own fallback color without rebuilding geometry;
- authenticated tiles use `private, max-age=0, must-revalidate`, preventing a
  browser from holding another client's edit for an hour;
- history undo/redo explicitly invalidates because it restores annotations via
  raw collection operations;
- point annotations always use their configured screen-space radius rather
  than being routed through the bbox-based sub-pixel polygon path; and
- the server version also contains a 120-second wall-clock bucket; otherwise
  an unchanged per-process ETag could return 304 forever after a write handled
  by another Girder process, bypassing the geometry cache TTL entirely; and
- the read-only tile route explicitly permits Girder cookie authentication.
  GeoJS fetches OSM tiles as images and cannot attach the REST client's
  `Girder-Token` header; without `cookie=True`, private-dataset tiles return
  401 even while the application is logged in.

## 1. Motivation

For datasets with very large annotation counts the frontend already
subsamples what it draws (stub/hydration architecture, see
`codebaseDocumentation/ANNOTATION-STUBS.md`). That keeps the viewer
responsive but means the user never sees _all_ annotations at once. This
feature adds a server-rendered **raster overview**: a tile layer in which
every annotation for the current frame is rasterized (filled shapes, no
strokes) into transparent PNG tiles at up to full image resolution, so the
user can see the complete annotation set cheaply at any zoom, and only
switches to interactive vector annotations when zoomed in far enough for
them to matter.

Design goals:

- **Complete**: every annotation matching the frame is rendered — no
  subsampling.
- **Full resolution**: underlying images can be ~20,000 × 20,000 px; the
  raster must stay crisp until roughly 1 screen pixel per image pixel, at
  which point the existing vector annotation rendering takes over.
- **Cheap to serve**: bounded memory per request, cached geometry, ~ms
  per-tile render after a one-time per-frame fetch.
- **Coarsely interactive**: drag/lasso selection below the switch
  threshold uses the client-side stub centroid index, selects every match,
  and renders a bounded sample of selected stub indicators. Pixel-perfect
  click/hover still requires vectors.

## 2. Architecture decision: tile pyramid, not a single PNG

Four candidate designs were considered. **Only (d) works at 20K×20K with
dynamic annotations.**

a. **Single full-frame PNG served once, displayed as one GeoJS quad**
(like the worker preview). Rejected: a 20,000² RGBA canvas is 1.6 GB on
the server; WebGL `MAX_TEXTURE_SIZE` is typically 8192–16384 (the
codebase itself assumes 4096 in `baseQuadOptions.maxTextureSize`,
`src/store/index.ts:2934`); browsers cap canvas/ImageBitmap area below
400 MP (Safari ~268 MP). A single image cannot be full resolution.

b. **Grid of region PNGs, one quad each** (e.g. 5×5 tiles of 4096²).
Rejected: keeping the full grid resident is ~1.6 GB of GPU textures,
and there is no level-of-detail — the viewer pays full cost even fully
zoomed out.

c. **Materialized large_image item**: render the full-resolution raster
once, store it as a pyramidal TIFF item in the dataset, and let the
existing `large_image` plugin serve its tiles. Tempting because it
reuses the image-serving stack wholesale, but rejected: annotations
change constantly, and every create/edit/delete would require
re-rendering a 20K×20K image and re-encoding a pyramid file (tens of
seconds plus storage churn), whereas dynamic tiles invalidate with a
counter bump. The raster is also parameterized by the visible display-layer
selectors (channel plus the axes each layer fixes), mode, and colors, so
each combination would need its own baked file. (A custom dynamic
large_image tile source is
technically possible, but its API is file/item-oriented; keying one on
frame + filters fights the framework.) Baking a static pyramid could
still return as a pre-warming optimization for read-only published
datasets (§9).

d. **Standard z/x/y tile pyramid endpoint consumed by a GeoJS `osm`
layer.** Chosen. This deliberately mirrors large*image's tile
\_protocol* — the same zxy pyramid semantics and the same client-side
consumption: the viewer already renders all image layers as `osm`
tile layers configured via `geojs.util.pixelCoordinateParams`
(`src/components/ImageViewer.vue:1056-1081`, layer creation at
`:1264`), so GeoJS provides fetching, LOD, viewport culling, tile
caching and eviction for free, exactly as it does for large_image
tiles. The downsampling that large_image performs by reading pyramid
levels from a file is replaced by rendering vector geometry at the
requested tile's scale — vectors downsample for free, so no image
pyramid ever needs to be built, stored, or invalidated. The backend
renders one small PNG per requested tile from an in-memory, per-frame
geometry cache.

## 3. Backend

All paths below are relative to
`devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/`.

### 3.1 Endpoint

New route on the **existing** annotation resource (`server/api/annotation.py`;
no new resource registration in `__init__.py` needed):

```python
self.route("GET", ("raster", ":z", ":x", ":y"), self.rasterTile)
```

→ `GET /api/v1/upenn_annotation/raster/{z}/{x}/{y}?datasetId=...&selectors=[{"channel":0,"XY":0,"Z":0,"Time":0}]&sizeX=20000&sizeY=20000&maxLevel=8&...`

Access control mirrors `stubs` (`server/api/annotation.py:507-523`) but enables
cookie authentication for GeoJS image requests:
`@access.public(scope=TokenScope.DATA_READ, cookie=True)` plus
`Folder().load(datasetId, user=..., level=AccessType.READ, exc=True)`.
Anonymous users get tiles only for public datasets; private datasets return 401. This is safe for the GET-only route and is required because `<img>`
requests cannot attach a `Girder-Token` header. The GeoJS layer uses
`crossDomain = "use-credentials"` so Girder's HttpOnly cookie is sent.

**Query parameters** (validate at the API boundary, per the API/model
separation rules — the model/helper layer receives clean typed values):

| Param            | Type       | Required | Constraint                                                                                                                   | Meaning                                                                                                                                                                                                                                                           |
| ---------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `datasetId`      | ObjectId   | yes      | `requireObjectId`                                                                                                            | dataset folder                                                                                                                                                                                                                                                    |
| `selectors`      | JSON array | yes      | 1 … 64 unique objects; each requires nonnegative integer `channel` and may contain nonnegative integer `XY`, `Z`, and `Time` | union of the annotation predicates for the display layers rendered on this map. Omitted axes match every value, which gives max-merge layers the same annotation projection as their image projection. Selectors are deduplicated and sorted at the API boundary. |
| `sizeX`, `sizeY` | int        | yes      | 1 … 131072                                                                                                                   | full-resolution image extent; the client already has this from `GET item/{id}/tiles`                                                                                                                                                                              |
| `tileSize`       | int        | no       | one of 256 / 512 / 1024; default **512**                                                                                     | output tile edge                                                                                                                                                                                                                                                  |
| `maxLevel`       | int        | yes      | 0 … 30                                                                                                                       | maximum level of the image map's coordinate pyramid; independent of the overview tile size                                                                                                                                                                        |
| `mode`           | str        | no       | `shapes` (default) \| `discs`                                                                                                | true footprints vs. centroid discs                                                                                                                                                                                                                                |
| `color`          | str        | no       | `^#[0-9a-fA-F]{6}$`, default `#FFD700`                                                                                       | fill for annotations whose own `color` is null/invalid                                                                                                                                                                                                            |
| `pointRadius`    | float      | no       | 0.5 … 20, default 3                                                                                                          | point-annotation disc radius in **tile pixels** (constant apparent size across levels)                                                                                                                                                                            |
| `lineWidth`      | int        | no       | 1 … 10, default 1                                                                                                            | line-annotation stroke width in tile pixels                                                                                                                                                                                                                       |
| `v`              | str        | no       | opaque, ≤ 64 chars                                                                                                           | client cache-buster; not interpreted server-side                                                                                                                                                                                                                  |

Invalid values → `RestException` 400. Out-of-range `z`/`x`/`y` → 400.

**Response**: `image/png`, RGBA, exactly `tileSize × tileSize`, fully
transparent background, transparent padding beyond image bounds (no edge
cropping — padding is invisible and simpler). `ETag` header per §3.5;
`If-None-Match` match → 304 with empty body. `Cache-Control: private,
max-age=0, must-revalidate`; the client busts on its own edits via `v`
(§4.6), while mandatory ETag revalidation observes edits from other clients.

Note: `sizeX`/`sizeY` are client-supplied deliberately. The server could
derive them from the dataset's large-image item, but that would couple the
plugin to `girder_large_image` (the test suite unbinds it — see
`unbindLargeImage` fixture) for a value that only affects _that client's_
rendering scale. Wrong values misrender only the caller's own tiles; the
geometry cache key does not include them (§3.4), so there is no
cross-user poisoning. Clamps bound resource use.

### 3.2 Tile geometry

Must match the **image map's** pixel-coordinate pyramid, which is the
coordinate system GeoJS uses to place every layer. `maxLevel` therefore
comes from the image layer params rather than being inferred from the
overview's (potentially different) `tileSize`:

```
scale(z)   = 2 ** (z - maxLevel)          # image px -> level px, z in [0, maxLevel]
levelW     = ceil(sizeX * scale);  levelH = ceil(sizeY * scale)
nTilesX    = ceil(levelW / tileSize);  nTilesY = ceil(levelH / tileSize)
tile (x,y) covers image-space
             [x*tileSize/scale, (x+1)*tileSize/scale) ×
             [y*tileSize/scale, (y+1)*tileSize/scale)
```

At `z == maxLevel` one tile pixel is one image pixel: full resolution.
For example, a map backed by 256 px image tiles can have `maxLevel = 8`
while the overview uses 512 px tiles. Inferring `maxLevel = 7` from those
overview tiles would rasterize coordinates at half the scale GeoJS uses to
position the layer.
Coordinate transform when drawing into tile `(z, x, y)`:

```
tilePx.x = coord.x * scale - x * tileSize
tilePx.y = coord.y * scale - y * tileSize
```

Annotations are stored in full-resolution image pixel coordinates (the
GeoJS map is pixel-coordinate based), so no other projection is involved.

### 3.3 Rendering rules

Renderer: **Pillow + numpy**. Both are already present in the Girder
container (transitively via `large_image`), but add `"Pillow"` and
`"numpy"` to `install_requires` in
`devops/girder/plugins/AnnotationPlugin/setup.py` so the plugin (and the
tox test environment) does not rely on transitive dependencies.

Per tile:

1. Allocate `numpy.zeros((tileSize, tileSize, 4), dtype=uint8)`.
2. Query the frame-geometry cache (§3.4) for candidate annotations whose
   bbox intersects the tile's image-space bbox (via the grid index). Pad that
   lookup by `max(pointRadius, lineWidth) / scale` image pixels so constant
   tile-pixel markers that cross a tile seam are retained.
3. Partition candidates by scaled footprint:
   - **Sub-pixel** (`max(bboxW, bboxH) * scale < 1.5` tile px): splat a
     single pixel into the numpy array at the scaled centroid
     (`arr[iy, ix] = rgba`). This is the critical fast path: at low zoom
     levels _every_ annotation of a dense frame lands here, and 700k
     splats take ~11 ms (measured). Never route sub-pixel shapes through
     `ImageDraw` — 700k `polygon()` calls take ~2.5–3 s.
   - **Visible footprint**: draw with `PIL.ImageDraw` on
     `Image.fromarray(arr)`:
     - `polygon` / `rectangle`: `draw.polygon(pts, fill=rgba)` — **fill
       only, no outline** (explicitly requested: no strokes, avoids
       crowding).
     - `line`: `draw.line(pts, fill=rgba, width=lineWidth)`.
     - `point`: `draw.ellipse` disc of radius `pointRadius` tile px
       (constant across levels, like a screen-space marker).
4. `mode=discs`: every annotation renders as a filled disc at its
   centroid with radius `estimatedRadius * scale` (min 0.5 px, sub-pixel
   splat rule applies). Uses the same centroid/radius definition as the
   `stubs` aggregation (`server/models/annotation.py:256-300`) so the
   overview matches what stub mode draws.
5. Color per annotation: its `color` field if it matches
   `^#[0-9a-fA-F]{6}$`, else the request's `color` param. Alpha 255
   (opaque); overall transparency is applied client-side via layer
   opacity, which keeps PNGs small and blending predictable. Overlaps:
   draw in `_id` order, last wins. No anti-aliasing in v1 (future: 2×
   supersample + downscale, §9).
6. Encode PNG from the final array and return bytes with
   `setRawResponse()` + `setResponseHeader("Content-Type", "image/png")`.

### 3.4 Frame-geometry cache

The dominant cost is not drawing — it is fetching/decoding coordinate
arrays from Mongo (§6). Tiles for the same frame must **not** each re-run
the fetch. New helper module `server/helpers/annotationRaster.py`:

- **Key**: `(datasetId, canonical layer selectors, mode)`. Note
  `sizeX/sizeY/tileSize/maxLevel/z/x/y` are _not_ in the key — geometry is
  stored in image coordinates and scaled at draw time.
- **Build** (on miss): one aggregation via the existing runtime-bounded
  `Annotation()._aggregate` (`server/models/annotation.py:130`, carries
  `maxTimeMS`): `$match {datasetId, $or: [one channel/location predicate per
selector]}`, then

  - `mode=shapes`: `$project {coordinates: 1, shape: 1, color: 1}`,
  - `mode=discs`: the `stubs`-style `$addFields` centroid /
    `estimatedRadius` + `$project {coordinates: 0}`.

  Decode the cursor into numpy: packed float32 vertex array + per-annotation
  offsets, an `(N, 4)` float32 bbox array, a per-annotation RGBA uint32
  array (pre-parsed colors), and a shape-kind array. Expected footprint:
  ~90–110 MB for a 700k-polygon frame (float32, 16 vertices avg).

- **Grid index**: uniform grid (e.g. 64 × 64 cells spanning the union of
  bboxes); each cell holds the indices of annotations whose bbox overlaps
  it. Tile lookup: gather cells overlapping the tile bbox, dedupe, exact
  bbox test. O(candidates) per tile.
- **Concurrency**: a per-key `threading.Lock` makes concurrent requests for
  the same cold selector set trigger exactly one fetch. A process-wide,
  nonblocking build semaphore caps distinct cold builds at one; saturation
  returns retryable 503 instead of accumulating a Mongo/Python work queue.
  Anonymous cold builds are additionally limited per remote IP + dataset;
  cache hits are free.
- **Bounds**: LRU, max 3 entries and max 300 MiB of retained NumPy/spatial-grid
  allocations, plus a TTL of 120 s. Entries are evicted until both limits are
  met; a single over-budget geometry serves its request but is not retained.
  The TTL also bounds staleness in multi-process deployments where the
  in-process invalidation below can't see another process's writes.
- **Invalidation**: entries record the dataset raster-version (§3.5) at
  build time; a lookup whose stored version differs rebuilds.
- **Request-specific fallback colors**: packed colors are cached together with
  a validity bitmap. Invalid/null colors are replaced from the current
  request only after candidate selection; fallback color is intentionally not
  part of the geometry cache key.

### 3.5 Change detection: version registry and ETag

The annotation model has no update timestamps (noted TODO in
`server/models/annotation.py:97-98`), so change detection is a small
in-process registry in `server/helpers/annotationRaster.py`:

- `processUuid`: random UUID at import time (restart ⇒ all ETags change ⇒
  safe cold start, never a stale 304).
- `datasetCounter[datasetId]`: monotonic int.
- `globalEpoch`: monotonic int, folded into every dataset's version.
- `ttlEpoch`: `floor(wallClock / 120 s)`, which changes ETags and geometry
  versions even when a mutation happened in a different server process.

Bump points — override the mutating methods on the `Annotation` model
(every plugin code path funnels through them: `create`/`createMultiple`
call `save`/`saveMany`, the update endpoints call `save`/`saveMany` via
`updateMultiple`, deletes go through `remove`/`removeWithQuery`):

| Override                   | Bump                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save(document, ...)`      | `datasetCounter[saved["datasetId"]]`                                                                                                                                                                                                         |
| `saveMany(documents, ...)` | each distinct saved `datasetId`; `updateMultiple` — the only path that changes an annotation's `datasetId` — additionally bumps each moved-from dataset using the documents it already loaded                                                |
| `remove(annotation, ...)`  | `datasetCounter[annotation["datasetId"]]`                                                                                                                                                                                                    |
| `removeWithQuery(query)`   | `datasetId` when present in the query (e.g. `cleanOrphaned`); otherwise `globalEpoch` (e.g. `deleteMultiple`'s `_id $in` query — though its API layer already knows the dataset ids via `distinctDatasetIds` and may bump precisely instead) |

History undo/redo is the deliberate exception to model-hook coverage: it uses
raw collection replace/delete operations, so `History._undoOrRedo` bumps the
affected dataset explicitly after a successful restore.

`ETag = W/"{processUuid}:{globalEpoch}:{datasetCounter}:{ttlEpoch}:{sha1 of
the canonicalized query params}"`. Handle `If-None-Match` before touching the
geometry cache. The TTL epoch is essential: without it a process-local ETag
could keep returning 304 and prevent the cache's own TTL from ever running.

### 3.6 Security / abuse posture

Follows the repo's public-endpoint rules: every parameter is clamped or
enum-validated (table in §3.1), the aggregation is `maxTimeMS`-bounded,
per-tile CPU is bounded by `tileSize ≤ 1024` and the splat fast path, and
the folder ACL check runs on every request. The expensive operation
(geometry build) is amortized by the cache and serialized by the per-key
lock, so an anonymous client hammering tiles of a public dataset costs
one fetch plus milliseconds per tile. No new permission surface: the
endpoint reveals exactly what `stubs`/`find` already reveal, in pixel
form.

### 3.7 Endpoint pseudocode

```python
def rasterTile(self, z, x, y, params):
    p = validateRasterParams(z, x, y, params)          # clamps, 400s
    Folder().load(p.datasetId, user=self.getCurrentUser(),
                  level=AccessType.READ, exc=True)
    version = rasterVersions.get(p.datasetId)
    etag = buildEtag(version, p)
    if requestIfNoneMatchEquals(etag):
        cherrypy.response.status = 304
        return
    geometry = frameGeometryCache.get(p.cacheKey(), version)  # locked build
    tilePng = renderTile(geometry, p)                  # numpy splat + PIL
    setResponseHeader("Content-Type", "image/png")
    setResponseHeader("ETag", etag)
    setResponseHeader("Cache-Control", "private, max-age=3600")
    setRawResponse()
    return tilePng
```

## 4. Frontend

### 4.1 Configuration state

New `IAnnotationOverviewConfig` in `src/store/model.ts`, persisted on the
**configuration** (shared, like layers) following the `visibilityConfig`
pattern exactly — defaults + resolver merging persisted partials
(`resolveVisibilityConfig`, consumed at `src/store/GirderAPI.ts:1305-1308`,
loaded at `src/store/index.ts:1229`, synced via
`syncConfiguration("visibilityConfig")` at `index.ts:2245`):

```typescript
interface IAnnotationOverviewConfig {
  enabled: boolean; // default false
  mode: "shapes" | "discs"; // default "shapes"
  opacity: number; // 0..1, default 0.6
  // Raster shows while imagePixelsPerScreenPixel > threshold;
  // vector annotations take over below it. Default 1.
  vectorSwitchThreshold: number;
}
```

Add `overviewConfig?: IAnnotationOverviewConfig` to
`IDatasetConfiguration`, a resolver + unit tests mirroring
`src/store/GirderAPI.visibilityConfig.test.ts`, and a store action
`updateOverviewConfig` using the standard mutation + `syncConfiguration`
pattern.

### 4.2 API client

URL construction lives in `src/store/AnnotationsAPI.ts` (never in
components, per repo rules):

```typescript
annotationRasterTemplateUrl(options: {
  datasetId: string;
  selectors: Array<{ channel: number; XY?: number; Z?: number; Time?: number }>;
  sizeX: number; sizeY: number;
  tileSize: number;
  maxLevel: number;              // image map's coordinate max level
  mode: "shapes" | "discs";
  color: string;
  version: number;              // client mutation counter, §4.6
}): string
// -> `${apiRoot}/upenn_annotation/raster/{z}/{x}/{y}?datasetId=...&selectors=...&v=...`
```

Returns a template with literal `{z}/{x}/{y}` placeholders, the same
convention as `tileTemplateUrl` (`src/store/GirderAPI.ts:333-361`).

### 4.3 Viewer layer

In `ImageViewer.vue`, one additional GeoJS `osm` layer per map entry
(created alongside the existing layers around `:1111-1172`):

- Start with `geojs.util.pixelCoordinateParams(el, sizeX, sizeY, 512,
512)`, then override `maxLevel`, `tilesAtZoom`, and `tilesMaxBounds` to
  use the existing image map's coordinate max level. The 512 px overview
  tile size stays independent, but its scale and extent exactly match the
  native image pyramid (§3.2).
- `url` callback substitutes `{z}/{x}/{y}` in the template from §4.2 and
  returns `undefined` for out-of-range tile indices (GeoJS skips them),
  like the existing `blankUrl` handling (`ImageViewer.vue:1272-1291`).
- Z-order: above all image (`osm`) layers, below the annotation feature
  layers — extend the existing z-order enforcement block
  (`ImageViewer.vue:1540-1558`).
- Reactivity: watchers on current `xy/z/time`, `overviewConfig`, and the
  mutation counter rebuild the template and call `layer.url(newTemplate)`
  (which drops GeoJS's tile cache and refetches), plus
  `layer.opacity(...)` / `layer.visible(...)`.
- **Unroll mode: the layer is hidden** (`layer.visible(false)`) whenever
  unrolling is active. Extending the raster to the unroll grid needs the
  custom tile-index remapping the image layers use and is out of scope
  for v1 (§9).

### 4.4 Raster ↔ vector switching

The point of the feature: full-detail raster while zoomed out, vector
annotations once zoomed in. In `AnnotationViewer.vue`, alongside the
existing zoom/camera watchers (`:4549-4608`):

- Compute `imagePixelsPerScreenPixel = map.unitsPerPixel(map.zoom())`
  (map units are image pixels).
- `rasterActive = enabled && imagePixelsPerScreenPixel >
vectorSwitchThreshold`, with **15% hysteresis** (switch to vectors at
  `threshold`, back to raster at `threshold * 1.15`) so panning at the
  boundary doesn't flap.
- While `rasterActive`: show the raster layer, and suppress vector
  annotation rendering through the same code path as the existing global
  "show annotations" visibility toggle (reuse it — do not invent a second
  hide mechanism; this is a known symmetric-path trap). Also early-out
  `updateVisibilityAndHydration` (`src/store/annotation.ts:2393`) so no
  hydration requests are scheduled for suppressed frames — hydrating
  20k geometries the user can't see is pure waste.
- While not `rasterActive`: hide the raster layer. While the overview feature
  remains enabled and unroll is inactive, the vector layer draws only hydrated
  annotations; visible unhydrated stubs still drive viewport selection and
  hydration but are not rendered as temporary dots. Disabling the overview or
  entering unroll restores the normal stub rendering behavior. **Both
  visibility flips must be verified in both
  directions** (raster→vector and vector→raster) — retention/clearing is
  the twin path of drawing.

While the raster is active, drag/lasso selection queries the global stub
centroid spatial index even though normal vectors are suppressed. The result is
the complete set of annotations in the selected region. Only the visual
feedback is capped at `visibilityConfig.minimumVisible` (5,000 by default): a
stable pseudo-random subset is drawn as highlighted centroid stubs over the
raster so redraws do not reshuffle the indicators. This preserves coarse
interaction without hydrating geometry or restoring the noisy all-stub layer.
Pixel-perfect click, hover, and geometry-dependent tools still require the
vector-visible range.

### 4.5 Settings UI

New section in `src/components/VisibilitySettings.vue` (mounted from
`UISettings.vue`), following its existing field/`v-description`/tooltip
patterns: enable switch ("Annotation overview raster"), mode select
(footprints vs discs), opacity slider, and the switch threshold as an
advanced numeric field with bounds in
`src/utils/visibilityConfigBounds.ts`-style constants. Include a one-line
blurb noting the overview is display-only and hides while unrolling.

### 4.6 Client-side cache busting

The annotation store keeps a monotonic `mutationCounter` incremented
after every successful annotation create/update/delete/import affecting
the current dataset. It feeds the `v` query param (§3.1), so the user's
own edits immediately invalidate browser-cached tiles and force refetch
(which the server answers freshly thanks to §3.5). Other users' edits
surface on the next natural refetch (frame change, reload, toggle) — v1
accepts that; live invalidation is future work (§9).

### 4.7 Navigation from the annotation table

Annotation table rows already route through the shared stub-aware
`goToAnnotationLocation` helper. When the overview is enabled and the current
map scale is still in raster mode, row navigation now recenters and zooms just
past `vectorSwitchThreshold` (clamped to the map's maximum zoom) instead of
performing only a pan. The camera helper scales `gcsBounds` together with zoom,
so viewport hydration is computed against the destination actually shown. A
next-tick hydration retry covers the brief transition in which raster-mode
suppression may still be active; hydration requests remain deduplicated.

## 5. What was measured (basis for budgets)

Benchmark: synthetic 16-vertex cell-like polygons over a 20,000² image,
Pillow + numpy + pymongo BSON (C extension), single core. Methodology in
Appendix A.

| Cost                                                    | Measured        |
| ------------------------------------------------------- | --------------- |
| BSON decode, 100k coordinate-projected polygon docs     | 1.4 s (52 MB)   |
| BSON decode, 700k coordinate-projected polygon docs     | ~10 s (~360 MB) |
| BSON decode, 700k stub-style docs (discs mode)          | ~5 s (64 MB)    |
| PIL polygon fill throughput (small filled polys, no AA) | ~200–250k/s     |
| numpy sub-pixel splat, 700k points                      | ~11 ms          |
| Full-canvas render 700k polygons at 4096 px             | ~4 s            |
| PNG encode, 512² RGBA tile                              | ~5–20 ms        |

Live validation on dataset `6a19784f247013c971283206` (708,983
annotations, 17,700,404 vertices) after the single-pass packing change:

| Cost                             |    Before |             After |
| -------------------------------- | --------: | ----------------: |
| Direct cold frame geometry build |  16.396 s | 13.340 s (-18.6%) |
| Cached geometry memory           | 163.77 MB |         163.77 MB |
| Authenticated cold HTTP tile     |         — |          13.052 s |
| Warm HTTP tile / ETag 304        |         — |  38.9 ms / 4.0 ms |

## 6. Performance budgets (acceptance criteria)

- **Cold frame (geometry build)**: ≤ 3 s for frames with ≤ 100k
  annotations; ≤ 15 s worst case for a pathological 700k-annotation
  single frame (`shapes` mode); ~half that in `discs` mode. Happens once
  per (frame, filters) per edit, protected by the per-key lock.
- **Warm tile**: ≤ 50 ms server time for typical tiles (≤ ~5k candidate
  shapes); low-zoom tiles over dense frames must route sub-pixel shapes
  through the numpy splat path and stay ≤ 200 ms even at 700k.
- **Memory**: geometry cache ≤ ~300 MB total (LRU 3 + TTL 120 s);
  per-tile transient ≤ ~5 MB.
- **Client**: no additional per-frame work when the feature is disabled
  (zero-cost when off); enabling it must not regress the existing
  stub/hydration path budgets (see the regression checklists referenced
  in `CLAUDE.md`).

## 7. Testing plan

### Backend (`test/test_raster.py`, pytest via tox)

Geometry & rendering (decode returned PNGs with PIL in the test):

1. A polygon with known coordinates renders filled at the expected pixels
   at `z = maxLevel`, and as a single splatted pixel at `z = 0`
   (min-footprint rule).
2. Tile geometry: annotation on a tile boundary appears in both adjacent
   tiles, each correctly offset; tiles fully outside the image are fully
   transparent.
3. `mode=discs` renders a disc whose radius matches
   `estimatedRadius * scale`.
4. Layer selectors include only matching channels/locations; omitted axes
   project across every value for max-merge layers; duplicate selectors do not
   duplicate geometry.
5. `color`: annotation `color` honored; null/invalid falls back to the
   `color` param; invalid `color` param → 400.
6. Points render at `pointRadius` tile px at two different levels
   (constant apparent size); lines honor `lineWidth`; rectangles fill.

Protocol & safety: 7. Anonymous on a private dataset → 401 (Girder's normal anonymous access
response); public dataset → 200 (mirror the `stubs` access tests). 8. 400s: out-of-range `z/x/y`, bad `tileSize`, `sizeX` above clamp, malformed,
empty, oversized, or structurally invalid selectors, and negative selector
values. 9. ETag: identical request returns the same ETag; `If-None-Match` → 304;
creating/deleting an annotation in the dataset changes the ETag and a
fresh tile shows/loses the annotation (cache invalidation observable
end-to-end, not just counter-was-bumped). 10. `updateMultiple` (save path) also bumps the version — the twin of the
create/delete paths in (9); don't test one mutation verb and assume
the rest. 11. Concurrency: two threads requesting the same cold selector set trigger
exactly one aggregation; a distinct cold build is rejected while the slot
is occupied; anonymous cold-build limits do not charge cache hits. 12. Geometry construction traverses each annotation's coordinates once,
bulk-packs the vertex buffer, and indexes both single-cell and
boundary-crossing bboxes (`testGeometryConstructionTraversesCoordinatesOnce`).

Watch the known test-harness traps from `CLAUDE.md`: verify each test
fails without its fix (use `git stash`, not `cp` round-trips), and don't
let shared fixtures return fixed values that defeat assertions.

### Frontend

- Vitest: `annotationRasterTemplateUrl` output (params, placeholder
  preservation, `v` propagation); `overviewConfig` resolver
  defaults/merge (mirror `GirderAPI.visibilityConfig.test.ts`); the
  hysteresis switch function (crossing down at `threshold`, back up at
  `threshold * 1.15`, no flap in between).
- In-browser (use the `in-browser-testing` skill — tsc/vitest green does
  not mean the UI works): on a dataset seeded with ≥ 100k annotations via
  the `nimbusimage` Python API, verify from a fresh page load: raster
  appears when enabled; zooming past the threshold swaps raster → vector
  and back (with hysteresis); opacity slider works; frame change
  refetches; creating an annotation refreshes tiles (`v` bump); unroll
  hides the raster; disabling the feature restores today's behavior
  exactly.

## Regression checklist

Per `CLAUDE.md`, every item names its test:

- **Drawing/clearing symmetry**: raster→vector hides raster AND restores
  vectors; vector→raster the reverse — _"suppresses vectors and hydration only
  while the raster is active"_ + in-browser step 2.
- **Cost when disabled**: no raster layer created, no watchers firing
  work, no hydration early-out taken — _"does not allocate a GeoJS layer while
  the feature is disabled"_ + in-browser with feature off.
- **Hydration suppression**: no hydrate requests scheduled while raster
  active — _"suppresses vectors and hydration only while the raster is active"_.
- **Stub-free vector handoff**: with the overview enabled, zoomed-in vectors
  contain only hydrated geometry while unhydrated stubs remain available to
  visibility and hydration; disabling the overview or entering unroll restores
  stub dots — _"omits unhydrated stubs while raster overview is enabled"_.
- **Handoff only when a raster is available**: above the 64-selector contract
  limit the raster never activates, so stub dots must be retained rather than
  hidden with nothing behind them — _"retains stub dots when the raster
  selector contract is unsupported"_.
- **Connection navigation escapes the raster**: clicking a same-frame
  connection row while zoomed out frames the endpoints from inside the
  vector-visible range, zooming back out only as far as keeping both
  endpoints on screen requires — _"zooms a same-frame connection into the
  vector-visible range"_.
- **Busy tiles retry**: a raster tile that fails (503 during a concurrent
  cold build) triggers a bounded delayed `reset()`+redraw — GeoJS caches the
  rejected tile, so nothing else ever refetches it — and hidden or
  retemplated layers do not retry — _"retries failed overview tiles with a
  bounded delayed reset"_ and _"does not retry tiles for a hidden overview
  layer"_.
- **Invalidation on every mutation verb**: create, updateMultiple,
  delete, deleteMultiple each change the ETag —
  _"testEveryModelMutationPathInvalidatesEtag"_ and
  _"testAccessAndEtagInvalidation"_.
- **Bulk move invalidates both datasets**: an updateMultiple that changes an
  annotation's datasetId bumps the source and destination rasters (saves
  themselves bump only the saved documents' datasets; the move path bumps
  the source) — _"testBulkMoveInvalidatesSourceAndDestinationRasters"_.
- **Sub-pixel fast path**: low-zoom footprints collapse to the splat path rather
  than drawing full polygons — _"testPolygonAndSubpixelRendering"_.
- **Single-pass cold geometry build**: coordinates are traversed once and
  both vectorized single-cell and boundary-crossing grid entries remain
  queryable — _"testGeometryConstructionTraversesCoordinatesOnce"_.
- **Public-endpoint clamps**: all 400 cases — _"testInvalidInputsReturn400"_.
- **Private-dataset image authentication**: an anonymous tile request returns
  401 while the same read-only request with Girder's auth cookie returns 200 —
  _"testAccessAndEtagInvalidation"_ plus the in-browser private-dataset pass.
- **Coordinate-pyramid alignment**: a 512 px overview layer on a map backed
  by 256 px image tiles uses the image map's max level for both server scale
  and GeoJS tile bounds — _"testImagePyramidLevelControlsCoordinateScale"_ and
  _"lazily creates the layer and refreshes its URL on mutations"_.
- **Cold-build feedback without cache-hit flicker**: a raster tile load that
  remains active for 300 ms creates a global indeterminate progress item and
  completes it when GeoJS reports the layer idle, while an already-idle cached
  load never creates one — _"shows delayed progress while overview tiles load
  and completes on idle"_ and _"does not show progress when overview tiles are
  already cached"_.
- **Raster-mode coarse selection**: drag/lasso queries the global centroid
  index, selects every match, and draws a stable pseudo-random subset capped at
  the zoomed-out visibility floor without restoring unselected stubs or
  hydrated geometry — _"drag-selects every matching stub while only the raster
  is visible"_ and _"draws only selected stubs as feedback over the raster"_,
  plus _"returns a stable pseudo-random subset at the requested limit"_.
- **Raster-mode selection predicate parity**: global drag selection and
  selected-stub feedback use the same channel/current/offset/max-merge/hidden
  selectors as the raster tiles — _"drag-selects exactly the annotations
  represented by raster selectors"_ and _"matches fixed axes and treats
  omitted max-merge axes as wildcards"_.
- **Table-row vector navigation**: clicking an object row from raster mode
  recenters and zooms just inside the vector threshold, keeps `gcsBounds`
  consistent, and retries hydration after suppression lifts —
  _"zooms a table-row destination into the vector-visible range"_, _"recenters
  and scales bounds consistently with the requested zoom"_, plus the
  in-browser row-click pass.
- **Cold-build availability controls**: identical keys coalesce, distinct keys
  cannot exceed the process-wide build cap, anonymous cache misses are
  rate-limited without charging hits, and saturation returns retryable HTTP
  responses — _"testConcurrentRequestsForSameKeyBuildOnce"_,
  _"testDistinctColdBuildsRespectGlobalConcurrencyLimit"_,
  _"testAnonymousColdBuildsAreRateLimitedButCacheHitsAreNot"_, and
  _"testColdBuildCapacityErrorsReturnRetryableResponses"_.
- **Byte-budgeted geometry retention**: the cache counts the unique NumPy and
  spatial-grid allocations and evicts least-recently-used entries until it is
  within 300 MB — _"testGeometryCacheEvictsByRetainedBytes"_ and
  _"testGeometryConstructionTraversesCoordinatesOnce"_.
- **Monotonic cache generations**: a queued stale request reuses a fresh newer
  geometry entry and cannot roll the cache backward or repeat the cold build —
  _"testNewerCachedVersionSatisfiesStaleRequest"_.
- **Raster/vector layer predicate parity**: current, constant/offset,
  max-merge, channel visibility, invalid slices, and duplicate layers produce
  canonical backend selectors — _"matches visible current, offset, and
  max-merge layer predicates"_, _"preserves z/x/y placeholders and serializes
  render inputs"_, _"testGeometryPipelineUsesCanonicalLayerSelectors"_, and
  _"testLayerSelectorsFilterFrameChannelAndColors"_.
- **Client/server selector-limit parity**: exactly 64 canonical selectors are
  accepted, while larger configurations skip the raster request and retain
  vector rendering — _"accepts the backend selector limit and rejects larger
  requests"_, _"does not request or activate a raster above the selector
  limit"_, and _"retains vector mode above the raster selector limit"_.
- **No hidden raster work**: the GeoJS layer is created hidden, has no tile URL
  or progress item while vectors are active, and applies both only on a raster
  visibility transition — _"lazily creates the layer and refreshes its URL on
  mutations"_ and _"shows delayed progress while overview tiles load and
  completes on idle"_.
- **Mixed layer-unroll fallback**: shared vector visibility is suppressed only
  when every mounted map viewer is raster-active, so a group above the raster
  selector limit keeps its vectors even when a sibling group uses the raster —
  _"coordinates shared raster suppression across mounted map viewers"_ and
  _"waits for every map viewer before suppressing shared visibility"_.
- **Layer-unroll teardown safety**: removing an unrolled map updates aggregate
  raster activity without accessing its already-exited GeoJS overview layer —
  _"ignores raster visibility events from removed map viewers"_ plus the live
  Multiple → Unroll → Multiple pass.
- **Transparent edge padding**: geometry outside `sizeX`/`sizeY` cannot paint
  into the rightmost or bottommost tile padding —
  _"testTileBoundaryAndTransparentPadding"_.

## 9. Explicit non-goals / future extensions

- **Pixel-perfect hover/click under the raster** (stub proximity hit-testing or
  a server-rendered ID map). Coarse drag/lasso selection is implemented.
- **Unroll-mode support** (per-cell tile remapping like
  `ImageViewer.vue:1272-1319`).
- **Anti-aliasing** (2× supersample + downscale; ~4× tile draw cost).
- **Coupling to annotation-browser filters** (render only the filtered
  set; needs filter serialization into the tile URL / cache key).
- **Cross-process/live invalidation** (shared cache or pub/sub; today:
  TTL 120 s + per-process ETag uuid).
- **Partial-axis projection ranges** (max-merge currently omits the axis and
  therefore projects every value; bounded windows would require range-valued
  selectors).
- **Tile pre-warming** (background job rendering the pyramid after bulk
  imports).

## 10. Suggested implementation order

1. **Backend endpoint, no cache**: params/validation, tile math,
   rendering rules, access control + tests 1–8. Correct before fast.
2. **Geometry cache + version registry + ETag**: tests 9–11.
3. **Frontend**: config + resolver + settings UI + API template + viewer
   layer + `v` counter; vitest suite.
4. **Switching behavior + in-browser verification pass**; record findings
   into the regression checklist above.

Each step should leave `tox`, `pnpm tsc`, `pnpm lint:ci`, and `pnpm test`
green.

---

## Appendix A: benchmark methodology

Measured on the spec author's container (single core, Python 3.11,
Pillow 11 / numpy 2 / pymongo's C BSON). Synthetic annotations: 16-vertex
polygons, radius 6–25 px, uniformly scattered over a 20,000 × 20,000
image; docs shaped like the real schema (`coordinates: [{x, y}]`,
`shape`, `color`). BSON cost measured with `bson.decode_all` over
concatenated documents — the same batched decode path a pymongo cursor
uses, so it approximates driver-side cursor cost (Mongo server scan and
localhost transfer add a few seconds at the 700k scale, already reflected
in the §6 budgets). Rasterization measured as scale-transform +
`ImageDraw.polygon(fill=...)` per annotation into an RGBA canvas;
sub-pixel splats as vectorized numpy integer-index assignment; PNG encode
via `Image.save(BytesIO(), "PNG")`.
