# Stub Annotations Architecture

## Overview

This document describes the staged implementation plan for refactoring the annotation system to use a stub/hydrated architecture. The goal is to improve performance when working with large numbers of annotations by loading minimal data initially and hydrating full details on demand.

## Problem Statement

Currently, all annotation data is loaded fully when fetching annotations for a dataset. With thousands of annotations, this causes:
- Slow initial load times
- High memory usage
- UI lag when filtering/rendering

## Proposed Solution: Stub/Hydrated Architecture

### Concept

**Stub Annotation**: Minimal data for display and filtering - rendered as a point at the centroid
- `id`: Unique identifier
- `centroid`: { x, y } computed from coordinates (single point, not full geometry)
- `location`: { XY, Z, Time } for filtering by frame
- `shape`: Original shape type (for UI display, not rendering)
- `channel`: For layer assignment
- `tags`: For filtering
- `color`: Custom color override (falls back to layer color if null)

**Hydrated Annotation**: Full annotation data (current IAnnotation)
- All current fields including full `coordinates` array
- `name`: User-assigned name
- `datasetId`: Parent dataset reference

### Memory Analysis

**Theoretical estimates** (complex polygons with 20 coordinates):

```
Polygon with 20 coordinates:
- coordinates array: 20 * ~24 bytes = ~480 bytes
- Other fields: ~100 bytes
- Total: ~580 bytes

Stub (centroid only):
- centroid: ~24 bytes
- Other fields: ~80 bytes
- Total: ~104 bytes

Memory reduction: ~82% per annotation
```

**Real-world measurements** (26K annotations, mostly 4-coordinate rectangles):

Using the `memoryStats` getter on actual data:

```
Field breakdown (avg bytes per annotation):
- id: 48           (MongoDB ObjectId string)
- datasetId: 48    (MongoDB ObjectId - REDUNDANT, removed from stubs)
- location: 54     ({XY, Z, Time} object with string keys)
- tags: 36         (array of tag strings)
- shape: 14        (enum string like "polygon")
- channel: 8       (number)
- color: 1         (usually null)
- name: 0          (usually null)
- coordinates: 160 (4 coords × ~40 bytes each)

Total per annotation: ~369 bytes
- Metadata: ~209 bytes
- Coordinates: ~160 bytes
```

**Actual savings for 26K simple annotations:**
- Removing `datasetId`: 48 bytes × 26K = **1.19 MB**
- Removing `name`: ~0 (already null)
- Removing coordinates (80% stubs): ~2.07 MB
- **Total savings: ~3.2 MB (~35% reduction)**

**Key insight**: For simple shapes (4 coordinates), metadata dominates storage. The biggest wins come from removing redundant fields (`datasetId`) rather than coordinate compression.

### Architecture Pattern

```typescript
// Stub - minimal data, rendered as point at centroid
interface IAnnotationStub {
  id: string;
  centroid: IGeoJSPosition;      // Single point computed from coordinates
  location: IAnnotationLocation;  // { XY, Z, Time }
  shape: AnnotationShape;         // For UI display (not used in stub rendering)
  channel: number;
  tags: string[];
  color: string | null;           // Falls back to layer color
}

// Full annotation - has coordinates for actual shape rendering
interface IAnnotation extends IAnnotationBase {
  id: string;
  name: string | null;
  coordinates: IGeoJSPosition[];  // Full geometry
  // ... other fields
}

// Store tracks both
interface IAnnotationStore {
  annotationStubs: Map<string, IAnnotationStub>;
  hydratedAnnotations: Map<string, IAnnotation>;
  selectedAnnotationIds: Set<string>;  // ID-based selection

  isHydrated(id: string): boolean;
  hydrate(ids: string[]): Promise<IAnnotation[]>;
}
```

### Rendering Strategy

1. **Check if annotation is hydrated**
2. **If hydrated**: Render full shape using coordinates (point, line, polygon, rectangle)
3. **If stub only**: Render as a point at the centroid with appropriate color

This means:
- Stubs are always visible but simplified (points)
- When user interacts with an annotation, it gets hydrated and renders fully
- User sees the actual shapes for annotations they care about

### Stub Field Decisions

Based on real-world memory profiling, we made deliberate decisions about what to include/exclude from stubs:

#### Fields INCLUDED in stubs:

