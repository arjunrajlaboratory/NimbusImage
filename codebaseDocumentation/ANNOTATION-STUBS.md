# Stub Annotations Architecture

## Overview

The annotation system uses a stub/hydrated architecture to efficiently handle large numbers of annotations. Annotations are loaded as lightweight stubs (centroid + metadata, no coordinates) and selectively hydrated (full coordinates loaded) based on viewport, size, and selection state.

**Branch:** `feature/stub-annotations`
**Status (2026-06-22):** Backend endpoints + frontend migration complete and functionally correct on real data (HCR 26K, Xenium 708K). Server-side annotation list (Option B) shipped — see [`ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](./ANNOTATION-LIST-SERVER-SIDE-DESIGN.md). `/list` performance (was 3.6–25 s at 708K) is resolved via PV-driven queries — see section A. Recent fixes: stub circle world-locked sizing (see "RESOLVED: stub circles too large" below); the property-column sort arrow; row-click navigation hydrating the stale viewport (section C); hydrate-on-selection/navigation (C3, section C); **property-value lazy loading Stages 1 & 2** — no code path loads the full property-value map in stub-only mode anymore: the wholesale load on dataset open is gone (Stage 1) and an active property filter now drives drawing from a server-fetched id set instead of loading every value (Stage 2; verified 708K→0 resident even with a filter active, section D); **C1** — the viewport hydration fetch is now debounced + abortable (section C); and **stub circle size/stroke/fill now match the real annotation** (size: backend bbox-diagonal/2 → `max(w,h)/2`; stroke + fill mirror the full-annotation style — see "RESOLVED (2026-06-22)" below). **density-adaptive render budget + zoom hysteresis + restyle throttle (C4)** — the render/hydration budget is now **size-gated** (datasets ≤ `maxVisible` cap render fully at every zoom) and, above the cap, set by a **density-derived** zoomed-out floor (`coverageTarget × screenArea / dotArea`, default 0.17 → ~10K of 708K — a readable density map instead of a solid blob) that **doubles per zoom level** up to the cap (`visibilityBudgetForZoom`); a **unified pan+zoom hysteresis** (`cameraRefreshNeeded`, `viewportRefreshFraction` 0.2) skips the refresh until either the zoom magnification or the pan distance (as a fraction of the viewport) crosses 20%, cutting loading churn; `restyleAnnotations` is throttled like the draw path; and the render-coverage HUD is now viewport-relative ("Showing N of M in view · K loaded"). See section C4. **C2 (zoom-aware hydration) was built, verified correct, then SHELVED** — it caused a felt rendering regression (zoom-in freeze) because it concentrates full-polygon shapes into the viewport and the draw path rebuilds all features per refresh; parked on branch `shelf/c2-zoom-aware-hydration` (commit `3e783c83`) pending the draw-path fix. See the C2 note in section C. **Next:** (1) a profiling pass on a high-zoom pan, then (2) **draw-path incrementalization** (the real rendering bottleneck — `drawAnnotations` tears down and rebuilds every feature each refresh, hiccuping at high zoom even at the pre-C2 baseline), then (3) **D3** (server aggregation for plots/panels — last wholesale property-value consumer), then (4) un-shelve C2. **Deferred to later PRs / lower priority:** A3 (infinite scroll — deep-page tail), D2 (per-column loading — unnecessary; loading all values for one *item* is fine), D4 (PV stubs), D5 (explicit LRU), B3 (streaming partial counts). See the **Remaining work** summary at the very bottom for the authoritative roadmap.

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

- **Hydrate-on-selection via backend API — DONE (2026-06-19, item C3).** Selecting or navigating to an un-hydrated stub now triggers a one-off hydrate via the `ensureHydrated` action. See **C. Hydration refinements → C3** in the consolidated Remaining Work section below.
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
- The gate variable `needsStubSystem` (`stubsSize > 0 && frameCount > maxVisible`, OR `stubOnlyMode`) controls both visibility filtering and `getForRendering` in a single check

> **Note (2026-06-21): `stubThreshold` decouples lazy-mode activation from the render budget.** `maxVisible` still caps *rendering* (the bypass above), but a separate `visibilityConfig.stubThreshold` now decides when **stub-only / lazy mode** activates in `fetchAnnotations` (`count > stubThreshold` → fetch stubs + lazy property values; else full fetch). Previously the fetch decision reused `maxVisible`, so raising the render budget also raised the lazy-mode threshold. Defaults: `stubThreshold: 10000`, `maxVisible: 50000`, `maxHydrated: 20000`, `hydrationCacheCap: 40000` (all overridable in UISettings). So a 26K dataset enters lazy mode (26K > 10K stub threshold) yet renders all of it (< 50K budget). Verified in-browser on the 26K HCR dataset (`stubOnlyMode: true`, `propertyValues: 0`) and the 708K Xenium dataset (50K visible / 20K hydrated).

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

### RESOLVED (2026-06-22): stub circle size, stroke, and fill now match the real annotation
After the world/pixel fix above, a stub still rendered slightly large with a
distinct (thinner, more translucent) outline. Two follow-ups closed the gap, so a
dehydrated stub now reads like its hydrated form — only the shape (circle vs.
polygon) distinguishes it.

- **Size — backend `estimatedRadius` was the bbox _diagonal_/2.** The stubs
  aggregation computed `sqrt(dx² + dy²)/2`, which circumscribes the bounding box and
  overshoots the footprint by up to √2 (~41% for a square/round cell; measured
  1.29–1.41× across the Xenium data). The frontend `estimateAnnotationRadius` already
  used `max(dx, dy)/2`; the backend now matches it (`server/api/annotation.py`,
  `test/test_stubs.py`). Verified on 708K: backend radius ÷ `max/2` went from
  1.29–1.41 to exactly **1.0**.
- **Stroke + fill — stub style now mirrors the full-annotation style.**
  `getStubStyleFromBaseStyle` used `strokeWidth 2` / `strokeOpacity 0.8` /
  `fillOpacity 0.4`; the real annotation (`getAnnotationStyleFromBaseStyle`) uses
  `strokeWidth 4` / `strokeOpacity 1` (selected 6, hovered 5) and
  `fillOpacity = store.annotationOpacity`. The stub now uses the same stroke and takes
  `fillOpacity` as a parameter, which the three `AnnotationViewer` styling sites pass
  as `store.annotationOpacity` — so the stub fill **tracks the opacity slider** via the
  existing `baseStyle` restyle watcher. (GeoJS only scales a point's _radius_ with
  `scaled`, not its stroke, so the stroke is a flat pixel width either way.) Tests:
  `annotationStubUtils.test.ts`.

**Follow-up observations (noted, not yet addressed):**
- **UI can lock during rendering updates after several pans.** Even with the C1
  hydration-fetch debounce + `AbortController`, rapid repeated pans can briefly freeze
  the UI while GeoJS rebuilds/redraws features. The hydration _fetch_ is debounced, but
  the **draw/restyle path itself** (a distinct stage) is not coalesced — it likely
  needs its own debouncing/throttling. See section C (hydration refinements).
- **Thicker stub strokes hurt readability when zoomed out.** Now that stubs carry the
  full 4px stroke, a zoomed-out view packed with thousands of small objects looks
  noisy (strokes dominate the tiny dots). The likely lever is **lowering `maxVisible`**
  (render fewer objects when zoomed out) rather than re-thinning the stroke — see the
  `maxVisible` tuning to-do. A zoom-adaptive `maxVisible` would address both this and
  the lock above.

### Selection includes non-visible annotations
- `getSelectedAnnotationsFromAnnotation()` queries both the displayed RBush and the global `annotationSpatialIndex`
- Drag-select catches ALL annotations in the region on the current frame, regardless of visibility budget
- Frame filtering (XY, Z, Time) applied to global candidates

---

## To-Do List

### Threshold and Hydration Refinement
- [x] Test and tune `maxVisible` (default 50,000) — **2026-06-22: now density-adaptive + size-gated** via `visibilityBudgetForZoom` (C4 above). The 50,000 is both the zoomed-in cap and the size gate (datasets ≤ it render fully). Above it, the effective budget starts at a density-derived floor (`coverageTarget × screenArea / dotArea`, default 0.17 → ~10K of 708K) and doubles per zoom level. Resolves the zoomed-out visual noise from the full 4px stroke.
- [x] Test and tune `maxHydrated` (default 20,000) — scaled by the same zoom factor as `maxVisible` (C4). Fewer shapes hydrated/drawn when zoomed out (where they look like dots anyway).
- [x] **Zoom-adaptive `maxVisible`** — DONE 2026-06-22 (C4 above). Addresses both zoomed-out readability and per-frame draw cost.
- [x] Consider making thresholds configurable via UI settings panel — all live in `visibilityConfig` and are editable in `UISettings.vue` (incl. the new `coverageTarget` and `viewportRefreshFraction`).
- [ ] Evaluate whether size-based hydration ranking (largest first) is the right heuristic vs. alternatives (density, distance to viewport center, user focus area)
- [ ] Profile `updateVisibilityAndHydration` with 100K+ annotations to identify bottlenecks
- [x] **Debounce/throttle the draw+restyle path** — DONE 2026-06-22 (C4): `restyleAnnotations` is now throttled (the draw path already was); the zoom-adaptive budget cuts the per-frame feature count (10× fewer when fully zoomed out) which is the main pan-lock remedy.
- [ ] **Profiling pass: high-zoom pan (NEXT — do before any draw-path change).** The high-zoom pan
  still hiccups at the pre-C2 baseline. Profile a high-zoom pan/zoom on the 708K Xenium dataset to
  attribute the per-refresh cost across stages: the hydrate **fetch** (network + merge), the
  `layerAnnotations` **recompute**, the GeoJS feature **teardown+rebuild** (`drawAnnotations` →
  `clearOldAnnotations(true)` + `drawNewAnnotations`), and the **`restyle`** pass. Hypothesis: the
  full feature rebuild dominates (see "Draw-path incrementalization" in section C). Use the
  browser Performance panel + `window.__stubPerf` counters; isolate by temporarily stubbing each
  stage. Output: a confirmed bottleneck ranking that says whether the incremental-draw fix is the
  right lever (and whether C2 can then return). No production code changes in this pass.
- [ ] Test hydration/dehydration memory churn during rapid pan/zoom

### Styling Adjustments
- [x] Review whether stubs should respect `scaleAnnotationsWithZoom` setting or always use fixed world size — **resolved 2026-06-19:** stubs are always world-locked via `scaled = log2(unitsPerPixel(0))` so the dot tracks the annotation's real footprint at every zoom (see "RESOLVED: stub circles too large" above)
- [x] Stub size/stroke/fill match the real annotation — **resolved 2026-06-22:** backend `estimatedRadius` switched from bbox-diagonal/2 to `max(w,h)/2`, and the stub stroke (4/1.0) + fill (`store.annotationOpacity`) now mirror the full-annotation style (see "stub circle size, stroke, and fill" above). The stub is now distinguished from its hydrated form **only by its circular shape**.
- [ ] Consider different hover/selection effects for stubs vs full annotations
- [ ] Reconsider whether stubs should be visually distinct again (they used to have a thinner stroke + lower opacity). They now match the real annotation per user request; if a denser zoomed-out view needs the dots de-emphasized, prefer lowering `maxVisible` over re-thinning the stroke.

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
- `annotation.ts`: `fetchAnnotations()` checks annotation count — under `stubThreshold` (was `maxVisible`; see 2026-06-21 note above) uses existing full fetch, over threshold uses stubs endpoint
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
- [x] Hydrate on selection — DONE (2026-06-19, C3): `ensureHydrated` action triggered on select + navigate (see Remaining Work → C3)
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

### A. Performance at large scale — RESOLVED via PV-driven queries (2026-06-19)

`POST /upenn_annotation/list` was **3.6–25 s at 708K** (see
[`ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](./ANNOTATION-LIST-SERVER-SIDE-DESIGN.md) §8):
the aggregation joined property values onto the **whole matched set** (708K
`$lookup`/`$unwind`), computed the centroid over all rows, and `$sort`ed before
`$skip`/`$limit`. Measured directly on the 708K Xenium dataset, the fix was the
**query shape, not an index**.

