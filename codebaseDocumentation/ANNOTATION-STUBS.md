# Stub Annotations Architecture

## Overview

The annotation system uses a stub/hydrated architecture to efficiently handle large numbers of annotations. Annotations are loaded as lightweight stubs (centroid + metadata, no coordinates) and selectively hydrated (full coordinates loaded) based on viewport, size, and selection state.

**Branch:** `feature/stub-annotations`
**Status (2026-06-19):** Backend endpoints + frontend migration complete and functionally correct on real data (HCR 26K, Xenium 708K). Server-side annotation list (Option B) shipped — see [`ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](./ANNOTATION-LIST-SERVER-SIDE-DESIGN.md). Recent fixes: stub circle world-locked sizing (see "RESOLVED: stub circles too large" below) and the property-column sort arrow. **Still open / next:** large-scale performance (708K `/list` is 3.6–25 s), progress indicators for long loads, hydration debounce + zoom-aware hydration, and the property-value loading rework. See **Next Steps** and the **Remaining work** summary at the very bottom.

---

## Next Steps (post-migration)

Pick these up in this order — each unblocks the next and the first one is the biggest win.

### 1. Accumulating hydration cache with LRU eviction (highest leverage)

Right now every `updateVisibilityAndHydration` call builds `idsToHydrate` (up to `maxHydrated` = 5000) and `_hydrateFromBackend` replaces the entire `hydratedAnnotations` map. On every pan the cache is rebuilt; annotations that were hydrated 200ms ago get refetched. With `maxHydrated = 5000`, one pan can cost ~3–5 MB of redundant HTTP traffic.

**Approach:** Keep a global cap (say 10–15k entries), accumulate on `setHydratedAnnotations`, and LRU-evict when over cap. `updateVisibilityAndHydration` Step 7 computes `idsToFetch = idsToHydrate.filter(id => !cache.has(id))` and `keepEntries = everything already in cache` — don't restrict keep to the current viewport. Touch order on read (for LRU) can be piggybacked on the Step 4 "should be hydrated this frame" list.

**Files:** `src/store/annotation.ts` — `setHydratedAnnotations` mutation, `_hydrateFromBackend` keep-logic, and the Step 7 block in `updateVisibilityAndHydration`.

**Verification:** Network tab shows mostly cache hits on short pans (`idsToFetch` count drops to near 0 when revisiting already-hydrated regions). Watch for memory — confirm LRU actually evicts when over cap.

### 2. Debounce the hydration fetch itself (~200 ms)

`updateVisibilityDebounced` is debounced 250 ms, but a zoom-then-pan can legitimately call `updateVisibility` multiple times (the cameraInfo watcher debounces; the `xy/z/time` and `filteredAnnotations` watchers fire immediately). Each fires `_hydrateFromBackend` independently. With (1) done, this matters less, but still batches HTTP.

**Approach:** Debounce `_hydrateFromBackend` itself (or the Step 7 computation) with a short trailing-edge timer. Latest call wins; earlier in-flight requests can be cancelled via `AbortController` to stop stale responses from overwriting newer cache state.

**Files:** `src/store/annotation.ts` — the module-level `_hydrateFromBackend` function.

### 3. Zoom doesn't change hydration selection (real bug)

Documented in Phase 5 notes below under "Hydration set doesn't change on zoom." The 2× viewport expansion (applied in Step 2 of `updateVisibilityAndHydration`) was designed for pan pre-loading, but when zoomed out the expanded box covers the entire frame — so `inViewportIds ≈ currentFrameIds` and viewport-based prioritization becomes a no-op. Zoom-in does not cause the newly-visible region to be preferentially hydrated.

**Approach (simplest):** Use **unexpanded** bounds for the hydration viewport split (Step 4), and expanded bounds only for the visibility split (Step 3). Two separate `annotationSpatialIndex.splitByViewport` calls.

**Files:** `src/store/annotation.ts` — `updateVisibilityAndHydration` Steps 2–4.

### Future (smaller wins)

- **Hydrate-on-selection via backend API** — currently selection preservation only works if the annotation is already in the hydration cache (see `setHydratedAnnotations` loop over `selectedAnnotationIds`). If user selects a stub that isn't hydrated, we should trigger a one-off hydrate for that id.
- **Handle hydration failures gracefully** — `logError` is called but the UI doesn't retry or surface the error to the user.
- **Property values lazy loading** — see section below; likely a bigger memory win than stub annotations at scale.

> **Note (2026-06-17):** Export is NOT affected by stub-only mode. `ExportAPI.exportJson/exportCsv` stream from the backend `/export/{json,csv}` endpoints (datasetId + ids only); the server reads full coordinates from Mongo and never touches the frontend's stub state. The earlier "hydrate-all before export" concern was based on an in-frontend iteration path that no longer exists.

---

## Stub-only mode: known bugs + AnnotationList scaling decision (2026-06-17)

### Status correction
The "Next Steps" above are partly stale. As of 2026-06-17: **(1) the accumulating LRU hydration cache is DONE** (`mergeHydratedAnnotations`, cap 10k, protects selected ids); `stubPerf` instrumentation (`window.__stubPerf`) is in. Still open: **(2) debounce / AbortController on the fetch itself** (only the watcher is debounced, 250 ms — the fetch fires un-cancelled), and **(3) zoom hydration selection** (still uses the 2× expanded viewport for both visibility and hydration, so zoom doesn't re-prioritize).

### Known bugs — coordinate access in stub-only mode — FIXED (2026-06-17)
In stub-only mode, `annotationsForIteration` returns `IAnnotationStub`s cast as `IAnnotation` — they have `.centroid` but **no `.coordinates`**. Any code that reads `.coordinates` on a list/filter item breaks. Both were latent (only fire on the relevant interaction), which is why normal use didn't catch them. Both now fixed (TDD; full suite green):

- **Row-click recenter** — `AnnotationList.vue` `goToAnnotationIdLocation` called `simpleCentroid(annotation.coordinates)`; in stub-only mode `getAnnotationFromId` returns `undefined` for non-hydrated annotations, so the row-click no-op'd entirely. **Fixed:** fall back to `getStub(id)` for location and to the stub centroid / `annotationCentroids[id]` for the camera center (full annotations still use `simpleCentroid(coordinates)`). Test: `AnnotationList.test.ts` "navigates using the stub when the annotation has no coordinates".
- **ROI filter** — `filters.ts` `filteredAnnotations` did `annotation.coordinates.some(...)`, which threw as soon as an ROI filter was enabled in stub-only mode. **Fixed:** extracted a pure `annotationTestPoints(annotation, centroid)` helper (`utils/annotation.ts`) that returns coordinates when present and falls back to the centroid (consistent with stub-based drag-select); the getter captures `annotationCentroids` before the filter callback. Tests: `annotationStubUtils.test.ts` "annotationTestPoints".

### Why the AnnotationList doesn't scale today (investigation findings)
The list is a **client-side, load-everything** component:
- **Not virtualized / not server-paginated.** `<v-data-table :items="filteredItems">` materializes one item object per *filtered* annotation (`filteredItems = listedAnnotations.map(annotationToItem)`). Vuetify renders only the current page (10/50/200) into the DOM, but holds and processes the entire array.
- **Sort is client-side over the full set.** Sorting by a property column requires *every* annotation's value loaded in memory.
- **Filter is client-side over the full set.** `filteredAnnotations` iterates all annotations and reads `properties.propertyValues[id]` (property filter) and `.coordinates` (ROI filter) per annotation.
- **Property values are loaded eagerly and wholesale.** `fetchPropertyValues()` → `getPropertyValues(datasetId)` pulls *all* values for *all* annotations into one `{[annoId]:{[propId]:value}}` map and **replaces** it each time (`properties.ts:224 TODO(performance): merge instead`). This is the single largest structure (annotations × properties) and is unchanged by stub-only mode — so the stub coordinate-memory win is undercut by property values at scale.
- **Existing precedent:** hover-to-highlight is already hard-disabled above 5,000 annotations (`AnnotationList.vue:600`), confirming list interactions already don't scale.

What the **backend already supports**: `annotation_property_values/histogram` computes per-property histograms server-side (the filter UI already uses these), and `annotation_property_values` is paginated — but sorted by `_id` only. There is **no** server-side "sort / paginate by property value" endpoint.

### The decision
**Keep the list client-side (make it correct + bounded), or move list operations server-side (sort / filter / paginate)?**

- **Option A — client-side, bounded (small):** fix the coordinate bugs above, keep loading everything, add a hard "list degraded/disabled above N" guard (extends the existing 5,000 hover guard). Does *not* solve property-value memory — only fixes correctness.
- **Option B — server-side list (the real fix):** new backend endpoint returning a *page* of annotations joined with the requested property values, sorted/filtered server-side (Mongo aggregation: `$match` filters → join property values → `$sort` → `$skip/$limit`). Property values become lazy (only the visible page + histograms). Rewrite the list to Vuetify server-items mode (`:items-length`, fetch-on page/sort/filter change). This is the direction the stub architecture points to and the only option that actually scales — but it's meaningful backend + frontend work.
- **Option C — hybrid (viewport-driven):** list shows viewport annotations (like hydration), values loaded for those, with an explicit "load all values for property X" for global sort/export. More UX complexity; likely not the first move.

**Recommendation:** A as an immediate correctness patch (cheap, unblocks stub-only datasets), then B as the real scaling work. C only if viewport-scoped browsing turns out to be the desired UX.

**Decision (2026-06-17): A now, then B.** **A is complete:**
- Both coordinate bugs above are **fixed** (TDD, full suite green).
- **List scale guard added** — `AnnotationList.vue` `LIST_ITEM_LIMIT = 20000`; when the filtered count exceeds it, `tooManyToList` short-circuits `filteredItems` to `[]` and the table is replaced with a "Too many to list — narrow with filters" message (the annotation ID filter stays available to narrow down). Tests: `AnnotationList.test.ts` "list size guard". This prevents the tab hanging on large stub-only datasets; it is *not* a partial-sort — it's an honest block until B ships.

**B (IMPLEMENTED 2026-06-18):** server-side sort/filter/paginate + lazy per-page property values + dual-mode `AnnotationList.vue` (the existing client-side list is unchanged below the stub threshold; a server-driven `v-data-table-server` takes over above it). Full design + as-built notes: [`ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](./ANNOTATION-LIST-SERVER-SIDE-DESIGN.md); task-by-task plan: [`ANNOTATION-LIST-SERVER-SIDE-PLAN.md`](./ANNOTATION-LIST-SERVER-SIDE-PLAN.md).

