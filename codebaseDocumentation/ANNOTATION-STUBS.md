# Stub Annotations Architecture

## Overview

The annotation system uses a stub/hydrated architecture to efficiently handle large numbers of annotations. Annotations are loaded as lightweight stubs (centroid + metadata, no coordinates) and selectively hydrated (full coordinates loaded) based on viewport, size, and selection state.

**Branch:** `feature/stub-annotations`
**Status:** Frontend implementation complete (mock data strategy). Backend stub API deferred.

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
two-tier visibility budget (max 20K)
  Tier 1: inViewportIds (hash-ranked if over budget)
  Tier 2: outOfViewportIds (hash-ranked, fill remaining)
       │
       ▼
visibleAnnotationIds (render budget)
       │
       ▼
two-tier hydration budget (max 10K)
  Tier 1: inViewportIds (largest first by estimatedRadius)
  Tier 2: outOfViewportIds (largest first, fill remaining)
       │
       ▼
hydratedAnnotations (top 10K, shapes rendered)
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
  maxVisible: number;   // Max annotations to render (default 20,000)
  maxHydrated: number;  // Max annotations to hydrate as shapes (default 10,000)
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
| `src/store/annotation.ts` | New state: `annotationStubs`, `hydratedAnnotations`, `visibleAnnotationIds`, `hydrationMode`, `visibilityConfig`. New getters: `isHydrated`, `getStub`, `getHydratedAnnotation`, `isVisible`, `shouldRenderAsShape`, `getForRendering`. New mutations: `setVisibleAnnotationIds`, `setHydrationMode`, `hydrateAnnotations`, `clearNonSelectedHydration`. New action: `updateVisibilityAndHydration`. Modified mutations: `setAnnotations`, `addAnnotationImpl`, `setAnnotation` |
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
3. First 20% of annotations (by array order) are kept in `hydratedAnnotations`
4. The full `annotations[]` array is retained for backward compatibility with all existing consumers (AnnotationBrowser, export, property computation, etc.)

**Implication:** The mock strategy uses MORE memory than the current system (stubs + full array), not less. The savings come when the backend returns real stubs (Phase 5).

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
- Stubs render as dots sized to their actual annotation size (bbox diagonal / 2)
- Minimum radius of 3 world units to keep tiny annotations visible
- `stubRadius` stored in GeoJS annotation options for restyle persistence

### Selection includes non-visible annotations
- `getSelectedAnnotationsFromAnnotation()` queries both the displayed RBush and the global `annotationSpatialIndex`
- Drag-select catches ALL annotations in the region on the current frame, regardless of visibility budget
- Frame filtering (XY, Z, Time) applied to global candidates

---

## To-Do List

### Threshold and Hydration Refinement
- [ ] Test and tune `maxVisible` (currently 20,000) — balance between coverage and rendering performance
- [ ] Test and tune `maxHydrated` (currently 10,000) — how many shapes to render before performance degrades
- [ ] Consider making thresholds configurable via UI settings panel
- [ ] Evaluate whether size-based hydration ranking (largest first) is the right heuristic vs. alternatives (density, distance to viewport center, user focus area)
- [ ] Consider zoom-based adaptive thresholds — show shapes only when annotations are large enough relative to the viewport (code is deferred/commented out in Vue 2 version)
- [ ] Profile `updateVisibilityAndHydration` with 100K+ annotations to identify bottlenecks
- [ ] Review debounce timing (currently 250ms) for responsiveness vs CPU trade-off
- [ ] Test hydration/dehydration memory churn during rapid pan/zoom

### Styling Adjustments
- [ ] Review whether stubs should respect `scaleAnnotationsWithZoom` setting or always use fixed world size
- [ ] Consider different hover/selection effects for stubs vs full annotations
- [ ] Fine-tune stub visual distinction (currently thinner stroke + lower opacity)

### Selection Improvements
- [ ] Verify point-click selection works correctly for stub annotations (centroid hit-testing)
- [ ] Consider whether non-visible, non-rendered annotations should be selectable via point-click (currently only drag-select catches them)

### Backend API (Phase 5 — Deferred)
- [ ] Create `GET /upenn_annotation/stubs` endpoint returning stub data with server-computed centroids
- [ ] Create `GET /upenn_annotation/hydrate` batch endpoint returning full annotations by ID
- [ ] Remove mock data strategy from `setAnnotations` — replace with real stub fetching
- [ ] Server-side `estimatedRadius` computation (client won't have coordinates)

### On-Demand Hydration (Phase 6 — Deferred)
- [ ] Hydrate on selection (currently done via mock — needs real API)
- [ ] Consider hydrate-on-hover for quick preview
- [ ] Hydration batching/queuing (50ms debounce to batch requests)
- [ ] Hydrate all before export operations
- [ ] Handle hydration failures gracefully

### Connection Stubs (Phase 7 — Optional)
- [ ] Evaluate if connections need stub treatment (typically fewer than annotations)

---

## Resolved Design Decisions

1. **Stub fields**: Include tags, shape, channel, location, centroid, color, estimatedRadius. Exclude datasetId (redundant), name (usually null), coordinates (the whole point)
2. **Selection architecture**: ID-based (`Set<string>` with `markRaw()`)
3. **Stub rendering**: Points at centroid, sized to `estimatedRadius`
4. **Vue 3 reactivity**: All new Maps/Sets wrapped with `markRaw()`, replaced on mutation for Vuex reactivity
5. **Two spatial indexes coexist**: Displayed annotations RBush (bbox-based, for click/lasso hit-testing) and global centroid RBush (for visibility viewport queries). Independent, different purposes.
6. **`annotations[]` retained**: Full array stays for backward compatibility. Stub architecture is additive.
7. **Shape as string enum**: Not worth compressing to numeric index (~13 bytes savings vs added complexity)