- **A2 — Bound the work before pagination (DONE).** `listPage` sorts on the indexed
  `{datasetId,_id}` order (or a field), paginates, and only *then* joins display-only
  property columns and computes the centroid — paying per-row cost on the page, not
  the full set.
- **PV-driven query (DONE — the headline fix; this is the "bidirectional" option).**
  When a property sort/filter is active and there are no annotation-field filters,
  `listPage`/`listCount`/`listIds` drive from `annotation_property_values` — sort/filter
  and paginate the lean value docs, then `$lookup` the annotation back for just the
  page — instead of joining values onto every annotation. Tie-break on `annotationId`
  reproduces the annotation `_id` order exactly. A pure property sort still surfaces
  no-value annotations last via a tail query; a property filter excludes them. Falls
  back to the annotation-driven pipeline when annotation-field filters combine with a
  property sort/filter. Measured end-to-end on the live endpoint (incl. count + JSON):

  | query | before | after |
  |---|---|---|
  | plain page 1 | 3.6 s | 0.08 s |
  | property sort, page 1 | 10 s | 1.1 s |
  | range filter + count, page 1 | 21 s | 0.7 s |
  | deep property sort (offset 700K) | 25 s | 3.4 s |

- **A1 — Property-value index / EAV reshape (DROPPED).** The slowness was the 708K
  join before the sort, not a missing index — a raw PV-driven sort of 708K scalar
  values is ~0.7 s with no index. A wildcard index or flattened collection would only
  shave the already-sub-second residual and isn't worth the index bloat / migration
  (and the per-property-path indexing problem). Revisit only if profiling ever shows
  the sort itself dominating.