What shipped:
- **Backend** `POST /upenn_annotation/list` (a page of stub-shaped rows + the requested property values + `total`) and `POST /upenn_annotation/list/ids` (all matching ids, for `Select All` / `Delete Unselected`). Annotation-driven aggregation: `$match` (datasetId/shape/tags/location/idSubstring/idConstraints) → property `$lookup`+`$unwind` (only when a property column/sort/filter needs it) → property filters → centroid `$addFields` + missing-last sort → `$skip`/`$limit` → project. Filter/sort/path shape is validated → 400. Backend in `server/{api,models}/annotation.py`; tests in `test/test_server_list.py` (18 cases).
- **Frontend** `AnnotationsAPI.fetchAnnotationListPage/Ids`, the `annotationListServer` store module (`buildListFilters` translates the client filter store → backend filters), and dual-mode `AnnotationList.vue`. In server mode the component is **fully decoupled** from `filterStore.filteredAnnotations` (it would iterate all stubs and apply property filters without values loaded — both a perf and correctness hazard); refetch is debounced (~300 ms).
- **Filters applied server-side:** tags (inclusive `$in` / exclusive `$all`+`$size`, matching `tagCloudFilterFunction`), location (onlyCurrentFrame), idSubstring, property range/values, **and** selection + annotation-id filters (translated to `idConstraints` = AND of `_id $in` sets). **ROI is the only filter NOT applied server-side** (shows an inline notice).
- **Real-data validated:** HCR 26K (16/16 checks), idConstraints (7/7), Xenium 708K (functionally correct).

**Deferred (NOT done — see design spec §8):**
- **Performance at large scale** — at 708K, `/list` is 3.6–25 s because centroid/`$lookup`/sort run over the full matched set before pagination and there is no per-property index (indexing is non-trivial: property values are nested and prop ids differ per dataset). Decision (2026-06-18): ship correct, optimize later.
- **Server-side ROI filtering**; **infinite scroll** (page-numbers + total for now; deep `$skip` is slow); **tag/color server-mode refresh** (rows show stale tags/colors until the next refetch); other `propertyValues` consumers (plots, properties panels) still load values wholesale.
- The Option-A `LIST_ITEM_LIMIT = 20000` client guard is now **unreachable** (server mode activates at `maxVisible = 10000`); kept as a defensive net.

