# Stub Annotations Architecture

## Overview

The annotation system uses a stub/hydrated architecture to efficiently handle large numbers of annotations. Annotations are loaded as lightweight stubs (centroid + metadata, no coordinates) and selectively hydrated (full coordinates loaded) based on viewport, size, and selection state.

**Branch:** `feature/stub-annotations`
**Status (2026-06-23):** Backend endpoints + frontend migration complete and functionally correct on real data (HCR 26K, Xenium 708K). Server-side annotation list (Option B) shipped — see [`Archived Source: ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](#archived-annotation-list-server-side-design). `/list` performance (was 3.6–25 s at 708K) is resolved via PV-driven queries — see section A. Recent fixes: stub circle world-locked sizing (see "RESOLVED: stub circles too large" below); the property-column sort arrow; row-click navigation hydrating the stale viewport (section C); hydrate-on-selection/navigation (C3, section C); **property-value lazy loading Stages 1 & 2** — no code path loads the full property-value map in stub-only mode anymore: the wholesale load on dataset open is gone (Stage 1) and an active property filter now drives drawing from a server-fetched id set instead of loading every value (Stage 2; verified 708K→0 resident even with a filter active, section D); **C1** — the viewport hydration fetch is now debounced + abortable (section C); and **stub circle size/stroke/fill now match the real annotation** (size: backend bbox-diagonal/2 → `max(w,h)/2`; stroke + fill mirror the full-annotation style — see "RESOLVED (2026-06-22)" below). **density-adaptive render budget + zoom hysteresis + restyle throttle (C4)** — the render/hydration budget is now **size-gated** (datasets ≤ `maxVisible` cap render fully at every zoom) and, above the cap, set by a **density-derived** zoomed-out floor (`coverageTarget × screenArea / dotArea`, default 0.17 → ~10K of 708K — a readable density map instead of a solid blob) that **doubles per zoom level** up to the cap (`visibilityBudgetForZoom`); a **unified pan+zoom hysteresis** (`cameraRefreshNeeded`, `viewportRefreshFraction` 0.2) skips the refresh until either the zoom magnification or the pan distance (as a fraction of the viewport) crosses 20%, cutting loading churn; `restyleAnnotations` is throttled like the draw path; and the render-coverage HUD is now viewport-relative ("Showing N of M in view · K loaded"). See section C4. **C2 (zoom-aware hydration) — DONE (un-shelved 2026-06-23).** Re-applied onto the now-incremental draw path (two viewport splits: 2× expanded box → visibility/pan-preload, unexpanded box → hydration so zoom-in re-prioritizes the actual viewport). Matched A/B on 708K confirmed **no perf regression** (median main-thread block at the worst-case mid-zoom: C2 ~1.3 s vs mainline ~2.0 s, C2's distribution tighter) while concentrating ~2× more hydration into the actual viewport. See the C2 note in section C. **High-zoom pan perf — DONE (2026-06-23).** The profiling pass (2026-06-22) found each refresh blocked the main thread ~3.3 s at 708K, split between **two** co-dominant O(total-annotations) costs; both are now fixed and the per-pan main-thread block is **~3.3 s → ~0.82 s (~4×)**, verified in-browser: **(1) selection fix** — `selectRandomSubset` hashes each id once (was 2×/comparison), `selectLargestBySize` (new) replaces the Step-4 full sort with a bounded min-heap, and the action captures `this.annotationStubs` once instead of through the vuex proxy in hot loops (`updateVisibilityAndHydration` ~1.9 s → ~0.31 s); **(3) draw-path incrementalization** — the main draw now diffs via `clearOldAnnotations(false)` with a stub-aware keep-check (`drawnFeatureUnchanged`) + a hybrid bulk-clear for high churn (frame changes), so ~95 % of features survive a pan and `drawNewAnnotations` drops ~450 ms → ~55 ms; **(2) coalesce double draw** — subsumed by (3): the 2nd (hydrate-merge) draw is now an incremental diff that only updates the newly-hydrated features. See "Profiling pass: high-zoom pan (results)" and the "Draw-path incrementalization (DONE)" note in section C. **D3 (server aggregation for the properties panels — DONE 2026-06-23):** the plots were already server-driven; the broken wholesale consumer was the per-property "uncomputed" count (it iterated the empty-in-lazy-mode full annotation array), now served by `POST /upenn_annotation/uncomputed_counts` (counts only — `propertyValues` verified 0 resident on 708K). See the "Recommended order" footer item #1 for the full as-built. **Next:** **viewport-bound the visibility/hydration budget when zoomed in.** Surprising finding from the C2 verification: the budget still fills to `maxVisible`/`maxHydrated` with **off-screen** annotations even when almost nothing is in view (verified at zoom 6.5 with ~340 in view → still `visible=50000`, `hydrated=40000`), and churning that 50K *visible* set is the dominant ~1–3 s mid-zoom main-thread block — **C2-independent**; it's the Step-3 visibility rebuild, not hydration. Bounding the drawn/hydrated count to roughly what's near the viewport is the practical form of "decouple hydrated-in-memory from drawn-as-shape" and the highest-leverage remaining perf lever. **Pre-PR settings cleanup — DONE 2026-06-23** (defaults kept; added `visibilityConfigBounds.ts` floor/ceiling + cross-field clamp-on-blur, an "Advanced settings for large numbers of annotations" disclosure with per-field info tooltips, and a chatbot prompt section; 200K ceiling verified survivable on 708K — see the "Threshold and Hydration Refinement" to-do). **Deferred to later PRs / lower priority:** A3 (infinite scroll — deep-page tail), D2 (per-column loading — unnecessary; loading all values for one *item* is fine), D4 (PV stubs), D5 (explicit LRU), B3 (streaming partial counts). See the **Remaining work** summary at the very bottom for the authoritative roadmap.

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

**B (IMPLEMENTED 2026-06-18):** server-side sort/filter/paginate + lazy per-page property values + dual-mode `AnnotationList.vue` (the existing client-side list is unchanged below the stub threshold; a server-driven `v-data-table-server` takes over above it). Full design + as-built notes: [`Archived Source: ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](#archived-annotation-list-server-side-design); task-by-task plan: [`Archived Source: ANNOTATION-LIST-SERVER-SIDE-PLAN.md`](#archived-annotation-list-server-side-plan).

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

### RESOLVED (2026-06-24): point annotations bypass the stub/hydrated machinery
A point's centroid **is** its only coordinate, so the stub/hydrated split — built
for polygons, where coordinates are the bulk of the payload — is pure overhead
for points. Investigation on a 1,000,000-point dataset confirmed it: hydration
fetched ~23K points whose `/hydrate` response equalled the centroid already held,
the `/stubs` payload was ~239 MB (a point stub's metadata dwarfs its one
coordinate), and a point stub rendered as a radius-0 dot that popped/resized into
a `scaled` regular point the moment it hydrated.

**Fix (collapse, not removal — points stay in the lightweight index):**
- New pure predicates in `utils/annotation.ts`: `shapeNeedsHydration(shape)`
  (`false` for `Point`, `true` otherwise) and
  `drawnFeatureUsesDotStyle(isStub, shape)` (`isStub && shapeNeedsHydration(shape)`).
- **Render** (`AnnotationViewer.vue`, three styling sites — `createGeoJSAnnotation`,
  the `drawNewAnnotations` restyle loop, `restyleAnnotations`): a point stub now
  renders with the **regular point style** (`getAnnotationStyle`), not the dot
  stub style. `annotationShape` is carried in the GeoJS feature `options` so the
  restyle loops can re-derive the decision. Non-point stubs are unchanged.
- **Hydration** (`annotation.ts`): `updateVisibilityAndHydration` Step 4 filters
  points out of **both** hydration tiers before budget allocation, and
  `ensureHydrated` drops point ids. Points never enter `hydratedAnnotations` and
  never hit `/hydrate`.
- **Unchanged:** points stay in `annotationStubs` + the spatial index, and the
  visibility budget still downsamples them — that (not stubs) is what makes 1M
  points tractable. `estimatedRadius` is now unused for points. No backend change.
- **Click hit-test stays consistent for free:** `shouldSelectStub` tests against
  the feature's live `style()`, which is now the regular point style — so the hit
  radius matches the drawn radius automatically.
- **Verified in-browser** on 1M points + 200 polygons: `stubOnlyMode` true,
  `hydratedAnnotations` held the 200 polygons and **zero** points across repeated
  pans, `httpRequestsFired` = 1 (the polygons), points still downsampled
  (`visibleAnnotationIds` ~15K). The residual ~1.2 s per-pan main-thread block is
  the C2-independent visible-set rebuild — see issue #1205
  (`VIEWPORT-BOUND-BUDGET.md`), deliberately out of scope here.

#### Follow-up (2026-06-24): resolution layer also had to collapse for points
The first pass collapsed *rendering* and *hydration* for points but missed the
*resolution* layer. Codex found that connection rendering, copy/paste, and
timelapse linking all resolve ids through `getAnnotationFromId`, which returned
`undefined` for unhydrated point stubs — so with points never hydrating, those
features silently dropped point annotations in stub-only mode. (Codex flagged 3
sites; the same pattern hit ~6, incl. `createConnection`.) **Fix:**
`getAnnotationFromId` now materializes a point stub into a full `IAnnotation`
(`coordinates = [centroid]`) via the pure `materializeStubAnnotation` helper in
`utils/annotation.ts` — non-point stubs still return `undefined` (they need real
hydration). One getter change fixes every site that resolves through it. The
`datasetId` stamp is sourced once per getter access from `main.dataset` (not
stored per-stub — that would waste ~50 MB on 1M identical values, and a per-call
read regressed the hot path 17→76 ms/100K; hoisting it lands at ~36 ms/100K).
Verified in-browser: `getAnnotationFromId(pointId)` returns a materialized point,
and all 5 point→point test connections resolve both endpoints.

**Perf note / future lever.** Materializing adds cost only on the
resolve-an-unhydrated-point path (hydrated/full annotations return early,
unchanged); benchmarked at ~36 ms/100K resolutions vs ~17 ms for the old
`undefined` return (~357 vs ~173 ns/call). This getter is **not** on the 50K
per-feature render loop (that uses `getForRendering`), and every volume caller
that resolves points (connection draw, timelapse track drawing, selection
hit-test) genuinely needs the point — so inlining the materialization at those
sites would cost the same, just spread across more code. The 100K figure is a
micro-benchmark; the heaviest real caller (timelapse track draw) is bounded by
displayed connections (single-digit ms, dwarfed by the draw). **If a profile
ever shows this hot:** the connection/timelapse-centroid paths only need
`id`+`centroid`, so they can read the stub directly (`getStub`) and skip the
coordinate-array allocation — a surgical per-site change, not a re-architecture.

#### Follow-up (2026-06-24): point moves must update local state in stub-only mode
Materializing point stubs let alt-drag move a point, but the stub-only update
path only synced tags/color, so a moved point's backend coordinates changed
while `annotationStubs` / `annotationCentroids` / `annotationSpatialIndex` kept
the old centroid until reload. **Fix (two parts):**
- `buildStubUpdates` now emits a centroid update for a moved point (a point's
  only coordinate *is* its centroid; gated to point shape), and
  `applyStubFieldUpdates` applies it to the stub centroid, the centroid index
  (in place — copying the up-to-1M-entry map per drag would be wasteful), and
  the spatial index (clean upsert).
- Newly-created annotations are always added to `hydratedAnnotations` (even in
  stub-only mode), and `getAnnotationFromId` prefers that hydrated copy before
  materializing from the stub. `applyStubFieldUpdates` now also makes the
  hydrated copy's `coordinates` follow a point move (`coordinates = [centroid]`),
  so a freshly-created, then-dragged point no longer resolves to stale coords in
  copy/paste, hit-testing, selection, and connections.

Verified in-browser (a created point resolved to its old coords after a move
before the fix, correct coords after). TDD: 2 new `buildStubUpdates` tests.

### Selection includes non-visible annotations
- `getSelectedAnnotationsFromAnnotation()` queries both the displayed RBush and the global `annotationSpatialIndex`
- Drag-select catches ALL annotations in the region on the current frame, regardless of visibility budget
- Frame filtering (XY, Z, Time) applied to global candidates

---

## To-Do List

### Code review follow-ups (Codex, 2026-06-23)
The six findings in [`Archived Source: ANNOTATION-STUBS-REVIEW.md`](#archived-annotation-stubs-review)
are fixed (see its "Resolution" section) — stub-aware selection, stub-aware
delete-unselected, full stub-state reset, PV-sort dedup, and values-filter
clearing. One follow-up remains:
- [ ] **Rebuild `annotationStubs.test.ts` off the real store boundary.** It uses
  a copied mini-store still asserting the obsolete "hydrate first 20%" strategy
  that production `setAnnotations` abandoned, so those cases test the copy, not
  production. Replace with pure-utility tests + a thin integration test (and
  fold in stub-mode `deleteUnselectedAnnotations` coverage).

### Threshold and Hydration Refinement
- [x] Test and tune `maxVisible` (default 50,000) — **2026-06-22: now density-adaptive + size-gated** via `visibilityBudgetForZoom` (C4 above). The 50,000 is both the zoomed-in cap and the size gate (datasets ≤ it render fully). Above it, the effective budget starts at a density-derived floor (`coverageTarget × screenArea / dotArea`, default 0.17 → ~10K of 708K) and doubles per zoom level. Resolves the zoomed-out visual noise from the full 4px stroke.
- [x] Test and tune `maxHydrated` (default 20,000) — scaled by the same zoom factor as `maxVisible` (C4). Fewer shapes hydrated/drawn when zoomed out (where they look like dots anyway).
- [x] **Zoom-adaptive `maxVisible`** — DONE 2026-06-22 (C4 above). Addresses both zoomed-out readability and per-frame draw cost.
- [x] Consider making thresholds configurable via UI settings panel — all live in `visibilityConfig` and are editable in `UISettings.vue` (incl. the new `coverageTarget` and `viewportRefreshFraction`).
- [x] **Pre-PR settings cleanup — DONE 2026-06-23.** Defaults kept (current values judged a good balance; the dominant mid-zoom cost is the C2-independent visible-set rebuild whose real fix is viewport-bounding — a deferred roadmap item — not retuning a global cap). Added bounds + validation:
  - New pure, unit-tested util `src/utils/visibilityConfigBounds.ts` (`VISIBILITY_BOUNDS` + `clampVisibilityConfig(proposed, current) → { config, adjusted }`), mirroring `visibilityBudget.ts`. Bounds: `stubThreshold`/`maxVisible` [1000, 200000], `maxHydrated` [500, 200000], `hydrationCacheCap` [500, 200000], `coverageTarget` [0.01, 1], `viewportRefreshFraction` [0.01, 2]. Integer fields rounded. Cross-field invariants: `maxHydrated ≤ maxVisible`; `hydrationCacheCap ≥ maxHydrated`. NaN/empty reverts to current.
  - `UISettings.vue` rewritten: the annotation-rendering controls now live in a collapsed `v-expansion-panel` titled **"Advanced settings for large numbers of annotations"** (open state persisted via `Persister`, key `uiSettingsAdvancedOpen`); a section blurb; the 6 numeric fields are metadata-driven (`numericFields`) so the field label/description is the single source for both the inline info-icon tooltip *and* the HelpPanel `v-description`. Each field has an `mdi-information-outline` tooltip (description + allowed range) via the `#activator` slot pattern (the nested `activator="parent"` variant renders the icon but does **not** open on hover — caught by real-mouse in-browser verification). Validation is **clamp-on-blur + reflect + a 4 s "Adjusted to N" note** per adjusted field (replaces the old silent `if (value > 0)` ignore).
  - Chatbot: added a "Large Annotation Sets & Advanced Rendering Settings" subsection to `system_prompt_2.txt` (§13 Performance).
  - **Ceiling 200000 verified in-browser on 708K Xenium:** at a budget-saturating mid-zoom the visible set fills to 200K with a single ~4.9 s main-thread block and heap ~371→927 MB — slow but survivable, no OOM/crash, and memory is bounded by the visible-set cap (hydration stayed viewport-bounded at ~1K). Default 50K at the same dataset: ~10.9K-dot readable overview, heap ~435 MB. Confirms 200K is a safe "guard against pathological input," not a freeze/OOM.
- [ ] Evaluate whether size-based hydration ranking (largest first) is the right heuristic vs. alternatives (density, distance to viewport center, user focus area)
- [x] **Profile `updateVisibilityAndHydration` with 100K+ annotations to identify bottlenecks** — DONE 2026-06-22 (see profiling pass below). The action is ~1.4–2.0 s per refresh at 708K; the cost is `selectRandomSubset` doing a **full O(N log N) sort of the whole off-viewport set** (Step 3, ~1.1–1.2 s) plus the Step 4 hydration sort (another ~0.4–0.5 s when zoomed in past `inViewport < maxHydrated`).
- [x] **Debounce/throttle the draw+restyle path** — DONE 2026-06-22 (C4): `restyleAnnotations` is now throttled (the draw path already was); the zoom-adaptive budget cuts the per-frame feature count (10× fewer when fully zoomed out) which is the main pan-lock remedy.
- [x] **Profiling pass: high-zoom pan — DONE 2026-06-22.** Profiled with temporary per-stage
  `performance.now()` instrumentation (since reverted; tree clean) on the **708K Xenium** dataset in
  stub-only mode (50K render budget), plus the **26K HCR** control. Drove pan/zoom via the GeoJS map
  API at zoom 4–5 and isolated the draw stage with two throwaway probes (force-all-dots, and route
  the draw through the existing `clearOldAnnotations(false)` diff path). **The leading hypothesis was
  half right: the full feature rebuild is a major cost, but it is NOT the largest, and the naive
  incremental-draw fix makes pans _slower_.** Full numbers + ranking + recommendation in the new
  **"Profiling pass: high-zoom pan (results)"** section directly below; the "Draw-path
  incrementalization" note in section C is updated with the measured per-stage costs. Headline: two
  co-dominant O(total-annotations) synchronous costs per refresh — the **`selectRandomSubset`
  visibility/hydration sort (~1.2–2.0 s)** and the **double full feature rebuild (~1.3–1.7 s, fires
  twice per pan)** — so the **algorithmic selection fix is the higher-leverage, lower-risk first
  lever**, ahead of touching the delicate draw code.
- [ ] Test hydration/dehydration memory churn during rapid pan/zoom

### Profiling pass: high-zoom pan (results) — 2026-06-22

Measured on **708K Xenium**, stub-only mode, render budget 50,000, at zoom 4–5 (high zoom). Temporary
`performance.now()` deltas wrapped `drawAnnotationsNoThrottle` (per stage), `restyleAnnotations`,
the `layerAnnotations` computed, `updateVisibility`, and each step of `updateVisibilityAndHydration`;
all instrumentation has been reverted (`git diff` is clean except this doc). Each number is a steady-
state median over ≥3 gestures; numbers are consistent run-to-run.

**Per-refresh cost — high-zoom PAN (zoom 4–5):**

| Stage | Cost | Notes |
|---|---|---|
| `updateVisibility` (synchronous, main thread) | **~1.45–1.89 s** | the single largest block; ~99% is the action below |
| └ id-list build (`annotationsForIteration.map`) | ~12 ms | maps all 708,983 stubs → ids |
| └ Step 1+2: frame filter + 2× `splitByViewport` | ~260–280 ms | O(708K) frame loop + two RBush partitions over 708K |
| └ **Step 3: `selectRandomSubset` (visibility budget)** | **~1.15–1.22 s** | **full comparison sort of the ~674–700K off-viewport ids, calling `hashString` twice per compare (~26M hashes of 24-char ObjectIds) to pick ~15–42K** |
| └ Step 4: hydration-budget sort | ~20 ms (z4) → ~410–470 ms (z5) | cheap `inViewportOnly` branch when `inViewport ≥ maxHydrated`; another full ~700K sort once zoomed in past that |
| └ Step 5b + 6/7 | ~20 ms | raw-viewport split + hydrate classify |
| `layerAnnotations` recompute | ~40–73 ms × (per draw) | Vue computed |
| **`drawAnnotations` (fires ×2 per pan)** | **~0.66–0.90 s each** | see breakdown; **2 draws per pan** (one on the visibility update, one when the async hydrate merge mutates `hydratedAnnotations`) |
| └ `clearOldAnnotations(true)` (teardown) | ~100–115 ms | `removeAllAnnotations` (one shot) |
| └ **`drawNewAnnotations` (rebuild)** | **~410–505 ms** | `createGeoJSAnnotation` ×50,000 + `addMultipleAnnotations`; **count-bound, NOT shape-bound** (see probe) |
| └ `annotationLayer.draw()` (GeoJS render) | ~130–310 ms (polygons), ~58 ms (all points) | the only shape-sensitive stage |
| hydrate **fetch** (network + `mergeHydratedAnnotations`) | ~40–350 ms | async, debounced (C1); mostly off the main thread |
| `restyleAnnotations` | not on the pan path | only fires on hover/select/opacity, already throttled (C4) |

**Total synchronous main-thread block per pan ≈ 1.5–1.9 s (action) + 1.3–1.7 s (two draws) + ~0.1 s
≈ 3.2–3.5 s.** This is the felt "freeze for a beat" (in practice several beats).

**Zoom STEP (one level):** same structure, action is _more_ expensive (~2.0 s) because once the
in-viewport count drops below `maxHydrated`, **both** Step 3 and Step 4 do full ~700K sorts.

**A/B isolation probes (throwaway):**
- **Force all-dots (clear hydration cache, render 50K point stubs):** `drawNewAnnotations` stayed
  **~451 ms** (vs ~450–505 ms for the polygon mix) — so the rebuild cost is the **count of 50K
  feature recreations, not polygon geometry**. Only `annotationLayer.draw()` dropped (58 ms vs
  130–310 ms). Also: with no new hydration, **only one draw fired** — confirming the second draw is
  the hydrate-merge reactivity.
- **Route draw through the existing diff path (`clearOldAnnotations(false)`):** **net SLOWER** — total
  draw rose to **1.1–1.2 s** (vs 0.66–0.72 s). Two reasons: (1) only **~6,200 of 50,000 features
  survived a pan (≈88% visible-set churn)**, so `drawNewAnnotations` barely dropped; (2) the diff
  itself cost **~620 ms** (`clearMs`) because it does reactive `.value` getter lookups per feature and
  removes ~44K features one-by-one (`removeAnnotation` is O(N) per call → ~O(N²)).

**Control — 26K HCR (under the 50K budget):** the same pan costs **action ~26 ms** (`selectRandomSubset`
early-returns; the whole set is under budget so no sort) and **~0.66 s of draw** (2× ~330 ms, still a
full 26K rebuild) — total ~0.7 s, smooth. Confirms both bottlenecks are **O(total annotations) per
refresh** and only bite at 708K scale.

**Bottleneck ranking (high-zoom pan):**
1. **`selectRandomSubset` / hydration-sort selection** in `updateVisibilityAndHydration` — **~1.2–2.0 s**,
   once per refresh. Largest single cost; a pure O(N log N)→O(N) algorithmic problem (full sort to pick
   top-K by hash), independent of the draw code.
2. **Double full feature rebuild** in `drawAnnotations` — **~1.3–1.7 s aggregate** (drawNew ~450 ms × 2),
   amplified 2× by the hydrate-merge re-draw. `drawNew` is count-bound.
3. Frame/viewport split + `layerAnnotations` recompute — ~0.3–0.4 s.
4. Hydrate **fetch** — async, ~0.04–0.35 s, mostly off the main thread (already debounced/abortable, C1).

**Implemented (2026-06-23) — all three landed; per-pan main-thread block ~3.3 s → ~0.82 s (~4×),
verified in-browser on 708K Xenium (zoom 2/5/6 + pan) and 26K HCR (full render + Z frame changes;
feature count == visible count in every state, no orphans/stale).**
- **Selection (#1):** `selectRandomSubset` now hashes each id once into a typed array + index sort
  (was 2 hashes/comparison); `selectLargestBySize` (new, `utils/annotation.ts`) replaces the Step-4
  hydration full-sort with a **bounded min-heap** (O(n log count), deterministic size+hash tie-break);
  and `updateVisibilityAndHydration` captures `this.annotationStubs` once instead of resolving it
  through the vuex-module action proxy ~1.4M times. Action **~1.9 s → ~0.31 s**.
- **Draw incrementalization (#3):** `drawAnnotationsNoThrottle` routes through
  `clearOldAnnotations(false)`, which keeps unchanged features and removes/recreates only the rest,
  with a **hybrid** bulk-clear (`INCREMENTAL_BULK_CLEAR_FRACTION`) when most must go (frame change).
  **The "~88 % churn" below was a measurement artifact, not real churn:** the old diff used
  `getAnnotationFromId`, which returns undefined for non-hydrated non-point stubs (the full `annotations[]` is
  empty in stub-only mode), so it dropped every dot feature each pass. The new stub-aware keep-check
  (`drawnFeatureUnchanged`) fixes it — true survivor rate on a high-zoom pan is **~95 %**, so
  `drawNewAnnotations` drops **~450 ms → ~55 ms** and each draw is ~250 ms (was ~680 ms).
- **Coalesce double draw (#2):** subsumed by #3 — the 2nd (hydrate-merge) draw is now an incremental
  diff that only re-creates the newly-hydrated features (~250 ms), so the double draw is no longer a
  perf problem. Literal "draw once" coalescing was not added (it would delay first paint for marginal
  gain); revisit only if the residual second draw matters.

The original recommendation (kept for the reasoning trail) follows.

**Recommendation — the draw-path rebuild is real but is NOT the first lever, and the naive diff
fix is wrong.** In priority order:
1. **Fix the selection cost first (highest leverage, lowest risk, no draw-code changes).** Replace the
   full sort in `selectRandomSubset` with an O(N) selection: compute each id's hash once (not twice per
   comparison), then quickselect / bounded-heap / hash-threshold to take the lowest-`maxCount` — or keep
   a stable global hash ranking so the off-viewport fill doesn't re-roll each pan. Also avoid the Step 4
   full sort the same way. This alone removes ~1.2–2.0 s/refresh.
2. **Coalesce the double draw** into one per pan (the visibility update and the hydrate-merge both
   trigger a full `drawAnnotations`). ~2× win on the draw stage for near-zero risk.
3. **Then** do draw-path incrementalization — but do it _properly_, not by flipping
   `clearOldAnnotations(true)→(false)`. It needs (a) a cheap viewport-set diff (no per-feature reactive
   getter calls), (b) a batched/O(N) removal (not one-by-one `removeAnnotation`), and crucially (c) a
   **stable visible set across pans** so features actually persist — today ~88% of the visible set
   churns per pan, so even a perfect diff would rebuild ~44K/pan. Fixing (1) (stable hash ranking) is a
   prerequisite for (c).

**Does this unblock un-shelving C2?** Yes, and it clarifies _why_ C2 froze. C2 concentrates hydration
into the exact viewport, turning more in-view features into polygons. But the profiling shows `drawNew`
is **count-bound, not shape-bound** — extra polygons add mainly to the (smaller) `annotationLayer.draw()`
stage, not the dominant rebuild. C2's real cost is that the tighter hydration box **churns the
hydration/visible set harder → more refreshes**, each paying the full ~3 s selection+rebuild cycle. So
once (1) the selection is O(N) and (2)/(3) the draw is single + incremental over a stable set, C2 should
be safe to bring back. This **strongly supports decoupling "hydrated-in-memory" from "drawn-as-shape"**:
a separate, smaller shape-draw cap bounds the polygon (`annotationLayer.draw()`) cost and the per-pan
shape churn independent of how much is hydrated for selection/measurement — exactly the lever C2 needs.

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
[`Archived Source: ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`](#archived-annotation-list-server-side-design) §8):
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
- **C2 — Zoom-aware hydration (DONE — un-shelved 2026-06-23).** The change: split current-frame
  ids by *two* boxes — the 2× expanded box drives visibility (pan pre-load, Step 3), the
  **unexpanded** box drives hydration (Step 4) so zooming in re-prioritizes hydration onto the
  actual viewport. The unexpanded split is reused for the render-coverage counts (Step 5b), one
  fewer `splitByViewport`.

  **As-applied (not a clean cherry-pick).** The shelf commit (`3e783c83`) branched off an *older*
  base, before the O(N) selection rewrite (`344d4d85`). The shelf had extracted the selection into
  `selectVisibleIds`/`selectHydrationIds` in `utils/visibilityBudget.ts`, but its `selectHydrationIds`
  used a **full `.sort()`** (the slow pre-rewrite path) — so it was **not** adopted. Instead the C2
  idea (two splits) was layered onto the *current* fast helpers (`selectRandomSubset`,
  `selectLargestBySize`). Net: the only behavioral change vs mainline is Step 4 ranking against the
  unexpanded box. Tests: the C2 behavior test was ported into `annotationStubs.test.ts` (the harness
  was first corrected to mirror the real action's 50% expansion, so the test is a true RED→GREEN);
  `visibilityBudget.test.ts` was **not** added (those wrappers weren't adopted). tsc clean, full
  suite 2331 green.

  **Verified in-browser on 708K Xenium (matched A/B: `git stash` → reload → measure → pop → reload
  → measure; longtask `PerformanceObserver`):**
  - **Behavior works** — at a budget-saturating zoom C2 concentrates ~2× more hydration into the
    *actual* viewport than mainline (in-view hydrated ~10K vs ~5K; ~22.8K vs 5.3K once the cache
    warms). Renders correctly (cells draw as full polygons at high zoom).
  - **No perf regression** — matched 5-pan A/B at the worst-case mid-zoom (~2.7): C2 median
    main-thread block **1336 ms** vs mainline **2025 ms** (C2 tighter; both span 1–4 s). Earlier
    single-sample "C2 2515 vs mainline 1143" was noise. Why no regression: C2 only changed the
    *hydration* split (Step 4); the dominant mid-zoom cost is the **50K visible-set rebuild** (Step 3
    visibility budget), which C2 doesn't touch — see the new "off-screen budget fill" item below.

  Earlier shelved (2026-06-22) only because the draw path then rebuilt all features per refresh
  (the freeze); the incremental-draw fix below removed that, exactly as predicted. The old shelf
  branch `shelf/c2-zoom-aware-hydration` (commit `3e783c83`) can now be deleted.

- **Off-screen budget fill when zoomed in (NEW — surprising finding from the C2 verification,
  2026-06-23; the next perf lever).** At high zoom the visibility/hydration budget still fills to
  the full caps with **off-screen** annotations: verified at zoom 6.5 with only ~340 annotations in
  the actual viewport, `visibleAnnotationIds=50000` and `hydratedAnnotations=40000`. Panning that
  ~50K *visible* set to a fresh region is the dominant **~1–3 s mid-zoom main-thread block** — and
  it is **C2-independent** (the cost is in the Step-3 visibility rebuild + `drawNewAnnotations`,
  present identically on mainline; even at `inView=0` a pan still blocked ~2 s because the 50K
  off-viewport hash-fill churns). **Lever:** bound the drawn/hydrated count to roughly what's near
  the viewport when zoomed in — i.e. don't fill the budget with annotations far off-screen. This is
  the practical, measured form of the long-noted "decouple hydrated-in-memory from drawn-as-shape"
  (a separate, smaller shape-draw cap), and it is now the **highest-leverage remaining perf lever**.

- **Draw-path incrementalization (DONE 2026-06-23; profiled 2026-06-22).** *Was:*
  `drawAnnotations` (`AnnotationViewer.vue`) tore the whole GeoJS layer down and rebuilt *every*
  visible feature on every refresh: `drawAnnotationsNoThrottle` called `clearOldAnnotations(true, …)`
  → `removeAllAnnotations()`, then `drawNewAnnotations` re-creates all features via
  `createGeoJSAnnotation` + `addMultipleAnnotations`. (The snapshot of existing features used by the
  `excluded` skip is built *after* the `removeAllAnnotations`, so it is always empty — the rebuild is
  unconditional.) **Profiling confirmed this rebuild is a major cost but corrected three assumptions**
  (full numbers in the "Profiling pass: high-zoom pan (results)" section above):
  - At 708K/50K-budget it is **~410–505 ms for `drawNewAnnotations` and fires _twice_ per pan**
    (~1.3–1.7 s aggregate) — the second draw is the async hydrate-merge mutating `hydratedAnnotations`.
  - The rebuild is **count-bound, not polygon-bound**: forcing all 50K to point stubs left `drawNew`
    unchanged (~451 ms); only the GeoJS `draw()` stage is shape-sensitive (58 ms points vs 130–310 ms
    polygons). So this is NOT primarily what C2 amplified.
  - It is **not the largest per-refresh cost** — the synchronous `selectRandomSubset` visibility/
    hydration sort in `updateVisibilityAndHydration` (~1.2–2.0 s) is co-dominant or larger.

  **As built:** `drawAnnotationsNoThrottle` now calls `clearOldAnnotations(false, false)` — the
  existing incremental diff path — and the snapshot of surviving features feeds `drawNewAnnotations`,
  whose `excluded` check then skips them so only genuinely-new features are created. Two fixes made the
  diff a win (the earlier "naive flip is slower" finding was a *bug*, not fundamental):
  - **Stub-aware keep-check (the bug).** The old `clearOldAnnotations(false)` decided "keep" via
    `getAnnotationFromId`, which returns undefined for non-hydrated non-point stubs (the full `annotations[]` is
    empty in stub-only mode), so it dropped **every dot feature** each pass — that, not real churn, is
    why only ~6.2K survived. The new pure helper `drawnFeatureUnchanged` (`utils/annotation.ts`) keys
    off `layerData` (the renderData already in `layerAnnotations`): keep iff still displayed on the
    layer, same color, same dot/shape state. True survivor rate on a high-zoom pan is **~95 %**.
  - **Hybrid bulk-clear.** `removeAnnotation` is ~O(n) per call, so removing most features one-by-one
    (a frame change turns the whole set over) would be ~O(n²). `clearOldAnnotations(false)` now
    collects the removals first and, if they exceed `INCREMENTAL_BULK_CLEAR_FRACTION` (0.5) of the
    drawn set, does a single `removeAllAnnotations` instead; below it, individual removals.

  Result: `drawNewAnnotations` ~450 ms → ~55 ms, each draw ~250 ms (was ~680 ms). The **double draw**
  is thereby coalesced in effect — the 2nd (hydrate-merge) draw only re-creates the newly-hydrated
  features. Verified in-browser across pan/zoom and Z frame changes: drawn feature count == visible
  count in every state (no orphans, duplicates, or stale features), no console errors. Tests:
  `drawnFeatureUnchanged` (`annotationStubUtils.test.ts`, 7) + `clearOldAnnotations` keep/hybrid +
  updated `drawAnnotationsNoThrottle` (`AnnotationViewer.test.ts`). Shipped with the selection fix in
  commit `344d4d85`.
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
- **D3 — Server-side aggregation for stats/histograms — DONE 2026-06-23.** The filter
  histogram was already server-driven; the remaining wholesale consumer was the properties
  panels' uncomputed-count badge, now served by `POST /upenn_annotation/uncomputed_counts`
  (counts only). Full as-built notes in the "Recommended order" footer item #1 below.
- **D4 — Property-value stubs:** lightweight per-property summary (min/max/mean) loaded
  upfront; full per-annotation values on demand.
- **D5 — Cache eviction:** LRU / frame-based eviction so the value map stays bounded when
  switching properties or frames.

**Recommended order (updated 2026-06-23):** **DONE so far** — A (A2 + PV-driven queries);
the row-click navigation fix and C3 hydrate-on-selection (section C); **D Stage 1**
(viewport-scoped property values — wholesale load on open eliminated); **D Stage 2**
(server-side filtered drawing — the last wholesale-load path removed; the memory story is now
complete: no code path loads the full property-value map in lazy mode); **C1**
(debounce/AbortController on the hydration fetch); **B1 + B2** (stub-fetch progress bar
+ per-query list feedback); the **stub circle size/stroke/fill match** (2026-06-22);
**C4 / density-adaptive render budget + unified pan+zoom hysteresis + restyle throttle +
viewport-relative indicator** (2026-06-22 — size-gated density-derived budget that doubles per zoom
level; the refresh is skipped until either zoom or pan crosses 20%; mid-size datasets render fully);
the **high-zoom-pan profiling pass** (2026-06-22); and the **high-zoom pan perf fix** (2026-06-23,
commit `344d4d85`) — **selection fix** (`selectRandomSubset` hash-once + `selectLargestBySize`
min-heap + capture stub map: action ~1.9 s → ~0.31 s), **draw-path incrementalization**
(`clearOldAnnotations(false)` diff + stub-aware `drawnFeatureUnchanged` keep + hybrid bulk-clear:
~95 % survivors, `drawNew` ~450 ms → ~55 ms), with the **double draw coalesced in effect**
(2nd draw is now incremental). Per-pan main-thread block **~3.3 s → ~0.82 s (~4×)** at 708K.
**Remaining, recommended order (updated 2026-06-23 after #1–#3 + D3 shipped):**

1. ~~**D3 — server-side aggregation for plots + properties panels**~~ — **DONE 2026-06-23.**
   Investigation found the plots were *already* server-driven (the
   `PropertyFilterHistogram` curve reads the `/histogram` endpoint via
   `filterStore.getHistogram`); the one genuinely-broken wholesale consumer was the
   **properties panels' per-property "uncomputed" count**
   (`uncomputedAnnotationsPerProperty`), which iterates `annotations.annotations` —
   *empty* in lazy mode — so at 708K the badge / "Compute all" / `hasUncomputedProperties`
   silently read 0. **As built:** new `POST /upenn_annotation/uncomputed_counts` (model
   `Annotation.uncomputedCounts`) returns, per property, `max(0, total_matching −
   has_value)` via **two batched aggregations** (a `$facet` over annotations counting
   shape+tag matches — inclusive `$all` / exclusive `$all`+`$size`, mirroring
   `tagFilterFunction`; and one `$objectToArray`/`$unwind`/`$group` streaming pass over the
   value docs counting which carry each property key). **Counts only, never values.** Edge
   case: `has_value` counts value docs regardless of tags edited *after* compute, so the
   count can under-report by such an annotation — acceptable for an informational badge,
   and far cheaper than a 708K `$lookup` join (~2 s vs multi-second). Frontend: new
   `PropertiesAPI.getUncomputedCounts`, `properties.uncomputedCounts` state +
   `fetchUncomputedCounts` action (lazy-only; triggered from **both** `fetchPropertyValues`
   and `fetchProperties` with a properties-empty guard, because the two async flows that set
   `stubOnlyMode` and load `properties` race — a cached stub fetch resolves before
   properties load), a reactive non-function getter `uncomputedCountByProperty` (lazy →
   server count, wholesale → client length, via pure `selectUncomputedCount`); the 3
   consumers (`Property.vue`/`PropertyList.vue`/`App.vue`) now read it; and
   `PropertyFilterHistogram.vue` dropped its wholesale `values` computed (range now from
   `histogramBounds(hist)` only). TDD: backend `test_uncomputed_counts.py` (12, tag/shape
   semantics + batching + access), frontend pure helpers in `propertyValues.test.ts` (+6) +
   `PropertiesAPI.test.ts` (2) + updated panel/histogram tests. **Verified in-browser on
   708K Xenium (real reload):** `uncomputed_counts` POST fires (200, ~2 s), store
   `uncomputedCounts` = `{<prop>: 0}` (all computed — correct), `propertyValues` stays **0
   resident**, only the pre-existing 512-doc path sample hits `annotation_property_values`
   (no wholesale page load), no console errors; a fabricated uncomputed property returns the
   correct **708,983** on the live data. Backend 250 tests / frontend 2330 tests / tsc /
   flake8 all green.
2. **C2 — zoom-aware hydration — DONE (un-shelved 2026-06-23).** Re-applied onto the incremental
   draw path; matched A/B on 708K confirmed no perf regression (C2 ~1.3 s vs mainline ~2.0 s median
   block at worst-case mid-zoom) while concentrating ~2× more hydration into the actual viewport.
   See the C2 note in section C. The old `shelf/c2-zoom-aware-hydration` branch can be deleted.
3. **Viewport-bound the visibility/hydration budget when zoomed in (NEW — highest-leverage perf
   lever).** Surfaced by the C2 verification: the budget fills to `maxVisible`/`maxHydrated` with
   **off-screen** annotations even when ~nothing is in view (zoom 6.5, ~340 in view → still 50K
   visible / 40K hydrated), and churning that 50K visible set on a pan is the dominant ~1–3 s
   mid-zoom block (C2-independent — Step-3 visibility rebuild). Bound the drawn/hydrated count to
   roughly what's near the viewport = the measured form of "decouple hydrated-in-memory from
   drawn-as-shape." See the "off-screen budget fill" item in section C.
4. **Pre-PR cleanup** (before opening the stub-annotations PR): tune the `visibilityConfig` defaults
   (`maxVisible`, `maxHydrated`, `hydrationCacheCap`, `stubThreshold`, `coverageTarget`,
   `viewportRefreshFraction`) to good values and add **min/max guards** on each in `UISettings.vue`
   so a user can't enter a pathological value.
5. **Optional follow-ups to the perf work** (low priority): literal double-draw coalescing (the 2nd
   draw is already incremental, so marginal); revisit the size-based hydration ranking heuristic
   (largest-first is near-meaningless when cell sizes are uniform — see the open To-Do); the step1+2
   frame/viewport split is still O(total-annotations) per refresh (~0.26 s at 708K) if it ever needs
   trimming.

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

---

## Developer workflow notes & known infra issues

Practical gotchas for anyone working on the stub/draw/hydration code, plus two pre-existing infra
problems (not caused by the perf work): the test-suite OOM is now **fixed**; the Vuex store HMR issue
should be confirmed pre-existing and fixed in its own PR.

### In-browser profiling / verification workflow

When changing the selection, draw, or hydration code, verify both **correctness** and **performance**
in-browser on the real datasets (the unit tests can't exercise GeoJS rendering or 700K-scale timing):

- **Datasets.** 708K Xenium (the stress case): `/#/datasetView/6a18deb286eb377626a51dc5/view`. 26K HCR
  (control — renders fully, under the render budget; **multi-Z, annotations live on Z=3** with only
  5 on Z=0 and 100 on Z=4, so it's the dataset to test **frame changes** on):
  `/#/datasetView/69f744e4a3094194968458dc/view`. Frontend :5173, Girder :8080.
- **Switching datasets via the hash leaves stale store state — force `location.reload()`** (or a hard
  reload). On the 708K, the stub fetch then takes **~15–20 s** before `annotationStubs` is populated;
  wait before reading state or driving the map.
- **Read live state** via
  `document.querySelector('#app').__vue_app__.config.globalProperties.$store` → `.state.annotation.*`
  (e.g. `annotationStubs.size`, `visibleAnnotationIds.size`, `hydratedAnnotations.size`,
  `stubOnlyMode`). Note `store.state.z` is **undefined** — frame indices come through getters; change a
  frame with `store.dispatch('setZ', n)` (also `setXY`, `setTime`).
- **Find the map**: iterate `.geojs-map` nodes and call `window.$(node).data('data-geojs-map')`.
  **Index 0 is the main viewer; index 1 is the 150×150 navigator thumbnail** — don't drive the thumb.
- **Drive pan/zoom via the map API** (`map.zoom(v)`, `map.center({x,y})`); programmatic moves DO fire
  the camera watcher, but only after **~700 ms+** (250 ms camera debounce + 200 ms hydrate-fetch
  debounce) — wait before reading. Synthetic CDP drags do **not** reliably register as geojs pans.
  Mind the **20 % pan/zoom hysteresis** (`viewportRefreshFraction`): a gesture must cross 20 % of the
  viewport (zoom magnitude or center distance) to trigger a refresh at all — a too-small move is a no-op.
- **Counters**: `window.__stubPerf.snapshot()` / `.report()` / `.reset()` (HTTP requests, ids fetched,
  cache size, hydrate latency, camera/visibility update counts). For ad-hoc stage timing, wrap the
  function under test in temporary `performance.now()` deltas pushed to a `window.__*` array — **but
  keep all such instrumentation in `.vue` files** (HMR-safe; see the Vuex issue below) and revert it
  before committing.
- **The correctness invariant to check after any draw change**: the count of drawn GeoJS features with
  a `girderId` must equal `visibleAnnotationIds.size`, with **no duplicate ids and no stale features**
  (e.g. after a frame change, every drawn feature's `location` must match the current frame). This
  invariant caught the incremental-draw edge cases; re-run it across pan / zoom-in / zoom-out / frame
  change. Also confirm zero console errors.

### Infra issue 1 — Vuex store HMR breaks (investigate; fix in a separate PR if pre-existing)

Editing a `vuex-module-decorators` store module (`src/store/*.ts`) while `pnpm run dev` is running makes
Vite hot-reload **re-register** the module instead of replacing it, producing a cascade of
`[vuex] duplicate getter key: ...` errors and a broken store (annotations never load, `annotationStubs`
stays 0). Editing a `.vue` component HMRs fine. The cause is almost certainly that the decorated module
registers its getters/mutations on the root store at import time and has **no `import.meta.hot` accept
handler**, so a hot re-import double-registers.

- **Current workaround:** after editing any `src/store/*.ts`, force a full page reload, not an HMR
  update (and budget the ~15–20 s stub re-fetch on the 708K).
- **TODO (separate PR):** first confirm this reproduces on a clean checkout independent of the
  stub-annotations work (it almost certainly does — it's a vuex-module-decorators + Vite interaction,
  not specific to this feature). If pre-existing, fix it on its own branch: add HMR-dispose/accept
  handling for the store modules (e.g. unregister the module on `import.meta.hot.dispose` before
  re-register, or `hotUpdate`-style state preservation), so store edits hot-reload cleanly. This would
  meaningfully speed up backend-store iteration.

### Infra issue 2 — `AnnotationViewer.test.ts` OOM (FIXED 2026-06-23)

`src/components/AnnotationViewer.test.ts` (~4400 lines / 246 tests, each mounting the component against
a large `reactive()`-mocked store) used to **OOM the vitest worker** ("Ineffective mark-compacts near
heap limit") when run as a single file — you could only run it in `-t` slices, which hid regressions.

**Root cause:** the `afterEach` had an empty `if (wrapper) {}` block — the intended `wrapper.unmount()`
was never written. So all 246 `shallowMount`s (each with its GeoJS mock layers, watchers, and reactive
subscriptions, attached via `attachTo` to a `document.body` div) accumulated across the run.

**Fix:** `afterEach` now calls `wrapper.unmount()` and clears `document.body.innerHTML`. The full file
runs in one process in ~2.7 s with all 246 passing (no `-t` slicing needed) — so no file split was
required after all. The two `handleAnnotationCombine` tests that fail when run *in isolation* (they
inherit selection state from earlier tests) pass in the full run; making them standalone-safe (set up
their own state) is a minor optional cleanup, not blocking.
---

## Consolidated Historical Notes

The sections below preserve the contents of standalone annotation design, plan, and review files consolidated into this document on 2026-06-24. Historical cross-file references inside the archived material are intentionally left as they appeared in the source documents.

---

<a id="archived-annotation-list-server-side-design"></a>

## Archived Source: `ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`

# Server-Side Annotation List — Design Spec (Stub Annotations, Option B)

**Date:** 2026-06-18
**Branch:** `feature/stub-annotations`
**Status:** **IMPLEMENTED 2026-06-18** on `feature/stub-annotations`. This began as a design spec; the *As-built notes* box below records where the shipped code differs from the original design. Task-by-task plan: `ANNOTATION-LIST-SERVER-SIDE-PLAN.md`.
**Related:** `ANNOTATION-STUBS.md` (the stub architecture this builds on; this is its "Option B").

> ### As-built notes (2026-06-18) — read alongside the design below
> The design below is largely as-shipped, with these deviations:
> - **Row id field:** `/list` rows carry **`_id`** (not `id`) — stubs-consistent; the frontend `toStub`/`toListRow` maps `_id`→`id`. (§5.1's example was corrected to `_id`.)
> - **Selection + annotation-id filters ARE applied server-side** via a new `idConstraints` filter (AND of `_id $in` sets) — §5.1/§5.3. **ROI** is the only filter that stays client-side-only (notice shown in server mode).
> - **Dual-mode threshold:** server mode = `annotationStore.stubOnlyMode` (true when annotation count > `maxVisible` = 10,000). The Option-A `LIST_ITEM_LIMIT = 20000` client guard is therefore **unreachable** in practice (kept as a defensive net).
> - **Debounce:** the watch-driven server refetch is debounced ~300 ms; explicit pagination/sort is immediate. Vuetify **`v-data-table-server`** is the table component.
> - **Input validation:** filter/sort/property-path/idConstraints *shape* is validated at the API boundary → 400 (not an uncaught 500).
> - **Performance:** §8 records the measured 708K latency (3.6–25 s) and why the perf pass is deferred.
> - **Property-column sort arrow (fixed 2026-06-19):** the custom `header.${key}` slot used for property columns *replaces* Vuetify's default header content, which silently dropped the `.v-data-table-header__sort-icon` — property columns looked unsortable (only the `×` remove button showed). The slot now reproduces Vuetify's `.v-data-table-header__content` structure and renders the sort icon via the `getSortIcon` slot prop, with the remove button after it. Applied to both the client `v-data-table` and the server `v-data-table-server`.

---

## 1. Background & problem

The `AnnotationBrowser/AnnotationList` is a **client-side, load-everything** component:

- `<v-data-table :items="filteredItems">` materializes one item object per *filtered* annotation; Vuetify sorts/filters the whole array in JS.
- Property values are loaded **wholesale** for every annotation (`propertiesStore.propertyValues` = `{[annoId]: {[propId]: value}}`) — the single largest mutable structure in the app and, at scale, the dominant memory cost (larger than annotation coordinates per `ANNOTATION-STUBS.md`'s memory analysis).
- Interim guard (Option A, shipped): above `LIST_ITEM_LIMIT = 20000` filtered annotations the list refuses to render and asks the user to narrow with filters.

Option B replaces the guarded list, at scale, with a server-driven list so the client never holds all rows or all property values.

## 2. Goals / non-goals

**Goals (iteration 1 — "Core scale fix"):**

- List pagination, sorting, and **property-value filtering** move server-side above a threshold.
- Property values loaded only for the **visible page's displayed columns** — the memory win.
- Tag, location, and ID-substring filters also move server-side in this mode (pagination must reflect *all* active filters).
- `Select All` / `Delete Unselected` keep current meaning ("all matching the filters") via a matching-IDs endpoint.
- Small datasets are **unchanged** (dual-mode; zero behavior change below the threshold).

**Non-goals (deferred):**

- **Server-side ROI (polygon) filtering** — arbitrary-polygon containment needs Mongo geo operators; deferred. In server mode an active ROI filter shows a "not available for very large datasets yet" notice.
- **Infinite scroll** — iteration 1 keeps page numbers + total. Deep-page jumps are a common mode and ultimately want cursor-based infinite scroll; recorded as the next pagination iteration (more work).
- **Other `propertyValues` consumers** (property plots, AnnotationProperties panels) — still load values; not addressed by B-core, which targets the list.
- Per-property database indexes (see §5.4 — accept a dataset-scoped scan for v1).

## 3. Decisions (resolved during design)

| Decision | Choice |
|---|---|
| Scope of iteration 1 | Core scale fix (sort/filter/paginate server-side; lazy per-page property values) |
| `Select All` / `Delete Unselected` | **Matching-IDs endpoint** — fetch all matching IDs, populate selection, run existing batch ops |
| Pagination model | **Page numbers + total** now; migrate to infinite scroll later |
| Backend query | **Annotation-driven single aggregation** (Approach 1); bidirectional optimization deferred |
| Mode switch | **Dual-mode**, mirroring the existing stub under/over-threshold pattern |
| ROI server-side | Deferred |

## 4. Architecture — dual-mode list

Mirrors the existing stub system (`needsStubSystem` activates only when over budget), so small datasets keep today's exact behavior and risk is contained to the large-dataset path.

- **Below threshold** (≤ the list guard, currently 20,000 matching): today's **client-side** list — all filters incl. ROI, client sort, property values loaded for that bounded set. Unchanged.
- **Above threshold:** **server-driven** list. It sends `{datasetId, filters, sort, page, pageSize, propertyPaths}` and renders the returned page. `propertyValues` is **not** bulk-loaded; each row carries only its displayed-column values.

The canvas is **unaffected** — it keeps using stubs + viewport hydration. The list becomes an independent server-driven view. Selection (`selectedAnnotationIds`) remains shared between canvas and list.

## 5. Backend design

New routes on the existing `Annotation` resource (`server/api/annotation.py`), following the established orjson-streamed, `@access.public` + dataset `READ` pattern used by `find`/`stubs`.

### 5.1 `POST /upenn_annotation/list`

POST (not GET) so many property paths / filter values don't hit URL length limits — matches the CSV export precedent.

**Request body:**
```jsonc
{
  "datasetId": "ObjectId",
  "filters": {
    "shape": "polygon",                       // optional
    "tags": { "values": ["DAPI"], "exclusive": false },  // inclusive=$in (has any); exclusive=$all+$size (exactly that set) — matches tagCloudFilterFunction (NOT find's $all superset)
    "location": { "XY": 0, "Z": 0, "Time": 0 },          // optional (onlyCurrentFrame)
    "idSubstring": "abc",                     // optional
    "propertyFilters": [                      // optional
      { "path": ["propId", "sub"], "mode": "range", "min": 0, "max": 10 },
      { "path": ["propId2"], "mode": "values", "values": [1, 2, 3] }
    ],
    "idConstraints": [ ["id1","id2"], ["id2","id3"] ]    // optional; _id must be in EVERY set (AND of $in). Frontend builds these from the selection filter + annotation-id filters.
  },
  "sort": { "type": "property", "key": ["propId", "sub"], "order": "asc" },
  // sort.type: "property" (key = path array) | "field" (key = "location.XY" | "name" | "channel" | "_id")
  "propertyPaths": [ ["propId", "sub"] ],     // columns whose values to return per row
  "offset": 0,
  "limit": 50
}
```

**Response (streamed):**
```jsonc
{
  "total": 142318,
  "rows": [
    {
      "_id": "ObjectId",                         // rows carry _id (stubs-consistent); frontend toListRow maps _id -> id
      "centroid": { "x": 1.0, "y": 2.0 },
      "location": { "XY": 0, "Z": 0, "Time": 0 },
      "shape": "polygon",
      "channel": 0,
      "tags": ["DAPI"],
      "color": null,
      "values": { "propId": { "sub": 1.23 } }   // only for requested propertyPaths
    }
  ]
}
```

**Page aggregation pipeline (annotation-driven):**
1. `$match` — `datasetId` + shape + tags (inclusive `$in` / exclusive `$all`+`$size`) + location + `idSubstring` (`$regexMatch` on stringified `_id`) + `idConstraints` (`$and` of `_id $in` sets). Built by `Annotation._buildListMatchStages`.
2. `$lookup` `annotation_property_values` on `_id` ↔ `annotationId` → `pv` (needed only if there are property filters, a property sort, or requested `propertyPaths`; skip otherwise).
3. `$unwind` `{ path: "$pv", preserveNullAndEmptyArrays: true }` (1:1; null when no values doc).
4. `$match` property filters (range / values) on `pv.values.<path>` — only if present.
5. `$addFields` — `centroid` (via `$avg` of coordinates, like `stubs`); for property sort, `sortValue = $pv.values.<path>` and `hasValue = {$cond: present}`.
6. `$sort` — for property sort: `{ hasValue: -1, sortValue: order, _id: 1 }` so **missing values sort to the end regardless of direction** (matches the current client sort) and ties are stable by `_id`. For field sort: `{ <field>: order, _id: 1 }`. Default (no sort): `{ _id: 1 }`.
7. `$skip: offset`, `$limit: limit`.
8. `$project` — stub fields + centroid + `values` reduced to the requested `propertyPaths`. Always exclude `coordinates`.

**Count:** a parallel pipeline mirroring stages 1–4 (the lookup + property `$match` only when a property *filter* is active — sorting never changes the count) then `$count`. One HTTP response carries both `total` and the page.

### 5.2 `POST /upenn_annotation/list/ids`

Same `filters` block; returns all matching IDs (no values, no coordinates) for `Select All` / `Delete Unselected`.

```jsonc
// request: { "datasetId": "...", "filters": { ... } }
// response (streamed): { "ids": ["ObjectId", ...], "total": 142318 }
```

### 5.3 Access control & validation

- `@access.public`, load dataset folder with `AccessType.READ` (same as `find`/`stubs`).
- API layer converts inputs once at the top (datasetId → `ObjectId`), passes clean data to model methods (`server/models/annotation.py`); the model raises `ValueError` (invalid sort field) → mapped to `RestException(400)`; the model never raises `RestException` itself.
- **As-built:** `_validateListInputs` (API) shape-validates `propertyFilters`/`sort`/`propertyPaths`/`idConstraints` (e.g. property paths are non-empty string arrays with no `.`/`$`; `idConstraints` is a list of lists of id strings) and raises `RestException(400)` — closing the uncaught-500-on-malformed-input hole on this public endpoint.

### 5.4 Indexing / performance

- v1 accepts a **dataset-scoped** aggregation scan (one dataset's annotations + their 1:1 property-value docs — bounded, not the whole DB). Existing `(datasetId, _id)` compound indexes serve the `$match` and stable sort.
- **Perf lever (deferred):** sparse `(datasetId, "values.<propertyId>")` indexes + the bidirectional query (drive from `annotation_property_values` when sorting/filtering by a property). Because properties are created at runtime, index creation would hook property-compute completion. Add only if profiling shows property sort/filter is slow at target scale.

## 6. Frontend design

### 6.1 List component

- `AnnotationList.vue` uses Vuetify **server-items mode**: `:items` = current page rows, `:items-length` = `total`, react to `@update:options` (page / itemsPerPage / sortBy) with a **debounced** fetch and a table loading state.
- Below threshold: existing client-side path (unchanged). The mode flag aligns with the existing list guard / stub `stubOnlyMode`.

### 6.2 New store module

A focused module (e.g. `src/store/annotationListServer.ts`) owns server-mode list state (page rows, total, current sort, loading) and the fetch, keeping the already-large `annotation.ts` / `filters.ts` from growing. API calls live in `AnnotationsAPI.ts` (`fetchAnnotationListPage`, `fetchAnnotationListIds`).

### 6.3 Filter translation & ROI

- The module reads active filters from `filterStore` (tag, location/onlyCurrentFrame, property, ID-substring) and translates them to backend params.
- If an **ROI filter is active in server mode**, show an inline notice: "ROI filtering isn't available for very large datasets yet" (ROI server-side is deferred).

### 6.4 Property values & columns

- Server mode requests values only for `displayedPropertyPaths` (+ the sort property); rows carry their own `values`. `propertyStore.propertyValues` is **not** loaded in server mode (the memory win).
- The "Index" column becomes position-in-result (`offset + rowIndex`).

## 7. Selection & bulk operations

- Per-row checkbox + canvas drag-select → `selectedAnnotationIds` (unchanged).
- `Select All` / `Delete Unselected`: call `/list/ids` with the current filters, populate `selectedAnnotationIds` with the full matching set, then run the existing batch delete/tag/color endpoints. Behavior identical to today; only the source of the ID set changes.

## 8. Limitations & future work

### Performance at very large scale — measured, DEFERRED (2026-06-18)

Real-data testing on two live datasets confirmed **correctness** (HCR 26K: 16/16 checks; Xenium 708K: all functional checks pass) but revealed a **serious latency problem at 708K** that is deferred to a dedicated perf pass:

| Call (708K dataset) | Latency |
|---|---|
| `/list/ids` (708K ids) | ~1.5 s |
| page 1 — no property column, no sort | ~3.6 s |
| page 1 — field sort (location.XY) | ~3.7 s |
| page 1 — with a property column | ~13.4 s |
| property sort | ~13.9 s |
| range filter | ~21.1 s |
| deep page + property sort | ~25.0 s |

**Root cause:** the pipeline computes the centroid `$addFields`, does the property `$lookup`+`$unwind`, and `$sort`s over the **entire matched set** before `$skip`/`$limit`, so the per-row cost is paid on all 708K rows for every page. Two compounding culprits: centroid+sort over the full set (~3.6 s floor) and the lookup over the full set (+~10 s).

**Planned fix (deferred), two tiers:**
1. **Cheap, high-impact reorder:** for the default browse + field-sort case (no property sort/filter), defer the centroid `$addFields` and the `$lookup` until *after* `$skip`/`$limit` — `match → (indexed sort) → skip → limit → centroid + lookup on just the page`. Turns 3.6–13 s into ~tens of ms at any scale. Covers the most common UI interactions.
2. **Property sort/filter at scale needs an index — but indexing is non-trivial here and needs design thought (the reason this is deferred, not done now):** property values are stored **nested** (`values.<propertyId>.<subField>`) and the `<propertyId>`s **differ per dataset**, so a naive per-property compound index doesn't generalize — you'd need a wildcard index, a flattened/reshaped property-values collection, an index created at property-compute time, or the bidirectional query (drive from `annotation_property_values`). Pick a strategy deliberately later.

Decision (2026-06-18): proceed with the frontend now; do the perf pass as a follow-up. The architecture is correct; large datasets are just slow until then.

### Other deferred items

- **Pagination → infinite scroll:** iteration 1 is page numbers + total. Deep-page jumps (`$skip` at large offsets) are slow and are a common access mode, so a later iteration should move to cursor-based infinite scroll (encode sort key + `_id`). This is meaningfully more work; functional page-numbers first.
- **Server-side ROI filtering:** deferred (Mongo geo / centroid-bounds).
- **Other `propertyValues` consumers** (plots, properties panels) still load values wholesale; separate future work.

## 9. Testing plan

**Backend (pytest):**
- `/list`: each filter (shape, tags incl/excl, location, idSubstring, property range, property values), sort asc/desc on a property and on a field, **missing-value ordering** (missing always last), pagination (offset/limit + `total`), requested `propertyPaths` projection, `coordinates` excluded.
- `/list/ids`: returns exactly the matching set; matches `/list` total for the same filters.
- Access denied for a user without dataset READ; empty dataset; nonexistent dataset.

**Frontend (vitest):**
- Server-mode fetch fires on page / itemsPerPage / sortBy change (debounced) and renders returned rows + total.
- Dual-mode switch at the threshold.
- `Select All` populates selection from `/list/ids`; bulk delete/tag/color run on that set.
- Loading state on the table; ROI-active notice in server mode.

## 10. Risks

- **Deep-offset `$skip`** latency at 1M (accepted for v1; infinite-scroll follow-up).
- **`$lookup` + `$unwind`** cost without per-property indexes (mitigations in §5.4).
- **Filter-semantics drift** between client (`filteredAnnotations` getter / `tagCloudFilterFunction`) and the new server filters — backend tests must pin tag-exclusive and missing-value semantics to match the client exactly so the dual-mode switch is seamless.

---

<a id="archived-annotation-list-server-side-plan"></a>

## Archived Source: `ANNOTATION-LIST-SERVER-SIDE-PLAN.md`

# Server-Side Annotation List Implementation Plan

> **✅ IMPLEMENTED 2026-06-18** on `feature/stub-annotations`. All tasks (1–7, plus the real-data checkpoint and a follow-up `idConstraints` task) are done, two-stage-reviewed, and real-data-validated (HCR 26K 16/16, Xenium 708K functional, idConstraints 7/7). Backend: 18 `test_server_list` tests; frontend: ~70 list-related tests; tsc clean. See `ANNOTATION-LIST-SERVER-SIDE-DESIGN.md` (As-built notes) for deviations from this plan — notably rows carry `_id` (not `id`), `idConstraints` was added for selection/annotation-id filters, the refetch is debounced ~300 ms, and the perf pass is deferred. The task bodies below are kept as the historical implementation record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AnnotationList's pagination, sorting, and filtering server-side above a size threshold, loading property values only for the visible page — so large datasets no longer hold all rows or all property values in the browser.

**Architecture:** Dual-mode list mirroring the existing stub system. Below the threshold the current client-side list is unchanged; above it, a new annotation-driven MongoDB aggregation (`POST /upenn_annotation/list`) returns a page of stub-shaped rows + the requested property-column values + a total count, and `POST /upenn_annotation/list/ids` returns all matching IDs for Select All / Delete Unselected. The frontend uses Vuetify server-items mode driven by a focused new store module.

**Tech Stack:** Girder (Python) + MongoDB aggregation + orjson streaming; Vue 3 `<script setup>` + Vuetify 4 `v-data-table` server-items; Vuex (`vuex-module-decorators`); pytest/tox (backend), vitest (frontend).

**Spec:** `codebaseDocumentation/ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`.

**Key conventions to honor (from CLAUDE.md):**
- API layer parses/validates input + handles HTTP/streaming; **model layer** builds queries and runs the aggregation (raise `ValueError`/`ValidationException` in the model, `RestException` only in the API).
- Use `Model().collection.aggregate(...)` (the documented exception for aggregations).
- Convert IDs to `ObjectId` once at the top of the API method.
- Tag semantics MUST match the client `tagCloudFilterFunction` (`src/utils/annotation.ts:232`): **inclusive → `$in`** (has any), **exclusive → `$all` + `$size`** (exactly that set). This is intentionally different from the existing `find` endpoint's `$all` (superset) semantics.

**Backend dir (abbrev `B`):** `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation`
**Backend test command:** `cd devops/girder/plugins/AnnotationPlugin && tox` (runs pytest + flake8). Targeted: `tox -- upenncontrast_annotation/test/test_server_list.py -v` if posargs supported; otherwise run full `tox`.
**Frontend test command:** `pnpm exec vitest run <file>`; type check `pnpm tsc`; lint `pnpm exec eslint <files>`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `B/server/models/annotation.py` | `listIds`, `listCount`, `listPage` + private pipeline builders | Modify |
| `B/server/api/annotation.py` | `POST /list`, `POST /list/ids` routes + handlers (parse/validate/stream) | Modify |
| `B/test/test_server_list.py` | Integration tests for both endpoints | Create |
| `src/store/model.ts` | `IAnnotationListRow`, `IAnnotationListQuery`, `IAnnotationListSort` types | Modify |
| `src/store/AnnotationsAPI.ts` | `fetchAnnotationListPage`, `fetchAnnotationListIds`, `toListRow` | Modify |
| `src/store/annotationListServer.ts` | Server-mode list state + fetch (new Vuex module) | Create |
| `src/store/__tests__/annotationListServer.test.ts` | Store module tests | Create |
| `src/store/AnnotationsAPI.test.ts` (or existing) | API client tests | Create/Modify |
| `src/components/AnnotationBrowser/AnnotationList.vue` | Dual-mode: server-items binding, loading, ROI notice, selection wiring | Modify |
| `src/components/AnnotationBrowser/AnnotationList.test.ts` | Server-mode + selection tests | Modify |

Phasing: backend `/list/ids` → `/list` (field sort) → property lookup; then frontend API → store module → component wiring → selection.

---

## Task 1: Backend — `POST /upenn_annotation/list/ids` (filters → matching IDs)

Establishes the shared annotation-field match (dataset, shape, tags incl/excl, location, idSubstring).

**Files:**
- Modify: `B/server/models/annotation.py`
- Modify: `B/server/api/annotation.py`
- Test: `B/test/test_server_list.py` (create)

- [ ] **Step 1: Write the failing test**

Create `B/test/test_server_list.py`:

```python
import json
import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def makeAnnotation(datasetId, coords=None, tags=None, shape="polygon",
                   location=None):
    ann = upenn_utilities.getSampleAnnotation(datasetId)
    ann["coordinates"] = coords or [
        {"x": 0, "y": 0}, {"x": 10, "y": 0},
        {"x": 10, "y": 10}, {"x": 0, "y": 10},
    ]
    ann["shape"] = shape
    if tags is not None:
        ann["tags"] = tags
    if location is not None:
        ann["location"] = location
    return Annotation().create(ann)


def parseStreaming(resp):
    return json.loads(b"".join(resp.body))


def postList(server, user, path, body):
    return server.request(
        path=path, method="POST", user=user,
        body=json.dumps(body), type="application/json", isJson=False,
    )


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListIds:
    def testListIdsFilterByTagsInclusive(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a = makeAnnotation(folder["_id"], tags=["A"])
        b = makeAnnotation(folder["_id"], tags=["B"])
        makeAnnotation(folder["_id"], tags=["C"])

        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A", "B"], "exclusive": False}},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert set(result["ids"]) == {str(a["_id"]), str(b["_id"])}
        assert result["total"] == 2

    def testListIdsFilterByTagsExclusive(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        exact = makeAnnotation(folder["_id"], tags=["A", "B"])
        makeAnnotation(folder["_id"], tags=["A", "B", "C"])  # superset, excluded
        makeAnnotation(folder["_id"], tags=["A"])             # subset, excluded

        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A", "B"], "exclusive": True}},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["ids"] == [str(exact["_id"])]

    def testListIdsRequiresReadAccess(self, admin, user, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])
        resp = postList(server, user, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {},
        })
        assertStatus(resp, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd devops/girder/plugins/AnnotationPlugin && tox -- upenncontrast_annotation/test/test_server_list.py -v` (or full `tox`)
Expected: FAIL — route `/upenn_annotation/list/ids` returns 400/404 (not registered).

- [ ] **Step 3: Add model match-builder + `listIds`**

In `B/server/models/annotation.py`, add these methods to the `Annotation` class (after `deleteMultiple`):

```python
    def _buildListMatchStages(self, datasetId, filters):
        """Pipeline stages matching annotation-document fields.

        Tag semantics mirror the client tagCloudFilterFunction:
        inclusive -> $in (has any); exclusive -> exactly that set.
        """
        match = {"datasetId": datasetId}
        if filters.get("shape"):
            match["shape"] = filters["shape"]

        tags = filters.get("tags") or {}
        tagValues = tags.get("values") or []
        if tagValues:
            if tags.get("exclusive"):
                match["tags"] = {"$all": tagValues, "$size": len(tagValues)}
            else:
                match["tags"] = {"$in": tagValues}

        location = filters.get("location")
        if location:
            match["location.XY"] = location["XY"]
            match["location.Z"] = location["Z"]
            match["location.Time"] = location["Time"]

        stages = [{"$match": match}]

        idSubstring = filters.get("idSubstring")
        if idSubstring:
            stages.append({"$match": {"$expr": {"$regexMatch": {
                "input": {"$toString": "$_id"},
                "regex": idSubstring,
            }}}})
        return stages

    def listIds(self, datasetId, filters):
        """All annotation _ids (as strings) matching the filters."""
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append({"$project": {"_id": 1}})
        cursor = self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
        return [str(doc["_id"]) for doc in cursor]
```

- [ ] **Step 4: Register route + add API handler**

In `B/server/api/annotation.py` `__init__`, after the `hydrate` route (line ~89) add:

```python
        self.route("POST", ("list",), self.listAnnotations)
        self.route("POST", ("list", "ids"), self.listAnnotationIds)
```

Add the handler (near `hydrate`, end of class). Reuse imports already present (`ObjectId`, `Folder`, `AccessType`, `TokenScope`, `orjson`, `orJsonDefaults`, `setResponseHeader`, `memoizeBodyJson`):

```python
    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Annotation IDs matching list filters")
        .param("body", "JSON: {datasetId, filters}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    @memoizeBodyJson
    def listAnnotationIds(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        datasetId = ObjectId(body["datasetId"])
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = body.get("filters") or {}
        ids = self._annotationModel.listIds(datasetId, filters)

        def generateResult():
            chunk = [b'{"total":', str(len(ids)).encode(), b',"ids":[']
            first = True
            for sid in ids:
                if not first:
                    chunk.append(b",")
                chunk.append(orjson.dumps(sid))
                first = False
                if len(chunk) > 1000:
                    yield b"".join(chunk)
                    chunk = []
            chunk.append(b"]}")
            yield b"".join(chunk)

        setResponseHeader("Content-Type", "application/json")
        return generateResult
```

(Define `listAnnotations` as a temporary stub returning `[]` so the route registration in `__init__` doesn't reference a missing method; it is fully implemented in Task 2:

```python
    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(Description("List annotations (page)"))
    @memoizeBodyJson
    def listAnnotations(self, params, *args, **kwargs):
        return []
```
)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd devops/girder/plugins/AnnotationPlugin && tox -- upenncontrast_annotation/test/test_server_list.py -v`
Expected: 3 tests PASS. flake8 clean.

- [ ] **Step 6: Commit**

```bash
git add devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_server_list.py
git commit -m "feat(backend): annotation list/ids endpoint with client-matching tag semantics"
```

---

## Task 2: Backend — `POST /upenn_annotation/list` (page + field sort + count, no properties yet)

**Files:** Modify `B/server/models/annotation.py`, `B/server/api/annotation.py`; Test `B/test/test_server_list.py`.

- [ ] **Step 1: Write the failing tests**

Append to `test_server_list.py`:

```python
@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListPage:
    def testListPaginatesAndCounts(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for i in range(5):
            makeAnnotation(folder["_id"], location={"XY": i, "Z": 0, "Time": 0})

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "asc"},
            "propertyPaths": [],
            "offset": 0, "limit": 2,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 5
        assert len(result["rows"]) == 2
        assert result["rows"][0]["location"]["XY"] == 0
        assert result["rows"][1]["location"]["XY"] == 1
        # Stub-shaped: centroid present, coordinates absent
        assert "centroid" in result["rows"][0]
        assert "coordinates" not in result["rows"][0]

    def testListFieldSortDescending(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for i in range(3):
            makeAnnotation(folder["_id"], location={"XY": i, "Z": 0, "Time": 0})
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "desc"},
            "propertyPaths": [], "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        xys = [r["location"]["XY"] for r in result["rows"]]
        assert xys == [2, 1, 0]
```

- [ ] **Step 2: Run to verify failure**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py::TestServerListPage -v`
Expected: FAIL — `listAnnotations` returns `[]` (stub).

- [ ] **Step 3: Add `listCount` + `listPage` + centroid/sort builders to the model**

In `B/server/models/annotation.py`, add (after `listIds`). Note the centroid `$addFields` mirrors the `stubs` endpoint:

```python
    # Annotation fields allowed as a sort key (field-type sort).
    _SORTABLE_FIELDS = {"location.XY", "location.Z", "location.Time",
                        "name", "channel", "_id"}

    def _centroidAddFields(self):
        return {"$addFields": {"centroid": {
            "x": {"$avg": "$coordinates.x"},
            "y": {"$avg": "$coordinates.y"},
        }}}

    def _sortStage(self, sort):
        """$sort stage for a field-type sort (property sort added in
        a later task). Always tie-break on _id for stable paging."""
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "field":
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            if key == "_id":
                return {"$sort": {"_id": direction}}
            return {"$sort": {key: direction, "_id": 1}}
        return {"$sort": {"_id": 1}}

    def listCount(self, datasetId, filters):
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append({"$count": "n"})
        result = list(self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        ))
        return result[0]["n"] if result else 0

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append(self._centroidAddFields())
        pipeline.append(self._sortStage(sort))
        pipeline.append({"$skip": max(0, offset)})
        pipeline.append({"$limit": limit})
        pipeline.append({"$project": {"coordinates": 0}})
        return self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
```

- [ ] **Step 4: Implement the `listAnnotations` API handler**

Replace the Task-1 stub `listAnnotations` in `B/server/api/annotation.py` with:

```python
    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("List annotations (paged), stub-shaped + property values")
        .param("body", "JSON: {datasetId, filters, sort, propertyPaths, "
                       "offset, limit}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    @memoizeBodyJson
    def listAnnotations(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        datasetId = ObjectId(body["datasetId"])
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = body.get("filters") or {}
        sort = body.get("sort")
        propertyPaths = body.get("propertyPaths") or []
        offset = int(body.get("offset", 0))
        limit = int(body.get("limit", 50))

        total = self._annotationModel.listCount(datasetId, filters)
        cursor = self._annotationModel.listPage(
            datasetId, filters, sort, propertyPaths, offset, limit
        )

        def generateResult():
            chunk = [b'{"total":', str(total).encode(), b',"rows":[']
            first = True
            for row in cursor:
                if not first:
                    chunk.append(b",")
                chunk.append(orjson.dumps(row, default=orJsonDefaults))
                first = False
                if len(chunk) > 1000:
                    yield b"".join(chunk)
                    chunk = []
            chunk.append(b"]}")
            yield b"".join(chunk)

        setResponseHeader("Content-Type", "application/json")
        return generateResult
```

Note: the model raises `ValueError` for an invalid sort field; convert it at the API boundary. Wrap the `listPage` call:

```python
        try:
            cursor = self._annotationModel.listPage(
                datasetId, filters, sort, propertyPaths, offset, limit
            )
        except ValueError as e:
            raise RestException(str(e), code=400)
```

(`RestException` is already imported in this file.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py -v`
Expected: all Task 1 + Task 2 tests PASS. flake8 clean.

- [ ] **Step 6: Commit**

```bash
git add devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_server_list.py
git commit -m "feat(backend): annotation list page endpoint (field sort + count)"
```

---

## Task 3: Backend — property lookup (sort-by-property, property filters, return values)

**Files:** Modify `B/server/models/annotation.py`; Test `B/test/test_server_list.py`.

- [ ] **Step 1: Write the failing tests**

Append to `test_server_list.py`:

```python
@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListProperties:
    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        anns = []
        # values 30, 10, 20 for prop "p"/"Area"; a 4th with no value
        for val in (30, 10, 20):
            a = makeAnnotation(folder["_id"])
            pv.appendValues({"p": {"Area": val}}, a["_id"], folder["_id"])
            anns.append(a)
        noval = makeAnnotation(folder["_id"])
        return folder, anns, noval

    def testSortByPropertyAscMissingLast(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"], "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        vals = [r["values"]["p"]["Area"] for r in result["rows"][:3]]
        assert vals == [10, 20, 30]
        # Annotation with no value sorts to the end regardless of direction.
        # Its projected `values` has no Area (the $ifNull/$$REMOVE drops the
        # leaf; the `p` wrapper may remain as {}).
        last = result["rows"][-1]
        assert last["id"] == str(noval["_id"])
        assert "Area" not in last.get("values", {}).get("p", {})

    def testSortByPropertyDescMissingStillLast(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"], "order": "desc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        vals = [r["values"]["p"]["Area"] for r in result["rows"][:3]]
        assert vals == [30, 20, 10]
        assert result["rows"][-1]["id"] == str(noval["_id"])

    def testPropertyRangeFilterAffectsCountAndRows(self, admin, server):
        folder, anns, noval = self._setup(admin)
        body = {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range", "min": 15, "max": 100}
            ]},
            "sort": {"type": "property", "key": ["p", "Area"], "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 0, "limit": 10,
        }
        resp = postList(server, admin, "/upenn_annotation/list", body)
        result = parseStreaming(resp)
        assert result["total"] == 2  # 20 and 30
        assert [r["values"]["p"]["Area"] for r in result["rows"]] == [20, 30]

        # /list/ids must agree with the same filters
        resp2 = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]), "filters": body["filters"],
        })
        assert parseStreaming(resp2)["total"] == 2
```

- [ ] **Step 2: Run to verify failure**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py::TestServerListProperties -v`
Expected: FAIL — no property lookup; `values` absent, property sort/filter not applied.

- [ ] **Step 3: Add property lookup to the pipeline builders**

In `B/server/models/annotation.py`, add the property helpers and update `_buildListMatchStages`-consumers. Add these methods:

```python
    PROPERTY_VALUES_COLLECTION = "annotation_property_values"

    def _needsLookup(self, filters, sort, propertyPaths):
        if propertyPaths:
            return True
        if sort and sort.get("type") == "property":
            return True
        return bool(filters.get("propertyFilters"))

    def _lookupStages(self):
        return [
            {"$lookup": {
                "from": self.PROPERTY_VALUES_COLLECTION,
                "localField": "_id",
                "foreignField": "annotationId",
                "as": "_pv",
            }},
            {"$unwind": {
                "path": "$_pv", "preserveNullAndEmptyArrays": True,
            }},
        ]

    def _propertyFilterStages(self, filters):
        stages = []
        for pf in filters.get("propertyFilters") or []:
            valueKey = "_pv.values." + ".".join(pf["path"])
            if pf.get("mode") == "values":
                values = pf.get("values") or []
                if values:
                    stages.append({"$match": {valueKey: {"$in": values}}})
            else:  # range
                cond = {}
                if pf.get("min") is not None:
                    cond["$gte"] = pf["min"]
                if pf.get("max") is not None:
                    cond["$lte"] = pf["max"]
                if cond:
                    stages.append({"$match": {valueKey: cond}})
        return stages

    def _projectStage(self, propertyPaths):
        """Project stub fields + only requested property values; drop
        coordinates and the lookup scratch field."""
        project = {"coordinates": 0, "_pv": 0, "_sortValue": 0,
                   "_hasSortValue": 0}
        if propertyPaths:
            # Re-add a trimmed `values` object holding only requested paths.
            valuesExpr = {}
            for path in propertyPaths:
                # Build nested {p:{Area: "$_pv.values.p.Area"}}
                ref = "$_pv.values." + ".".join(path)
                node = valuesExpr
                for key in path[:-1]:
                    node = node.setdefault(key, {})
                node[path[-1]] = {"$ifNull": [ref, "$$REMOVE"]}
            return [
                {"$addFields": {"values": valuesExpr}},
                {"$project": project},
            ]
        return [{"$project": project}]
```

Replace `_sortStage` to support property sort with missing-to-end, and add a property `$addFields` for the sort value. Update `_sortStage`:

```python
    def _sortStage(self, sort):
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "property":
            # _hasSortValue desc puts present-values first (so missing
            # always lands last regardless of direction).
            return {"$sort": {
                "_hasSortValue": -1, "_sortValue": direction, "_id": 1,
            }}
        if sort and sort.get("type") == "field":
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            if key == "_id":
                return {"$sort": {"_id": direction}}
            return {"$sort": {key: direction, "_id": 1}}
        return {"$sort": {"_id": 1}}

    def _propertySortAddFields(self, sort):
        if sort and sort.get("type") == "property":
            ref = "$_pv.values." + ".".join(sort["key"])
            return [{"$addFields": {
                "_sortValue": ref,
                "_hasSortValue": {"$cond": [
                    {"$ne": [{"$ifNull": [ref, None]}, None]}, 1, 0,
                ]},
            }}]
        return []
```

Rewrite `listCount`, `listPage`, and `listIds` to compose the lookup + property stages:

```python
    def _composePipeline(self, datasetId, filters, sort, propertyPaths,
                         include_sort, include_project):
        pipeline = self._buildListMatchStages(datasetId, filters)
        if self._needsLookup(filters, sort, propertyPaths):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
        if include_sort:
            pipeline += self._propertySortAddFields(sort)
            pipeline.append(self._centroidAddFields())
            pipeline.append(self._sortStage(sort))
        return pipeline

    def listCount(self, datasetId, filters):
        # Count only needs lookup when a property FILTER is active
        # (sorting never changes the count).
        pipeline = self._buildListMatchStages(datasetId, filters)
        if filters.get("propertyFilters"):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
        pipeline.append({"$count": "n"})
        result = list(self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        ))
        return result[0]["n"] if result else 0

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        pipeline = self._composePipeline(
            datasetId, filters, sort, propertyPaths,
            include_sort=True, include_project=False,
        )
        pipeline.append({"$skip": max(0, offset)})
        pipeline.append({"$limit": limit})
        pipeline += self._projectStage(propertyPaths)
        return self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )

    def listIds(self, datasetId, filters):
        pipeline = self._composePipeline(
            datasetId, filters, None, [],
            include_sort=False, include_project=False,
        )
        pipeline.append({"$project": {"_id": 1}})
        cursor = self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
        return [str(doc["_id"]) for doc in cursor]
```

(Remove the standalone `_centroidAddFields()` + `_sortStage()` calls left in the old `listPage`/`listIds` from Task 2 — they're now inside `_composePipeline`/`listPage`. The old `listIds` from Task 1 is fully replaced here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py -v`
Expected: all `TestServerListIds`, `TestServerListPage`, `TestServerListProperties` PASS. flake8 clean.

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd devops/girder/plugins/AnnotationPlugin && tox`
Expected: all tests PASS, flake8 clean.

- [ ] **Step 6: Commit**

```bash
git add devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_server_list.py
git commit -m "feat(backend): property lookup for list (sort, filter, projected values)"
```

---

## Task 3.5: Backend real-data verification (CHECKPOINT — requires user input)

The pytest/tox tests above use synthetic data. Before building the frontend on these endpoints, validate them against **real datasets and database objects** on the running local backend.

**STOP and ask the user** to point to: (a) a real `datasetId` (ideally a large one, > the 20k guard), (b) a known property path + expected sort order or value range, and (c) known tag/location facts — so results can be checked against ground truth.

- [ ] **Step 1: Ask the user for real objects** (dataset ID, a property path, expected facts to assert against).

- [ ] **Step 2: Exercise the endpoints against the running local Girder.**

Use the `nimbusimage` low-level client (preferred over raw curl — see CLAUDE.md "NimbusImage Python API" + the `nimbus-local-ops` skill). Example:

```python
import os
from dotenv import load_dotenv
from nimbusimage._girder import create_client
load_dotenv()
gc = create_client(
    api_url=os.environ["GIRDER_API_URL"],
    username=os.environ["GIRDER_USERNAME"],
    password=os.environ["GIRDER_PASSWORD"],
)
DATASET_ID = "<<user-provided>>"

# Page 1, sort by a real property, descending
page = gc.post("/upenn_annotation/list", json={
    "datasetId": DATASET_ID,
    "filters": {},
    "sort": {"type": "property", "key": ["<<propId>>", "<<sub>>"],
             "order": "desc"},
    "propertyPaths": [["<<propId>>", "<<sub>>"]],
    "offset": 0, "limit": 50,
})
print(page["total"], len(page["rows"]), page["rows"][0]["values"])

ids = gc.post("/upenn_annotation/list/ids", json={
    "datasetId": DATASET_ID, "filters": {},
})
assert ids["total"] == page["total"]  # ids count must equal page total
```

- [ ] **Step 3: Validate against ground truth** (with the user's expected facts):
  - `total` matches the dataset's annotation count (and the count endpoint) for empty filters.
  - `/list/ids` total == `/list` total for identical filters.
  - Property sort order is correct on real values; missing-value rows land last.
  - A tag filter (inclusive and exclusive) returns the counts the user expects (this is the parity risk — confirm against the client's current list behavior on the same dataset).
  - A property range filter narrows `total` as expected.
  - Spot-check latency on the large dataset (note deep-offset behavior).

- [ ] **Step 4: Record findings** in the PR/commit notes; fix any discrepancies before proceeding to the frontend.

---

## Task 4: Frontend — API client methods + types

**Files:** Modify `src/store/model.ts`, `src/store/AnnotationsAPI.ts`; Test `src/store/AnnotationsAPI.test.ts` (create if absent).

- [ ] **Step 1: Add types to `src/store/model.ts`**

Near `IAnnotationStub` (line ~1391):

```typescript
export interface IAnnotationListSort {
  type: "field" | "property";
  key: string | string[]; // "location.XY" | "name" | ... | ["propId","sub"]
  order: "asc" | "desc";
}

export interface IAnnotationListPropertyFilter {
  path: string[];
  mode: "range" | "values";
  min?: number;
  max?: number;
  values?: number[];
}

export interface IAnnotationListFilters {
  shape?: string;
  tags?: { values: string[]; exclusive: boolean };
  location?: IAnnotationLocation;
  idSubstring?: string;
  propertyFilters?: IAnnotationListPropertyFilter[];
}

export interface IAnnotationListQuery {
  datasetId: string;
  filters: IAnnotationListFilters;
  sort: IAnnotationListSort | null;
  propertyPaths: string[][];
  offset: number;
  limit: number;
}

// A server list row: stub fields + the requested property values.
export interface IAnnotationListRow extends IAnnotationStub {
  values: IAnnotationPropertyValues[string]; // {[propId]: value | nested}
}

export interface IAnnotationListPage {
  total: number;
  rows: IAnnotationListRow[];
}
```

- [ ] **Step 2: Write the failing API-client test**

Create `src/store/AnnotationsAPI.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import AnnotationsAPI from "./AnnotationsAPI";

function makeApi(postImpl: any) {
  const client = { post: vi.fn(postImpl) } as any;
  return { api: new AnnotationsAPI(client), client };
}

describe("AnnotationsAPI.fetchAnnotationListPage", () => {
  it("posts the query and maps rows to stub-shaped objects", async () => {
    const { api, client } = makeApi(async () => ({
      data: {
        total: 1,
        rows: [{
          _id: "a1", tags: ["X"], shape: "polygon", channel: 0,
          location: { XY: 0, Z: 0, Time: 0 }, color: null,
          centroid: { x: 1, y: 2 }, values: { p: { Area: 9 } },
        }],
      },
    }));
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds", filters: {}, sort: null,
      propertyPaths: [["p", "Area"]], offset: 0, limit: 50,
    });
    expect(client.post).toHaveBeenCalledWith(
      "upenn_annotation/list", expect.objectContaining({ datasetId: "ds" }),
    );
    expect(page.total).toBe(1);
    expect(page.rows[0].id).toBe("a1");
    expect(page.rows[0].values.p.Area).toBe(9);
  });
});

describe("AnnotationsAPI.fetchAnnotationListIds", () => {
  it("returns the id array", async () => {
    const { api } = makeApi(async () => ({
      data: { total: 2, ids: ["a", "b"] },
    }));
    const ids = await api.fetchAnnotationListIds("ds", {});
    expect(ids).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2b: Run to verify failure**

Run: `pnpm exec vitest run src/store/AnnotationsAPI.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the methods**

In `src/store/AnnotationsAPI.ts` add imports for the new types and add methods (after `getAnnotationStubs`). Reuse the existing `markRaw` import:

```typescript
  toListRow = (item: any): IAnnotationListRow => {
    const stub = this.toStub(item);
    return markRaw({ ...stub, values: item.values || {} });
  };

  async fetchAnnotationListPage(
    query: IAnnotationListQuery,
  ): Promise<IAnnotationListPage> {
    const response = await this.client.post("upenn_annotation/list", query);
    return {
      total: response.data.total,
      rows: (response.data.rows as any[]).map(this.toListRow),
    };
  }

  async fetchAnnotationListIds(
    datasetId: string,
    filters: IAnnotationListFilters,
  ): Promise<string[]> {
    const response = await this.client.post("upenn_annotation/list/ids", {
      datasetId,
      filters,
    });
    return response.data.ids as string[];
  }
```

Add to the import block at the top of `AnnotationsAPI.ts`:
```typescript
import {
  // ...existing...
  IAnnotationListQuery,
  IAnnotationListPage,
  IAnnotationListRow,
  IAnnotationListFilters,
} from "./model";
```

- [ ] **Step 4: Run tests + tsc**

Run: `pnpm exec vitest run src/store/AnnotationsAPI.test.ts && pnpm tsc`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/model.ts src/store/AnnotationsAPI.ts src/store/AnnotationsAPI.test.ts
git commit -m "feat(frontend): annotation list API client methods + types"
```

---

## Task 5: Frontend — `annotationListServer` Vuex module

Owns server-mode list state and the fetch (reads filters from `filterStore`, displayed columns from `propertyStore`). Keeps `annotation.ts`/`filters.ts` from growing.

**Files:** Create `src/store/annotationListServer.ts`, `src/store/__tests__/annotationListServer.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/store/__tests__/annotationListServer.test.ts`. Mirror the plain-Vuex test approach used in `annotationStubs.test.ts` (don't import the real module's dependencies). Test the **filter-translation** pure helper and the page-state reducer, which are the logic worth pinning:

```typescript
import { describe, it, expect } from "vitest";
import { buildListFilters } from "../annotationListServer";

describe("buildListFilters", () => {
  it("translates an enabled tag filter (inclusive)", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: true, exclusive: false, tags: ["A", "B"] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
    });
    expect(filters.tags).toEqual({ values: ["A", "B"], exclusive: false });
    expect(filters.location).toBeUndefined();
  });

  it("includes location when onlyCurrentFrame is set", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: true,
      currentFrame: { XY: 2, Z: 1, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
    });
    expect(filters.location).toEqual({ XY: 2, Z: 1, Time: 0 });
  });

  it("translates a property range filter", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "abc",
      propertyFilters: [
        { propertyPath: ["p", "Area"], valuesOrRange: "range",
          range: { min: 1, max: 5 }, values: [] },
      ],
    });
    expect(filters.idSubstring).toBe("abc");
    expect(filters.propertyFilters).toEqual([
      { path: ["p", "Area"], mode: "range", min: 1, max: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/store/__tests__/annotationListServer.test.ts`
Expected: FAIL — `buildListFilters` not exported.

- [ ] **Step 3: Implement the module + pure helper**

Create `src/store/annotationListServer.ts`:

```typescript
import {
  getModule, Action, Module, Mutation, VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import { markRaw } from "vue";

import main from "./index";
import filters from "./filters";
import properties from "./properties";
import {
  IAnnotationListRow, IAnnotationListSort, IAnnotationListFilters,
  ITagAnnotationFilter, IPropertyAnnotationFilter, IAnnotationLocation,
} from "./model";

// Pure: translate the client filter store into backend list filters.
export function buildListFilters(input: {
  tagFilter: ITagAnnotationFilter;
  onlyCurrentFrame: boolean;
  currentFrame: IAnnotationLocation;
  idSubstring: string;
  propertyFilters: IPropertyAnnotationFilter[];
}): IAnnotationListFilters {
  const out: IAnnotationListFilters = {};
  if (input.tagFilter.enabled && input.tagFilter.tags.length > 0) {
    out.tags = {
      values: input.tagFilter.tags,
      exclusive: input.tagFilter.exclusive,
    };
  }
  if (input.onlyCurrentFrame) {
    out.location = { ...input.currentFrame };
  }
  if (input.idSubstring) {
    out.idSubstring = input.idSubstring;
  }
  const pfs = input.propertyFilters
    .filter((f) => f.enabled)
    .map((f) =>
      f.valuesOrRange === "values"
        ? { path: f.propertyPath, mode: "values" as const, values: f.values }
        : {
            path: f.propertyPath, mode: "range" as const,
            min: f.range.min, max: f.range.max,
          },
    );
  if (pfs.length > 0) {
    out.propertyFilters = pfs;
  }
  return out;
}

@Module({ dynamic: true, store, name: "annotationListServer" })
export class AnnotationListServer extends VuexModule {
  rows: IAnnotationListRow[] = markRaw([]);
  total = 0;
  loading = false;
  page = 1; // 1-based (Vuetify)
  pageSize = 50;
  sort: IAnnotationListSort | null = null;
  idSubstring = "";

  @Mutation
  setPageResult(payload: { rows: IAnnotationListRow[]; total: number }) {
    this.rows = markRaw(payload.rows);
    this.total = payload.total;
  }

  @Mutation
  setLoading(value: boolean) {
    this.loading = value;
  }

  @Mutation
  setOptions(payload: {
    page?: number; pageSize?: number; sort?: IAnnotationListSort | null;
  }) {
    if (payload.page !== undefined) this.page = payload.page;
    if (payload.pageSize !== undefined) this.pageSize = payload.pageSize;
    if (payload.sort !== undefined) this.sort = payload.sort;
  }

  @Mutation
  setIdSubstring(value: string) {
    this.idSubstring = value;
  }

  get currentFilters(): IAnnotationListFilters {
    return buildListFilters({
      tagFilter: filters.tagFilter,
      onlyCurrentFrame: filters.onlyCurrentFrame,
      currentFrame: { XY: main.xy, Z: main.z, Time: main.time },
      idSubstring: this.idSubstring,
      propertyFilters: filters.propertyFilters,
    });
  }

  @Action
  async fetchPage() {
    const datasetId = main.dataset?.id;
    if (!datasetId) return;
    this.setLoading(true);
    try {
      const page = await main.annotationsAPI.fetchAnnotationListPage({
        datasetId,
        filters: this.currentFilters,
        sort: this.sort,
        propertyPaths: properties.displayedPropertyPaths,
        offset: (this.page - 1) * this.pageSize,
        limit: this.pageSize,
      });
      this.setPageResult(page);
    } finally {
      this.setLoading(false);
    }
  }

  @Action
  async fetchMatchingIds(): Promise<string[]> {
    const datasetId = main.dataset?.id;
    if (!datasetId) return [];
    return main.annotationsAPI.fetchAnnotationListIds(
      datasetId, this.currentFilters,
    );
  }
}

export default getModule(AnnotationListServer);

if (import.meta.hot) {
  import.meta.hot.accept();
}
```

Note: confirm `main.annotationsAPI` is the correct accessor (same one `annotation.ts` uses — it reads `this.annotationsAPI = main.annotationsAPI`). If the property differs, match the existing accessor in `annotation.ts`.

- [ ] **Step 4: Run tests + tsc**

Run: `pnpm exec vitest run src/store/__tests__/annotationListServer.test.ts && pnpm tsc`
Expected: 3 tests PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/annotationListServer.ts src/store/__tests__/annotationListServer.test.ts
git commit -m "feat(frontend): annotationListServer store module + filter translation"
```

---

## Task 6: Frontend — wire `AnnotationList.vue` to server mode (dual-mode)

**Files:** Modify `src/components/AnnotationBrowser/AnnotationList.vue`, `src/components/AnnotationBrowser/AnnotationList.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `AnnotationList.test.ts`. Add a mock for the new module near the other `vi.mock` blocks:

```typescript
const mockFetchPage = vi.fn();
vi.mock("@/store/annotationListServer", () => {
  const state = {
    rows: [], total: 0, loading: false, page: 1, pageSize: 50, sort: null,
    setOptions: vi.fn(),
    fetchPage: (...a: any[]) => mockFetchPage(...a),
    fetchMatchingIds: vi.fn(async () => []),
    setIdSubstring: vi.fn(),
  };
  return { default: state };
});
```

Add a test (inside the main describe):

```typescript
describe("server mode", () => {
  it("uses server rows + total and fetches on mount when stubOnlyMode", () => {
    (annotationStore as any).stubOnlyMode = true;
    const serverStore = (await import("@/store/annotationListServer")).default as any;
    serverStore.rows = [{
      id: "s1", tags: [], shape: "point", channel: 0,
      location: { XY: 0, Z: 0, Time: 0 }, color: null,
      centroid: { x: 0, y: 0 }, values: {},
    }];
    serverStore.total = 1234;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isServerMode).toBe(true);
    expect(vm.serverItemsLength).toBe(1234);
    expect(mockFetchPage).toHaveBeenCalled();
  });
});
```

(Set `(annotationStore as any).stubOnlyMode = false;` in the `beforeEach` reset block so other tests stay in client mode. Make the test function `async` to use the dynamic import, or import the mocked module at top instead.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts`
Expected: FAIL — `isServerMode` / `serverItemsLength` undefined.

- [ ] **Step 3: Implement dual-mode in the component**

In `AnnotationList.vue` `<script setup>`:

```typescript
import annotationListServer from "@/store/annotationListServer";
import { watch, onMounted } from "vue"; // merge with existing vue imports

const isServerMode = computed(() => annotationStore.stubOnlyMode);
const serverRows = computed(() => annotationListServer.rows);
const serverItemsLength = computed(() => annotationListServer.total);
const serverLoading = computed(() => annotationListServer.loading);

// ROI filters can't run server-side yet.
const roiActiveInServerMode = computed(
  () => isServerMode.value && filterStore.roiFilters.some((f) => f.enabled),
);

function onServerOptions(opts: {
  page: number;
  itemsPerPage: number;
  sortBy: { key: string; order: "asc" | "desc" }[];
}) {
  const sortEntry = opts.sortBy[0];
  annotationListServer.setOptions({
    page: opts.page,
    pageSize: opts.itemsPerPage,
    sort: sortEntry ? mapSort(sortEntry) : null,
  });
  annotationListServer.fetchPage();
}

// Map a Vuetify sort key to the backend sort descriptor.
function mapSort(entry: { key: string; order: "asc" | "desc" }): IAnnotationListSort {
  if (entry.key.startsWith("properties.")) {
    return {
      type: "property",
      key: entry.key.slice("properties.".length).split("."),
      order: entry.order,
    };
  }
  // strip the "annotation." prefix the columns use
  const fieldKey = entry.key.replace(/^annotation\./, "");
  return { type: "field", key: fieldKey, order: entry.order };
}

// Keep the server idSubstring in sync with the existing localIdFilter box.
watch(localIdFilter, (v) => {
  if (isServerMode.value) {
    annotationListServer.setIdSubstring(v?.trim() || "");
    annotationListServer.setOptions({ page: 1 });
    annotationListServer.fetchPage();
  }
});

// Re-fetch when filters/frame/displayed columns change in server mode.
watch(
  () => [
    filterStore.tagFilter, filterStore.propertyFilters,
    filterStore.onlyCurrentFrame, propertyStore.displayedPropertyPaths,
    store.xy, store.z, store.time,
  ],
  () => {
    if (isServerMode.value) {
      annotationListServer.setOptions({ page: 1 });
      annotationListServer.fetchPage();
    }
  },
  { deep: true },
);

onMounted(() => {
  if (isServerMode.value) annotationListServer.fetchPage();
});
```

Add `IAnnotationListSort` to the `@/store/model` import. Expose the new computeds/functions in `defineExpose` (`isServerMode`, `serverItemsLength`, `serverRows`, `serverLoading`, `roiActiveInServerMode`, `onServerOptions`, `mapSort`).

In the template, replace the single `<v-data-table>` block with a mode switch. Keep the existing client table as the `v-else`; add the server table + ROI notice:

```html
<v-alert
  v-if="roiActiveInServerMode"
  type="info" density="compact" variant="tonal" class="mb-2"
>
  ROI filtering isn't available for very large datasets yet — it's ignored
  in this list. Other filters still apply.
</v-alert>

<v-data-table-server
  v-if="isServerMode"
  :items="serverRowItems"
  :items-length="serverItemsLength"
  :loading="serverLoading"
  :headers="headers"
  :items-per-page="annotationListServer.pageSize"
  :items-per-page-options="[10, 50, 200]"
  show-select
  density="compact"
  item-value="annotation.id"
  v-model="selectedIds"
  @update:options="onServerOptions"
  class="compact-table"
>
  <!-- Copy the existing client table's header.data-table-select,
       header.${header.key}, and item slots VERBATIM into here. No edits
       needed: serverRowItems produces the identical item shape
       ({annotation, index, shapeName, isSelected, properties}), and
       item.index is already (offset + rowIndex) from serverRowItems, so the
       Index column cell renders correctly without change. -->
</v-data-table-server>
```

Add a `serverRowItems` computed that adapts server rows to the existing item shape (so the row slot markup is shared):

```typescript
const serverRowItems = computed(() =>
  serverRows.value.map((row, i) => ({
    annotation: row, // stub-shaped: has id/tags/shape/location/centroid
    index:
      (annotationListServer.page - 1) * annotationListServer.pageSize + i,
    shapeName: AnnotationNames[row.shape],
    isSelected: annotationStore.isAnnotationSelected(row.id),
    properties: row.values || {},
  })),
);
```

Keep `tooManyToList` (Task A guard) active **only in client mode** — when `isServerMode` is true the server handles scale, so guard the existing block with `v-if="!isServerMode && tooManyToList"` and gate the client `<v-data-table>` with `v-if="!isServerMode && !tooManyToList"`.

- [ ] **Step 4: Run tests + tsc + lint**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts && pnpm tsc && pnpm exec eslint src/components/AnnotationBrowser/AnnotationList.vue`
Expected: PASS, 0 type errors, 0 new lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/AnnotationBrowser/AnnotationList.vue src/components/AnnotationBrowser/AnnotationList.test.ts
git commit -m "feat(frontend): dual-mode AnnotationList with server-items rendering"
```

---

## Task 7: Frontend — Select All / Delete Unselected via matching-IDs in server mode

**Files:** Modify `src/components/AnnotationBrowser/AnnotationList.vue`, `AnnotationList.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `AnnotationList.test.ts`:

```typescript
describe("server-mode select all", () => {
  it("populates selection from fetchMatchingIds", async () => {
    (annotationStore as any).stubOnlyMode = true;
    const serverStore =
      (await import("@/store/annotationListServer")).default as any;
    serverStore.fetchMatchingIds = vi.fn(async () => ["a", "b", "c"]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.selectAllCallback();
    expect(mockSetSelected).toHaveBeenCalledWith(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts -t "server-mode select all"`
Expected: FAIL — `selectAllCallback` selects from `filteredItems`, not the server IDs.

- [ ] **Step 3: Implement**

In `AnnotationList.vue`, make `selectAllCallback` async and branch on mode:

```typescript
async function selectAllCallback() {
  if (selectAllValue.value) {
    selectedIds.value = [];
    return;
  }
  if (isServerMode.value) {
    selectedIds.value = await annotationListServer.fetchMatchingIds();
  } else {
    selectedIds.value = filteredItems.value.map((item) => item.annotation.id);
  }
}
```

Update `deleteUnselected` for server mode (fetch all matching IDs, subtract the explicit selection, delete the remainder). Add an action on the annotation store or compute inline:

```typescript
async function deleteUnselected() {
  if (isServerMode.value) {
    const all = await annotationListServer.fetchMatchingIds();
    const selected = new Set(annotationStore.selectedAnnotationIds);
    const toDelete = all.filter((id) => !selected.has(id));
    await annotationStore.deleteAnnotations(toDelete); // existing batch action
    return;
  }
  annotationStore.deleteUnselectedAnnotations();
}
```

Confirm the exact batch-delete action name in `annotation.ts` (`deleteAnnotations` vs `deleteMultipleAnnotations`); use whichever the store exposes for "delete this list of ids". `selectAllValue`/`selectAllIndeterminate` should use `serverItemsLength` in server mode — update them:

```typescript
const selectAllValue = computed(() => {
  if (isServerMode.value) {
    return serverItemsLength.value > 0 &&
      annotationStore.selectedAnnotationIds.size === serverItemsLength.value;
  }
  return selectedItems.value.length === filteredItems.value.length;
});
```

- [ ] **Step 4: Run tests + tsc + lint**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts && pnpm tsc`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Run the full frontend suite (no regressions)**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/AnnotationBrowser/AnnotationList.vue src/components/AnnotationBrowser/AnnotationList.test.ts
git commit -m "feat(frontend): server-mode Select All / Delete Unselected via matching-ids"
```

---

## Final verification

- [ ] Backend: `cd devops/girder/plugins/AnnotationPlugin && tox` — all green, flake8 clean.
- [ ] Frontend: `pnpm tsc && pnpm test && pnpm exec eslint src/store/annotationListServer.ts src/store/AnnotationsAPI.ts src/components/AnnotationBrowser/AnnotationList.vue` — green, no new errors.
- [ ] Manual (real app, large dataset > guard): list paginates, sorts by a property column (missing values last), property/tag/location filters narrow results + total, ROI filter shows the notice, Select All → Delete works, switching to a small dataset still uses the client list unchanged.
- [ ] Update `ANNOTATION-STUBS.md`: mark Option B implemented; restate the deferred items (infinite scroll, server-side ROI, per-property indexes, other propertyValues consumers).

---

## Notes & risks (carried from the spec)

- **Deep-offset `$skip`** is slow at very large offsets — acceptable for v1; infinite-scroll is the planned follow-up.
- **No per-property index** — `$lookup`+`$unwind` over a dataset's property values is the cost; add sparse `(datasetId, "values.<propertyId>")` indexes + bidirectional query only if profiling demands it.
- **Tag-semantics parity** is pinned by `testListIdsFilterByTags*` — keep these green; they're what makes the dual-mode switch seamless.
- **`v-data-table-server`** is the Vuetify 4 server component; confirm it's available in the project's Vuetify version. If the team prefers, the existing `v-data-table` can be driven in server mode via `:items-length` + `@update:options` instead — adjust Task 6 accordingly.

---

<a id="archived-annotation-list-server-side-review"></a>

## Archived Source: `ANNOTATION-LIST-SERVER-SIDE-REVIEW.md`

# Server-Side Annotation List — Code Review Notes (2026-06-18)

Holistic review of this session's work (Option A coordinate fixes + Option B server-side list), scoped to `git diff 9ff4f782..HEAD` on `feature/stub-annotations`. Each task was already two-stage-reviewed during implementation; this is the cross-cutting pass.

**Related docs:** `ANNOTATION-LIST-SERVER-SIDE-DESIGN.md` (spec + as-built notes), `ANNOTATION-LIST-SERVER-SIDE-PLAN.md` (task plan), `ANNOTATION-STUBS.md` (stub architecture / Option B status).

## Verdict
Quality is high: API/model layer separation intact (model raises `ValueError`, never `RestException`), no looped DB queries, no raw PyMongo (`.aggregate` only), access control correct (READ check + 403 test), tag/missing-sort/property-path semantics match the client and are tested, and the server-mode decoupling from `filterStore.filteredAnnotations` is well-guarded and proven by a throwing-getter test. The pass found **one High bug** (tag/color/name edits silently no-op in server mode) and a few Medium robustness gaps.

**Recommended to fix now:** #1 (High), #2 (Medium).
**Follow-ups (defer OK):** #3 (sequence token), #4 (row-component extraction), and the documented perf pass (spec §8).
**Cheap cleanups:** #5–#11.

> **Note:** `file:line` references are as of 2026-06-18 and will drift — search by symbol. Verify each root cause against current code before fixing (per memory: review notes are point-in-time).

## Resolution (2026-06-18) — ALL findings #1–#11 fixed (TDD)

All eleven findings are resolved on `feature/stub-annotations`. The deferred perf pass (spec §8) and the other documented-deferred items below remain out of scope. Commits:

| Commit | Findings |
|---|---|
| `05ad5cad` fix(backend): harden server-side annotation list | #2, #5, #6, #7, #10 |
| `ffaa3b56` fix(frontend): tag/color/name edits in server mode | #1 (High) |
| `f29518a2` fix(frontend): index unsortable + list-guard comment | #8, #9 |
| `92fbbd88` fix(frontend): fetchPage stale-response guard | #3 |
| `05e5f68e` refactor(frontend): extract AnnotationListRow | #4 |

Per-finding notes:
- **#1** — `updateAnnotationsPerId` is now stub-aware: in `stubOnlyMode` it builds patches from stubs via the new pure `buildStubUpdates` helper, persists them with the batch endpoint, and patches tags/color back onto local stubs (`applyStubFieldUpdates`). The Tag/Color/Name handlers refresh the server list afterward. `name` is threaded through the server rows so renames are visible.
- **#2 / #7 / #10** — `_validateListInputs` now rejects invalid-ObjectId `idConstraints`, non-string `idSubstring`, and non-list `values` / non-numeric range bounds with `RestException(400)` (was uncaught 500). `idSubstring` is `re.escape()`d in the model → literal substring match matching the client's `String.includes` (this also closes the **#11** alignment note — no separate change needed).
- **#3** — `fetchPage` captures a monotonic `requestSeq` and drops out-of-order responses.
- **#4** — row `<tr>` extracted to `AnnotationListRow.vue`, used by both tables (single source of truth). The two `<v-data-table>` / `<v-data-table-server>` elements and their header slots remain (Vuetify can't switch component type reactively; the header slots are small and low-divergence-risk — left as-is).
- **#5** — the page cursor is built before the count, so an invalid sort field 400s without paying for a full count aggregation.
- **#6** — the orjson streaming generator is now the shared `_streamJsonArray` helper across find/stubs/hydrate/list/list-ids.
- **#8 / #9** — `index` is non-sortable server-side (header + `mapSort`); the `LIST_ITEM_LIMIT` comment now documents it as a defensive net superseded by `stubOnlyMode`.

Tests: backend `test_server_list.py` (malformed inputs → 400 on both endpoints, idSubstring escaping, invalid-sort-skips-count); frontend `buildStubUpdates`, `AnnotationListRow`, `annotationListServerFetch` (stale guard), and server-mode handler/sort tests. Full suites green (backend 227, frontend 2219); `tsc` + targeted `eslint` clean.

---

## Findings

### Finding 1 — Tag / Color / Name edits silently no-op in server mode  ·  Severity: High  ·  Reactivity/correctness
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue` — `handleTagSubmit`, `handleColorSubmit`, `updateAnnotationName` → `src/store/annotation.ts` `updateAnnotationsPerId` (~:1185).
**Problem:** Those handlers route through `updateAnnotationsPerId`, which does `const idx = this.annotationIdToIdx[id]; if (idx === undefined) continue;`. In stub-only/server mode `annotations[]` is empty so `annotationIdToIdx` is empty → **every id is skipped, the backend is never called.** "Tag Selected" / "Color Selected" / inline name edit silently do nothing on large datasets, with no error. The spec §2 lists tag/color bulk ops as in-scope. (This was earlier mis-deferred as mere "staleness" — it's actually a silent no-op, which is worse.) Contrast: `deleteAnnotations` was made stub-aware and `deleteSelected/Unselected` got server-mode branches; the tag/color/name path was not.
**Fix options:** (a) give the handlers server-mode branches that call the existing batch tag/color endpoints by id, then `annotationListServer.fetchPage()` to refresh; or (b) if the batch-by-id mutation isn't readily available, disable the Tag/Color actions + inline name field in server mode so the no-op isn't silent (and file a follow-up). Prefer (a). Verify the actual mutation path in `annotation.ts` first (`tagSelectedAnnotations`/`colorSelectedAnnotations`/`updateAnnotationName` → `updateAnnotationsPerId`), and check whether a stub-aware update already exists (mirror `deleteAnnotations`'s `if (this.stubOnlyMode)` branch).

### Finding 2 — Invalid ObjectId in `idConstraints` → uncaught 500 on a public endpoint  ·  Severity: Medium  ·  Error Handling
**Where:** `server/api/annotation.py` — `listAnnotationIds` (~:691, no try/except) and `listAnnotations` (`listCount` at ~:734 runs *before* the `except ValueError`); validator `_validateListInputs` (~:42-53).
**Problem:** `_validateListInputs` checks `idConstraints` entries are non-empty *strings* but not ObjectId-valid. The model then calls `ObjectId(i)` in `_buildListMatchStages`. A string like `"notanobjectid"` raises `bson.errors.InvalidId` (a `ValueError` subclass) → uncaught 500 in `/list/ids` (no try), and in `/list` it fires inside `listCount` before the `except ValueError` can catch it. Contradicts the validator's stated purpose ("avoid uncaught 500s on a public endpoint").
**Fix:** Convert/validate `idConstraints` ids to `ObjectId` at the API boundary (in or right after `_validateListInputs`) and raise `RestException(400)` on `InvalidId`. Same gap applies to `idSubstring` not being `isinstance(str)`-checked (see #7) — fold both in.
**Test:** add to `test/test_server_list.py` — malformed idConstraints (`[["notanobjectid"]]`) → 400 on both `/list` and `/list/ids`.

### Finding 3 — No stale-response guard (sequence token) in `fetchPage`  ·  Severity: Medium  ·  Reactivity/correctness
**Where:** `src/store/annotationListServer.ts` `fetchPage` (~:152-172).
**Problem:** `fetchPage` unconditionally `setPageResult(page)` after the await with no request token. Debounce reduces but doesn't eliminate overlap (immediate pagination racing a trailing debounced filter fetch; or a fast page-1 returning after a slow filtered request at 708K) — an older response can overwrite a newer one.
**Fix:** monotonic `requestSeq` captured before the await; only `setPageResult` if it's still the latest. (Documented-deferred; reasonable to defer but tracked here.)

### Finding 4 — ~113 lines of identical table markup duplicated  ·  Severity: Medium  ·  Code Duplication
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue` client table (~:196-308) vs server table (~:337-449).
**Problem:** The select-header, property-header, and item `<tr>` slots are byte-identical between `<v-data-table>` and `<v-data-table-server>`. Two table elements are unavoidable (Vuetify can't switch component type reactively), but the row content could be a small `AnnotationListRow.vue` child (props `item`, `selectedColumns`, `displayedPropertyPaths`; emits hover/click/select/tag). Prevents silent divergence on future edits. Defer OK.

### Finding 5 — `listCount` runs before sort-field validation  ·  Severity: Low  ·  Performance/Redundant
**Where:** `server/api/annotation.py:~734`; model `_sortStage` (~:347).
**Problem:** An invalid sort key pays a full count aggregation (seconds at 708K) before the `ValueError`→400.
**Fix:** validate the field-sort key (fixed `_SORTABLE_FIELDS` allowlist) at the API layer before counting, or move count after the page query.

### Finding 6 — Streaming `generateResult` duplicated 4× in `annotation.py`  ·  Severity: Low  ·  Code Duplication
**Where:** `server/api/annotation.py:~693, ~742` (+ pre-existing `~587`, `~653`).
**Fix:** extract `_streamJsonArray(items, prefix, suffix, default=None)`.

### Finding 7 — `idSubstring` user regex not type-checked/escaped  ·  Severity: Low  ·  Security/Access Control
**Where:** `server/models/annotation.py:~241` (the `$regexMatch`); validator `~:42`.
**Problem:** Passed verbatim as the `$regexMatch` regex over every matched `_id` on a public endpoint; not `isinstance(str)`-checked (non-string → 500) nor escaped. ReDoS impact is bounded by the 24-hex `_id` length, so Low — but add a string-type check (fold into #2) and consider escaping (it's a substring match, not a regex feature for users).

### Finding 8 — `index` column sorts by `_id`  ·  Severity: Low  ·  Naming/correctness nuance
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue` `mapSort` (~:611-613) + index cell (~:387).
**Problem:** "Sort by index" maps to `_id` order, which only matches the displayed index in default order.
**Fix:** add `"index"` to `serverUnsortableColumns` (position isn't meaningfully sortable server-side).

### Finding 9 — `LIST_ITEM_LIMIT=20000` client guard unreachable + stale comment  ·  Severity: Nit  ·  Unnecessary Variables
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue:~687`, branch `~:311-321`, comment `~:683-686`.
**Problem:** Server mode activates at `maxVisible=10000`, so the client `tooManyToList` branch can never fire.
**Fix:** update the comment to "defensive net, superseded by `stubOnlyMode`" or remove the dead branch.

### Finding 10 — `propertyFilters` `values`/`min`/`max` not type-validated  ·  Severity: Nit  ·  Redundant Validation (missing)
**Where:** `server/api/annotation.py:~42`.
**Problem:** No injection risk (comparison operands, not operators); worst case an odd result. Noted for completeness; optional defense-in-depth.

### Finding 11 — `idSubstring` has two implementations  ·  Severity: Nit  ·  Pattern Consistency
**Where:** `AnnotationList.vue` client `includes` (~:672-681) vs server `setIdSubstring` (~:923-930).
Mutually exclusive at runtime (correct). Flagging only so substring semantics stay aligned across the boundary. Not a bug.

---

## Documented-deferred (not findings — your explicit calls)
- **Performance at 708K** (`/list` 3.6–25 s): centroid `$addFields` + property `$lookup` + `$sort` run over the full matched set before `$skip`/`$limit`; no per-property index (indexing is non-trivial — nested values, per-dataset prop ids). Spec §8 has the two-tier plan (reorder centroid/lookup after skip/limit for the common case; index/bidirectional later).
- **Server-side ROI filtering** (shows a notice), **infinite scroll** (page-numbers for now), other `propertyValues` consumers.

## Verification reference
- Backend: `cd devops/girder/plugins/AnnotationPlugin && tox` (or `tox -- upenncontrast_annotation/test/test_server_list.py -v`). flake8 runs in tox (79-char).
- Frontend: `pnpm exec vitest run <file>`, `pnpm tsc`, `pnpm exec eslint <files>`.
- **Backend changes need a girder image rebuild to hit the live API** — the plugin is baked into the image, so a plain `restart` won't load new code: `docker compose build girder && docker compose up -d girder` (~7s to come back).
- Real-data spot-check datasets (local): HCR `6a052e3704de280ec0a0309b` (26K, property id `6a33d0aa07139003543c4f2e`), Xenium `6a18de9586eb377626a51daf` (708K, property id `6a33f1d4cf32b89865b6affa`). Token: `curl -s -u admin:password http://localhost:8080/api/v1/user/authentication`. Mongo container: `nimbusimage-mongodb-1`.

---

<a id="archived-annotation-stubs-review"></a>

## Archived Source: `ANNOTATION-STUBS-REVIEW.md`

# Stub Annotation Branch Code Review

Review date: 2026-06-23

## Resolution (2026-06-23)

All six findings addressed on `feature/stub-annotations`. Each fix was
generalized to an error pattern and the whole branch audited for other
instances (none beyond those below).

- **#1 selection skips unhydrated stubs (P1) — FIXED.** `AnnotationViewer.vue`
  selection now resolves a candidate to its stub when the full annotation is
  absent (`resolveSelectionCandidate`), gating on `stub.location` and testing
  containment against `stub.centroid` (drag) or the rendered dot (`shouldSelectStub`,
  click). All four paths (spatial-index drag, fallback drag, global centroid,
  click) updated. Geometry-only handlers (`handleAnnotationEdits`) explicitly
  narrow to hydrated annotations, preserving prior behavior. `filterAnnotations`
  is now generic over `TAnnotationOrStub` (reads only tags/channel). Regression
  tests added (click + drag stub selection in `AnnotationViewer.test.ts`).
- **#2 delete-unselected no-op in stub mode (P1) — FIXED.**
  `deleteUnselectedAnnotations` now derives from the stub-aware
  `allAnnotationIds` getter instead of `this.annotations` (which is empty in
  stub mode), mirroring the other dataset-wide actions.
- **#3 dataset reset leaks stub cache/index (P1) — FIXED.**
  `resetAnnotationStateImpl()` now clears `annotationStubs`, `hydratedAnnotations`,
  `visibleAnnotationIds`, viewport counts, `averageStubRadius`, `stubOnlyMode`,
  `annotationSpatialIndex.clear()`, and cancels the in-flight viewport hydration
  task.
- **#4 PV-driven sort row duplication (P1) — FIXED.** On a pure property sort,
  the PV-driven first segment is restricted to docs that have the sort key, so
  it no longer overlaps the no-value tail. Regression test added (RED/GREEN
  verified; full backend suite 251 passed).
- **#5 clearing values filter leaves old values (P2) — FIXED.**
  `updateValuesFilter()` always writes `values: []` on empty input (empty ==
  "do not filter", confirmed in `filters.ts`). Existing test updated to the
  corrected behavior.
- **#6 stub store tests drifted (P2) — PARTIALLY ADDRESSED.** Added the
  explicit regression coverage Codex requested for the unhydrated-stub selection
  (#1). The broader `annotationStubs.test.ts` mini-store rewrite (it still
  asserts the obsolete "hydrate first 20%" strategy that production
  `setAnnotations` no longer uses) is deferred as a dedicated test-refactor —
  noted as a follow-up to avoid cascading changes across the 900-line copied
  mini-store in this pass.

Scope: `feature/stub-annotations`, focused on the stub/hydration data path, annotation viewer/list behavior, backend list/stub endpoints, property-value lazy loading, and nearby tests.

Verification run:

- `pnpm vitest run src/components/AnnotationBrowser/AnnotationList.test.ts src/components/AnnotationViewer.test.ts src/store/__tests__/annotationStubs.test.ts src/store/__tests__/filters.test.ts src/utils/__tests__/annotationStubUtils.test.ts src/utils/__tests__/debouncedAbortable.test.ts src/utils/__tests__/visibilityBudget.test.ts src/utils/__tests__/propertyValues.test.ts`
  - Passed: 8 files, 451 tests.
  - Note: the run prints repeated Vuetify/JSDOM CSS `@layer` parse warnings, but exits successfully.
- `pnpm tsc`
  - Passed.

Backend Girder plugin tests were reviewed but not run in this pass.

## Findings

### 1. Drag/click selection skips unhydrated stubs in stub-only mode

Severity: P1

Files:

- `src/components/AnnotationViewer.vue:1623`
- `src/components/AnnotationViewer.vue:1672`
- `src/components/AnnotationViewer.vue:1710`

`getSelectedAnnotationsFromAnnotation()` now builds spatial indexes over `TAnnotationOrStub`, but when it handles candidates it immediately calls `getAnnotationFromId()` and requires `annotation.coordinates`. In stub-only mode, `getAnnotationFromId()` returns only hydrated annotations because `annotations[]` is empty and most displayed annotations are intentionally stub-only. As a result:

- Click selection cannot select visible unhydrated stub dots.
- Drag selection skips displayed unhydrated stubs.
- The global centroid-index pass, which is supposed to select non-visible annotations in the region, also skips unhydrated stubs before it can use their centroid/location.

This contradicts the architecture note's selection guarantee that region selection/deletion should capture all annotations in the area, not just the currently hydrated subset. It also blocks downstream operations that depend on selection, including tagging, connections, combine, and hydrate-on-selection.

Suggested fix: make selection return IDs rather than full `IAnnotation` where possible, or teach the candidate path to use `annotationStore.getStub(id)` when the full annotation is absent. For stub-only drag selection, use the stub `location` for frame gating and the stub `centroid` for containment; if precision is required, select/hydrate candidates first and refine after hydration. Add a test where `annotationStore.stubOnlyMode = true`, a visible GeoJS feature has `isStub: true`, `getAnnotationFromId()` returns `undefined`, and selection still picks the stub ID.

### 2. Viewer action-panel "Delete Unselected" is a no-op in stub-only mode

Severity: P1

Files:

- `src/components/AnnotationViewer.vue:15`
- `src/store/annotation.ts:1241`

The annotation list toolbar has a server-mode workaround for deleting unselected rows, but the floating `AnnotationActionPanel` in `AnnotationViewer.vue` still wires `@delete-unselected` directly to `annotationStore.deleteUnselectedAnnotations`. That store action computes unselected IDs from `this.annotations`, which is intentionally empty in stub-only mode:

```ts
const unselectedIds = this.annotations
  .filter((annotation) => !selectedIds.has(annotation.id))
  .map((annotation) => annotation.id);
```

So in large datasets the action panel can show "Delete Unselected" after a selection, call the backend with an empty ID list, and leave all unselected annotations untouched.

Suggested fix: make the store action stub-aware. If the intended action is dataset-wide, compute from `this.allAnnotationIds` in stub-only mode. If the intended action is filter/list-scoped, expose a separate server-list action that uses `/upenn_annotation/list/ids`; do not leave the shared store method silently empty.

### 3. Dataset reset leaves the large stub cache and spatial index alive

Severity: P1

Files:

- `src/store/index.ts:1397`
- `src/store/annotation.ts:366`
- `src/store/annotation.ts:377`

`setSelectedDataset()` calls `resetAnnotationState()` when switching/clearing datasets. The reset mutation now clears the old full `annotations[]`, but it does not clear the new stub-only state:

- `annotationStubs`
- `hydratedAnnotations`
- `visibleAnnotationIds`
- `viewportAnnotationCount` / `viewportRenderedCount`
- `averageStubRadius`
- `stubOnlyMode`
- the module-level `annotationSpatialIndex`
- any pending viewport hydration task

For a 708K-annotation dataset, clearing the selected dataset or navigating away can still retain the large stub map and spatial index until a later `fetchAnnotations()` happens to call `setAnnotations([])`. That is both a memory leak and a stale-state risk.

Suggested fix: extend `resetAnnotationStateImpl()` with the same clearing semantics as an empty annotation load, including `annotationSpatialIndex.clear()`, empty raw maps/sets, zeroed counts, `stubOnlyMode = false`, and cancellation of any pending/in-flight viewport hydration task.

### 4. PV-driven property sort can duplicate rows when a PV doc lacks the sort key

Severity: P1

File: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py:423`

The PV-driven pure property sort path paginates over all property-value docs for the dataset, including docs that do not contain the sort key. Then `_pvDrivenPage()` appends a no-value tail from the annotation collection when `len(rows) < limit`:

- `_pvDrivenPagePipeline()` includes PV docs with `_hasSortValue = 0`.
- `_noValueTail()` matches annotations whose joined `_pv.values.<sortKey>` is `None`, which includes the same "PV doc exists but sort key is missing" annotations.
- Those annotations can therefore appear once from the PV-driven rows and again from the no-value tail.

Example to add as a regression test: three annotations where one has `values.p.Area`, one has a PV doc with only `values.q.Other`, and one has no PV doc. Sorting by `["p", "Area"]` with a limit larger than the present-value count should return three unique annotation IDs, with the latter two in the missing-value tail. The current shape can duplicate the `q.Other` row and omit another missing row.

Suggested fix: for pure property sort, have the PV-driven first segment match only docs where the sort key exists/non-null, then append the complete missing-value tail once. Alternatively, keep the current first segment but make the tail exclude IDs already returned and compute the offset against the full missing set precisely.

### 5. Clearing a values-mode property filter leaves the old values active

Severity: P2

File: `src/components/AnnotationBrowser/AnnotationProperties/PropertyFilterHistogram.vue:308`

`updateValuesFilter()` only writes to the filter store when `parsedValues.length` is non-zero. If a user deletes all text from the values textarea, the previous `propertyFilter.values` remain in the store, so the UI looks cleared while the old values filter continues to apply.

Suggested fix: always update the filter store, using `values: []` for an empty parse. The backend/client filter builders already treat an empty values list as "do not filter."

### 6. Stub store tests have drifted from production behavior

Severity: P2 test coverage

File: `src/store/__tests__/annotationStubs.test.ts:397`

`annotationStubs.test.ts` uses a copied mini-store instead of importing the real annotation module. That can be reasonable for speed, but the copy still asserts the old "hydrate first 20%" mock-data strategy while production `setAnnotations()` now clears `hydratedAnnotations` and hydrates through `updateVisibilityAndHydration`. The tests pass because they are testing the copied implementation, not the current store behavior.

Suggested fix: either update the mini-store to match production behavior or replace these cases with pure utility tests plus a thin integration test against the real mutation/action boundary. Also add explicit regression coverage for the unhydrated-stub selection and stub-mode `deleteUnselectedAnnotations()` cases above.

## Notes

- The server-side list endpoint has solid input validation for malformed property paths, invalid sort fields, bad `idConstraints`, non-string `idSubstring`, and non-list value filters.
- The annotation list component itself handles server-mode selected/unselected deletion more carefully than the shared store action; the issue is the viewer action panel and any other direct store caller.
- ROI filtering in server list mode is explicitly not supported and is surfaced as a notice. ROI filtering in client lazy drawing uses centroid fallback, which appears to be an intentional approximation rather than an accidental coordinate access bug.

---

<a id="archived-branch-review-stub-annotations"></a>

## Archived Source: `BRANCH-REVIEW-stub-annotations.md`

# Branch Review — `feature/stub-annotations`

**Base:** `master` · **Reviewed:** 2026-06-23 · **Scope:** ~9K lines of source across 4 backend files and ~36 frontend files.

This is the actionable fix list from the branch review. Findings are globally numbered and ordered by severity (Medium → Low → Nit). Each has a location, the problem, and concrete fix guidance. Two open questions were resolved by the author — their answers are baked into Findings 1 and 5 below.

> **Status (2026-06-23): all 26 findings addressed (TDD).** Each finding below carries a **✅ Resolved** note with the change + the test that covers it. Verified green: `pnpm tsc` (clean), `pnpm lint:ci` (0 warnings), `pnpm test` (2377/2377), backend `tox` + `flake8` (full plugin clean — note `tox` runs pytest only, so `flake8` is run separately).
>
> **Finding 1 was re-scoped per the author**: the per-IP rate limiter is dropped (rate limiting belongs at the edge proxy / HAProxy at this traffic level); the app keeps only the input-size sanity ceilings (10M) + a 5-minute `maxTimeMS` query bound. See Finding 1 below.
>
> New tests: backend added cases in `test_uncomputed_counts.py`, `test_property_values_batch.py`, `test_stubs.py`; frontend `math.test.ts`, `sequenceGuard.test.ts`, `stubPerf.test.ts`, `properties.test.ts`, `annotationsAPI.test.ts`, plus added cases in `annotationListFilters`, `annotationStubUtils`, `annotationUpdate`, `propertyValues`, `loadingLabels`, `annotationStubs`, `AnnotationViewer`, `AnnotationList`.
>
> **Still needs a human in-browser check** (display-only, not assertable in jsdom): Finding 16 — change a filter while on server-list page 3 and confirm the footer snaps to page 1.

## Author clarifications (resolved questions)

- **Count-endpoint failure (Finding 5):** *Recoverable.* A failed annotation count must NOT route a large dataset into the full-fetch branch. Treat a count failure as "over threshold" → stub-only mode (the safe path), rather than `0` → full fetch (the OOM path). Optionally retry, but the fallback must be stub-mode, not full-fetch.
- **Anonymous access (Finding 1):** *Real.* Datasets can be made public, so the new aggregation endpoints are reachable unauthenticated. Rate limiting / abuse mitigation must be handled, not just documented.

## Fix checklist

Medium (do before merge):
- [x] 1 — Rate-limit new public aggregation endpoints
- [x] 2 — Validate `uncomputedCounts` input
- [x] 3 — Validate `batch` `propertyPaths` input
- [x] 4 — Cancel debounced/throttled fns on AnnotationViewer unmount
- [x] 5 — `getAnnotationCount` failure → stub-mode, not full-fetch (OOM fix)
- [x] 6 — Add stale-response guard to property-value fetch
- [x] 7 — Reset `discoveredPropertyPaths` on dataset switch
- [x] 8 — Dev-gate `stubPerf` + bound `hydrateLatencyMs`

Low:
- [x] 9 — `findByAnnotationIds` consistent doc shape
- [x] 10 — Move `hydrate` dataset-discovery aggregation to a model helper
- [x] 11 — Share `_isValidPropertyPath` / `_validateListInputs` helpers
- [x] 12 — Extract `stubFromAnnotation(...)` helper (4 dup sites)
- [x] 13 — Extract `createSequenceGuard()` (2 dup sites)
- [x] 14 — Avoid double stub-map / spatial-index build under threshold
- [x] 15 — Avoid full-dataset id array allocation per frame
- [x] 16 — Bind server page index to the table footer
- [x] 17 — Let checkbox read selection reactively (don't bake `isSelected`)
- [x] 18 — Extract `<PropertyColumnHeader>` (dup header markup)
- [x] 19 — `stubPerf.reset()` should reset `cacheCap`
- [x] 20 — Extract shared `clamp(value, lo, hi)`
- [x] 21 — Replace `as unknown as IAnnotation` double-cast with `Partial<IAnnotation>`

Nit:
- [x] 22 — Replace `JSON.stringify` sort compare with `sortsEqual`
- [x] 23 — Type/validate `getUncomputedCounts` response
- [x] 24 — Tighten `idsNeedingHydration` map param types
- [x] 25 — Move orphaned docblock in `camera.ts`
- [x] 26 — Add NaN-intent comment to `!(viewportExtent > 0)`

---

## Codex review round (PR #1203, 2026-06-23)

A later Codex pass on the open PR surfaced four more findings (P1–P3 from the
Codex cloud UI; P4 inline on the PR). All fixed (TDD), branch audited per
pattern.

- **[P1] "Select all" in server-list mode could hydrate the entire dataset.**
  `ensureHydrated([...allSelectedIds])` posted every unhydrated id to `/hydrate`
  with no budget — a giant request that defeats lazy mode and risks OOM, and the
  selected-protection meant the cache could grow unbounded. **Fix:** (a)
  `ensureHydrated` now caps its fetch at `visibilityConfig.maxHydrated` (extras
  stay dots — you can't view more shapes than that at once anyway); (b)
  `hydrationCacheCap` is now a HARD ceiling — new pure `planHydrationEvictions`
  helper protects selected ids but evicts selected LRU too when the protected
  set alone exceeds the cap, so the cache can't grow without bound. Tests:
  `annotationStubUtils.test.ts` "planHydrationEvictions" (5 cases incl. the
  select-all hard-cap).
- **[P2] Geometry edit/combine broke on unhydrated stubs.** Combine accepted a
  stub polygon then failed the union lookup silently; edit dropped unhydrated
  polygons with no feedback. **Fix:** both paths now detect an unhydrated target
  and show a toast ("Annotation not fully loaded — zoom in to fully load it…")
  instead of silently no-op'ing/failing (`AnnotationViewer.vue` snackbar +
  `notifyGeometryNotLoaded`). Combine also guards the previously-selected first
  annotation (in case it was LRU-evicted between clicks). **Audit:** the other
  selection handlers (select, connections, tagging) operate only on
  ids/tags/centroid — stub-safe — so combine + edit were the only
  coordinate-requiring paths. Tests: `AnnotationViewer.test.ts` "geometry edits
  on unhydrated stubs" (edit + combine).
- **[P3] New public endpoints converted client ids with bare `ObjectId()`** →
  uncaught `bson.InvalidId` 500s. **Fix:** `stubs`, `hydrate`, `listAnnotations`,
  `listAnnotationIds` now use `requireObjectId` (→ 400). **Audit:** the
  pre-existing `find`/`count` (both files) and the `deleteMultiple` id helpers
  have the same pattern but predate the branch — filed as follow-up issue
  **#1204** rather than expanding this PR's diff. Tests: malformed-datasetId/id
  → 400 in `test_stubs.py` and `test_server_list.py`.
- **[P4] Empty values-mode property filter wrongly routed `/list` into the
  PV-driven path,** dropping annotations with no value document (also skewed the
  count and select-all). **Fix:** new `dropNoOpPropertyFilters` normalizes away
  no-op filters (empty `values`, or a range with neither bound) before the model
  chooses a path, so an inactive filter == no filter. Test: `test_server_list.py`
  "testEmptyValuesFilterIsPassAll" (4 returned incl. the value-less annotation,
  on both `/list` and `/list/ids`).

---

## Findings

### Finding 1 — Public aggregation endpoints have no rate limiting · Medium · Security/Access Control

**Files:** `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py:527` (`uncomputedCounts`), plus `stubs` / `hydrate` / `listAnnotations` / `listAnnotationIds`; `server/api/propertyValues.py:143` (`batch`).

All `@access.public`; each runs an `allowDiskUse=True` aggregation (full-collection `$lookup` / `$facet` / `$objectToArray`+`$unwind`). **Author confirmed datasets can be public**, so an unauthenticated client can trigger multi-second aggregations over a 700K-annotation collection.

**Fix:** Add rate limiting / abuse mitigation to the new public aggregation endpoints. Options to weigh during the fix:
- Per-IP / per-token rate limit on the heavy endpoints.
- Cap aggregation cost (e.g. reject `uncomputedCounts` when `properties` list is huge; cap `batch` id count; cap page size — `listPage` already caps at 200).
- Confirm `allowDiskUse` is necessary; consider a `maxTimeMS` guard so a single query can't run unbounded.

Not a regression (`find`/`count` were already public), but these materially raise cost-per-request — handle them.

**✅ Resolved (scoped per author, 2026-06-23).** Request-*rate* limiting is deferred to the edge proxy (HAProxy stick-tables), which is the right layer for it and avoids a weak per-process in-app limiter at this traffic level. What remains in the app are the two mitigations the proxy *cannot* do, kept as cheap correctness/hygiene regardless of abuse:
1. **Input-size sanity ceilings** — `MAX_UNCOMPUTED_PROPERTIES` and `MAX_ANNOTATION_IDS`, both `10_000_000`, on `uncomputedCounts` / `batch` / `hydrate`. These are garbage guards (real usage is orders of magnitude below: hydration budget ~40K ids, datasets < 1K properties), not tuning knobs; oversized → `400`. (`listPage` already caps page size at 200.)
2. **`maxTimeMS` guard** — every heavy aggregation routes through `Annotation._aggregate(...)` (or carries `maxTimeMS` explicitly for the API-layer `stubs` pipeline), bounding any single query at `AGGREGATION_MAX_TIME_MS` = **300000 (5 min)** with `allowDiskUse` retained — comfortably above the slowest legitimate query, a hard ceiling against a runaway one pinning a Mongo connection.

The per-IP rate limiter (`server/helpers/rate_limit.py` + `enforceAnonymousRateLimit` calls + `test_rate_limit.py`) was **removed**. The cap tests moved to their endpoints' suites: `test_uncomputed_counts.py` (properties cap), `test_property_values_batch.py` (id cap), `test_stubs.py` (hydrate id cap) — each shrinks the cap via `monkeypatch` and asserts `400`.

---

### Finding 2 — `uncomputedCounts` does no input validation → uncaught 500s · Medium · Redundant Validation / Error Handling

**File:** `server/api/annotation.py:527-536`; model loop does `counts[pf["id"]]`.

```python
def uncomputedCounts(self, body):
    datasetId = ObjectId(body["datasetId"])   # KeyError if missing; InvalidId → 500 not 400
    Folder().load(datasetId, user=..., level=AccessType.READ, exc=True)
    properties = body.get("properties") or []
    return self._annotationModel.uncomputedCounts(datasetId, properties)
```

The model later does `pf["id"]` unconditionally and `pf.get("tags")` (expects a dict). `{"properties": [{}]}`, `{"properties": [{"id": 5}]}`, or a malformed `datasetId` → uncaught `KeyError` / `TypeError` / `bson.errors.InvalidId` → 500 on a public endpoint.

**Fix:** Validate at the API boundary, mirroring `_validateListInputs`:
- `datasetId` present + valid ObjectId; map `bson.errors.InvalidId` → `RestException(code=400)` (remember: `InvalidId` is a `BSONError`, **not** a `ValueError`).
- `properties` is a list of dicts, each with a non-empty string `id` (optional `shape` str / `tags` dict).

**✅ Resolved.** `uncomputedCounts` now uses `requireObjectId(body.get("datasetId"), "datasetId")` (missing/malformed → 400, `InvalidId` caught explicitly) and `validateUncomputedCountsProperties(properties)` (each entry a dict with a non-empty string `id`; optional `shape` str / `tags` dict) — both in the new `server/helpers/validation.py`. Validation runs before the `Folder().load` and the aggregation. Tests: `test_uncomputed_counts.py` (malformed/missing datasetId, missing/non-dict/non-string id, properties-not-a-list, tags-not-a-dict → all 400).

---

### Finding 3 — `batch` property-values endpoint doesn't validate `propertyPaths` → 500 / projection injection · Medium · Redundant Validation / Error Handling

**File:** `server/api/propertyValues.py:143-156`; model `server/models/propertyValues.py:140-144`.

`propertyPaths` flows into `findByAnnotationIds`, which builds `"values." + ".".join(path)`. A non-list-of-lists-of-strings (e.g. `[["a", 5]]`) raises `TypeError`; a component containing `.` / `$` silently builds a wrong/injected projection key.

**Fix:** Validate `propertyPaths` with `_isValidPropertyPath` (the same helper `listAnnotations` uses). Pairs with Finding 11 — move that helper somewhere both API files can import it.

**✅ Resolved.** `batch` now calls `validatePropertyPaths(propertyPaths)` (shared helper — same `isValidPropertyPath` the list endpoint uses; rejects non-list-of-lists, non-string components, and `.`/`$` injection). `datasetId` and each `annotationId` go through `requireObjectId` (malformed → 400 instead of 500). Tests: `test_property_values_batch.py` (propertyPaths not-a-list / element-not-a-list / non-string component / `.`/`$` injection / malformed datasetId → 400; empty propertyPaths list still OK).

---

### Finding 4 — Debounced/throttled fns in AnnotationViewer aren't cancelled on unmount · Medium · Error Handling

**File:** `src/components/AnnotationViewer.vue:3564` (`onBeforeUnmount`); fns: `updateVisibilityDebounced` (:3392), `restyleAnnotationsThrottled` (:1502). `onMounted` invokes `updateVisibilityDebounced()`.

Current `onBeforeUnmount` unbinds events and cancels the idle callback, but does **not** cancel the debounce/throttle. A trailing fire after teardown (navigate away right after a pan) calls `props.annotationLayer.map()` on a dead layer and dispatches store actions against a torn-down view. The prior OOM bug here was a missing unmount; sibling `AnnotationList.vue:614` already cancels its `debouncedServerRefetch`.

**Fix:**
```ts
onBeforeUnmount(() => {
  updateVisibilityDebounced.cancel();
  restyleAnnotationsThrottled.cancel();
  drawAnnotations.cancel?.();      // pre-existing, cancel while here
  drawTooltips.cancel?.();         // pre-existing
  handleValueOnMouseMoveDebounce.cancel?.(); // pre-existing, if present
  // ...existing unbinds
});
```
Confirm each is a lodash debounce/throttle exposing `.cancel()`.

**✅ Resolved.** `onBeforeUnmount` now cancels all five (`updateVisibilityDebounced`, `restyleAnnotationsThrottled`, `drawAnnotations`, `drawTooltips`, `handleValueOnMouseMoveDebounce`) — all real lodash `debounce`/`throttle` (`import { throttle, debounce } from "lodash"`), so `.cancel()` exists. Exposed `updateVisibilityDebounced`/`restyleAnnotationsThrottled` (the other three already were) for the test. Test: `AnnotationViewer.test.ts` "cancels all pending debounced/throttled callbacks so none fire after teardown" (spies each `.cancel`, unmounts, asserts all called).

---

### Finding 5 — `getAnnotationCount` failure routes large datasets to full-fetch (OOM) · Medium · Error Handling

**File:** `src/store/AnnotationsAPI.ts:370-375`; consumed at `src/store/annotation.ts:1666-1669`.

```ts
async getAnnotationCount(datasetId: string): Promise<number> {
  return this.client.get("upenn_annotation/count", { params: { datasetId } })
    .then((res) => res.data.count)
    .catch(() => 0);   // 0 <= stubThreshold → FULL fetch (OOM path)
}
```

**Author confirmed failure is recoverable, but must NOT trigger a full fetch.** A transient count failure on a huge dataset returns `0`, takes the full-fetch branch, and tries to load every annotation — the exact OOM scenario stub-mode exists to prevent.

**Fix:** On count failure, fall back to **stub-only mode**, not full-fetch. Practical approaches:
- Let `getAnnotationCount` reject (drop the `.catch`), and in `fetchAnnotations` catch a count failure specifically and route to the stub-only branch (treat as "over threshold").
- Or return a sentinel that `fetchAnnotations` reads as "over threshold" (e.g. `Infinity`) instead of `0`.
- Either way `logError` the failure. Optional: one retry before falling back.

Make sure the chosen approach keeps the floating `connectionsPromise` (`annotation.ts:1663`) safe (no unhandled rejection).

**✅ Resolved.** `getAnnotationCount` no longer swallows errors to `0` — it rejects (the doc comment spells out why a silent 0 is the OOM trigger). `fetchAnnotations` wraps the count in try/catch: on failure it `logError`s and sets `count = Number.POSITIVE_INFINITY`, which is `> stubThreshold` → the stub-only branch (the safe path). `annotationLoadingTitle` now returns a count-less "Loading annotations…" for a non-finite count so the bar doesn't read "Infinity". `connectionsPromise` stays awaited (the stub-only branch awaits it in its `Promise.all`), so no unhandled rejection. The other consumer, `DatasetInfo.vue`, now `.catch(() => null)`s the count so a failure shows "unknown" rather than crashing. Tests: `annotationsAPI.test.ts` (resolves count / rejects on failure), `loadingLabels.test.ts` (Infinity → count-less title); `DatasetInfo.test.ts` (17) still green.

---

### Finding 6 — Property-value fetch has no stale-response guard (race) · Medium · Error Handling

**File:** `src/store/properties.ts:804` (`ensureVisiblePropertyValues`), `_fetchVisiblePropertyValues` at `:983`.

The hydration path (abortable) and the two id-fetch paths (`requestSeq`-guarded) protect against out-of-order responses; this one calls `mergeVisiblePropertyValues({ newEntries, keepIds })` with no guard. On rapid pans, a slow earlier fetch resolving last prunes freshly-fetched entries scoped to a stale `keepIds`.

**Fix:** Route through a `requestSeq` token or a `createDebouncedAbortableTask` like the hydration fetch (see `src/utils/debouncedAbortable.ts`). If Finding 13's `createSequenceGuard()` is built, reuse it here.

**✅ Resolved.** Reuses Finding 13's `createSequenceGuard()`. `ensureVisiblePropertyValues` claims a token up front (superseding any in-flight fetch, and making the synchronous prune reflect the latest set); `_fetchVisiblePropertyValues` carries the token and only merges if `guard.isCurrent(token)` after the await. Test: `properties.test.ts` "does not let a slow earlier fetch overwrite a newer fetch scoped to a different visible set" (+ "applies the latest fetch result").

---

### Finding 7 — `discoveredPropertyPaths` not cleared on dataset reset · Medium · Pattern Consistency

**File:** `src/store/properties.ts:194` (`resetPropertyStateImpl`).

`displayedPropertyPaths` and `uncomputedCounts` are reset; the sibling lazy-mode field `discoveredPropertyPaths` is not. On dataset switch, the previous dataset's paths persist until the next `fetchPropertyPathsSample`; `computedPropertyPaths` reads them in the interim (largely masked by the `getPropertyById` filter, but inconsistent).

**Fix:** `this.discoveredPropertyPaths = markRaw([]);` in `resetPropertyStateImpl`.

**✅ Resolved.** Added `this.discoveredPropertyPaths = markRaw([]);` to `resetPropertyStateImpl` (next to the `displayedPropertyPaths`/`uncomputedCounts` resets). Test: `properties.test.ts` "clears discoveredPropertyPaths along with the other per-dataset paths".

---

### Finding 8 — `stubPerf` instrumentation runs always-on in production · Medium · Performance / Dead code

**File:** `src/utils/stubPerf.ts:167-172`; hot-path callsites `src/store/annotation.ts:2342-2396`, `src/components/AnnotationViewer.vue:3405`.

```ts
export const stubPerf = new StubPerf();
if (typeof window !== "undefined") {
  (window as unknown as { __stubPerf: StubPerf }).__stubPerf = stubPerf;
}
```

Header says "Dev-only," but it's not gated — counters increment on per-pan/per-hydrate hot paths, and `hydrateLatencyMs` (`push` at :93, cleared only by `reset()`) grows unbounded for the tab's lifetime — a slow leak on a branch whose purpose is memory hygiene.

**Fix:**
- Gate behind `import.meta.env.DEV` so the module tree-shakes from prod builds (and/or make the track* methods no-ops in prod).
- Cap `hydrateLatencyMs` to a ring buffer of the last N samples.
- Replace `as unknown as { __stubPerf: StubPerf }` with a declared global type (e.g. `declare global { interface Window { __stubPerf?: StubPerf } }`).
- This also moots the `console.log` usage at `:86` and `:144-162` (was Finding U3) and the `cacheCap` reset gap (Finding 19) for prod.

**✅ Resolved.** Added `enabled = import.meta.env.DEV`; every `track*` method early-returns when disabled, so the per-pan/per-hydrate hot paths are no-ops (and the verbose `console.log` never runs) in prod. `trackLatency` now keeps a ring buffer of the last `MAX_LATENCY_SAMPLES` (200) — no unbounded growth. `Window.__stubPerf?` is a proper `declare global` augmentation (no `as unknown` cast). `StubPerf` is exported for unit testing. Tests: `stubPerf.test.ts` (ring-buffer cap, disabled no-op, enabled counters, cacheCap reset).

---

### Finding 9 — `findByAnnotationIds` returns different doc shapes depending on projection · Low · Pattern Consistency

**File:** `server/models/propertyValues.py:140-154`.

With `propertyPaths`: docs include `annotationId` + projected values, drop `_id`/`datasetId`. Without it: full docs. Confirm the frontend keys only on `annotationId` and doesn't rely on `_id`/`datasetId` when projecting; if it might, include a consistent minimal field set in both branches.

**✅ Resolved.** Confirmed the only consumer (`PropertiesAPI.getPropertyValuesForIds`) maps each doc to `{annotationId, values}` and keys on nothing else. Also made the shape consistent regardless of projection: the no-projection branch now projects `["annotationId", "values"]` (instead of returning full docs), so both branches return the same minimal field set and neither leaks `datasetId`. Test: `test_property_values_batch.py` "testConsistentDocShapeWithAndWithoutPaths".

---

### Finding 10 — `hydrate` dataset-discovery aggregation built in API layer · Low · Raw PyMongo / Layer smell

**File:** `server/api/annotation.py` (`hydrate`).

`collection.aggregate()` is the allowed pipeline exception, but constructing the `$group` dataset-discovery pipeline in the API method reads better as a model helper, e.g. `self._annotationModel.distinctDatasetIds(objectIds)`, keeping the API method free of pipeline construction.

**Fix:** Move the aggregation into a small model method; call it from `hydrate`.

**✅ Resolved.** Added `Annotation.distinctDatasetIds(objectIds)` to the model; both `hydrate` and `deleteMultiple` (which had the identical inline `$match`/`$group` block) now call it, so neither API method constructs the pipeline. Test: `test_stubs.py::TestDistinctDatasetIds` (distinct datasets, empty input, nonexistent ids); existing hydrate + deleteMultiple endpoint tests still green.

---

### Finding 11 — `_isValidPropertyPath` / `_validateListInputs` should be shared helpers · Low · Code Duplication

**File:** `server/api/annotation.py:23-138` vs `server/api/propertyValues.py`.

`propertyValues.py:batch` needs the same path validation (Finding 3). Per CLAUDE.md, extract these validators to `server/helpers/` (alongside `serialization.py`'s `orJsonDefaults`, e.g. a `validation.py`) rather than importing across API modules. `_streamJsonArray` is also a candidate for sharing if `batch` ever streams large value sets.

**✅ Resolved.** Created `server/helpers/validation.py` with `requireObjectId`, `isValidPropertyPath`, `validatePropertyPaths`, `validateListInputs`, and `validateUncomputedCountsProperties`. `annotation.py` and `propertyValues.py` both import from it; the local `_isValidPropertyPath`/`_validateListInputs` copies in `annotation.py` are removed. `_streamJsonArray` left in `annotation.py` (batch doesn't stream yet — defer until needed). Existing `test_server_list.py` (34) still green against the moved validators.

---

### Finding 12 — Duplicated stub-construction object literal (4 copies) · Low · Code Duplication

**File:** `src/store/annotation.ts:662, 697, 743, 807`.

Identical 8-field stub literal (`{ id, centroid, location, shape, channel, tags, color, estimatedRadius }`) hand-written in four mutations; one already diverges (`value.coordinates` vs `annotation.coordinates`).

**Fix:** Extract `stubFromAnnotation(annotation, centroid): IAnnotationStub` into `src/utils/annotation.ts` (next to `estimateAnnotationRadius`); call from all four sites. Re-verify the `coordinates` source is correct after consolidating.

**✅ Resolved.** `stubFromAnnotation(annotation, centroid)` added to `src/utils/annotation.ts`; all four mutations (`addAnnotationImpl`, `addAnnotationsImpl`, `setAnnotation`, `setAnnotations`) now call it. The `value`/`annotation` naming difference was cosmetic (same object); coordinates source confirmed correct. Tests: `annotationStubUtils.test.ts` "stubFromAnnotation"; existing `annotationStubs.test.ts` (45) still green.

---

### Finding 13 — Duplicated monotonic `requestSeq` stale-guard pattern · Low · Code Duplication / Missing Abstractions

**File:** `src/store/annotationListServer.ts:87-92,145-162` and `src/store/filters.ts:225-254`.

Both implement "increment seq, capture, only apply if `seq === this.seq`."

**Fix:** Extract a `createSequenceGuard()` util. Reuse it in Finding 6 (which currently lacks any guard).

**✅ Resolved.** `createSequenceGuard()` added to `src/utils/sequenceGuard.ts` (`next()` / `isCurrent(token)`). `annotationListServer.ts` and `filters.ts` now use module-level guards instead of Vuex `requestSeq` state + increment mutations (the counters were never read by the UI). Tests: `sequenceGuard.test.ts`; existing server/filter store tests still green. (Finding 6 reuses it — see below.)

---

### Finding 14 — Redundant stub-map + spatial-index rebuild under threshold · Low · Performance

**File:** `src/store/annotation.ts:1669-1680` (`fetchAnnotations`, `count <= stubThreshold`).

`setAnnotations(...)` builds the full stub map/centroids and `bulkLoad`s the spatial index; `setStubsFromServer(stubs)` then overwrites those and `bulkLoad`s again over the same ids. For ≤10K datasets the O(N) build runs twice.

**Fix:** Have `setAnnotations` skip stub/index construction when a `setStubsFromServer` follows, or fold the server-stub override into one mutation.

**✅ Resolved.** `setAnnotations` now accepts an array (unchanged for all existing callers) or `{ values, serverStubsFollow }`. With `serverStubsFollow: true` it builds only `annotations[]` + `annotationIdToIdx` and skips the centroid/stub-map/spatial-index build (which the immediately-following `setStubsFromServer` does from server data). The under-threshold `fetchAnnotations` branch passes the flag only when server stubs are actually present (else it falls back to the full client build). Verified by `pnpm tsc` + the full suite (the under-threshold path's output is unchanged — `setStubsFromServer` produces the same final state).

---

### Finding 15 — `updateVisibility` allocates a full-dataset id array per frame · Low · Performance

**File:** `src/components/AnnotationViewer.vue:3346-3350`; watch at `:3408`.

`.map((a) => a.id)` materializes a fresh 700K-string array on every XY/Z/Time change. Not per-animation-frame, but consider passing the source array/Set and deriving ids once in the store (or having the store maintain the Set).

**✅ Resolved.** `updateVisibilityAndHydration`'s `filteredIds` is now optional: when a client filter is active the component still passes the (smaller) filtered id array, but with no filter it omits it and the action walks its own `annotationStubs` map directly — no full-dataset id array materialized per frame. Behavior-preserving (same current-frame set either way). Test: `annotationStubs.test.ts` "derives ids from the stub map when filteredIds is omitted".

---

### Finding 16 — Server page reset not reflected in the data-table footer · Low · Pattern Consistency

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:608` (filter watch sets `page:1`) vs `v-data-table-server` at `:195` (no `v-model:page`).

Changing a filter while on page 3 resets the store to page 1 and refetches page-1 rows, but Vuetify's footer may still show "Page 3" (display desync; correct rows render).

**Fix:** Bind `v-model:page` / `:page="serverPage"`. Verify in-browser before/after.

**✅ Resolved.** `<v-data-table-server>` now binds `:page="annotationListServer.page"` and `:items-per-page="annotationListServer.pageSize"`, so a store-driven page reset (the filter watch's `setOptions({ page: 1 })`) is reflected in the footer. The existing `onServerOptions` no-op guard (now using `sortsEqual`) prevents a redundant refetch when the bound page round-trips back. ⚠️ Footer display is a Vuetify-internal concern not asserted in jsdom — verify in-browser (change a filter while on page 3 → footer should snap to page 1).

---

### Finding 17 — `serverRowItems` rebuilds the whole page array on selection change · Low · Performance

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:321-329`.

Baking `isSelected` into each row item makes the computed depend on `selectedAnnotationIds`, so every selection toggle re-maps and re-spreads up to 200 rows.

**Fix:** Let the row checkbox read selection reactively (e.g. `annotationStore.isAnnotationSelected(row.id)` in the row component) instead of precomputing `isSelected` in the array. Bounded by the 200-row cap, so low priority.

**✅ Resolved.** `isSelected` removed from both row-item builders (`serverRowItems` and the client `annotationToItem`) and from the `IAnnotationListItem`/`IAnnotationListRowItem` types. `AnnotationListRow.vue`'s checkbox now binds `:model-value="annotationStore.isAnnotationSelected(item.annotation.id)"` (reactive read), so toggling a selection no longer re-maps/re-spreads the page array — only the touched checkbox bindings re-evaluate. `selectedItems` updated to filter via `isAnnotationSelected`. Test: `AnnotationList.test.ts` "reads selection reactively from the store rather than baking it into items".

---

### Finding 18 — Duplicated property-header slot markup across the two tables · Low · Code Duplication

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:218-245` (server table) vs the client `v-data-table` equivalent.

The custom property-header template (label + `getSortIcon` + remove `v-btn`) is byte-for-byte identical in both tables. The row body was already extracted to `AnnotationListRow.vue`; the header block is the remaining copy-paste.

**Fix:** Extract a `<PropertyColumnHeader>` component (or a shared `#header` render helper).

**✅ Resolved.** Extracted `src/components/AnnotationBrowser/PropertyColumnHeader.vue` (label + sort icon + remove button, with the `.property-header-*` scoped styles moved into it). Both tables use it via `<property-column-header :title :sortable :sort-icon @remove>`. It takes plain props (the parent computes the icon with the slot's `getSortIcon`) rather than the column object + function, so it stays decoupled from Vuetify's internal `InternalDataTableHeader` type. `pnpm tsc` clean; `AnnotationList` tests (283) green.

---

### Finding 19 — `stubPerf.reset()` does not reset `cacheCap` · Low · Error Handling / Correctness

**File:** `src/utils/stubPerf.ts:64-76`.

`reset()` zeroes every counter except `cacheCap`, so a `report()` after `setDataset()` but before the first `trackCache` reports the previous dataset's cap.

**Fix:** Add `this.cacheCap = 0;` to `reset()`. (Subsumed if Finding 8 dev-gates the module, but cheap to do regardless.)

**✅ Resolved.** `reset()` now zeroes `cacheCap`. Test: `stubPerf.test.ts` "reset() also clears cacheCap".

---

### Finding 20 — `clamp` reimplemented in three sibling util files · Low · Code Duplication / Missing Abstractions

**File:** `src/utils/visibilityBudget.ts:28-30`, `src/utils/visibilityConfigBounds.ts:45` (inline in `clampField`), `src/utils/renderCoverage.ts:37` (`Math.min(1, Math.max(0, x))`).

**Fix:** Extract a single `clamp(value, lo, hi)` into a shared `src/utils/math.ts`; import in all three. (Check whether a `clamp` util already exists before adding one.)

**✅ Resolved.** No pre-existing `clamp` util; added `src/utils/math.ts` `clamp(value, lo, hi)` and imported it in `visibilityBudget.ts`, `visibilityConfigBounds.ts` (`clampField`), and `renderCoverage.ts`. Tests: `math.test.ts`; the three consumers' existing tests still green.

---

### Finding 21 — `buildStubUpdates` uses `as unknown as IAnnotation` double-casts · Low · Type Safety

**File:** `src/utils/annotationUpdate.ts:67-68`.

```ts
const before = { ...stub, tags: [...stub.tags] } as unknown as IAnnotation;
const after  = { ...stub, tags: [...stub.tags] } as unknown as IAnnotation;
```

A stub lacks `coordinates`/`name`, so it's force-cast through `unknown`. Safe today (`getAnnotationUpdatePatch` only diffs stub-carried fields), but silently passes `undefined` if `editFunction` ever touches `coordinates`.

**Fix:** Type the `editFunction` boundary as `(annotation: Partial<IAnnotation>) => void`, or document the precondition prominently.

**✅ Resolved.** `getAnnotationUpdatePatch` now accepts `Partial<IAnnotation>` (with an early `after.id === undefined → null` guard), so `buildStubUpdates` builds `before`/`after` as `Partial<IAnnotation>` with no `as unknown` cast. The single remaining `after as IAnnotation` at the `editFunction` call carries a prominent comment documenting the precondition (editFunction must only touch stub-carried fields in this path). Widening the whole `editFunction`/`updateAnnotationsPerId` contract to `Partial` was rejected — function-param contravariance (strictFunctionTypes) would break the three `(ann: IAnnotation) => void` callers in `AnnotationViewer.vue`. Tests: `annotationUpdate.test.ts` ("diffs partial (stub-shaped) annotations", "returns null when the partial annotation has no id").

---

### Finding 22 — `onServerOptions` compares sort objects via `JSON.stringify` · Nit · Pattern Consistency

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:383-385`.

`JSON.stringify` equality is key-order-sensitive. Works today (both sides built by `mapSort`).

**Fix:** Small `sortsEqual(a, b)` helper comparing `type`/`key`/`order`.

**✅ Resolved.** `sortsEqual(a, b)` added to `src/utils/annotationListFilters.ts` (handles null, compares `type`/`order` and the `key` element-wise — string field vs `string[]` path). `onServerOptions` uses it instead of `JSON.stringify`. Tests: `annotationListFilters.test.ts` "sortsEqual".

---

### Finding 23 — `getUncomputedCounts` returns `response.data` unchecked · Nit · Type Safety

**File:** `src/store/PropertiesAPI.ts:85` (and the `as any[]` mappers in `AnnotationsAPI.ts:124-151`).

`return response.data;` coerced to declared `{[id]: number}` with no cast/validation.

**Fix:** Optional — add a light runtime/structural check or explicit typing at the boundary. Consistent-enough with the file's existing convention, so lowest priority.

**✅ Resolved.** Added `coerceUncomputedCounts(data: unknown)` to `src/utils/propertyValues.ts` (non-object → `{}`; drops non-finite-number values) and `getUncomputedCounts` returns it instead of raw `response.data`. The `as any[]` mappers in `AnnotationsAPI.ts` were left as-is (consistent with the file's `toStub`/`toAnnotation` convention, as the finding allows). Tests: `propertyValues.test.ts` "coerceUncomputedCounts".

---

### Finding 24 — `idsNeedingHydration` over-generic map params · Nit · Type Safety / Naming

**File:** `src/utils/annotation.ts:425-428`.

Params typed `ReadonlyMap<string, unknown>` but only `.has()` is used.

**Fix:** Use `ReadonlyMap<string, never>` or a `{ has(id: string): boolean }` interface to communicate "keys only, values unused."

**✅ Resolved.** `hydrated`/`stubs` params now typed `IHasKey` (`{ has(id: string): boolean }`) — communicates keys-only and also lets a `Set` be passed. Test: `annotationStubUtils.test.ts` "accepts any has-only collection (e.g. a Set)".

---

### Finding 25 — Orphaned docblock above `cameraRefreshNeeded` · Nit · Naming / Documentation

**File:** `src/utils/camera.ts:3-35`.

Two consecutive doc blocks precede `cameraRefreshNeeded`; the first (lines 3-18) actually describes `recenterCameraInfo` (defined below at `:65`).

**Fix:** Move the `recenterCameraInfo` docblock down to sit immediately above `recenterCameraInfo`.

**✅ Resolved.** The `recenterCameraInfo` docblock now sits immediately above `recenterCameraInfo`; only the hysteresis docblock precedes `cameraRefreshNeeded`. `camera.test.ts` (15) still green.

---

### Finding 26 — `!(viewportExtent > 0)` needs a NaN-intent comment · Nit · Simplification

**File:** `src/utils/camera.ts:50`.

The double-negative is deliberate — it also catches `NaN` (a `<= 0` rewrite would not).

**Fix:** Keep the form; add an inline `// also catches NaN` so a future "simplification" doesn't break it.

**✅ Resolved.** Added a comment above `if (!(viewportExtent > 0))` explaining the double-negative catches NaN (NaN comparisons are always false) → refresh-on-any-pan safe default.

---

## What's already done well (no action)

- No N+1 / looped DB or API calls anywhere — `$in` / `$facet` / aggregation / batch endpoints throughout.
- Access control intact on every new endpoint; `hydrate` checks access against the datasets the requested annotations actually belong to (no id-smuggling escalation); `exc=True` used consistently.
- Layer separation respected (models raise `ValueError`; API maps to `RestException(400)`); `bson.errors.InvalidId` caught explicitly; no broad `except Exception`.
- Genuine bug fix in `propertyValues.py` `annotationsRemovedEvent` (ObjectId normalization fixes property-value orphaning on bulk deletes).
- API calls correctly placed in `AnnotationsAPI.ts` / `PropertiesAPI.ts`; no raw `girderRest` in stores/components; no `console.*` in committed component code; no `as any`/`@ts-ignore` introduced; `pnpm tsc` clean.
- No frontend-compensating-for-backend dual-API fallbacks; new store state correctly isolated in `annotationListServer.ts`.
- `selectLargestBySize` / `selectRandomSubset` hot-path optimizations correct and documented; `debouncedAbortable.ts` has no abort/debounce race; `spatialIndex.ts` RBush wrapper handles reference-based removal correctly.

## Pre-existing (not introduced by this branch, no action required here)

- `getDatasetIdFromAnnotationListInBody` uses `load(annId, force=True)` without a justifying comment (`server/api/annotation.py:161`) — the real write check happens in `@recordable`'s dataset gate.

---

<a id="archived-branch-review-stub-annotations-round2"></a>

## Archived Source: `BRANCH-REVIEW-stub-annotations-round2.md`

# Branch Review (Round 2) — feature/stub-annotations

Second-pass review findings and remediation tracking. Each finding records its
fix approach (TDD where possible), the test that proves it, and a status.

**Status legend:** ⬜ open · 🔧 in progress · ✅ fixed (test green) · ⏭️ deferred / won't-fix (with reason)

## Verification summary (final)

- **Frontend:** `pnpm tsc` clean (0 errors); `pnpm lint:ci` clean (0 warnings); full `vitest run src/` — **138 files / 2400 tests green**. New tests added for F1 (geometry fingerprint / drawn keep-check), F2 (stub/hydrated refresh on edit), F5 (spatial-index upsert), F11 (empty-list select-all), F12 (array-as-leaf).
- **Backend:** `tox` — **284 tests green**, flake8 clean. New tests for F3, F4, F7, F10, F17.
- **Rebuilt backend (`docker compose build girder && up -d`)** and live-smoke-tested the rebuilt container: F3 bad offset/limit → 400, F4 non-dict filters → 400 (`/list` and `/list/ids`), F17 `[[]]` → 400, valid `/list` → 200, refactored `/stubs` (F13) → 200. List row shape correct (`_id` + centroid, no coordinates).
- **F19** accepted/won't-fix in app code (decided 2026-06-24): rate limiting will be done at the HAProxy proxy layer later. No app change.

All 20 findings resolved: 18 fixed, 1 (F19) accepted/documented, plus the F20 sub-items.

---

## Findings

### Finding 1 — In-place geometry edits are not repainted (incremental draw keeps stale feature)
- **Severity:** High · **Category:** Correctness (rendering)
- **Files:** `src/components/AnnotationViewer.vue:684`, `src/utils/annotation.ts:417-426` (`drawnFeatureUnchanged`)
- **Problem:** The incremental draw keep-check compares only layer existence, `color`, and stub/shape state — never `coordinates`. A polygon-slice edit mutates `coordinates` on the same id/color/hydrated-state, so the stale GeoJS feature is kept and `drawNewAnnotations` skips it. The edit never repaints until a forced full clear.
- **Fix approach:** Add a geometry fingerprint (e.g. coordinate-derived token) to the draw-state comparison so a coordinate change makes `drawnFeatureUnchanged` return `false`. TDD the predicate.
- **Test:** `src/utils/__tests__/annotationStubUtils.test.ts` — `drawnFeatureUnchanged` returns false when the geometry key differs.
- **Status:** ✅ fixed — added float-safe `coordinatesFingerprint` + `geometryKeyForRender` helpers; `drawnFeatureUnchanged` now compares the rendered-geometry key (5th param). `createGeoJSAnnotation` stamps `geometryKey` into the GeoJS feature options; `clearOldAnnotations` reads it back. New tests cover fingerprint stability/vertex-move/count-change/sub-integer-move, `geometryKeyForRender` for hydrated+stub, and the in-place-edit keep-decision. 360 tests green across viewer + stub utils + store stubs; `pnpm tsc` clean.

### Finding 2 — `setAnnotationsAtIndices` leaves `annotationStubs`/`hydratedAnnotations` stale
- **Severity:** High · **Category:** Correctness (cache invalidation)
- **Files:** `src/store/annotation.ts:745-763`
- **Problem:** The non-stub-only `updateAnnotationsPerId` path commits via `setAnnotationsAtIndices`, which updates only `annotations[]`/centroids/idx — not `annotationStubs` or `hydratedAnnotations`. Canvas rendering reads those maps when `needsStubSystem` is true (any frame > `maxVisible`), so color/tag/coordinate edits resolve to the stale stub/hydrated copy and don't repaint.
- **Fix approach:** In `setAnnotationsAtIndices`, rebuild the stub for each updated id and refresh any present hydrated entry (mirroring `setAnnotation:730-739`).
- **Test:** store test — after `setAnnotationsAtIndices`, `annotationStubs.get(id)` and `hydratedAnnotations.get(id)` reflect the new color/tags/coordinates.
- **Status:** ✅ fixed — `setAnnotationsAtIndices` now rebuilds the stub, refreshes the hydrated entry if present, and repositions the spatial index when the centroid moved. 4 new tests in `annotationStubs.test.ts` (color/tags/hydrated/spatial), all green (50/50). Test follows the repo's replicated-store convention (real module is too coupled to import) with the replica kept in lockstep with the real mutation.

### Finding 3 — `offset`/`limit` parsing throws uncaught 500 on public `/list`
- **Severity:** Medium · **Category:** Error Handling / Security
- **Files:** `devops/.../server/api/annotation.py:654-655`
- **Problem:** `int(body.get("offset"/"limit"))` raises `ValueError`/`TypeError` before the `try/except` around `listPage`, producing a 500 on a public endpoint.
- **Fix approach:** Add an int-or-400 helper in `validation.py` and use it for offset/limit.
- **Test:** pytest — POST `/list` with `offset: "abc"` / `limit: [1,2]` → 400 (`testNonIntegerOffsetReturns400`, `testNonIntegerLimitReturns400`).
- **Status:** ✅ fixed — added `requireInt` in `validation.py`; `listAnnotations` now does `max(0, requireInt(...))` / `max(1, requireInt(...))` (parse-or-400, then preserve the existing clamp).

### Finding 4 — Truthy non-dict `filters` → AttributeError 500 on `/list` & `/list/ids`
- **Severity:** Medium · **Category:** Error Handling / Security
- **Files:** `server/api/annotation.py:626,651`, `server/helpers/validation.py:133`
- **Problem:** `body.get("filters") or {}` only replaces falsy values; a string/list `filters` reaches `validateListInputs` which does `filters.get(...)` → AttributeError → 500.
- **Fix approach:** Guard `isinstance(filters, dict)` at the top of `validateListInputs`.
- **Test:** pytest — `filters: "not-a-dict"` (list) → 400 on both `/list` and `/list/ids` (`testNonDictFiltersReturns400OnList`, `...OnIds`).
- **Status:** ✅ fixed — `validateListInputs` now raises 400 when `filters` is not a dict.

### Finding 5 — Spatial index `insert` has no upsert; re-add leaks a stale node
- **Severity:** Medium · **Category:** Correctness (edge case)
- **Files:** `src/utils/spatialIndex.ts:28-32`
- **Problem:** `insert` doesn't remove an existing entry for the id first, so re-adding orphans the old RBush node; a later `remove` can't clean it up and `queryBox` returns a stale location.
- **Fix approach:** Make `insert` upsert-safe (`if (this.itemById.has(id)) this.remove(id)`).
- **Test:** `spatialIndex.test.ts` — insert id, insert same id at new location, remove id → query returns nothing at either location (`upserts when an id is inserted again`).
- **Status:** ✅ fixed — `insert` now removes any existing node for the id first. Also let me simplify the F2 spatial-index update to a single `insert` (no explicit remove). 10/10 spatialIndex tests green.

### Finding 6 — `annotationsForIteration` launders stubs through `as unknown as IAnnotation[]`
- **Severity:** Low · **Category:** Type Safety
- **Files:** `src/store/annotation.ts:157-164` and consumers
- **Problem:** Double cast disables the compiler at the stub-vs-full boundary.
- **Fix approach:** Return `TAnnotationOrStub[]`; narrow consumers via `isHydratedAnnotation`. Verify with `tsc`.
- **Test:** `pnpm tsc` clean (compile-time concern); affected vitest suites green (244 tests).
- **Status:** ✅ fixed — getter now returns the honest union (removed `as unknown as`). Consumers widened: `filters.ts` callback + `annotationTestPoints` (now `TAnnotationOrStub`, guarded), `AnnotationViewer` `displayableAnnotationsByChannel`/`layerAnnotations`/`updateVisibility`, `AnnotationContextMenu`, `TagCloudPicker`. `AnnotationList.filteredItems` narrows via `isHydratedAnnotation` (client list path is non-stub only). `AnnotationCSVDialog` prop widened to the union with the single `.name` read guarded. `tsc` clean (0 errors).

### Finding 7 — `listCount` (PV-driven path) can over-count vs. returnable rows
- **Severity:** Low · **Category:** Correctness (count/page)
- **Files:** `server/models/annotation.py` `listCount` vs `_pvDrivenPagePipeline`
- **Problem:** Count counts PV docs directly; the page pipeline joins back to annotations with a non-preserving `$unwind`, dropping orphan PV docs. `total` can exceed returnable rows.
- **Fix approach:** Count through the same join for the PV-driven path.
- **Test:** pytest — orphan PV doc present → `total` equals number of returned rows (`testPropertyFilterCountExcludesOrphanValueDocs`).
- **Status:** ✅ fixed — `listCount` PV-driven branch now `$lookup`+non-preserving `$unwind` to the annotation before `$count`, matching the page pipeline.

### Finding 8 — Under-threshold `fetchAnnotations` double-fetches (annotations + stubs)
- **Severity:** Low · **Category:** Performance
- **Files:** `src/store/annotation.ts:1664-1683`
- **Problem:** ≤threshold branch fetches full annotations and stubs; full annotations are a superset and stubs are built client-side cheaply at this size.
- **Fix approach:** Drop `getAnnotationStubs` in the under-threshold branch; pass `serverStubsFollow:false`.
- **Test:** No dedicated test — `fetchAnnotations` lives in the heavily-coupled store module (not unit-testable in isolation). Behavior-preserving: the under-threshold path now passes a bare array to `setAnnotations`, whose client-side stub/centroid/spatial-index build is already covered by `annotationStubs.test.ts`. `tsc` clean.
- **Status:** ✅ fixed — under-threshold branch fetches only full annotations + connections; `setAnnotations(bare array)` builds stubs client-side.

### Finding 9 — `flashNote` timers not cleared on unmount
- **Severity:** Low · **Category:** Lifecycle cleanup
- **Files:** `src/components/UISettings.vue:195-206`
- **Problem:** `window.setTimeout` callbacks can fire after unmount, mutating reactive state on a destroyed component.
- **Fix approach:** Clear pending timers in `onBeforeUnmount`.
- **Test:** n/a (lifecycle) — covered by the existing UISettings suite staying green; verified by inspection.
- **Status:** ✅ fixed — added `onBeforeUnmount` clearing all pending `noteTimers`.

### Finding 10 — `findByAnnotationIds` returns `_id` despite docstring excluding it
- **Severity:** Low · **Category:** Correctness (doc mismatch)
- **Files:** `server/models/propertyValues.py:131-161`
- **Problem:** Inclusion-list projection leaves Mongo's default `_id:1`.
- **Fix approach:** Use a dict projection that drops `_id`.
- **Test:** pytest — returned PV docs have no `_id`/`datasetId`, with and without `propertyPaths` (`TestFindByAnnotationIds`).
- **Status:** ✅ fixed — `findByAnnotationIds` now builds a dict projection `{"_id": 0, "annotationId": 1, ...}`.

### Finding 11 — `selectAllValue` checked on empty client-mode list
- **Severity:** Low · **Category:** Correctness (dual-mode divergence)
- **Files:** `src/components/AnnotationBrowser/AnnotationList.vue:610-616`
- **Problem:** Client branch is `0 === 0 → true` on an empty table; server branch guards `total > 0`.
- **Fix approach:** Guard `filteredItems.length > 0` in the client branch.
- **Test:** `AnnotationList.test.ts` — empty filtered list → `selectAllValue` is false (`Finding 11`).
- **Status:** ✅ fixed — client branch now requires `filteredItems.length > 0`, matching the server branch. 71/71 green.

### Finding 12 — `valueAtPath` and `collectLeafPaths` disagree on arrays-as-leaves
- **Severity:** Low · **Category:** Code Duplication / Correctness
- **Files:** `src/utils/propertyValues.ts`
- **Problem:** `valueAtPath` descends into arrays; `collectLeafPaths` treats them as leaves.
- **Fix approach:** Treat arrays as leaves in `valueAtPath`.
- **Test:** `propertyValues.test.ts` via `idsMissingPaths` — a path descending INTO an array is treated as missing; a path resolving to an array leaf is present.
- **Status:** ✅ fixed — `valueAtPath` leaf check now includes `Array.isArray(current)`, matching `collectLeafPaths`. 27/27 green.

### Finding 13 — `stubs` aggregation built/run in the API layer
- **Severity:** Low · **Category:** Layer Violation
- **Files:** `server/api/annotation.py:518-563`
- **Problem:** Pipeline constructed and `collection.aggregate` called inline in the endpoint, unlike the rest of the PR which routes through the model's `_aggregate`.
- **Fix approach:** Add `Annotation.stubs(...)` model method using `_aggregate`; endpoint passes clean inputs. Behavior-preserving refactor — keep existing tests green.
- **Test:** existing stub tests stay green (`test_stubs.py`, 19 tests).
- **Status:** ✅ fixed — added `Annotation.stubs(datasetId, shape, tags)` routing through `_aggregate` (same hint/options); endpoint now just resolves access and calls it. Removed the now-unused `AGGREGATION_MAX_TIME_MS` import from the API file.

### Finding 14 — Selection watcher spreads full selection + `ensureHydrated` every change
- **Severity:** Low · **Category:** Performance
- **Files:** `src/components/AnnotationViewer.vue` selection watcher
- **Problem:** Materializes `[...ids]` and scans on every selection mutation.
- **Fix approach:** Pass the Set to `ensureHydrated` (iteration only) and/or early-return when nothing newly needs hydration.
- **Test:** existing AnnotationViewer/AnnotationList suites green (444 tests); `tsc` clean.
- **Status:** ✅ fixed — `ensureHydrated` now takes `Iterable<string>` (drops the `[...ids]` spread); the selection watcher passes the Set directly. `idsNeedingHydration` already iterated an iterable.

### Finding 15 — Client table uses two independent sorts (Vuetify vs `dataTableItems`)
- **Severity:** Low · **Category:** Correctness (fragile)
- **Files:** `src/components/AnnotationBrowser/AnnotationList.vue:189-206,719-739`
- **Problem:** Page-jump logic re-sorts with a hand-rolled comparator that can diverge from Vuetify's internal sort → wrong page.
- **Fix approach:** Make the parallel comparator agree with the table's display order.
- **Test:** existing AnnotationList suite green; `tsc` clean. (A full display-vs-page assertion needs a mounted Vuetify table; the fix instead mirrors Vuetify's exact algorithm so they cannot diverge.)
- **Status:** ✅ fixed — rather than reconfigure the table (UX risk: arrows/sort order), `dataTableItems`' comparator (the only consumer is `getPageFromItemId`) now mirrors Vuetify 4's internal `sortItems` exactly (lowercase compare, numeric coercion, empties-first, `Intl.Collator`). The table's display is untouched, so the page-lookup order matches what it renders.

### Finding 16 — `addAnnotationImpl` clones whole stub/hydrated maps per single insert
- **Severity:** Low · **Category:** Performance
- **Files:** `src/store/annotation.ts:654-678`
- **Problem:** O(N) per single add; O(N²) if ever looped.
- **Fix approach:** Document that single-add must not be looped (route bulk through `addAnnotationsImpl`); leave singular path as-is since it's interactive. Confirm no looped caller exists.
- **Test:** n/a (no behavior change) — verified `addAnnotationImpl` has a single caller (the interactive tool-create action at `annotation.ts:644`), not looped; bulk uses `addAnnotationsImpl`.
- **Status:** ✅ fixed — added a guard comment documenting the O(stub count) cost and the no-loop requirement.

### Finding 17 — Empty inner `idConstraints` (`[[]]`) silently matches nothing
- **Severity:** Nit · **Category:** Redundant Validation / edge case
- **Files:** `server/helpers/validation.py:174-196`
- **Problem:** `[[]]` validates (vacuous `all`) then emits `{"_id": {"$in": []}}`.
- **Fix approach:** Reject empty inner constraint lists at validation (or drop them).
- **Test:** pytest — `idConstraints: [[]]` → 400 (`testEmptyInnerIdConstraintReturns400`).
- **Status:** ✅ fixed — `validateListInputs` now requires each inner constraint list to be non-empty (`len(c) > 0`); an empty OUTER list stays a no-op.

### Finding 18 — Redundant conjunct in `stubRadius`
- **Severity:** Nit · **Category:** Redundant Validation
- **Files:** `src/components/AnnotationViewer.vue:1417-1420`
- **Problem:** `isStub && !isHydratedAnnotation(annotation)` repeats the same test.
- **Fix approach:** Drop the redundant `isStub` conjunct.
- **Test:** n/a (cleanup) — `tsc` clean, AnnotationViewer suite green.
- **Status:** ✅ fixed — `stubRadius` now `!isHydratedAnnotation(annotation) ? estimatedRadius ?? 5 : 5` (the narrow is what reaches `.estimatedRadius`); added a comment that it's only read on the stub path (covers the F20 `stubRadius` nit too).

### Finding 19 — Public heavy aggregations unauthenticated, no rate limit
- **Severity:** Nit (observation) · **Category:** Security / Access Control
- **Files:** `server/api/annotation.py` public endpoints, `propertyValues.py batch`
- **Problem:** `@access.public` full-collection aggregations bounded only by `AGGREGATION_MAX_TIME_MS`.
- **Fix approach:** Author already chose high count-caps as garbage-only guards with runtime bounded by `maxTimeMS` (documented in `validation.py`). Decide: accept as-is (document) or lower `maxTimeMS` for public paths.
- **Test:** n/a.
- **Status:** ⏭️ accepted, won't-fix in the app (decided 2026-06-24). These endpoints serve public datasets and are already (a) input-validated to 400 on garbage, (b) runtime-bounded by `AGGREGATION_MAX_TIME_MS` (5 min) with index hints, and (c) capped against pathological payloads. **Decision (Arjun):** leave the public endpoints as-is; rate limiting will be handled at the **proxy (HAProxy) layer later**, not in application code. No `maxTimeMS` change for public paths. Do not re-flag this in future reviews — it is an intentional, deferred infra task owned at the proxy, not an app-code gap.

### Finding 20 — Minor naming/clarity nits
- **Severity:** Nit · **Category:** Naming
- **Items:**
  - ✅ `_pvDrivenPagePipeline` hardcoded `"from": "upenn_annotation"` → now `self.name` (backend; `tox` 284 green).
  - ✅ `stubRadius` clarified with a comment that it's only read on the stub path (done with F18).
  - ✅ `selectRandomSubset` → renamed `selectStableSubset` across `annotation.ts` + 2 test files, with a JSDoc clarifying it's deterministic, not a uniform sample.
- **Fix approach:** Apply the cleanups; rename only if low-risk (check call sites).
- **Test:** n/a (cleanup) — `tsc` clean; affected suites green.
- **Status:** ✅ fixed — all three items applied.

---

<a id="archived-branch-review-stub-annotations-style-pass"></a>

## Archived Source: `BRANCH-REVIEW-stub-annotations-style-pass.md`

# Branch Review — `feature/stub-annotations` — Style Pass

**Scope:** A style/convention-conformance pass over the branch diff vs `master`,
complementary to the correctness rounds already completed
(`BRANCH-REVIEW-stub-annotations.md`, `...-round2.md`). This pass looked **only**
at stylistic conformance to documented repo conventions and local-idiom matching
(does new code read like its neighbors?) — not logic, performance, or access
control, which prior rounds covered.

**Overall:** The branch is highly conformant. New code consistently uses
`<script setup lang="ts">`, the button taxonomy, semantic color tokens, `I`/`T`
type prefixes, named-export utils with JSDoc, `logWarning`/`logError`, and proper
store-module organization. Backend is flake8-clean (all 5 files). This pass found
one genuinely important issue (a NUL byte that made a source file binary and thus
invisible to every prior review) plus a set of small import-hygiene, naming, and
comment-density deviations.

## Status legend
- [ ] TODO — not yet addressed
- [~] IN PROGRESS
- [x] DONE — fixed (commit/verification noted inline)
- [-] WONTFIX — deliberately not changed (reason noted inline)

## Progress
All 12 findings addressed: 11 fixed, 1 reviewed and kept as-is (Finding 11,
WONTFIX with rationale). Final verification: `pnpm tsc`, `pnpm lint:ci`, the
touched Vitest suites, and backend `tox` — results recorded below.

---

## Findings

### [x] Finding 1 — NUL byte makes `propertyValues.ts` a binary file
> **DONE.** Removed the duplicate `serializePath` (whose body held the NUL) and
> repointed both call sites at the shared `createPathStringFromPathArray()` from
> `@/utils/paths`. File is now UTF-8 text; `propertyValues.test.ts` (27 tests)
> passes. The "." separator is collision-safe here for the same documented reason
> the util uses it (MongoDB forbids "." in field names / property sub-ids).
- **Severity:** High
- **Category:** Encoding / Hygiene (with latent correctness + code duplication)
- **File:** `src/utils/propertyValues.ts:17`

**Current** (`hexdump`: `6e 28 22 00 22 29` = `n ( " <NUL> " )`):
```typescript
function serializePath(path: string[]): string {
  return path.join("\0");   // byte between the quotes is 0x00, not "."
}
```

**Fix:** Retype the separator. Prefer reusing the existing canonical util
`createPathStringFromPathArray()` in `src/utils/paths.ts:16` (which does
`path.join(".")` for exactly this purpose), or at minimum `path.join(".")`.

**Rationale:** A single `0x00` at offset 0x182 trips git's binary heuristic, so
the whole 6.4 KB module shows as `Bin 0 -> 6446 bytes` — no readable diff, no
line-level review, broken blame/merge. This is why the file was never examined in
the correctness rounds. `serializePath` is internal to the module so behavior is
self-consistent today (latent, not active, bug), but it must be retyped, and
ideally folded into the existing util to remove duplication.

---

### [x] Finding 2 — Stray "Finding N" review artifacts in committed comments
> **DONE.** Removed all 7 `(Finding N)` parentheticals across the 4 files,
> keeping the explanatory prose. `grep` confirms none remain; flake8 still clean.
- **Severity:** Low
- **Category:** Docstring / Comment
- **Files (7 sites):** `server/models/annotation.py:251,608`;
  `server/models/propertyValues.py:147`; `server/api/annotation.py:616,627`;
  `server/helpers/validation.py:148,192`

**Fix:** Drop the `(Finding N)` parentheticals, keep the explanatory prose.

**Rationale:** They reference review-round numbering meaningless in the committed
tree; nothing else in the plugin references "Finding N".

---

### [x] Finding 3 — Lone `import` placed ~2,400 lines into the file
> **DONE.** Moved `import type AnnotationsAPI from "./AnnotationsAPI"` into the
> top import group (next to the other `./` sibling imports). eslint clean.
- **Severity:** Low
- **Category:** Import Order
- **File:** `src/store/annotation.ts:2430`

**Current:**
```typescript
import type AnnotationsAPI from "./AnnotationsAPI";
async function _hydrateFromBackend(api: AnnotationsAPI, ...) {
```

**Fix:** Hoist `import type AnnotationsAPI` into the top import group.

**Rationale:** Every other import is at the top; a type-only import has no
ordering constraint forcing it mid-file.

---

### [x] Finding 4 — Module-level `const` wedged between import blocks
> **DONE.** Moved `propertyFilterRequestGuard` (and its comment) below the now-
> contiguous import block, before `type TFilterHistograms` — matching
> `annotationListServer.ts`. eslint clean.
- **Severity:** Low
- **Category:** Import Order
- **File:** `src/store/filters.ts:22-25`

**Fix:** Keep all imports contiguous; declare
`const propertyFilterRequestGuard = createSequenceGuard();` after the import
block (as `annotationListServer.ts:33` does).

**Rationale:** Interleaving a declaration between import groups (it currently
splits imports into three groups) is inconsistent with the file and its siblings.

---

### [x] Finding 5 — Separate `import type` instead of inline `type` on `./model`
> **DONE.** Folded the four type-only names into the existing
> `import { ... } from "./model"` block using inline `type` qualifiers (the
> file's own idiom for the `@/utils/annotationUpdate` import). eslint clean.
- **Severity:** Nit
- **Category:** Import Order
- **File:** `src/store/annotation.ts:33-38`

**Fix:** Fold the type-only names into the single existing
`import { ... } from "./model"` using inline `type` qualifiers — the idiom this
file already uses for `@/utils/annotationUpdate` (l.54-59).

**Rationale:** Two imports from one module breaks the file's own inline-`type`
pattern.

---

### [x] Finding 6 — Paragraph-length trailing field comments on `IVisibilityConfig`
> **DONE.** Converted all 7 fields to wrapped leading comments (full prose
> preserved, now within print width), matching the short-trailing-comment idiom
> used elsewhere in `model.ts`. eslint clean.
- **Severity:** Nit
- **Category:** Comment Style
- **File:** `src/store/model.ts:1454-1460`

**Fix:** Move prose into a leading block comment; keep trailing field comments
terse (cf. neighbors `// In GCS coordinates`, `// Time in seconds`).

**Rationale:** Every other interface in `model.ts` uses short trailing comments;
these 150-220-char trailing comments are far denser than any neighbor and
overflow Prettier's print width.

---

### [x] Finding 7 — JSDoc separated from its function by an interface
> **DONE.** Moved `interface IHasKey` above the JSDoc so the doc block is now
> flush against `export function idsNeedingHydration`. eslint clean.
- **Severity:** Nit
- **Category:** Comment Style
- **File:** `src/utils/annotation.ts:473-485`

**Fix:** Move `interface IHasKey` above the JSDoc so the doc sits flush against
`export function idsNeedingHydration`.

**Rationale:** Neighbors keep JSDoc immediately adjacent to the documented
subject; the interposed interface makes the doc read as documenting `IHasKey`.

---

### [x] Finding 8 — `body` local where siblings use `bodyJson`
> **DONE.** Renamed the `memoizedBodyJson` locals (and their in-method uses) to
> `bodyJson` in `listAnnotationIds` and `listAnnotations`. Left
> `uncomputedCounts(self, body)` alone — there `body` is the `autoDescribeRoute`
> jsonParam name, the correct idiom. flake8 clean.
- **Severity:** Nit
- **Category:** Naming
- **File:** `server/api/annotation.py:582,607`

**Fix:** `bodyJson = kwargs["memoizedBodyJson"]`.

**Rationale:** The other 9 extractions in this file (and 5 in `connections.py`)
name the local `bodyJson`.

---

### [x] Finding 9 — Opaque `pf` loop variable across two backend files
> **DONE.** Renamed all `pf` → `propertyFilter` (14 in `models/annotation.py`,
> 21 in `helpers/validation.py`, including docstring refs), matching the
> `propertyFilters` collection name. Reflowed 4 lines (1 docstring, 1 boolean
> return, 1 list comprehension) that crossed 79 chars. flake8 clean.
- **Severity:** Nit
- **Category:** Naming
- **Files:** `server/models/annotation.py` (~l.333,660,670);
  `server/helpers/validation.py` (~l.104,173)

**Fix:** Rename to `propertyFilter` (or `propFilter`).

**Rationale:** `pf` is introduced by this branch, used nowhere else in the
plugin; repo convention prefers descriptive names, and it appears pervasively
across two files.

---

### [x] Finding 10 — Single-name import expanded to 3-line parenthesized form
> **DONE.** Collapsed to
> `from ..models.annotation import Annotation as AnnotationModel` (61 chars).
> flake8 clean.
- **Severity:** Nit
- **Category:** Import Order
- **File:** `server/api/annotation.py:24-26`

**Current:**
```python
from ..models.annotation import (
    Annotation as AnnotationModel,
)
```

**Fix:** `from ..models.annotation import Annotation as AnnotationModel`
(fits under 79 chars; master and `connections.py` use the one-liner).

---

### [-] Finding 11 — `as string` cast in template markup  (WONTFIX — reviewed)
> **WONTFIX, with rationale.** On inspection this is a deliberate, documented
> design, and "fixing" it would *reduce* quality:
> - `PropertyColumnHeader.sortIcon` is intentionally typed `string` with a
>   comment: "Vuetify's getSortIcon is typed IconValue but always returns a
>   string … the parent narrows it." The `as string` cast IS that narrowing.
> - `getSortIcon` and `column` are Vuetify **slot-scoped** values; their types
>   are inferred *in the template*. Extracting the cast to a `<script>` helper
>   would force `any`/`unknown` params (the slot types aren't importable),
>   losing that inference — a net type-safety regression.
> - Widening the child prop to Vuetify's `IconValue` isn't viable: that type is
>   an internal `framework.d.ts` declaration, not cleanly exported from
>   `vuetify` and used nowhere in `src`.
>
> Net: the current template-level cast is the type-safest minimal option.
> Leaving as-is. (Happy to relocate it into an `any`-typed script helper if the
> markup-purity is preferred over the inference — flag if so.)
- **Severity:** Nit
- **Category:** Type Safety
- **File:** `src/components/AnnotationBrowser/AnnotationList.vue:218,257`

**Current:** `:sort-icon="getSortIcon(column) as string"`

**Fix:** Narrow once in `<script>` (e.g. make `getSortIcon` return a typed
`string`) rather than casting in markup.

**Rationale:** Casts elsewhere in these components live in `<script>`, not the
template. Narrowly justified; flagged for completeness.

---

### [x] Finding 12 — Braceless single-line `if`
> **DONE.** Braced the `if (hydrated)` body to match the file's dominant style.
> eslint clean.
- **Severity:** Nit
- **Category:** Pattern Consistency
- **File:** `src/store/annotation.ts:133`

**Current:** `if (hydrated) return hydrated;`

**Fix:** `if (hydrated) { return hydrated; }`

**Rationale:** The file is ~107 braced `if` bodies to effectively one braceless;
this breaks the dominant local style.

---

## Verification (post-fix)
- `pnpm tsc` (vue-tsc --noEmit): **pass** (exit 0).
- `pnpm lint:ci` (eslint, --max-warnings=0): **pass** (exit 0).
- `pnpm exec vitest run src/`: **pass** — 2400 tests across 138 files.
- backend `flake8` on all 5 touched files: **pass** (clean) throughout.
- backend `tox` (plugin pytest): **pass** — 284 passed, 0 failures (py311).
  Covers `test_server_list`, `test_uncomputed_counts`, `test_stubs`,
  `test_annotations`, `test_export` — the suites exercising the edited code.

All green. Changes are staged in the working tree (not committed).

## Lower-confidence items checked but NOT flagged (no action)
- `spatialIndex.ts:3` `interface SpatialItem` not `I`-prefixed — file-private,
  and `src/utils/` interface naming is genuinely mixed; no firm local norm.
- Backend `%`-style formatting vs f-strings — codebase leans f-string but `%`
  has local precedent in the plugin; mixed, not a defect.
- Backend comprehension wrapping at `annotation.py:556-557` — purely cosmetic.