- **Prerequisite fix:** bulk annotation delete previously left **orphaned property-value
  docs** — `annotationsRemovedEvent` matched a string `$in` against the ObjectId
  `annotationId` field, so nothing matched. Fixed (normalize to `ObjectId`) so PV-driven
  counts stay consistent with the annotation set. (Pre-existing orphans from before the
  fix would inflate a PV count; a one-time purge clears them — none in current datasets.)
- **A3 — Infinite scroll (cursor/keyset) — the remaining direction.** The lone
  multi-second case left is deep `$skip` (near the last page: 3.4 s at offset 700K;
  normal browsing ≤~10K deep stays <1 s). Keyset pagination (`value > cursor`, tie-break
  `annotationId`) is **flat ~0.5 s at any depth with no index** (the lean PV sort prunes
  as it descends) — the structurally correct end state for a 708K list. It's mostly
  **frontend** work (page-numbers → scroll-driven cursor; the backend `$skip`→cursor swap
  is small) and trades away random "jump-to-page". The PV-driven `listPage` is exactly
  the query keyset builds on, so none of this work is throwaway.

### B. Progress indicators for long-loading steps (UX, cheap, high value)

Several multi-second steps used to be silent or coarse: the 708K **stub fetch**, the
**property-values fetch** (`Fetching property values (N/total)`), and each **`/list`**
query (with no per-query feedback).

- **B1 — Stub-fetch progress bar (DONE 2026-06-21).** On dataset open in lazy mode the
  708K stub fetch (`getAnnotationStubs`, a single streamed GET) used to leave the canvas
  silently empty for seconds. `fetchAnnotations` (over-threshold branch only) now wraps it
  in a progress entry titled with the already-known `getAnnotationCount` value —
  **indeterminate** rather than determinate, because the stub response is one chunked
  `orjson` stream (no `Content-Length`, so neither pagination nor `onDownloadProgress`
  yields a real percentage; an honest moving bar beats a fake-stuck 0%). The under-threshold
  branch is untouched — its full fetch already surfaces a `Fetching annotations` bar via
  `fetchAllPages`, so no second bar is added there. Pure title helper
  `annotationLoadingTitle(count)` (pluralised, locale-grouped) in `utils/loadingLabels.ts`;
  it renders through the existing `progress` store → `ProgressBarGroup`. (The property-values
  fetch already had its bar.) Tests: `loadingLabels.test.ts` (7, shared with B2).
  **Verified in-browser on 708K Xenium:** during the stub load a bottom-left bar reads
  `Loading 708,983 annotations…` (progress-store item `ANNOTATION_FETCH`, total 0 →
  indeterminate animated stripe, no `aria-valuenow`); confirmed both live in the DOM and
  visually.