---

## Architecture

### Data Flow

```
annotations[] (full data from backend)
       │
       ▼
annotationStubs (Map<id, IAnnotationStub>) — source of truth for "what exists"
       │
       ▼
filteredAnnotations (user tag/property/frame filters applied)
       │
       ▼
frame split (current frame vs other frames)
       │
       ├── currentFrameIds ──► viewport split (R-tree query)
       │                          ├── inViewportIds
       │                          └── outOfViewportIds
       │
       ▼
two-tier visibility budget (maxVisible, default 10K)
  Tier 1: inViewportIds (hash-ranked if over budget)
  Tier 2: outOfViewportIds (hash-ranked, fill remaining)
       │
       ▼
visibleAnnotationIds (render budget)
       │
       ▼
two-tier hydration budget (maxHydrated, default 5K)
  Tier 1: inViewportIds (largest first by estimatedRadius)
  Tier 2: outOfViewportIds (largest first, fill remaining)
       │
       ▼
hydratedAnnotations (viewport-driven, replaced each update)
       │
       ▼
layerAnnotations gate: needsStubSystem?
  frameCount > maxVisible → use stub system (visibility + hydration)
  frameCount ≤ maxVisible → bypass, use full annotations directly
       │
       ▼
GeoJS Renderer (dots for stubs, full shapes for hydrated)
```

### Key Types

```typescript
// Lightweight stub — no coordinates, just centroid
interface IAnnotationStub {
  id: string;
  centroid: IGeoJSPosition;
  location: IAnnotationLocation;  // { XY, Z, Time }
  shape: AnnotationShape;
  channel: number;
  tags: string[];
  color: string | null;
  estimatedRadius?: number;       // bbox diagonal / 2, used for size-based hydration ranking
}

type TAnnotationOrStub = IAnnotation | IAnnotationStub;
type THydrationMode = "shapes" | "dots";

interface IVisibilityConfig {
  maxVisible: number;   // Max annotations to render as stubs or shapes (default 10,000)
  maxHydrated: number;  // Max annotations to keep hydrated with full coordinates (default 5,000)
}

// Type guard
function isHydratedAnnotation(annotation: TAnnotationOrStub): annotation is IAnnotation;
```

### Rendering Strategy

1. **Hydrated annotations**: Render as full shapes (polygon, line, point, etc.) using actual coordinates
2. **Stub annotations**: Render as points at centroid, sized to `estimatedRadius` (minimum 3 world units), with thinner strokes and lower opacity for visual distinction
3. **Selected annotations**: Always hydrated regardless of budgets or frame

### Selection Behavior

Drag-select queries **both** spatial indexes:
- The **displayed annotations index** (RBush of rendered annotation bounding boxes) for precise geometric hit-testing on visible annotations
- The **global centroid index** (`annotationSpatialIndex`) for non-visible annotations on the current frame

This ensures selecting a region and deleting captures ALL annotations in that area, not just the visible ones.

---

## Files Modified/Created

| File | Changes |
|------|---------|
| `src/store/model.ts` | `IAnnotationStub`, `TAnnotationOrStub`, `THydrationMode`, `IVisibilityConfig`, `isHydratedAnnotation()` |
| `src/utils/annotation.ts` | `getStubStyleFromBaseStyle()`, `hashString()`, `selectRandomSubset()`, `estimateAnnotationRadius()`, exported `TAnnotationStyle` |
| `src/utils/spatialIndex.ts` | **NEW** — `AnnotationSpatialIndex` class wrapping RBush for centroid-based viewport queries. Module-level singleton `annotationSpatialIndex` (outside Vuex to avoid reactivity corruption) |
| `src/store/annotation.ts` | New state: `annotationStubs`, `hydratedAnnotations`, `visibleAnnotationIds`, `hydrationMode`, `visibilityConfig`. New getters: `isHydrated`, `getStub`, `getHydratedAnnotation`, `isVisible`, `shouldRenderAsShape`, `getForRendering`. New mutations: `setVisibleAnnotationIds`, `setHydrationMode`, `setHydratedAnnotations`, `clearHydrationCache`. New action: `updateVisibilityAndHydration`. Modified mutations: `setAnnotations`, `addAnnotationImpl`, `setAnnotation` |
| `src/components/ImageViewer.vue` | Added `geojs.event.zoom` listener so `cameraInfo.gcsBounds` updates on zoom |
| `src/components/AnnotationViewer.vue` | `layerAnnotations` visibility filtering, `createGeoJSAnnotation` stub handling, stub-specific styling in restyle paths, debounced visibility watcher, global spatial index for selection of non-visible annotations |
| `src/utils/__tests__/spatialIndex.test.ts` | **NEW** — 9 tests |
| `src/utils/__tests__/annotationStubUtils.test.ts` | **NEW** — 15 tests |
| `src/store/__tests__/annotationStubs.test.ts` | **NEW** — 44 tests |

---

## Mock Data Strategy (Current)

Since the backend doesn't yet return stubs natively, the frontend simulates the architecture:

1. `fetchAnnotations()` loads ALL annotations with full coordinates (as before)
2. `setAnnotations()` builds stubs from the full data, computing centroids and `estimatedRadius`
3. Hydration cache starts empty — populated on demand by `updateVisibilityAndHydration`
4. Each visibility update computes `idsToHydrate` (viewport-prioritized, largest first) and replaces the hydration cache by looking up full annotations from the local `annotations[]` array
5. The full `annotations[]` array is retained for backward compatibility with all existing consumers (AnnotationBrowser, export, property computation, etc.)

**Implication:** The mock strategy uses MORE memory than the current system (stubs + full array), not less. The savings come when the backend returns real stubs (Phase 5).

**Backend swap point:** In `updateVisibilityAndHydration` Step 7, the inline loop that reads from `this.annotations[idx]` is the single point to replace with `this.annotationsAPI.getAnnotationsByIds(idsToHydrate)`. The fetch would become async + debounced, and the cache would accumulate rather than replace (with LRU eviction at a configurable cap) to avoid re-fetching on every pan.