| Field | Bytes | Reason |
|-------|-------|--------|
| `id` | 48 | Required to identify the annotation |
| `tags` | ~36 | Required for filtering |
| `shape` | 14 | Useful for UI display (showing original shape type) |
| `channel` | 8 | Required for layer assignment |
| `location` | 54 | Required for frame filtering (XY, Z, Time) |
| `centroid` | ~56 | Replaces coordinates for stub rendering |
| `color` | ~1 | Custom color override (usually null) |

#### Fields EXCLUDED from stubs:

| Field | Bytes | Reason |
|-------|-------|--------|
| `datasetId` | 48 | **Redundant** - identical for all annotations in a dataset. The store already knows the current dataset. Saves ~1.2 MB for 26K annotations. |
| `name` | ~24 | Usually null. Can retrieve from hydrated annotation when needed. |
| `coordinates` | varies | Replaced by `centroid`. This is the primary memory savings. |

#### Fields we considered optimizing but kept as-is:

**`shape` (kept as string enum, not numeric index)**

We considered storing shape as a numeric index (1 byte) instead of string ("polygon" = 14 bytes) to save ~13 bytes per annotation (~340 KB for 26K annotations).

**Decision: Keep as string enum.**

Reasoning:
1. The savings (~340 KB) are modest compared to `datasetId` removal (~1.2 MB)
2. Converting between index and enum adds CPU overhead on every stub creation
3. For datasets with millions of annotations, this overhead compounds
4. The string enum is more debuggable and doesn't require lookup tables
5. Complexity cost outweighs the memory benefit

**`location` (kept as object, not compact integers)**

We considered storing location as 3 raw integers (12 bytes) instead of `{XY, Z, Time}` object (~54 bytes).

**Decision: Keep as object for now.**

Reasoning:
1. Would require changes throughout the codebase that expects the object format
2. The savings (~1 MB for 26K annotations) are meaningful but require more refactoring
3. Can revisit if memory becomes a bottleneck

---

## Implementation Phases

### Phase 1: Testing Infrastructure ✅ COMPLETED

**Goal**: Establish unit tests for existing `annotation.ts` store before making changes.

**Files Created**:
- `src/store/__tests__/testUtils.ts` - Mock factories and test helpers
- `src/store/__tests__/annotation.test.ts` - Unit tests

**Tests Cover**:
- Selection operations (setSelected, selectAnnotation, unselectAnnotation, toggleSelected)
- Copy/paste operations
- CRUD operations (create, delete)
- Tag operations (add, remove, replace)
- Fetch operations
- Getters and computed properties
- Stub/hydrated architecture
- Memory statistics

**Verification**: `pnpm test` - All 74 tests pass

---

### Phase 2: Frontend Store Refactoring ✅ COMPLETED

**Goal**: Refactor annotation store to manage stubs and hydrated annotations separately. Use mock data initially (first 20% hydrated, rest as stubs computed from full data).

#### 2.1 Type Definitions

Add to `src/store/model.ts`:
```typescript
export interface IAnnotationStub {
  id: string;
  centroid: IGeoJSPosition;
  location: IAnnotationLocation;
  shape: AnnotationShape;
  channel: number;
  tags: string[];
  color: string | null;
}
```

#### 2.2 Store State Changes

In `src/store/annotation.ts`:
```typescript
// New state
annotationStubs: Map<string, IAnnotationStub> = new Map();
hydratedAnnotations: Map<string, IAnnotation> = new Map();

// Change selection to ID-based
selectedAnnotationIds: Set<string> = new Set();

// Keep for backward compatibility (computed from stubs + hydrated)
get annotations(): IAnnotation[] { ... }
```

#### 2.3 Selection Refactoring

Current selection stores full `IAnnotation[]` objects. Refactor to ID-based:

```typescript
// Current (object-based)
selectedAnnotations: IAnnotation[] = [];
selectAnnotation(annotation: IAnnotation) { ... }

// New (ID-based)
selectedAnnotationIds: Set<string> = new Set();
selectAnnotationById(id: string) { ... }

// Computed getter for compatibility
get selectedAnnotations(): IAnnotation[] {
  return [...this.selectedAnnotationIds]
    .map(id => this.hydratedAnnotations.get(id))
    .filter((a): a is IAnnotation => a !== undefined);
}
```

#### 2.4 Mock Data Strategy (for testing)

For initial implementation without backend changes:
1. Fetch all annotations as usual
2. Keep first 20% as hydrated (by ID order)
3. Convert remaining 80% to stubs (compute centroid from coordinates)
4. This lets us test the full frontend flow before backend work

