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

Based on actual annotation data:

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

For 10,000 annotations:
- Current: ~5.8 MB just for annotation data
- With stubs: ~1.0 MB
- **Savings: ~4.8 MB**

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
- [ ] Phase 4: Selection and Interaction Updates (NEXT)
  - [ ] Update selection to work without GeoJS annotations (for non-rendered stubs)
  - [ ] Implement centroid-based intersection testing for stubs
  - [ ] Consider spatial indexing for large datasets
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