---

## Memory Analysis

### Current Dataset: 26K annotations, ~4 coords/annotation avg

| | Count | Coords | Memory |
|---|---|---|---|
| All annotations (full) | 26,142 | 104,578 | 7.38 MB |
| Stub-only (no coords) | 16,142 | 0 | 3.08 MB |
| Hydrated (full coords) | 10,000 | 40,010 | 2.82 MB |
| **Current mock total** | 26,142 | 40,010 | **7.81 MB** |
| With real stub API would save | — | 64,568 | −0.43 MB |

Key insight: With only ~4 coordinates per annotation, metadata (200 bytes) dominates over coordinates (96 bytes). Savings are minimal at this scale.

### Projected: 1M annotations

**With 15 coords/annotation (typical complex polygons):**

| | Memory | % of full |
|---|---|---|
| Full data (1M × 560 bytes) | 534 MB | 100% |
| Stubs (990K × 200) + Hydrated (10K × 560) | 194 MB | 36% |
| **Savings** | **340 MB** | **64%** |

**With 4 coords/annotation (simple rectangles):**

| | Memory | % of full |
|---|---|---|
| Full data (1M × 296 bytes) | 282 MB | 100% |
| Stubs (990K × 200) + Hydrated (10K × 296) | 201 MB | 71% |
| **Savings** | **81 MB** | **29%** |

### Memory estimation constants

```
BYTES_PER_COORDINATE = 24    (x, y, z as 8-byte doubles)
BYTES_PER_STUB_OVERHEAD = 200  (id, location, tags, shape, channel, color, centroid)
```

### Network transfer savings (with real stub API)

At 1M annotations with 15 coords/annotation:
- Full fetch: 534 MB
- Stub fetch: 191 MB (stubs only, hydrate 10K on demand: +5 MB)
- **Transfer savings: 338 MB (63%)**

The bigger win is time-to-interactive: stubs load fast → dots render → user can interact → hydrate on demand.

---

## Post-Implementation Refinements (2026-04-06)

### Stub size matches annotation size
- `getStubStyleFromBaseStyle()` accepts `estimatedRadius` parameter
- Stubs render as dots sized to their actual annotation size (max bbox half-extent)
- No minimum radius — `estimatedRadius` used as-is
- `stubRadius` stored in GeoJS annotation options for restyle persistence

### Viewport-driven hydration (replaces random pre-hydration)
- Hydration cache is no longer pre-populated on annotation load — starts empty
- Each `updateVisibilityAndHydration` call computes `idsToHydrate` (up to `maxHydrated`) and **replaces** the cache entirely
- Viewport annotations are prioritized (largest first by `estimatedRadius`), then off-viewport fills remaining budget
- Zooming in immediately hydrates viewport annotations and drops off-viewport ones
- **Why replace, not accumulate:** With the mock strategy (all data local), there's no network cost to "re-fetch." Replacing ensures the hydration budget always reflects the current viewport. When the backend API exists, the strategy will switch to accumulate + LRU eviction to minimize network transfers.
- `selectRandomSubset()` is still used for the visibility budget (hash-based random downsampling when over `maxVisible`)

### Expanded hydration viewport (2x)
- `updateVisibilityAndHydration` expands the viewport bounds by 50% on each side before the spatial index query
- This means the "inViewport" region is 2x the actual viewport in each dimension
- Annotations in this expanded region are prioritized for both visibility and hydration budgets
- Result: panning reveals pre-hydrated annotations instead of stubs popping in

### Stub system bypass for below-budget frames
- `layerAnnotations` computed now counts annotations on the current frame per layer
- If the count is ≤ `maxVisible` (20,000), the entire stub system is bypassed: no visibility filtering, no stub-vs-hydrated rendering — the original full annotation objects are used directly
- **Why this matters:** Without this bypass, changing frames (XY, Z, Time) caused a visible flash. The sequence was: (1) frame changes, (2) `layerAnnotations` re-evaluates with stale `visibleAnnotationIds`/`hydratedAnnotations` from the previous frame, (3) new frame's annotations either get filtered out (invisible) or rendered as stubs, (4) `updateVisibilityAndHydration` runs and fixes the state, (5) re-render shows correct shapes. Steps 2–4 created a 1–2 frame flash of empty or stub-rendered annotations.
- **Strategic choice:** Rather than trying to keep `visibleAnnotationIds` and `hydratedAnnotations` perfectly in sync with frame changes (which is fragile due to Vue watcher ordering and Vuex action timing), we avoid the problem entirely — the stub system only activates when it's genuinely needed (more annotations than the render budget allows). This means datasets with ≤20K annotations per frame behave identically to master branch, with zero overhead from the stub architecture.
- The gate variable `needsStubSystem` (`stubsSize > 0 && frameCount > maxVisible`) controls both visibility filtering and `getForRendering` in a single check

### Debounce strategy for visibility updates
- Frame changes (`xy`, `z`, `time`) and annotation list changes (`filteredAnnotations`) trigger `updateVisibilityAndHydration` **immediately** (no debounce)
- Camera changes (`cameraInfo` — pan/zoom) trigger it with a **250ms debounce** since they fire rapidly during interaction
- **Why:** The debounce was originally applied to all sources. But frame changes are discrete events (user clicks a button), not continuous streams, and the 250ms delay was the primary cause of stale visibility state on frame transitions. Camera pan/zoom genuinely benefits from debouncing to avoid thrashing the spatial index query during drag.

### RESOLVED (2026-06-19): stub circles too large — world/pixel unit mismatch
The earlier symptom ("~2× too large for small annotations, fine for large ones")
was the visible tail of a general bug, not a GeoJS minimum-size quirk.

**Root cause:** `estimateAnnotationRadius()` returns a bbox half-extent in **world
(image-pixel) units**, but `getStubStyleFromBaseStyle()` fed it into a GeoJS point
feature with a hardcoded **`scaled: 1`**. GeoJS renders a point radius as
`radius · 2^(zoom − scaled)` display pixels, so `scaled: 1` only matches the
annotation's true footprint when the tile pyramid's zoom-0 resolution is
`unitsPerPixel(0) = 2`. On a whole-slide dataset where `unitsPerPixel(0) = 32`
(= 2⁵), every stub rendered `2^(5−1) = 16×` too large in radius — ~327 px blobs
instead of ~9 px cell-sized dots. The "2×" case was simply a `unitsPerPixel(0) = 4`
dataset (2^(2−1) = 2×); the "works for the square dataset" case was
`unitsPerPixel(0) = 2` (no error).