```typescript
// Temporary: convert annotation to stub
function annotationToStub(annotation: IAnnotation): IAnnotationStub {
  const centroid = computeCentroid(annotation.coordinates);
  return {
    id: annotation.id,
    centroid,
    location: annotation.location,
    shape: annotation.shape,
    channel: annotation.channel,
    tags: annotation.tags,
    color: annotation.color,
  };
}
```

#### 2.5 New Store Methods

```typescript
// Check if annotation has full data
isHydrated(id: string): boolean {
  return this.hydratedAnnotations.has(id);
}

// Get stub for any annotation (hydrated or not)
getStub(id: string): IAnnotationStub | undefined {
  return this.annotationStubs.get(id);
}

// Get full annotation (only if hydrated)
getHydratedAnnotation(id: string): IAnnotation | undefined {
  return this.hydratedAnnotations.get(id);
}

// Get annotation for rendering - returns full if hydrated, stub otherwise
getAnnotationForRendering(id: string): IAnnotationStub | IAnnotation | undefined {
  return this.hydratedAnnotations.get(id) ?? this.annotationStubs.get(id);
}

// All annotation IDs (stubs are the source of truth for "what exists")
get allAnnotationIds(): string[] {
  return [...this.annotationStubs.keys()];
}
```

---

### Phase 3: Rendering with Stubs ✅ COMPLETED

**Goal**: Update AnnotationViewer to render stubs as points, hydrated as full shapes.

**Changes to `src/components/AnnotationViewer.vue`**:

1. Modified `createGeoJSAnnotation` to check hydration status using `isHydratedAnnotation()` type guard
2. For stubs: render as point at centroid
3. For hydrated: render full shape as currently done

```typescript
// In createGeoJSAnnotation
if (isHydratedAnnotation(annotation)) {
  // Full shape - use actual coordinates
  coordinates = this.unrolledCoordinates(annotation.coordinates, ...);
  renderShape = annotation.shape;
} else {
  // Stub: render as point at centroid location
  coordinates = this.unrolledCoordinates([annotation.centroid], ...);
  renderShape = AnnotationShape.Point;
}
```

**Color handling**:
- Use `annotation.color` if set
- Fall back to layer color (existing behavior)

---

### Phase 4: Dynamic Visibility and Hydration 🔄 IN PROGRESS

**Goal**: Add dynamic visibility tracking and smart hydration to efficiently render 100K+ annotations. Annotations outside the viewport or above count thresholds render as dots; those in view and under thresholds render as full shapes.

#### 4.1 Architecture Overview

**Data Flow**:
```
annotations[] (full data, simulates backend)
       │
       ▼
annotationStubs (what exists - source of truth)
       │
       ▼
filteredAnnotations (user filters applied)
       │
       ▼
gcsBounds filtering (viewport spatial filter)  ← NEW
       │
       ▼
_visibleAnnotationIds (render budget, max 10K)
       │
       ▼
hydrationMode (shapes vs dots based on count + zoom)
       │
       ▼
hydratedAnnotations (full data for visible shapes)
       │
       ▼
GeoJS Renderer (dots or full geometry)
```

#### 4.2 New State Fields

Added to `src/store/annotation.ts`:

```typescript
// Visibility tracking (plain object for Vue 2 reactivity)
_visibleAnnotationIds: { [id: string]: true } = {};

// Hydration mode - 'shapes' or 'dots'
hydrationMode: THydrationMode = "dots";

// Configuration thresholds
visibilityConfig: IVisibilityConfig = {
  maxVisible: 10000,      // Max annotations to render
  hydrateThreshold: 5000, // Max to show as shapes
  zoomThreshold: 3,       // Min zoom level for shapes
};
```

#### 4.3 New Types

Added to `src/store/model.ts`:

```typescript
export type THydrationMode = "shapes" | "dots";

export interface IVisibilityConfig {
  maxVisible: number;
  hydrateThreshold: number;
  zoomThreshold: number;
}
```

#### 4.4 Core Action: `updateVisibilityAndHydration`

The main entry point for the visibility system. Called on filter changes, zoom, or pan.