- **B2 — Per-query `/list` feedback (DONE 2026-06-21).** A `/list` query can take ~1s+ (deep
  pages multi-second), and a page/sort click gave no immediate feedback. In server mode
  `AnnotationList.vue` now shows a `Querying N annotations…` line (spinner + the matched
  `annotationListServer.total`, via `listQueryingMessage`) while `serverLoading`, keeps the
  table mounted (stale rows stay visible), and dims + disables the footer paging controls
  (`is-loading` → `pointer-events:none; opacity:.5`) so a click registers visibly instead of
  silently queuing another fetch (the `requestSeq` guard already drops stale responses; this
  is the UX half). `listQueryingMessage` falls back to a count-less message before the first
  response (`total` 0). Tests: `loadingLabels.test.ts` (shared with B1).
  **Verified in-browser on 708K Xenium:** firing a query sets `loading` synchronously,
  renders `Querying 708,983 annotations…`, adds `is-loading` to the table, and computes
  `pointer-events:none` / `opacity:0.5` on the footer; confirmed visually during a deep-page
  (offset 500K) query.
- **B4 — Render-coverage indicator (DONE 2026-06-21).** In lazy mode the canvas renders only
  a budgeted subset (`maxVisible`, default 50,000) of the loaded stubs, with no on-screen cue
  that more exist. A small top-center HUD (`RenderCoverageIndicator.vue`, mounted in
  `ImageViewer.vue` alongside `ProgressBarGroup`) now shows `displayed / loaded rendered`
  (e.g. `50,000 / 708,983`) with a thin fraction bar. It appears **only while the budget is
  actively downsampling** — the show signal is budget saturation (`displayed >= maxVisible`),
  not `displayed < loaded`, so a dataset that fits under the budget (or one with all-but-a-few
  annotations on the current frame) reads as "fully rendered" and the HUD stays hidden. Pure
  helper `computeRenderCoverage({stubOnlyMode, displayed, loaded, maxVisible})` in
  `utils/renderCoverage.ts`; the HUD is `pointer-events:none` so it never blocks the canvas.
  Tests: `renderCoverage.test.ts` (6, incl. the cross-frame "hide when fully rendered" case).
  **Verified in-browser:** 708K Xenium shows `50,000 / 708,983 rendered` (bar ~7%); the 26K
  HCR dataset (26,041 < 50,000 budget → fully rendered) shows nothing.
- **B3 — Streaming/chunked partial counts (deferred):** the backend already streams `orjson`;
  surfacing partial counts is more work and not worth it yet.

### C. Hydration refinements (from "Next Steps" 2 & 3 above — partially done)

**RESOLVED (2026-06-19): row-click navigation hydrated the *stale* viewport.**
Clicking a row's "Go to annotation location" in the annotation list moved the
camera but the destination stayed empty (dots/sparse) until a manual pan/zoom.
Root cause: `goToAnnotationIdLocation` (`AnnotationList.vue`) recentered via
`store.setCameraInfo({ ...store.cameraInfo, center })`, updating `center` but
leaving `gcsBounds` at the pre-click viewport. It is the **only** programmatic
recenter that bypasses the GeoJS map — every map-driven recenter
(`setCenter`/`setCorners`/`resetView` in `ImageViewer.vue`) recomputes
`gcsBounds` via `synchroniseCameraFromMap`, while `applyCameraInfo` deliberately
suppresses that sync to avoid multi-map loops. Viewport-driven hydration
(`updateVisibilityAndHydration`, Step 2) splits current-frame annotations by
`gcsBounds`, so with stale bounds the destination was classified out-of-viewport
and never entered the in-viewport visibility/hydration tiers.
**Fix:** new pure helper `recenterCameraInfo(info, center)` in
[`src/utils/camera.ts`](../src/utils/camera.ts) translates the four `gcsBounds`
corners by the center delta (exact for a pure pan — zoom/rotation unchanged);
`goToAnnotationIdLocation` now calls
`store.setCameraInfo(recenterCameraInfo(store.cameraInfo, center))`.
`applyCameraInfo` is untouched (no loop risk). Tests:
`src/utils/__tests__/camera.test.ts` (6) + an `AnnotationList.test.ts` case
asserting the translated bounds are passed. Verified in-browser on the 708K
Xenium dataset.

- **C1 — Debounce the hydration fetch + `AbortController` (DONE 2026-06-20).** Previously
  only the camera watcher was debounced (250 ms); the viewport hydration fetch itself fired
  un-cancelled, so rapid zoom/pan/frame/filter changes could stack redundant in-flight
  requests and a stale response could overwrite newer cache state. Now `updateVisibilityAndHydration`
  Step 7 routes the fetch through a module-level debounced + abortable task
  (`viewportHydrationTask`, 200 ms trailing edge): rapid calls collapse to one fetch, and a
  still-in-flight fetch is `AbortController.abort()`-ed when a newer one fires so its response
  can't clobber newer state. `AnnotationsAPI.hydrateAnnotations(ids, signal?)` forwards the
  signal to axios; `_hydrateFromBackend` swallows abort errors (`isAbortError`) instead of
  logging them. `ensureHydrated` (C3 selection hydrate) deliberately bypasses the task and
  fires immediately so selected annotations always land. New pure helpers
  `createDebouncedAbortableTask` + `isAbortError` in `utils/debouncedAbortable.ts` (tests: 8).
  API test asserts signal forwarding (+2). **Verified in-browser on the 708K Xenium dataset:**
  an 8-tick zoom burst produced a single `hydrate` POST (coalesced), hydration stayed healthy
  (`hydrationMode: "shapes"`, cache populated), no console errors.