**Fix:** world-locked sizing needs `scaled = log2(unitsPerPixel(0))` — the zoom
level at which one world unit equals one display pixel. `getStubStyleFromBaseStyle()`
now takes a `scaled` parameter, and `AnnotationViewer` computes it from the live
map via `getStubScaled()` (= `Math.log2(map.unitsPerPixel(0))`) at all three
styling sites (initial draw, hover/select restyle, full restyle).

**Verified** on the 708K Xenium dataset: stubs carry `scaled = 5`, and the
rendered radius exactly equals the world-correct radius (`radius / unitsPerPixel(zoom)`)
at every zoom (ratio 1.0). Tests: `annotationStubUtils.test.ts` "applies the
provided scaled value so stubs track world size".

**Implication for the styling setting:** stubs are now always world-locked (they
scale with zoom to track the real shape's footprint), regardless of the
`scaleAnnotationsWithZoom` setting that governs literal point-annotation dots.
This resolves the open "should stubs respect scaleAnnotationsWithZoom" to-do below.

### Selection includes non-visible annotations
- `getSelectedAnnotationsFromAnnotation()` queries both the displayed RBush and the global `annotationSpatialIndex`
- Drag-select catches ALL annotations in the region on the current frame, regardless of visibility budget
- Frame filtering (XY, Z, Time) applied to global candidates

---

## To-Do List

### Threshold and Hydration Refinement
- [ ] Test and tune `maxVisible` (currently 10,000) — balance between coverage and rendering performance
- [ ] Test and tune `maxHydrated` (currently 5,000) — how many shapes to render before performance degrades
- [ ] Consider making thresholds configurable via UI settings panel
- [ ] Evaluate whether size-based hydration ranking (largest first) is the right heuristic vs. alternatives (density, distance to viewport center, user focus area)
- [ ] Consider zoom-based adaptive thresholds — show shapes only when annotations are large enough relative to the viewport (code is deferred/commented out in Vue 2 version)
- [ ] Profile `updateVisibilityAndHydration` with 100K+ annotations to identify bottlenecks
- [ ] Review debounce timing (currently 250ms) for responsiveness vs CPU trade-off
- [ ] Test hydration/dehydration memory churn during rapid pan/zoom

### Styling Adjustments
- [x] Review whether stubs should respect `scaleAnnotationsWithZoom` setting or always use fixed world size — **resolved 2026-06-19:** stubs are always world-locked via `scaled = log2(unitsPerPixel(0))` so the dot tracks the annotation's real footprint at every zoom (see "RESOLVED: stub circles too large" above)
- [ ] Consider different hover/selection effects for stubs vs full annotations
- [ ] Fine-tune stub visual distinction (currently thinner stroke + lower opacity)

### Selection Improvements
- [ ] Verify point-click selection works correctly for stub annotations (centroid hit-testing)
- [ ] Consider whether non-visible, non-rendered annotations should be selectable via point-click (currently only drag-select catches them)

### Backend API (Phase 5 — DONE)

Two new endpoints implemented in `server/api/annotation.py`, registered as routes on the `Annotation` resource class.

**Endpoint 1: `GET /upenn_annotation/stubs?datasetId=X`**
- Returns all annotations WITHOUT `coordinates` field, WITH server-computed `centroid` and `estimatedRadius`
- Supports `shape` and `tags` query filters (same as existing `find` endpoint)
- Uses MongoDB aggregation pipeline: `$match` → `$addFields` (centroid via `$avg`, estimatedRadius via bbox diagonal) → `$project {coordinates: 0}`
- Hints `{datasetId: 1, _id: 1}` compound index
- ACL: `@access.public`, loads dataset folder with `AccessType.READ`
- Streams response using same chunked `orjson` generator pattern as `find`
- Performance (26K annotations): 497ms, 6.7 MB (vs 738ms, 9.5 MB for full fetch)

**Endpoint 2: `POST /upenn_annotation/hydrate`**
- Accepts JSON array of annotation IDs in body, returns full documents with coordinates
- ACL: Aggregates distinct `datasetId` values from requested annotations, checks READ access on each via `requireDatasetsAccess`
- Streams response
- Performance: 104ms for 5K IDs, 329ms for 10K IDs
- Includes a note about `$in` chunking for future 500K+ scenarios (matching the CSV export lesson)

**Tests:** 13 new tests in `test_stubs.py` covering both endpoints (empty dataset, centroid/radius computation, shape/tag filters, access denied, nonexistent IDs, point annotations).

**All 136 backend tests pass, flake8 clean.**

### Frontend Integration (Phase 5 — IN PROGRESS, has unresolved issues)

**What's been implemented:**

- `AnnotationsAPI.ts`: Added `getAnnotationStubs(datasetId)` and `hydrateAnnotations(annotationIds)` methods with `toStub()` converter
- `annotation.ts`: `fetchAnnotations()` checks annotation count — under `maxVisible` threshold uses existing full fetch, over threshold uses stubs endpoint
- `annotation.ts`: New `setAnnotationStubsFromBackend()` mutation populates stubs/centroids/spatial index directly from server data (no client-side computation)
- `annotation.ts`: New `stubOnlyMode` state flag, `annotationsForIteration` getter (returns `annotations[]` normally, stubs in stub-only mode)
- `annotation.ts`: `removeAnnotationStubs()` mutation for deletions in stub-only mode
- `annotation.ts`: `_hydrateFromBackend()` module-level async function (see gotcha below)
- `AnnotationViewer.vue`: Uses `annotationsForIteration` instead of `annotations`, direct `hydratedAnnotations` read for reactive dependency
- Multiple component updates to use `annotationsForIteration` (filters.ts, AnnotationContextMenu, TagCloudPicker, AnnotationList, AnnotationImport, DeleteConnections, PropertyCreation, annotationImport.ts)
- All test mocks updated with `annotationsForIteration` getter

**TypeScript: 0 errors. Frontend tests: 2187/2187 passing.**

### On-Demand Hydration (Part of Phase 5 — IN PROGRESS)
- [x] Backend endpoints for stubs and hydration
- [x] Frontend API client methods
- [x] Count-based threshold to choose full fetch vs stubs
- [x] Hydration cache with keep/fetch logic
- [ ] **Fix rendering — hydrated annotations not reliably rendering as shapes (see Unresolved Issues below)**
- [ ] Viewport-driven hydration that actually tracks zoom level
- [ ] Re-introduce accumulating cache with LRU eviction (don't re-fetch on every pan)
- [ ] Debounced fetch (200ms) to batch rapid viewport changes into single request
- [ ] Hydrate on selection (currently done via mock — needs real API path)
- [ ] Consider hydrate-on-hover for quick preview
- [ ] Hydrate all before export operations
- [ ] Handle hydration failures gracefully

### Connection Stubs (Low Priority — Future Optimization)
- [ ] Connections are lightweight (two annotation IDs + label/tags), so stub treatment is not anticipated to be needed soon. Revisit if connection counts become a bottleneck.

### Property Values Lazy Loading (Important — Major Memory Source)

Property values (`IAnnotationPropertyValues`) are a separate and potentially larger memory burden than annotation coordinates. The current system loads all property values for all annotations upfront. At scale (1M annotations × multiple properties), this is unsustainable.

**Key differences from annotation stubs:** The problem is less about rendering and more about what the AnnotationList/AnnotationBrowser components display. Users interact with property values through sorting, filtering, and browsing — not just viewport visibility.

**Potential strategies:**

- [ ] **Visible-only loading**: Only fetch property values for annotations currently visible in the viewport (similar to annotation hydration). Cheapest approach, but limits sorting/filtering to visible subset.
- [ ] **On-demand column loading**: When user adds a property column to the AnnotationList, fetch values for that property only. Backend endpoint: `GET /annotation_property_values?propertyId=X&datasetId=Y`
- [ ] **Server-side sorting/pagination**: Instead of loading all values to sort client-side, add backend endpoints for sorted/paginated annotation lists by property value. The AnnotationList would request "page N of annotations sorted by property X" and only hydrate those.
- [ ] **Hybrid approach**: Load property values for visible annotations automatically, plus allow explicit "load all values for property X" for sorting/export use cases. Show "load values" button in column header.
- [ ] **Property value stubs**: Lightweight summary stats (min/max/mean) per property per layer, loaded upfront. Full per-annotation values loaded on demand.
- [ ] **Cache eviction**: When switching properties or frames, evict old property values to keep memory bounded. LRU or frame-based eviction.
- [ ] **Backend aggregation endpoints**: For common operations (histogram, statistics, filtering), compute server-side without transferring all values. The AnnotationBrowser's property filter could query the backend directly.

**Current property values structure** (`src/store/properties.ts`):
```typescript
// IAnnotationPropertyValues = { [annotationId]: { [propertyId]: value } }
// Loaded via PropertiesAPI.getPropertyValues()
// Used by: AnnotationList (display/sort), AnnotationBrowser (filter), property plots
```

---

## Phase 5 Implementation Notes — Unresolved Issues and Lessons Learned

### Critical: Mock strategy hid a rendering non-distinction

In the mock strategy, `layerAnnotations` falls back to the original `annotation` object when `getForRendering()` returns undefined:
```typescript
const renderData = needsStubSystem
  ? annotationStore.getForRendering(annotation.id) ?? annotation
  : annotation;
```
In mock mode, `annotation` comes from `this.annotations[]` which are full `IAnnotation` objects WITH coordinates. So `isHydratedAnnotation(renderData)` was always `true` — every annotation rendered as a shape regardless of whether it was in the hydrated set. **The stub/shape visual distinction was never actually exercised in mock mode.**

In backend mode, `annotation` comes from `annotationsForIteration` which returns stubs (no coordinates). Now the distinction is real: non-hydrated annotations render as dots, hydrated ones as shapes. This exposed multiple issues that were invisible before.

### Critical: vuex-module-decorators async actions are fundamentally broken

`@Action` methods in vuex-module-decorators use a `this` proxy. After an `await`:
- `this.someState` → `undefined` (reads fail silently)
- `this.someMutation()` → silently fails (no error without `rawError: true`)
- `this.context.commit()` → also unreliable after await

**Solution:** Extract async work into a **module-level function** outside the class. Capture all needed state into local variables BEFORE calling the async function. The async function commits mutations via the exported module instance (`annotationModule.setHydratedAnnotations(...)`) rather than through the action proxy.

Current implementation:
```typescript
// Inside the @Action (synchronous):
const hydratedCache = this.hydratedAnnotations;  // capture state
const api = this.annotationsAPI;                  // capture API ref
_hydrateFromBackend(api, idsToFetch, keepEntries); // fire-and-forget

// Outside the class (async, no proxy issues):
async function _hydrateFromBackend(api, idsToFetch, keepEntries) {
  const fetched = await api.hydrateAnnotations(idsToFetch);
  annotationModule.setHydratedAnnotations([...keepEntries, ...fetched]);
}
```

### Critical: Vuex getter functions defeat Vue reactivity tracking

Vuex getters like `isVisible`, `shouldRenderAsShape`, and `getForRendering` return **functions**. When a Vue `computed()` calls these functions, Vue tracks the dependency on the getter (the function reference), NOT on the state the function reads internally. So when `hydratedAnnotations` or `visibleAnnotationIds` change, `layerAnnotations` doesn't recompute unless it also reads those state properties directly.

**Solution:** In `layerAnnotations`, added explicit read of `annotationStore.hydratedAnnotations` to create a reactive dependency:
```typescript
const hydratedAnnotations = annotationStore.hydratedAnnotations;
```
This is also used directly for the hydration lookup (`hydratedAnnotations.get(annotation.id)`) instead of going through `getForRendering()`.

**`visibleAnnotationIds` has the same problem** — `annotationStore.isVisible(id)` calls go through a function-returning getter. This may need a similar direct-read fix.

### Resolved: Annotations disappear after hydration in stub-only mode

**Symptom:** In stub-only mode, stubs rendered correctly on initial load. As soon as async hydration populated `hydratedAnnotations`, all annotations disappeared from the canvas. Pan/drag briefly repainted them via GeoJS's internal redraw, then they vanished again on the next hydration cycle.

**Root cause:** `setStubsFromServer` populated `annotationStubs` and the spatial index but **not** `annotationCentroids`. In under-threshold mode, `setAnnotations` builds `annotationCentroids` from full annotation coordinates; in stub-only mode, `setAnnotations([])` is called first (zeroing `annotationCentroids`) and `setStubsFromServer` runs after — but the centroid map was never rebuilt from `stub.centroid`.

The `unrolledCentroidCoordinates` computed reads `annotationStore.annotationCentroids[annotation.id]`, which returned `undefined` for every stub. `drawGeoJSAnnotationFromConnection` spreads that undefined into empty `{}` objects and passes them to `geojs.annotation.lineAnnotation()`, which throws **"Invalid coordinates"**. The error propagated up through `drawNewConnections` → `drawAnnotationsNoThrottle`, **aborting before the final `annotationLayer.draw()`**. Since `clearOldAnnotations(true, false)` had already triggered GeoJS's internal `removeAllAnnotations` (which calls `draw()` internally when `update !== false`, painting an empty canvas), the canvas stayed empty.

The bug only manifested after hydration because `drawNewConnections` requires `getAnnotationFromId` to return truthy for both endpoints of a connection. In stub-only mode, that only happens after hydration populates the relevant ids — so the connection-drawing code path (and its error) was dormant on the initial stub-only render.

Pan/drag briefly reappeared annotations because GeoJS's internal pan handler triggers `_update()` on the layer, which rebuilds features from `m_annotations` (which DID receive the 10K added annotations via `addMultipleAnnotations` before the connection error aborted the flow).

**Fix:** Populate `annotationCentroids` in `setStubsFromServer` from each `stub.centroid`. The invariant "every annotation id in stubOnlyMode has a centroid in `annotationCentroids`" was already assumed by `removeAnnotationStubs` — this fix makes it hold.

### Unresolved: Hydration set doesn't change on zoom

With uniform-size annotations (all ~7.07 radius), the 2x viewport expansion makes `inViewportIds ≈ currentFrameIds` (the expanded viewport covers the entire frame). So viewport-based prioritization has no effect — hydration always selects from the full frame.

**Attempted fixes:**
- Sort by distance to viewport center → creates visible "hydration ring" (center hydrated, edges not)
- Hash-based random from visible set → even distribution but doesn't prioritize viewport on zoom
- Neither approach properly responds to zooming in (selecting annotations in the actual viewport)

**Root cause:** The 2x viewport expansion (designed for pre-hydration during pan) is too aggressive for this dataset geometry. When zoomed out, the expanded viewport covers everything.

**Potential solutions:**
1. Use the **unexpanded** viewport for hydration, expanded only for visibility
2. Adaptive expansion based on zoom level (less expansion when zoomed out)
3. Two-pass: hydrate all in actual (unexpanded) viewport first, fill remaining budget from expanded area
4. Just increase `maxHydrated` to match `maxVisible` (simpler, costs more memory but these are only 4-coord annotations)

### Files modified in Phase 5 frontend integration

| File | Changes |
|------|---------|
| `src/store/AnnotationsAPI.ts` | Added `getAnnotationStubs()`, `hydrateAnnotations()`, `toStub()` |
| `src/store/annotation.ts` | `stubOnlyMode` flag, `annotationsForIteration` getter, `setAnnotationStubsFromBackend()` mutation, `removeAnnotationStubs()` mutation, `_hydrateFromBackend()` module-level function, modified `fetchAnnotations()` (count-based branching), modified `updateVisibilityAndHydration()` Step 7, fixed `allAnnotationIds`/`inactiveAnnotationIds`/`annotationTags`/`getAnnotationFromId`/`deleteAnnotations`/`combineAnnotations` for dual-mode |
| `src/components/AnnotationViewer.vue` | `annotationsForIteration` refs (3 places), direct `hydratedAnnotations` reactive dependency, inline hydration lookup in `layerAnnotations`, stub-state-change check in `clearOldAnnotations` |
| `src/store/filters.ts` | `annotationsForIteration` in `filteredAnnotations` getter |
| `src/components/AnnotationContextMenu.vue` | `annotationsForIteration` |
| `src/components/TagCloudPicker.vue` | `annotationsForIteration` |
| `src/components/AnnotationBrowser/AnnotationList.vue` | `annotationsForIteration` |
| `src/components/AnnotationBrowser/AnnotationImport.vue` | `annotationsForIteration` |
| `src/components/AnnotationBrowser/DeleteConnections.vue` | `annotationsForIteration` |
| `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue` | `annotationsForIteration` |
| `src/utils/annotationImport.ts` | `annotationsForIteration` |
| Tests: `AnnotationViewer.test.ts`, `TagCloudPicker.test.ts`, `AnnotationList.test.ts`, `DeleteConnections.test.ts`, `PropertyCreation.test.ts` | Added `annotationsForIteration` getter to mocks |

### Backend files modified in Phase 5

| File | Changes |
|------|---------|
| `server/api/annotation.py` | Added `stubs` and `hydrate` route + handler methods |
| `test/test_stubs.py` | **NEW** — 13 tests for both endpoints |

---

## Resolved Design Decisions

1. **Stub fields**: Include tags, shape, channel, location, centroid, color, estimatedRadius. Exclude datasetId (redundant), name (usually null), coordinates (the whole point)
2. **Selection architecture**: ID-based (`Set<string>` with `markRaw()`)
3. **Stub rendering**: Points at centroid, sized to `estimatedRadius`
4. **Vue 3 reactivity**: All new Maps/Sets wrapped with `markRaw()`, replaced on mutation for Vuex reactivity
5. **Two spatial indexes coexist**: Displayed annotations RBush (bbox-based, for click/lasso hit-testing) and global centroid RBush (for visibility viewport queries). Independent, different purposes.
6. **`annotations[]` retained in under-threshold mode**: When count ≤ `maxVisible`, full fetch is used and `annotations[]` is populated normally. When count > `maxVisible`, `annotations[]` is empty and `annotationsForIteration` returns stubs cast as `IAnnotation[]`. The cast is safe because downstream iteration only reads metadata fields (id, channel, location, tags, shape, color) that stubs share. Making `coordinates` optional in `IAnnotation` was considered but rejected — it would require restructuring the type hierarchy (`IAnnotation extends IAnnotationBase` where `IAnnotationBase.coordinates` is required for creation) and adding guards at every coordinates access point. The separate-types approach (3 AnnotationViewer references + ~8 component references to update) was cleaner.
7. **Shape as string enum**: Not worth compressing to numeric index (~13 bytes savings vs added complexity)
8. **Connections don't need stubs**: Connections are lightweight (just two annotation IDs + label/tags), so stub treatment is unnecessary
9. **No plain private methods in Vuex modules**: vuex-module-decorators `@Action` proxy only exposes state, getters, `@Mutation`, and `@Action` methods on `this`. A plain `private` method (no decorator) is invisible to the proxy — calling it silently throws TypeError, swallowed by Vuex without `rawError: true`. All private methods must be decorated or their logic inlined in the action.
10. **No async/await in `@Action` methods that need state after the await**: The vuex-module-decorators proxy completely breaks after `await` — state reads return undefined, mutation calls silently fail. Solution: extract async work to a module-level function, capture all state before calling it, commit via the exported module instance.
11. **Vuex getter functions defeat Vue computed dependency tracking**: Getters that return functions (e.g., `get isVisible() { return (id) => this.visibleAnnotationIds.has(id); }`) don't create reactive dependencies on the underlying state when the returned function is called inside a `computed()`. The computed only tracks the getter reference, not what the function reads. Fix: also read the underlying state directly in the computed.

---

## Remaining Work (consolidated 2026-06-19)

Stub-only mode + the server-side list are **functionally correct** on real data
(HCR 26K, Xenium 708K). What's left is performance, UX feedback, and the
property-value rework. This section consolidates the scattered "Next Steps",
"Deferred", and "Property Values Lazy Loading" notes above into one roadmap with
options. Detailed rationale lives in the linked sections; this is the map.

### A. Performance at large scale (the headline gap)

`POST /upenn_annotation/list` is **3.6–25 s at 708K** (see
[`ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](./ANNOTATION-LIST-SERVER-SIDE-DESIGN.md) §8).
The aggregation runs centroid `$addFields` + property `$lookup`/`$unwind` + `$sort`
over the **full matched set** before `$skip`/`$limit`, and there is no per-property
index. Stub fetch + hydration is acceptable; the list query is the bottleneck.

- **A1 — Property-value index (biggest lever, hardest):** property values are stored
  nested (`values.<propertyId>.<subField>`) and prop ids differ per dataset, so a
  naive compound index doesn't generalize. Options: wildcard index; a flattened/
  reshaped property-values collection; an index created at property-compute time;
  or the **bidirectional query** (drive the aggregation from `annotation_property_values`
  when sorting/filtering by a property). Pick deliberately — this needs design.
- **A2 — Bound the work before sort:** when no property sort/filter is active, the
  centroid + lookup stages can be skipped or deferred until after pagination. Cheaper,
  partial win; doesn't help property-sorted pages.
- **A3 — Infinite scroll (cursor-based):** replace page-numbers + deep `$skip` (slow at
  large offset) with cursor pagination (encode sort key + `_id`). Improves the common
  "scroll down" access mode; more frontend work.

### B. Progress indicators for long-loading steps (UX, cheap, high value)

Today several multi-second steps are silent or coarse: the 708K **stub fetch**, the
**property-values fetch** (the only one that surfaces a bar — `Fetching property
values (N/total)`), and each **`/list`** query (3.6–25 s with no per-query feedback).

- **B1 — Determinate bars where counts are known** (stub fetch, property-values fetch):
  reuse the existing progress-bar pattern. Already done for property values; extend to
  stub fetch.
- **B2 — Per-query feedback for `/list`:** the table already has Vuetify's `loading`
  state; add skeleton rows / a clear "querying N annotations…" affordance and disable
  paging controls while in flight (avoids the "did my click register?" confusion at 20 s).
- **B3 — Streaming/chunked feedback:** the backend already streams `orjson`; surfacing
  partial counts is more work and probably not worth it before A.

### C. Hydration refinements (from "Next Steps" 2 & 3 above — partially done)

- **C1 — Debounce the hydration fetch + `AbortController`:** only the camera watcher is
  debounced (250 ms); the fetch itself fires un-cancelled, so a zoom-then-pan can stack
  redundant in-flight requests and stale responses can overwrite newer cache state.
- **C2 — Zoom-aware hydration:** Steps 2–4 use the 2× expanded viewport for *both*
  visibility and hydration, so zooming in doesn't re-prioritize the newly-visible region.
  Simplest fix: unexpanded bounds for the hydration split, expanded only for visibility.
- **C3 — Hydrate-on-selection via backend:** selecting a stub not already in the
  hydration cache should trigger a one-off hydrate for that id.

### D. Property-value setup rework (the area flagged as "minimally working")

This is the largest remaining structural item. `src/store/properties.ts` loads **all**
property values for **all** annotations into one `{[annoId]:{[propId]:value}}` map and
**replaces** it wholesale on each fetch (`TODO(performance): merge instead`). At
708K × N properties this dominates both memory and load time, and it's orthogonal to the
stub coordinate savings. The server-side list **already** lazy-loads per-page values, but
**plots, the properties panels, and the (client-mode) filter UI still load wholesale.**

- **D1 — Lazy per-page values everywhere:** make the server-list pattern the norm — only
  fetch values for the rows/annotations currently shown. Limits global sort/filter to what
  the backend computes; this is the direction the architecture already points.
- **D2 — On-demand per-column loading:** fetch a property's values only when its column is
  added (`GET /annotation_property_values?propertyId=X&datasetId=Y`).
- **D3 — Server-side aggregation for stats/histograms:** already used by the filter UI;
  extend so property summaries never require transferring all values.
- **D4 — Property-value stubs:** lightweight per-property summary (min/max/mean) loaded
  upfront; full per-annotation values on demand.
- **D5 — Cache eviction:** LRU / frame-based eviction so the value map stays bounded when
  switching properties or frames.

**Recommended order:** **B** (cheap, immediate UX win, unblocks testing at scale) →
**C1/C2** (correctness + redundant-traffic fixes, mostly local to `annotation.ts`) →
**A1** (the real scaling lever, needs an indexing-strategy decision) → **D1/D2** (the
property-value rework, the largest piece and the one most coupled to other consumers).
A and D are independent and can proceed in parallel once their designs are chosen.
