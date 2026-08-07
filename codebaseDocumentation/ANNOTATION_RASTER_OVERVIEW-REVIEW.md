# Annotation Raster Overview — Branch Review Findings

Review base: `master` (`da7a9e4e`)

## R1 — Public cold-build resource exhaustion

- **Severity:** High
- **Location:** `server/api/annotation.py:rasterTile`,
  `server/helpers/annotationRaster.py:FrameGeometryCache.get`
- **Summary:** Anonymous requests can vary raster geometry keys and start
  concurrent, memory-heavy cold builds.
- **Status:** fixed (uncommitted) — cold builds have a global concurrency gate,
  anonymous per-client/dataset rate limit, retryable 429/503 responses, and a
  capped canonical selector key.

## R2 — Entry-count cache exceeds the memory budget

- **Severity:** Medium
- **Location:** `server/helpers/annotationRaster.py:FrameGeometryCache`
- **Summary:** Retaining three geometries can exceed the documented 300 MB
  process budget because eviction ignores allocation size.
- **Status:** fixed (uncommitted) — the LRU now tracks retained NumPy/grid bytes
  against a 300 MB budget.

## R3 — Raster/vector inclusion predicates drift

- **Severity:** Medium
- **Location:** `src/components/ImageViewer.vue`,
  `src/components/AnnotationViewer.vue:layerAnnotations`
- **Summary:** The raster uses the global frame while vectors also honor visible
  layer channels, slice offsets, constants, and max-merge axes.
- **Status:** fixed (uncommitted) — raster requests serialize the same visible
  layer channel/current/offset/max-merge selectors used by vector rendering.

## R4 — Hidden raster layer starts unnecessary work

- **Severity:** Medium
- **Location:** `src/components/ImageViewer.vue:_syncAnnotationOverviewLayer`
- **Summary:** Creating the layer and assigning its URL can fetch tiles while
  the current zoom is vector-only.
- **Status:** fixed (uncommitted) — the layer starts hidden and its URL/progress
  lifecycle begins only when `AnnotationViewer` requests raster visibility.

## R5 — Edge-tile padding is not clipped

- **Severity:** Low
- **Location:** `server/helpers/annotationRaster.py:renderRasterTile`
- **Summary:** Geometry outside the image extent can paint into the transparent
  padding of rightmost and bottommost tiles.
- **Status:** fixed (uncommitted) — rendered edge tiles are cleared outside the
  scaled image bounds.

## R6 — GeoJS URL state bypasses type checking

- **Severity:** Nit
- **Location:** `src/components/ImageViewer.vue:_syncAnnotationOverviewLayer`
- **Summary:** URL deduplication casts the layer to `any` and writes an
  undocumented `_annotationOverviewUrl` property.
- **Status:** fixed (uncommitted) — desired and applied URLs live in typed
  `WeakMap`s instead of the GeoJS layer object.

## R7 — Stale requests can roll the geometry cache backward

- **Severity:** Medium
- **Location:** `server/helpers/annotationRaster.py:FrameGeometryCache.get`
- **Summary:** A queued request carrying an older raster version treats a
  newer cached entry as a miss, rebuilds the same geometry, and replaces the
  newer cache generation.
- **Status:** fixed (uncommitted) — fresh cache entries from the same process
  satisfy requests for the same or any older monotonic generation, so a queued
  stale request cannot rebuild and replace newer geometry. Covered by
  _"testNewerCachedVersionSatisfiesStaleRequest"_.

## R8 — Raster drag selection does not use raster layer selectors

- **Severity:** Medium
- **Location:** `src/components/AnnotationViewer.vue:chooseAnnotations`
- **Summary:** Global raster-mode selection checks only the raw current
  XY/Z/Time frame and ignores channel, offset, max-merge, and hidden-layer
  predicates used to construct the displayed raster.
- **Status:** fixed (uncommitted) — tile generation, selected-stub feedback,
  and global drag selection now share canonical per-layer selector construction
  and matching. Covered by _"drag-selects exactly the annotations represented
  by raster selectors"_ and _"matches fixed axes and treats omitted max-merge
  axes as wildcards"_.

## R9 — Changed raster templates retain stale GeoJS tiles

- **Severity:** High
- **Location:** `src/components/ImageViewer.vue:_syncAnnotationOverviewLayer`
- **Summary:** Replacing only the raster URL callback allows GeoJS to reuse
  cached z/x/y tiles after selectors, mode, or mutation version changes.
- **Status:** by-design — GeoJS 1.19.1's `tileLayer.url(newCallback)` setter
  calls `reset()` and `map().draw()` itself (`geojs/src/tileLayer.js`), so the
  new callback already drops cached z/x/y tiles. Calling `reset()` again in
  NimbusImage would duplicate the cache reset and draw.

## R10 — Client can activate raster mode above the selector limit

- **Severity:** Medium
- **Location:** `src/components/ImageViewer.vue`,
  `src/components/AnnotationViewer.vue`
- **Summary:** More than 64 unique selectors are sent to a backend endpoint
  that rejects them while the frontend still suppresses vector annotations.
- **Status:** fixed (uncommitted) — a shared frontend wire-contract guard
  rejects empty or >64-selector rasters in both `ImageViewer` and
  `AnnotationViewer`, so the template is not requested and vectors remain
  visible. Covered by _"does not request or activate a raster above the
  selector limit"_, _"retains vector mode above the raster selector limit"_,
  and _"accepts the backend selector limit and rejects larger requests"_.

## R11 — One unrolled map can suppress vectors for every map

- **Severity:** Medium
- **Location:** `src/components/ImageViewer.vue`,
  `src/components/AnnotationViewer.vue:updateVisibility`
- **Summary:** Each map independently decides whether its raster is active, but
  every `AnnotationViewer` writes the same global visibility-suppression state.
  In layer-unroll mode, a raster-capable map can therefore hide the vectors of
  a sibling map whose selector set is not raster-capable.
- **Status:** fixed — `ImageViewer` aggregates raster activity by
  map and grants shared suppression only when every mounted annotation viewer
  is active. Covered by _"coordinates shared raster suppression across mounted
  map viewers"_ and _"waits for every map viewer before suppressing shared
  visibility"_.

## R12 — Removed map mutates an exited raster layer

- **Severity:** Medium
- **Location:** `src/components/ImageViewer.vue:_setAnnotationOverviewVisibility`
- **Summary:** Switching out of layer-unroll mode exits surplus GeoJS maps
  before their `AnnotationViewer` children unmount. The child's final raster
  visibility event then calls `visible()` on an overview layer whose renderer
  has already been destroyed.
- **Status:** fixed — removed viewers still update aggregate
  activity, but their final event skips GeoJS layer operations once their map
  leaves the parent's mounted map list. Covered by _"ignores raster visibility
  events from removed map viewers"_ and a clean live Multiple → Unroll →
  Multiple pass.