- **C2 — Zoom-aware hydration (BUILT, then SHELVED 2026-06-22 — do not re-apply before the
  draw-path fix below).** The change: split current-frame ids by *two* boxes — the 2× expanded
  box drives visibility (pan pre-load), the **unexpanded** box drives hydration — so zooming in
  re-prioritizes hydration onto the actual viewport (the simplest fix noted previously). It was
  implemented, fully tested (pure helpers `selectVisibleIds`/`selectHydrationIds` in
  `utils/visibilityBudget.ts`; `visibilityBudget.test.ts` +5, `annotationStubs.test.ts` +1), and
  verified correct on 708K (a budget-saturated zoom put 17,412/17,412 hydrated slots inside the
  actual viewport vs ~25% before).

  **Why shelved:** it caused a *felt rendering regression* — zooming in froze the UI for a beat.
  Root cause is **not** the hydration selection but the **draw path**: because an annotation is
  drawn as a full shape only when it is *both visible and hydrated*, concentrating hydration onto
  the exact viewport means every annotation you zoom into becomes a full **polygon** (vs. only the
  largest ones under the old expanded-box ranking), and `drawAnnotations` rebuilds **all** of them
  from scratch each refresh (see the draw-path item below). More polygons rebuilt per frame inside
  the viewport = the freeze. C2 also churns the hydration set more tightly with the smaller box, so
  it refreshes more often. The practical benefit is subtle (the density-adaptive C4 budget already
  hydrates most of the viewport via the expanded box), so it is not worth the regression **until
  the draw path is incremental**. After that fix, C2 should be cheap to bring back — possibly with
  "hydrated-in-memory" decoupled from "drawn-as-shape" (a separate, smaller shape-draw cap).

  **Where it lives:** the finished commit is parked on branch **`shelf/c2-zoom-aware-hydration`**
  (commit `3e783c83`, "feat(frontend): zoom-aware hydration via unexpanded viewport split (C2)").
  `git cherry-pick 3e783c83` (or `git show 3e783c83`) to resurrect it. It is *not* on
  `feature/stub-annotations` (reverted via `git reset` after the regression was confirmed).

- **Draw-path incrementalization (the real rendering bottleneck — NEXT perf item, NOT YET DONE).**
  `drawAnnotations` (`AnnotationViewer.vue`) tears the whole GeoJS layer down and rebuilds *every*
  visible feature on every refresh: `drawAnnotationsNoThrottle` calls `clearOldAnnotations(true, …)`
  → `removeAllAnnotations()`, then `drawNewAnnotations` re-creates all features via
  `createGeoJSAnnotation` + `addMultipleAnnotations`. At high zoom with thousands of features (and
  full polygons) this O(N) rebuild per pan/zoom is the **high-zoom pan hiccup that exists even at
  the pre-C2 baseline**, and it is what C2 amplified. The codebase already has an **incremental diff
  path** that is unused by the main draw: `clearOldAnnotations(false)` removes only features whose
  annotation actually changed (color/layer/stub-state), and `drawNewAnnotations` already skips
  features that are still present (the `excluded` check). Likely fix: route the normal draw through
  the diff path (or a viewport diff that only adds/removes features entering/leaving). Correctness
  edges to cover with TDD + in-browser: frame changes (XY/Z/Time), stub→shape transitions,
  connections, and selection highlight. **Start with a profiling pass (see To-Do) to confirm the
  rebuild is the dominant cost before touching this delicate code.**
