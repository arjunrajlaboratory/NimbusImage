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
