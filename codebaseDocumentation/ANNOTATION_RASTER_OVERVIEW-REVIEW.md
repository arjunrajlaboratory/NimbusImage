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

## R13 — Pre-save datasetId aggregation on every save (PR review, pchoisel)

- **Severity:** Low (cost/complexity)
- **Location:** `server/models/annotation.py:save/saveMany`
- **Summary:** Every save and saveMany ran a `distinctDatasetIds` aggregation
  before writing, solely to catch the rare bulk-move case where an update
  changes an annotation's `datasetId`. An annotation belongs to exactly one
  dataset, so the set-and-loop shape was misleading and the pre-query was
  wasted work on every ordinary save.
- **Status:** fixed — `save`/`saveMany` now bump only the saved documents'
  datasetIds (no pre-query). The one path that moves annotations between
  datasets, `updateMultiple`, captures moved-from datasetIds from the
  documents it has already loaded (zero extra queries) and bumps those
  sources after saving. Covered by
  `testBulkMoveInvalidatesSourceAndDestinationRasters`, verified to fail
  without the source bump.
- **Follow-up (symmetric-path sweep):** the single-update endpoint
  (`PUT /upenn_annotation/:id`) still passed `datasetId` through — and,
  unlike create/updateMultiple, never converts body ids to ObjectIds, so a
  datasetId change there stored a corrupt string. `datasetId` is now
  stripped at that API boundary (immutable on the single path), making the
  "only updateMultiple moves annotations" invariant real. Covered by
  `testSingleUpdateCannotChangeDatasetId`, verified to fail without the
  strip.

## R14 — Thread-local raster-bump suppression legibility (PR review, pchoisel)

- **Severity:** Low (style/legibility)
- **Location:** `server/models/annotation.py:_rasterMutationState`
- **Summary:** Reviewer concern that `_rasterMutationState` could misbehave
  when users modify and remove annotations concurrently, with a suggestion to
  thread an explicit inhibit argument through overridden Girder methods
  instead.
- **Status:** by-design / deferred — the state is a `threading.local()`;
  each request thread carries its own `suppressRemoveBump` flag with
  try/finally restore, so one user's bulk save cannot suppress another
  request's invalidation. The flag exists only because
  `CustomNimbusImageModel.saveMany` implements bulk update as
  removeWithQuery + insert_many, whose internal remove would otherwise bump
  the global epoch. Replacing the ambient flag with explicit argument
  threading is a legibility refactor tracked as a follow-up issue.

## R15 — Stub-free handoff not gated on raster availability (Codex round, P2)

- **Severity:** Medium
- **Location:** `src/components/AnnotationViewer.vue:layerAnnotations`
- **Summary:** The predicate that omits unhydrated stub dots during the
  raster's vector handoff checked only `overviewConfig.enabled` and unroll.
  On a stub-only dataset whose visible layers exceed the 64-selector
  contract (where R10 correctly refuses to activate the raster), stubs were
  still hidden — no raster and no stub dots, only the hydrated subset. A
  half-done R10: activation was gated on the contract, the stub-omission
  twin was not.
- **Status:** fixed — the handoff predicate is now the
  `stubFreeRasterHandoff` computed, which also requires
  `annotationRasterSelectorsSupported(rasterSelectors)`. Deliberately NOT
  `rasterActive`: the handoff must hold while zoomed in (raster available
  but inactive). Covered by _"retains stub dots when the raster selector
  contract is unsupported"_, verified to fail without the gate.

## R16 — Raster activates on images larger than the backend dimension cap (Codex round, P2)

- **Severity:** Low (niche: requires a source image > 131,072 px on a side)
- **Location:** `src/components/ImageViewer.vue:_setupAnnotationOverview`,
  `server/api/annotation.py` (sizeX/sizeY 400 above 131072)
- **Status:** deferred — filed as a follow-up issue. Same
  mirror-the-backend-contract family as R10/R15, but fixing it properly
  means threading image dimensions through the shared wire-contract guard
  used by both `ImageViewer` and `AnnotationViewer`, and no current dataset
  approaches the cap.

## R17 — Connection-row navigation cannot escape the raster (Codex 2026-08-07 round, P1)

- **Severity:** High (user-facing dead end)
- **Location:** `src/utils/annotationNavigation.ts:goToConnection`
- **Summary:** Connections are not drawn while the raster is active, and
  `frameCameraInfo` never zooms in — so clicking a same-frame connection row
  from a zoomed-out view recentered without crossing the vector threshold,
  leaving the clicked connection invisible. The cross-frame path
  (`goToAnnotationLocation`) had already received the vector-threshold zoom;
  the `bothDisplayed` framing path was its unfixed twin.
- **Status:** fixed — the framing now starts from a camera recentered at the
  midpoint inside the vector range (`zoomForVectorAnnotations` +
  `recenterCameraInfoAtZoom`), so `frameCameraInfo` only zooms back out if
  that is what it takes to keep both endpoints on screen — in which case no
  zoom level could draw the connection anyway. Mirrors the hydrate-retry
  nextTick used by `goToAnnotationLocation`. Covered by _"zooms a same-frame
  connection into the vector-visible range"_ and _"frames a connection from
  the current camera when vectors are already visible"_, verified to fail
  without the fix. `goToTrack` was checked and left alone: it zooms in to
  fit content by design.

## R18 — Failed raster tiles are never retried (Codex 2026-08-07 round, P1)

- **Severity:** High (holes in the overview persist)
- **Location:** `src/components/ImageViewer.vue`,
  `server/helpers/annotationRaster.py` (503 + Retry-After on busy builds)
- **Summary:** A raster tile can 503 while another geometry key is still
  cold-building. GeoJS has no tile-error event, drops the failed tile, and —
  worse than originally reported — keeps the REJECTED tile in its cache, so
  later draws reuse the failure instead of refetching. Vectors stay
  suppressed while the raster shows holes.
- **Status:** fixed — the overview layer's `_getTile` factory (the seam GeoJS
  documents for derived classes) is wrapped at creation so every tile's
  promise interface reports failures; a failure schedules one bounded retry
  (max 3 per applied template, 1 s delay matching the server's Retry-After)
  that runs `layer.reset()` (the only way to purge a rejected cached tile) +
  redraw + reload tracking. Retries are skipped for unmounted, hidden, or
  retemplated layers; a new template restores the budget. Retry state lives
  in WeakMaps outside the GeoJS object (R6 rule). Covered by _"retries
  failed overview tiles with a bounded delayed reset"_ and _"does not retry
  tiles for a hidden overview layer"_, verified to fail without the fix.