- **C4 — Density-adaptive render budget + zoom hysteresis + restyle throttle (DONE 2026-06-22).**
  Three changes addressed the post-pan UI lock and the zoomed-out noise. The budget model went
  through one design iteration: an initial simple `zoomedOutFraction × cap` floor + doubling was
  replaced (same day, before this write-up) with a **density-derived** floor after grounding it
  in real geometry — see the design note below.
  - **Density-adaptive render/hydration budget (the headline).** Pure helper
    `visibilityBudgetForZoom` ([`src/utils/visibilityBudget.ts`](../src/utils/visibilityBudget.ts))
    returns an effective `{maxVisible, maxHydrated}`:
    - **Size gate:** datasets with `loaded ≤ maxVisible` (the cap, default 50K) render **fully at
      every zoom** — only over-cap datasets are downsampled. (So a 30K dataset is never thinned;
      a 708K one is.)
    - **Density-derived zoomed-out floor:** `floor = coverageTarget × screenArea / dotArea`, where
      `dotArea = (2·avgRadius/unitsPerPixel(zoomMin) + strokePx)²`. This is the count of dots that
      cover `coverageTarget` of the screen given each dot's on-screen footprint — self-tuning to a
      dataset's cell size + the viewport, not a magic fraction. `avgRadius` (mean `estimatedRadius`)
      is computed once in `setStubsFromServer`; `strokePx` is the 4px stub stroke (which dominates
      the footprint when zoomed out, where cells are sub-pixel).
    - **Zoom ramp:** the budget **doubles per zoom level** from that floor up to the cap. In-view
      count shrinks ~4×/level while the budget grows 2×/level, so the rendered fraction of what's
      in view rises until everything in view is shown — "reveal more as you zoom in."
    `updateVisibility` (`AnnotationViewer.vue`) feeds the live map geometry in and passes the
    result as `maxVisible`/`maxHydrated` overrides to `updateVisibilityAndHydration` (fall back to
    config). New config field `coverageTarget` (default **0.17** → ~10K of 708K at zoom 0), in
    `UISettings.vue`. The static cap still drives the **stub-system gate** (`needsStubSystem` in
    `layerAnnotations`) — that decides whether a dataset needs lazy mode at all and must not depend
    on zoom. Tests: `visibilityBudget.test.ts` (9).

    **Why density-derived, not a literal on-screen coverage cap (the design iteration):** grounding
    on the live 708K data (avg radius ≈ 14 world units, ~0.45px at zoom 0 — the 4px stroke
    dominates) showed a *constant* coverage cap renders **fewer** dots when zoomed in (dots grow to
    ~18px), under-rendering resolvable cells (~1.9K of 11K at zoom 3) — the opposite of "more when
    zoomed in." So density sets only the zoomed-out **floor**; the geometric doubling provides the
    ramp.
  - **Unified pan + zoom hysteresis.** Recomputing the budget + re-hydrating on every tiny camera
    change causes constant loading churn. Pure helper `cameraRefreshNeeded`
    ([`src/utils/camera.ts`](../src/utils/camera.ts)) gates the camera-driven refresh on a single
    sensitivity `viewportRefreshFraction` (default **0.2** = 20%): refresh once **either** the zoom
    magnification changed by ≥ the fraction (= `log2(1.2)` ≈ 0.263 zoom levels) **or** the center
    moved by ≥ the fraction of the viewport extent (world-unit diagonal of `gcsBounds`, computed by a
    `viewportExtent` helper in `AnnotationViewer.vue`); skip only when **both** are below threshold.
    Covering pan too is what suppresses scroll-wheel zoom (which shifts center toward the cursor) — a
    zoom-only gate would still refresh on that center drift. (This started as zoom-only; the unified
    variant was the agreed follow-up.) New config `viewportRefreshFraction` in `UISettings.vue`.
    Tests: `camera.test.ts` (+9).
  - **Restyle throttle.** `restyleAnnotations` iterates every drawn feature and redraws the layer,
    but (unlike the already-throttled `drawAnnotations`) it was uncoalesced — an opacity-slider drag
    or rapid selection over a dense field restyled all features per input tick. Now wrapped in
    `throttle(…, THROTTLE)` (same 100 ms pattern as the draw path); the restyle watchers route
    through it. The draw path was already throttled, so no second draw debounce was added.
  - **Indicator reworked to viewport-relative (option 3).** The budget change made the old
    "displayed / total" HUD misleading (off-screen pre-load inflates "displayed" when zoomed in).
    `computeRenderCoverage` ([`src/utils/renderCoverage.ts`](../src/utils/renderCoverage.ts)) +
    `RenderCoverageIndicator.vue` now show **"Showing N of M in view"** (a bar of rendered ÷
    in-current-viewport) with **"K loaded"** as text — the honest "am I seeing everything in this
    region?" metric. Shown only while some in-view annotations are downsampled away; hidden once the
    viewport is fully rendered. The action computes the actual- (unexpanded-) viewport counts
    (`viewportAnnotationCount`/`viewportRenderedCount`) via a second `splitByViewport` on the raw
    bounds. Tests: `renderCoverage.test.ts` (5). *Alternatives considered (per user preference, kept
    for reference): two stacked bars (shown/in-view + in-view/total), and a single nested
    shown⊂in-view⊂total segmented bar. Option 3 was chosen as the clearest compact form.*

  **Verified in-browser (real reloads):** 708K Xenium at zoom 0 → budget **10,226** (density floor,
  cov 0.17), HUD reads `Showing 10,226 of 708,764 in view · 708,983 loaded`. Hysteresis (viewport
  extent ≈ 59,513 world units → pan threshold ≈ 11,903): a centered zoom Δ0.2 (< 0.263) is
  **skipped** and a small pan (0.1× extent) is **skipped** (camera watcher fires, no visibility
  update), while a zoom Δ0.6 and a pan of 0.4× extent each **refresh** (budget ramps to **15,505** =
  floor × 2^0.6 on the zoom). The 26K HCR dataset renders **fully** (21,538 of 21,538 in view; all
  26,041 current-frame stubs) with the indicator **hidden** — the size gate, so mid-size datasets are
  never thinned. Tune via `coverageTarget` (lower = sparser overview) and `viewportRefreshFraction`
  (higher = fewer refreshes while navigating).
- **C3 — Hydrate-on-selection via backend (DONE 2026-06-19).** Selecting or
  navigating to a stub not in the hydration cache now triggers a one-off hydrate
  for that id, so it renders as a full shape immediately instead of a dot. New
  action `ensureHydrated(ids)` (`annotation.ts`) computes the ids to fetch via the
  pure `idsNeedingHydration(requestedIds, hydrated, stubs)` helper
  (`utils/annotation.ts` — dedupes, skips already-hydrated and non-stub ids) and
  fires `_hydrateFromBackend` (accumulating merge, protects selected ids; no-op
  outside stub-only mode). Wired at two entry points: `goToAnnotationIdLocation`
  (`AnnotationList.vue`) hydrates the navigated-to id, and a watcher on
  `selectedAnnotationIds` (`AnnotationViewer.vue`) covers all selection paths
  (list click, drag-select, context menu) reactively rather than from each
  mutation caller. Tests: `annotationStubUtils.test.ts` "idsNeedingHydration" (5)
  + an `AnnotationList.test.ts` navigation-hydrate case.
  (The viewport hydration fetch is now debounced/cancellable — see C1 (DONE). The
  selection hydrate intentionally stays immediate so selected ids always land.)