```typescript
@Action
updateVisibilityAndHydration(params: {
  filteredIds: string[];
  zoom: number;
  gcsBounds?: IGeoJSPosition[];  // Viewport corners for spatial filtering
}) {
  // 1. Filter by viewport bounds (spatial filtering)
  let viewportFilteredIds = filteredIds;
  if (gcsBounds && gcsBounds.length === 4) {
    // Compute axis-aligned bounding box from 4 corners
    const xs = gcsBounds.map((p) => p.x);
    const ys = gcsBounds.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    // Filter to annotations whose centroid is in viewport
    viewportFilteredIds = filteredIds.filter((id) => {
      const centroid = this.annotationCentroids[id];
      if (!centroid) return false;
      return centroid.x >= minX && centroid.x <= maxX &&
             centroid.y >= minY && centroid.y <= maxY;
    });
  }

  // 2. Apply maxVisible budget
  const visibleIds = viewportFilteredIds.length <= maxVisible
    ? viewportFilteredIds
    : viewportFilteredIds.slice(0, maxVisible);

  // 3. Determine hydration mode
  const showShapes = visibleIds.length <= hydrateThreshold && zoom >= zoomThreshold;

  // 4. Apply state changes
  this.setVisibleAnnotationIds(visibleIds);
  this.setHydrationMode(showShapes ? "shapes" : "dots");

  // 5. Hydrate as needed
  if (showShapes) {
    this.hydrateFromBackend(visibleIds);
  } else {
    this.clearNonSelectedHydration();
  }

  // 6. Always hydrate selected (they render as shapes)
  if (this.selectedAnnotationIds.length > 0) {
    this.hydrateFromBackend(this.selectedAnnotationIds);
  }
}
```

#### 4.5 Key Getters

```typescript
// Check if annotation should be rendered
get isVisible() {
  return (id: string): boolean => id in this._visibleAnnotationIds;
}

// Check if annotation should render as shape (not dot)
get shouldRenderAsShape() {
  return (id: string): boolean => {
    if (id in this._selectedAnnotationIds) {
      return this.hydratedAnnotations.has(id);
    }
    return this.hydrationMode === "shapes" && this.hydratedAnnotations.has(id);
  };
}

// Get annotation for rendering (respects hydration mode)
get getForRendering() {
  return (id: string): TAnnotationOrStub | undefined => {
    if (this.shouldRenderAsShape(id)) {
      return this.hydratedAnnotations.get(id);
    }
    return this.annotationStubs.get(id);
  };
}
```

#### 4.6 AnnotationViewer.vue Changes

**Added getters**:
```typescript
get zoom() {
  return this.store.cameraInfo.zoom;
}

get gcsBounds() {
  return this.store.cameraInfo.gcsBounds;
}
```

**Added watcher with debouncing**:
```typescript
@Watch("filteredAnnotations")
@Watch("zoom")
@Watch("gcsBounds")
onVisibilityInputsChanged() {
  this.updateVisibilityDebounced();
}

updateVisibilityDebounced = debounce(() => {
  const filteredIds = this.filteredAnnotations.map((a) => a.id);
  this.annotationStore.updateVisibilityAndHydration({
    filteredIds,
    zoom: this.zoom,
    gcsBounds: this.gcsBounds,
  });
}, 100);
```

**Updated `layerAnnotations` getter**:
```typescript
// Skip annotations not in visibility budget
if (!this.annotationStore.isVisible(annotation.id)) continue;

// Use getForRendering which respects hydration mode
const annotationOrStub = this.annotationStore.getForRendering(annotation.id);
```

#### 4.7 ImageViewer.vue Bug Fix

**Problem**: Zoom changes weren't updating `cameraInfo` because only `pan` events were listened to.

**Fix**: Added zoom event listener in `_setupMap`:
```typescript
map.geoOn(geojs.event.pan, synchronizationCallback);
map.geoOn(geojs.event.zoom, synchronizationCallback);  // ADDED
```

#### 4.8 Observed Behavior

| State | Zoom | Viewport Annotations | Hydration Mode | Result |
|-------|------|---------------------|----------------|--------|
| Zoomed out | -0.39 | 10,000 (capped) | dots | Circles at centroids |
| Zoomed in | 5 | 44 | shapes | Full rectangles |

The system correctly switches between modes based on viewport contents and zoom level.

#### 4.9 Remaining To-Do Items

**Styling Adjustments (4.6)**:
- [ ] Adjust dot size for stub rendering (currently uses default point size)
- [ ] Review shape outline thickness and colors
- [ ] Consider different visual treatment for dots vs shapes (opacity, border style)
- [ ] Ensure selected annotations stand out visually in both modes

**Threshold Tuning (4.7)**:
- [ ] Test and tune `maxVisible` (currently 10,000) - balance between coverage and performance
- [ ] Test and tune `hydrateThreshold` (currently 5,000) - when to switch to shapes
- [ ] Test and tune `zoomThreshold` (currently 3) - minimum zoom for shapes
- [ ] Consider making thresholds configurable via UI or configuration