### D. Property-value setup rework (the area flagged as "minimally working")

This is the largest remaining structural item. `src/store/properties.ts` loads **all**
property values for **all** annotations into one `{[annoId]:{[propId]:value}}` map and
**replaces** it wholesale on each fetch (`TODO(performance): merge instead`). At
708K × N properties this dominates both memory and load time, and it's orthogonal to the
stub coordinate savings. The server-side list **already** lazy-loads per-page values, but
**plots, the properties panels, and the (client-mode) filter UI still load wholesale.**

#### Stage 1 — viewport-scoped lazy loading (DONE 2026-06-20)

**Gated + coupled**, mirroring the stub architecture: lazy mode activates only in
stub-only mode (`annotations.stubOnlyMode`); below that threshold behavior is unchanged
(wholesale load). On dataset open in lazy mode the **wholesale load is skipped** — the
single biggest memory/load win, since `Viewer.vue` previously called `fetchPropertyValues`
on every mount and pulled all 708K×N values resident.

What shipped:
- **Backend** `POST /annotation_property_values/batch` — values for a set of annotation
  ids in one dataset, optionally projecting only the requested `propertyPaths` (chunked
  `$in`). `findByAnnotationIds` in `models/propertyValues.py`; route in
  `api/propertyValues.py`. Tests: `test_property_values_batch.py` (5).
- **Frontend** `propertyValues` is now a **bounded merge cache** scoped to the rendered
  set. `fetchPropertyValues` is lazy-aware: in lazy mode it discovers paths from a bounded
  **sample** (`fetchPropertyPathsSample`, reuses `find` with a 512-doc limit — no new
  endpoint) and loads values only for the **visible set × displayed columns**
  (`ensureVisiblePropertyValues`, coupled to `updateVisibility` in `AnnotationViewer`).
  `computedPropertyPaths` sources from the sample in lazy mode (via the new pure
  `collectLeafPaths`), so the path picker / prune-watcher don't depend on the full map.
- **Pure helpers** `collectLeafPaths`, `idsMissingPaths`, `scopedMergePropertyValues` in
  `utils/propertyValues.ts` (tests: `propertyValues.test.ts`, 13).
- **No regression on filtered drawing (Stage 1 only):** while a property filter was active
  in lazy mode, client-side filtered drawing needed every annotation's value, so a watcher on
  `filterStore.hasActivePropertyFilter` fell back to `fetchAllPropertyValues` (wholesale load)
  and pruned back to the visible set when the filter was removed. **This is the last
  wholesale-load path, now removed in Stage 2 (below).**
- **Ordering fix:** `Viewer.vue` now `await`s `fetchAnnotations` (which sets
  `stubOnlyMode`) before calling `fetchPropertyValues`. Without it the property fetch
  raced ahead while `stubOnlyMode` was still false and took the wholesale branch anyway.

**Verified** on the 708K Xenium dataset (real reload): on open with no columns,
`propertyValues` holds **0** entries (was 708,983) and only one 512-doc sample request
fires (`discoveredPropertyPaths` = 10); displaying a column loads values for the visible
set (≤10K) via `/batch`. CSV/JSON export is unaffected (it streams from the backend), and
the CSV preview was already empty in stub-only mode (`annotations[]` is empty there).

**Deferred to later D stages:** D2 on-demand per-column (Stage 1 fetches all displayed
paths for the visible set, not per-column-lazy); D3 server aggregation for plots/panels
(plots and the properties panels still read the cache / load wholesale); D4 PV stubs; D5
explicit LRU eviction (Stage 1/2 bound via visible-set scoping rather than an LRU counter).

#### Stage 2 — server-side filtered drawing (DONE 2026-06-20)

Removes the **last wholesale-load path**: in lazy mode an active property filter no longer
pulls every annotation's value into memory. Property filtering for drawing is now driven by
a **server-fetched id set** instead of reading `propertyValues[id]` for every annotation.

What shipped (frontend only — the `POST /upenn_annotation/list/ids` endpoint already filters
by property server-side, from Option B / the PV-driven A work):
- **`filters.ts`** — new state `propertyFilterPassingIds: Set<string> | null` (markRaw,
  replaced wholesale) + a monotonic `propertyFilterRequestSeq` guard, and an action
  `refreshPropertyFilterPassingIds` that fetches the **property-filters-only** matching ids
  (`fetchAnnotationListIds`) and stores them. `filteredAnnotations` now, in lazy mode with an
  active property filter, keeps only annotations whose id is in that set (passing all through
  while the set is still loading — `null` interim — so drawing never flashes empty); other
  filters (tags/location/selection/annotation-id/ROI) stay client-side on stub fields, so the
  composition is a clean AND. Full mode is unchanged (client-side per-value check).
- **Pure helper** `buildPropertyListFilters` extracted to `utils/annotationListFilters.ts`
  (reused by `annotationListServer.buildListFilters`, DRY).