**Performance Review (4.8)**:
- [ ] Profile `updateVisibilityAndHydration` with 100K+ annotations
- [ ] Evaluate cost of viewport filtering (iterates all filtered annotations)
- [ ] Review debounce timing (currently 100ms) - balance responsiveness vs CPU
- [ ] Monitor memory usage during rapid pan/zoom
- [ ] Test hydration/dehydration memory churn

**R-tree Spatial Index (4.10)**:
- [ ] Implement R-tree for efficient viewport queries (current O(n) filtering won't scale to 100K+)
- [ ] Evaluate libraries: `rbush` (lightweight), `flatbush` (static, very fast), or custom implementation
- [ ] Index annotation centroids on dataset load
- [ ] Replace linear viewport filtering in `updateVisibilityAndHydration` with R-tree bbox query
- [ ] Consider R-tree for selection (click/lasso) to avoid iterating all annotations
- [ ] Benchmark: compare current linear scan vs R-tree query performance

**Selection Updates (4.9)**:
- [ ] Verify selection works correctly with visibility filtering
- [ ] Test that selected annotations always render as shapes
- [ ] Consider whether non-visible annotations should be selectable

---

## Current Selection/Intersection Mechanism

Understanding how drag selection and click selection work is critical for future phases.

### How Drag/Click Selection Works Now

1. **`getSelectedAnnotationsFromAnnotation()`** (line 1842 in AnnotationViewer.vue):
   - Iterates over `this.annotationLayer.annotations()` - the **GeoJS annotations rendered on the map**
   - For each GeoJS annotation, extracts `girderId` from options
   - Calls `this.getAnnotationFromId(girderId)` to get the **full `IAnnotation`**
   - Calls `shouldSelectAnnotation()` to test intersection

2. **`shouldSelectAnnotation()`** (line 1787):
   - Uses `annotation.coordinates` from the **full annotation** to test intersection
   - For point selection: checks if click is near annotation coordinates
   - For lasso/box selection: checks if any annotation coordinate is inside the selection polygon

3. **`getAnnotationFromId()`**:
   - Currently looks up from `this.annotations[]` array via `annotationIdToIdx`
   - Returns full `IAnnotation` with all coordinates

### Current Behavior with Mock Data

With the mock data strategy (20% hydrated, 80% stubs):
- **GeoJS renders**: stubs as points at centroid, hydrated as full shapes
- **Intersection testing**: uses `this.annotations[]` which still has **full coordinates for ALL annotations**
- **Result**: A stub rendered as a point can be selected by clicking/dragging over where its **original polygon boundary** was (not just the visible point)

### Vue 2 Reactivity Considerations

**Important**: Vue 2 cannot track changes to `Set` or `Map` objects. The selection system uses:
```typescript
// Using plain object instead of Set for Vue 2 reactivity
_selectedAnnotationIds: { [id: string]: true } = {};
```

Selection mutations create **new objects** to trigger reactivity:
```typescript
// selectAnnotation
this._selectedAnnotationIds = { ...this._selectedAnnotationIds, [id]: true };

// unselectAnnotation
const { [id]: _, ...rest } = this._selectedAnnotationIds;
this._selectedAnnotationIds = rest;
```

---

## Future Selection Considerations (Phase 4+)

### When Annotations Are Not Rendered

In future phases, we may have so many annotations that we don't render all of them (e.g., only render annotations in the current viewport, or limit to N annotations). This requires a different selection strategy.

### Option 1: Spatial Index for Stub Selection

Instead of iterating over GeoJS annotations, use a spatial index on stubs:

```typescript
// Future: R-tree or quadtree index on stub centroids
interface ISpatialIndex {
  queryBox(bounds: IBounds): IAnnotationStub[];
  queryPoint(point: IGeoJSPosition, radius: number): IAnnotationStub[];
}

// Selection would query the index directly
function selectAnnotationsInBox(box: IBounds): string[] {
  return spatialIndex.queryBox(box).map(stub => stub.id);
}
```

### Option 2: Server-Side Selection

For very large datasets, selection could be done server-side:

```typescript
// POST /upenn_annotation/select
// Body: { datasetId, bounds: {minX, minY, maxX, maxY}, location: {XY, Z, Time} }
// Returns: string[] of annotation IDs
```

### Key Changes Needed for Non-Rendered Selection

1. **`getSelectedAnnotationsFromAnnotation()`** must not rely on `annotationLayer.annotations()`
2. **`shouldSelectAnnotation()`** must work with stubs (centroid-only intersection)
3. Selection should work on `annotationStubs` Map directly, not rendered GeoJS annotations
4. Consider using the stored `annotationCentroids` for efficient spatial queries

### Stub-Based Intersection Testing

When we only have stubs (no full coordinates), intersection testing changes:

```typescript
// Future: stub-based selection
function shouldSelectStub(
  selectionType: 'point' | 'box',
  selectionCoords: IGeoJSPosition[],
  stub: IAnnotationStub,
): boolean {
  if (selectionType === 'point') {
    // Point selection: check if click is near centroid
    return distance(selectionCoords[0], stub.centroid) < CLICK_RADIUS;
  } else {
    // Box selection: check if centroid is inside selection box
    return pointInPolygon(stub.centroid, selectionCoords);
  }
}
```

**Trade-off**: Centroid-based selection is less precise than full-coordinate selection, but works without hydrating annotations.

---

## Memory Statistics

### `memoryStats` Getter

The annotation store includes a `memoryStats` getter for monitoring memory usage:

```typescript
// Access in browser console:
$store.annotation.memoryStats
```

**Returns:**
```typescript
{
  // Counts
  totalAnnotations: number;
  stubCount: number;
  hydratedCount: number;
  hydratedPercent: number;

  // Byte estimates
  totalCoordinateBytes: number;      // All coordinate data
  hydratedCoordinateBytes: number;   // Coordinates for hydrated only
  stubCoordinateBytes: number;       // Coordinates that could be freed

  // Memory usage comparison
  currentMockUsageBytes: number;     // Current mock implementation
  theoreticalUsageBytes: number;     // With real stub API
  fullUsageBytes: number;            // If everything was hydrated
  theoreticalSavingsBytes: number;   // Potential savings
  theoreticalSavingsPercent: number; // Savings as percentage

  // Human-readable (MB)
  currentMockUsageMB: string;
  theoreticalUsageMB: string;
  fullUsageMB: string;
  theoreticalSavingsMB: string;
}
```

**Important Caveat**: The current mock implementation doesn't actually save memory because we still keep all full annotations in `this.annotations` (for backward compatibility with `getAnnotationFromId`). The `theoreticalSavings*` values show what you **would** save when the backend returns actual stubs without coordinates.

### Memory Estimation Constants

```typescript
const BYTES_PER_COORDINATE = 24;  // x, y, z as 8-byte doubles
const BYTES_PER_STUB = 200;       // Approximate overhead for metadata
```

---

### Phase 4: Selection and Interaction Updates

**Goal**: Ensure all selection and interaction logic works with ID-based selection.

**Changes needed**:

1. **AnnotationViewer.vue**: Update click handlers to use IDs
2. **AnnotationBrowser/**: Update list selection to use IDs
3. **Toolbar/tools**: Update selection-dependent tools

**Selection triggers hydration** (future):
- When annotation is selected, queue it for hydration
- This ensures selected annotations always have full data for editing

---

### Phase 5: Backend API for Stub Fetching (DEFERRED)

**Goal**: Create API endpoint that returns stub data efficiently.

**Backend Changes** (in `devops/girder/plugins/AnnotationPlugin`):

1. **New endpoint**: `GET /upenn_annotation/stubs`
   - Parameters: `datasetId`, `limit`, `offset`
   - Returns: Array of stub objects with server-computed centroids
   - MongoDB aggregation to compute centroids efficiently

2. **Batch hydration endpoint**: `GET /upenn_annotation/hydrate`
   - Parameters: `ids` (array of annotation IDs)
   - Returns: Full annotation objects for requested IDs

**Example API Response**:
```json
// GET /upenn_annotation/stubs?datasetId=xxx
{
  "stubs": [
    {
      "id": "abc123",
      "centroid": {"x": 280, "y": 315},
      "location": {"XY": 0, "Z": 0, "Time": 0},
      "shape": "polygon",
      "channel": 0,
      "tags": ["DAPI blob"],
      "color": null
    }
  ],
  "total": 10000,
  "hasMore": true
}
```

---

### Phase 6: On-Demand Hydration

**Goal**: Implement smart hydration triggers.

**Hydration Triggers**:
1. **Selection**: When annotation is selected, hydrate it
2. **Hover** (optional): Pre-hydrate on hover for quick access
3. **Edit**: Before opening edit dialog, ensure hydrated
4. **Export**: Hydrate all before export operations
5. **Batch operations**: Hydrate affected annotations

**Hydration Batching**:
```typescript
// Queue hydration requests
private hydrationQueue: string[] = [];
private hydrationTimeout: number | null = null;

requestHydration(id: string) {
  if (this.isHydrated(id)) return;

  this.hydrationQueue.push(id);
  if (!this.hydrationTimeout) {
    this.hydrationTimeout = setTimeout(() => {
      this.flushHydrationQueue();
    }, 50); // Batch requests within 50ms
  }
}

async flushHydrationQueue() {
  const ids = [...new Set(this.hydrationQueue)];
  this.hydrationQueue = [];
  this.hydrationTimeout = null;
  await this.hydrateAnnotations(ids);
}
```

---

### Phase 7: Connection Stubs (Optional)

**Goal**: Apply same pattern to connections if needed.

Connections are typically fewer than annotations, so this may not be necessary. Evaluate after Phase 6.

---

## Testing Strategy

### Unit Tests (Phase 1 - Done)
- Test store mutations and actions in isolation
- Mock API calls
- Verify state changes

### Unit Tests (Phase 2)
- Test stub/hydrated state management
- Test ID-based selection
- Test centroid computation
- Test backward compatibility getters

### Integration Tests (Phase 3+)
- Test rendering with mixed stubs/hydrated
- Test hydration flow
- Test fallback when hydration fails

### E2E Tests (Phase 5+)
- Test full workflow with real backend
- Measure performance improvements
- Test edge cases (offline, slow network)

---

## Performance Goals

| Metric | Current | Target |
|--------|---------|--------|
| Initial load (10K annotations) | ~5s | <1s |
| Memory usage (10K annotations) | ~5.8MB | <1.5MB |
| Filter responsiveness | 200ms | <50ms |
| Annotation click response | 50ms | 50ms (+ hydration if needed) |

---

## Rollback Plan

If issues arise:
1. Phase 2-3: Feature flag to use old `annotations` array directly
2. Phase 4+: Revert to full fetch, API changes are additive
3. Keep `fetchAnnotations()` working as fallback

---

## Resolved Questions

1. **Tag filtering**: Include tags in stub ✅
2. **Coordinates in stub**: NO - use centroid only for memory savings ✅
3. **Selection architecture**: ID-based (refactor from object-based) ✅
4. **Stub rendering**: As points at centroid with layer/custom color ✅
5. **Color handling**: Include in stub, fall back to layer color ✅
6. **Vue 2 reactivity**: Use plain objects `{ [id: string]: true }` instead of `Set<string>` ✅
7. **Selection mutations**: Create new objects (spread/destructure) to trigger reactivity ✅
8. **datasetId in stub**: NO - redundant, same for all annotations in dataset. Saves ~48 bytes/annotation ✅
9. **name in stub**: NO - usually null, can get from hydrated annotation when needed ✅
10. **shape as numeric index**: NO - conversion overhead not worth ~13 bytes savings. Keep as string enum ✅

## Open Questions

1. **Property values**: How to handle computed properties?
   - Properties are stored separately, no change needed

2. **Connections**: Include connection data in stubs?
   - Start without, add if needed for track visualization

3. **Cache invalidation**: When to clear hydrated cache?
   - On dataset change, configuration change, or manual refresh

4. **Centroid computation**: Server-side vs client-side?
   - Phase 2: Client-side (temporary, from full coordinates)
   - Phase 5: Server-side (MongoDB aggregation)

5. **Non-rendered annotation selection**: How to select annotations that aren't rendered?
   - Current: Selection iterates over `annotationLayer.annotations()` (GeoJS)
   - Future: Need spatial index on stubs, or query `annotationStubs` directly
   - See "Future Selection Considerations" section above

6. **Stub intersection precision**: Accept centroid-only intersection for stubs?
   - Trade-off: Less precise but works without hydration
   - For large datasets, centroid-based selection may be acceptable

---

## Related Files

### Store
- `src/store/annotation.ts` - Main annotation store
- `src/store/model.ts` - Type definitions
- `src/store/AnnotationsAPI.ts` - API client

### Components
- `src/components/AnnotationViewer.vue` - Canvas rendering
- `src/components/AnnotationBrowser/` - List and filtering UI

### Backend
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/rest/annotation.py`
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/models/annotation.py`

### Tests
- `src/store/__tests__/testUtils.ts` - Test utilities
- `src/store/__tests__/annotation.test.ts` - Store tests

---

## Progress Tracking

- [x] Phase 1: Testing Infrastructure
- [x] Phase 2: Frontend Store Refactoring
  - [x] 2.1 Type definitions (`IAnnotationStub`, `TAnnotationOrStub`, `isHydratedAnnotation`)
  - [x] 2.2 Store state changes (`annotationStubs`, `hydratedAnnotations` Maps)
  - [x] 2.3 Selection refactoring (ID-based with Vue 2 reactivity fix)
  - [x] 2.4 Mock data strategy (20% hydrated, 80% stubs)
  - [x] 2.5 New store methods (`isHydrated`, `getStub`, `getHydratedAnnotation`, `getAnnotationOrStub`, `memoryStats`)
- [x] Phase 3: Rendering with Stubs
  - [x] `createGeoJSAnnotation` handles stubs vs hydrated
  - [x] Stubs render as points at centroid
  - [x] Hydrated render as full shapes
- [~] Phase 4: Dynamic Visibility and Hydration (IN PROGRESS)
  - [x] 4.1 Visibility tracking state (`_visibleAnnotationIds`, `hydrationMode`, `visibilityConfig`)
  - [x] 4.2 Hydration mode switching (shapes vs dots based on count + zoom)
  - [x] 4.3 Viewport-based spatial filtering using `gcsBounds`
  - [x] 4.4 Zoom event listener fix in ImageViewer.vue
  - [x] 4.5 Debounced visibility updates in AnnotationViewer.vue
  - [ ] 4.6 Styling adjustments (dot size, shape outlines, colors)
  - [ ] 4.7 Threshold tuning (`maxVisible`, `hydrateThreshold`, `zoomThreshold`)
  - [ ] 4.8 Performance review and optimization
  - [ ] 4.9 Selection updates for non-rendered annotations (if needed)
  - [ ] 4.10 R-tree spatial index for efficient viewport queries
- [ ] Phase 5: Backend API for Stub Fetching
- [ ] Phase 6: On-Demand Hydration
- [ ] Phase 7: Connection Stubs (Optional)

## Implementation Notes

### Files Modified in Phases 2-3

**`src/store/model.ts`**:
- Added `IAnnotationStub` interface
- Added `TAnnotationOrStub` union type
- Added `isHydratedAnnotation()` type guard

**`src/store/annotation.ts`**:
- Added `annotationStubs: Map<string, IAnnotationStub>`
- Added `hydratedAnnotations: Map<string, IAnnotation>`
- Changed `_selectedAnnotationIds` from `Set<string>` to `{ [id: string]: true }` (Vue 2 reactivity)
- Added getters: `isHydrated`, `getStub`, `getHydratedAnnotation`, `getAnnotationOrStub`, `memoryStats`
- Updated `setAnnotations` mutation with mock data strategy
- Updated selection mutations to create new objects for reactivity

**`src/components/AnnotationViewer.vue`**:
- Updated `createGeoJSAnnotation` to handle `TAnnotationOrStub`
- Uses `isHydratedAnnotation()` type guard to determine rendering strategy
- Stubs use `annotation.centroid` as single coordinate, render as `AnnotationShape.Point`

**`src/store/__tests__/annotation.test.ts`**:
- Added tests for stub/hydrated architecture
- Added tests for memory stats
- Added tests for click/drag selection reactivity

### Files Modified in Phase 4

**`src/store/model.ts`**:
- Added `THydrationMode` type (`"shapes" | "dots"`)
- Added `IVisibilityConfig` interface (thresholds for visibility/hydration)

**`src/store/annotation.ts`**:
- Added `_visibleAnnotationIds: { [id: string]: true }` for visibility tracking
- Added `hydrationMode: THydrationMode` state
- Added `visibilityConfig: IVisibilityConfig` with default thresholds
- Added getters: `isVisible`, `visibleAnnotationIds`, `shouldRenderAsShape`, `getForRendering`
- Added mutations: `setVisibleAnnotationIds`, `setHydrationMode`, `hydrateFromBackend`, `clearNonSelectedHydration`
- Added action: `updateVisibilityAndHydration` with viewport-based spatial filtering

**`src/components/AnnotationViewer.vue`**:
- Added `zoom` getter for camera zoom level
- Added `gcsBounds` getter for viewport bounds
- Added `@Watch("gcsBounds")` to visibility watcher
- Added `updateVisibilityDebounced` function (100ms debounce)
- Updated `layerAnnotations` to use `isVisible` and `getForRendering`

**`src/components/ImageViewer.vue`**:
- Added `geojs.event.zoom` listener to `synchronizationCallback` (bug fix - zoom changes now update `cameraInfo`)

**`src/store/__tests__/annotation.test.ts`**:
- Added tests for visibility state management
- Added tests for hydration mode switching
- Added tests for `updateVisibilityAndHydration` action