- **`AnnotationViewer.vue`** — the old `hasActivePropertyFilter` watcher (which called
  `fetchAllPropertyValues`) is replaced by a watcher on `filterStore.propertyFilters` that
  calls `refreshPropertyFilterPassingIds` (refreshing on filter *content* change, not just
  on/off). `updateVisibility` and the `displayedPropertyPaths` watcher now always call
  `ensureVisiblePropertyValues` in lazy mode (no more `!hasActivePropertyFilter` guard), so
  the visible subset's displayed-column values still load while the full map never does.
- **Tests:** `annotationListFilters.test.ts` (5); `filters.test.ts` (7 — the action's
  property-only fetch, the null/non-lazy no-ops, the seq guard, and the getter's membership /
  interim-pass-all / full-mode branches).

**Verified in-browser on the 708K Xenium dataset:** with a property filter enabled
(`Area ∈ [0,100]`) a single `POST /upenn_annotation/list/ids` fires, `propertyFilterPassingIds`
= 9,925, drawing narrows to exactly those 9,925 (`visibleAnnotationIds` 10,000 → 9,925), and
**`propertyValues` stays at 0** (was 708,983 under the old wholesale fallback). Removing the
filter resets the set to `null` and restores the full visible budget. **Zero
`annotation_property_values` requests** fired across the whole session.

#### Stage 2 follow-up — bounded-cache consumer audit (DONE 2026-06-21)

Now that `propertyValues` is a *bounded visible-subset* cache in lazy mode, audited every
consumer that walks the full map. Findings: `filters.ts` is bypassed in lazy mode (server
membership, above); the `AnnotationList` client-mode `annotationToItem` is unreachable in
server mode; the CSV-dialog preview is a pre-existing empty-state (the real export streams
from the backend); tooltips only need the visible subset. **One real gap:**
`PropertyFilterHistogram.vue` derived the range-slider bounds (`defaultMin`/`defaultMax`)
from the full `propertyValues` map — in lazy mode that's only the visible subset, and with no
column displayed it's **empty → `Math.min/ max([])` = Infinity / -Infinity** (degenerate
slider; a new filter would be created with that range and hide everything).

**Fix:** derive the bounds from the **server-side histogram** (`hist[0].min` /
`hist[last].max`) — the authoritative full-data range the histogram *bars* already use — via
new pure helper `histogramBounds` (`utils/propertyValues.ts`, tests: 3). Falls back to the
client values only before the histogram loads, guarding the empty case (0, never Infinity).
A `watch(hist)` syncs the stored default range to the histogram range once it arrives (so a
filter created before the histogram loaded — common in lazy mode — doesn't keep a degenerate
range). **Verified in-browser on 708K:** opening the `Area` filter shows Min 11.73 / Max
7697.07 (was Infinity/-Infinity); the stored range syncs to the same; a full-range filter
passes all 708,983 (nothing wrongly hidden) and `propertyValues` stays 0.

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

**Recommended order (updated 2026-06-22):** **DONE so far** — A (A2 + PV-driven queries);
the row-click navigation fix and C3 hydrate-on-selection (section C); **D Stage 1**
(viewport-scoped property values — wholesale load on open eliminated); **D Stage 2**
(server-side filtered drawing — the last wholesale-load path removed; the memory story is now
complete: no code path loads the full property-value map in lazy mode); **C1**
(debounce/AbortController on the hydration fetch); **B1 + B2** (stub-fetch progress bar
+ per-query list feedback); the **stub circle size/stroke/fill match** (2026-06-22); and
**C4 / density-adaptive render budget + unified pan+zoom hysteresis + restyle throttle +
viewport-relative indicator** (2026-06-22 — size-gated density-derived budget that doubles per zoom
level; the refresh is skipped until either zoom or pan crosses 20%; mid-size datasets render fully).
**Remaining, recommended order (updated 2026-06-22 after the C2 regression):**

1. **Profiling pass on a high-zoom pan** (no code changes) — confirm whether the GeoJS feature
   teardown+rebuild is the dominant per-refresh cost. See the To-Do item and the "Draw-path
   incrementalization" note in section C.
2. **Draw-path incrementalization** — route the normal draw through the existing diff path so a
   pan/zoom only adds/removes the features that changed instead of rebuilding all. Fixes the
   high-zoom pan hiccup that exists even at the pre-C2 baseline; gated on the profiling pass.
3. **D3 — server-side aggregation for plots + properties panels** — the last wholesale
   property-value consumers; the remaining structural memory item at scale.
4. **C2 — zoom-aware hydration (un-shelve)** — only after the draw path is incremental (it is the
   reason C2 froze). Parked on branch `shelf/c2-zoom-aware-hydration` (commit `3e783c83`); see the
   C2 note in section C. Consider decoupling "hydrated-in-memory" from "drawn-as-shape" when
   bringing it back.

**Deferred to later PRs / lower priority:**
- **A3 / infinite scroll** — keyset pagination for the deep-`$skip` list tail (3.4 s at offset
  700K; normal browsing <1 s). Self-contained; pushed to a later PR.
- **D2 — on-demand per-column loading** — *not necessary for now.* Loading **all** property values
  for a **single item** is fine; the problem was only loading all values for **all items**, which
  D Stage 1/2 already solved. Defer.
- **D4 — property-value stubs** (min/max/mean summaries) — low priority.
- **D5 — explicit LRU eviction** of the property-value cache — Stage 1/2 already bound it via
  visible-set scoping; low priority.
- **B3 — streaming partial counts** — low value.
