# Annotation Performance Optimizations

Branch: `codex/perf-audit-annotation-viewer`

## Summary

Performance optimizations targeting the annotation rendering pipeline and store operations, focused on reducing unnecessary work when annotations are styled, selected, or filtered. The biggest gains come from separating hover/select into a restyle-only path (avoiding full redraws), replacing O(n) linear scans with O(1) Set/Map lookups, and eliminating Vuetify `deepEqual` overhead in drag-select by storing selection as primitive string IDs instead of full annotation objects.

## Changes

### 1. GeoJS Annotation Reuse — REVERTED

**What was proposed:** Reuse existing GeoJS annotations instead of clearing and redrawing all, using reference identity checks (`annotationRef === annotation`).

**Why reverted:** The dominant trigger for `drawAnnotationsNoThrottle` is slice changes (Z, Time, XY), and annotations are slice-specific — when you change slices, the entire set of displayed annotations changes. The reuse logic would build index maps and run identity checks only to conclude "remove everything, draw everything" nearly every time. The added complexity wasn't justified for the rare cases where it would help (e.g., connection changes on the same slice). The code was reverted to keep `clearOldAnnotations(true)` (clear all) as the default path.

### 2. Hover/Select Restyle Separation (AnnotationViewer.vue)

**What:** `hoveredAnnotationId` and `selectedAnnotationIds` were removed from the primary watcher (which triggers full redraw) and placed in a separate watcher that calls `restyleAnnotations()` instead.

**Why:** Hovering or selecting an annotation only changes visual style (stroke width, color, opacity), not geometry or position. A full redraw was unnecessary and caused perceptible lag with many annotations.

**Implication:** `restyleAnnotations` skips connections (`isConnection` check). If connection styling ever needs to respond to hover/selection, this would need updating.

### 3. Set/Map Lookups in Store Mutations (annotation.ts)

**What:** Replaced `Array.includes()` and `Array.find()` with `Set.has()` in:

- `inactiveAnnotationIds` getter
- `activateAnnotations` mutation
- `deactivateAnnotations` mutation
- `toggleActiveAnnotations` action
- `selectAnnotations` mutation
- `unselectAnnotations` mutation
- `toggleSelected` action
- `deleteAnnotations` action

**Why:** `Array.includes()` is O(n) per call. When called inside a filter over another array, the total becomes O(n\*m). Set lookup is O(1).

**Implication:** Straightforward improvement with no behavioral change.

### 4. `displayableAnnotationsByChannel` Computed (AnnotationViewer.vue)

**What:** Extracted channel-based annotation grouping into its own computed property (`displayableAnnotationsByChannel`), shared between `layerAnnotations` and `getDisplayedAnnotationIdsAcrossTime`.

**Why:** Previously, `layerAnnotations` built its own channel map on every evaluation. `getDisplayedAnnotationIdsAcrossTime` iterated all annotations for every layer even when only a subset matched the layer's channel. The shared computed avoids redundant grouping and narrows iteration scope.

**Implication:** Also fixes a minor inefficiency in `getDisplayedAnnotationIdsAcrossTime` where the inner `if (annotation.channel === layer.channel)` check is now redundant (annotations are already grouped by channel). The check remains as a safety guard but could be removed.

### 5. Timelapse Track Index Maps (AnnotationViewer.vue)

**What:** `drawTimelapseTrack` now builds `annotationsById` (Map) and `connectionsByAnnotationId` (Map) indexes before the main loop, and uses `Map.get()` for lookups instead of `Array.find()` and inner loops.

**Why:** The old code iterated all connections for every annotation (O(annotations \* connections)) and used `Array.find()` to look up connected annotations (O(annotations) per lookup). Now both are O(1) lookups after an O(n) indexing pass.

**Staleness concern:** The index maps are local variables rebuilt from scratch on every call — they are not cached between invocations. When connections change, the `annotationConnections` watcher fires the primary change handler, which calls `drawAnnotationsAndTooltips` → `drawTimelapseConnectionsAndCentroids` → `drawTimelapseTrack`, rebuilding the maps with current data.

### 6. Union-Find Path Compression (AnnotationViewer.vue)

**What:** The `find()` function in `findConnectedComponents` now uses path compression — after finding the root, intermediate nodes are updated to point directly to the root.

**Why:** Without path compression, repeated `find()` calls on deep chains are O(depth). With compression, amortized cost approaches O(1).

### 7. Property Path Deduplication (properties.ts)

**What:** `computedPropertyPaths` was rewritten from a two-pass approach (build nested object tree, then collect leaf paths) to a single-pass approach using a Map keyed by serialized paths (null-byte joined).

**Why:** The old approach created many intermediate objects and did two full traversals. The new approach collects unique paths in one pass. `updateDisplayedFromComputedProperties` also now uses a Set for O(1) path membership checks instead of `arePathEquals` comparisons.

**Implication:** The `arePathEquals` import and `TNestedObject` type were removed as no longer needed.

### 8. Reduce+Spread Accumulator Elimination (AnnotationViewer.vue)

**What:** `getSelectedAnnotationsFromAnnotation` and `getTimelapseAnnotationsFromAnnotation` were rewritten from `.reduce()` with `[...selected, item]` spread to imperative loops with `.push()`.

**Why:** `[...selected, item]` inside a reduce copies the entire accumulator array on every iteration, making it O(n^2) total. Push is O(1) amortized.

### 9. `updateAnnotationsPerId` Uses Index Map (annotation.ts)

**What:** Changed from `this.annotations.findIndex()` to `this.annotationIdToIdx[annotationId]` for looking up annotations by ID.

**Why:** `findIndex` is O(n) per call. The existing `annotationIdToIdx` getter provides O(1) lookup.

### 10. `drawNewConnections` Signature Change (AnnotationViewer.vue)

**What:** Changed from accepting `Map<string, IGeoJSAnnotation[]>` (the full drawn annotations map) to `Set<string>` (just drawn connection IDs). Connections and annotations are now tracked separately in `drawAnnotationsNoThrottle`.

**Why:** Connections only need an ID membership check, not access to the GeoJS annotation objects. Separating them avoids polluting the annotation map with connection entries.

### 11. Minor Loop Hoisting (AnnotationViewer.vue)

**What:** In `drawTooltipsNoThrottle` and `restyleAnnotations`, reactive values (`displayedAnnotations.value`, `propertyValues.value`, `annotationLayer.annotations()`) are read once before the loop instead of inside callbacks.

**Why:** Avoids repeated reactive proxy access overhead in hot loops. Small but consistent improvement.

### 12. R-tree Spatial Index for Drag-Select (AnnotationViewer.vue)

**What:** Added an RBush-based R-tree spatial index (`displayedAnnotationsSpatialIndex`) over `displayedAnnotations`. During drag-select, the selection polygon's bounding box is queried against the R-tree to narrow candidates before running `pointInPolygon` checks.

**Why:** The previous drag-select iterated all GeoJS annotations on the layer and called `shouldSelectAnnotation` for each — O(n) per selection with expensive geometry checks. The R-tree narrows candidates to only those whose bounding boxes overlap the selection region, typically a small fraction of total annotations.

**Async build:** The R-tree is built asynchronously via `requestIdleCallback` to avoid blocking the main thread during slice changes. A `watch` on `displayedAnnotations` triggers `buildSpatialIndex`, which invalidates the current tree immediately (sets it to `null`) and schedules the rebuild. If a lasso-select occurs before the tree is ready (e.g., immediately after a slice change), the code falls back to a linear scan over `annotationLayer.annotations()` — functionally correct, just slower.

**Implication:** Added `rbush` as a dependency. The fallback ensures selection always works regardless of tree readiness.

### 13. Store Selection by ID Instead of Annotation Objects (annotation.ts, AnnotationViewer.vue, AnnotationList.vue)

**What:** Changed `selectedAnnotations: IAnnotation[]` to `selectedAnnotationIds: Set<string>` in the annotation store. All selection mutations now accept `string[]` (IDs) instead of `IAnnotation[]`. The Set is wrapped with `markRaw()` to prevent Vue from creating a deep reactive proxy. Consumers that need full annotation objects do their own lookups via `getAnnotationFromId`.

**Why:** After the R-tree spatial index optimization, the drag-select bottleneck shifted from `pointInPolygon` to Vue/Vuetify reactivity overhead (~56% of time). Two sources of `deepEqual` were identified and eliminated:

1. **Vuetify `v-data-table` selection model:** The data table in `AnnotationList.vue` was bound via `v-model="selectedItems"` (full `IAnnotationListItem` objects). Vuetify's `select.ts` composable calls `deepEqual(v, item.value)` for every non-primitive selected value against every row item — O(n\*m) deep comparisons of large annotation objects. Fixed by binding `v-model="selectedIds"` (primitive `string[]`), which hits the `isPrimitive` fast path using `===` instead of `deepEqual`.

2. **Store-level reactivity:** Storing full `IAnnotation` objects in `selectedAnnotations` meant Vue's reactivity system tracked and compared large objects on every selection change. The `Set<string>` stores only IDs, and `markRaw()` prevents Vue from deep-proxying the Set contents, consistent with other large store data structures (`annotationCentroids`, `annotationIdToIdx`).

**What changed:**

- `annotation.ts`: `selectedAnnotations` state → `selectedAnnotationIds: Set<string>`. The old `selectedAnnotationIds` getter removed (now primary state). `isAnnotationSelected` getter simplified to read directly from Set. All selection mutations (`setSelected`, `selectAnnotation`, `selectAnnotations`, `unselectAnnotation`, `unselectAnnotations`, `toggleSelected`) accept string IDs and construct new `markRaw(new Set(...))` on each mutation for Vue 3 reactivity. `copySelectedAnnotations` looks up full objects via `getAnnotationFromId`. Actions that pass IDs downstream (`tagSelectedAnnotations`, `colorSelectedAnnotations`, `deleteSelectedAnnotations`) spread the Set to `string[]`.
- `AnnotationViewer.vue`: `selectedAnnotations` computed → `selectedAnnotationIds`. Template uses `.size` instead of `.length`. `selectAnnotations()` maps annotations to IDs before dispatching to store.
- `AnnotationList.vue`: `v-model="selectedItems"` → `v-model="selectedIds"` on `v-data-table`. `selected` computed → `selectedIds` (primitive string array). `selectedItems` simplified to read-only computed. `selectAllCallback` and `toggleAnnotationSelection` pass IDs.
- `filters.ts`: `addSelectionAsFilter` reads `selectedAnnotationIds` directly (already a Set of strings).
- `AnnotationActionPanel.vue`: Spreads Set for `.join()`.
- `DeleteConnections.vue`: Removed redundant `new Set()` wrapping.
- Tests updated to use `new Set<string>()` mocks.

**Implication:** Also fixed a pre-existing bug where `unselectAnnotation` used `.splice()` (in-place mutation), which wouldn't trigger Vue 3 watchers. Now all mutations replace the Set reference.

### 14. Guard Lasso-Select When Annotations Hidden (AnnotationViewer.vue)

**What:** Added early return in `getSelectedAnnotationsFromAnnotation` when `shouldDrawAnnotations` is false.

**Why:** The R-tree spatial index queries `displayedAnnotations` regardless of whether annotations are drawn on the canvas. Without this guard, lasso-select could select (and then edit/delete) annotations that are not visible to the user. The previous implementation (before the R-tree) iterated `annotationLayer.annotations()` which naturally returned none when drawing was disabled.

## Vue 3 Reactivity Consideration

Several mutations were initially changed from array spread (`this.arr = [...this.arr, ...items]`) to `.push()` for performance. However, Vue 3's `watch()` uses `Object.is()` for change detection — `.push()` keeps the same array reference, so watchers won't fire.

**Reverted to spread:** `addMultipleConnections`, `addConnectionImpl` (both have active watchers in AnnotationViewer.vue).

**Kept as .push():** `activateAnnotations` (no watchers on this array).

**Selection mutations (change #12):** Now operate on `Set<string>` instead of arrays. Every mutation constructs a new `markRaw(new Set(...))` to ensure reference change triggers watchers.

## What Remains to Test

### UI Scenarios (ordered by expected impact)

1. **Pan/zoom with many annotations** — Load a dataset with 500+ annotations, pan and zoom.
2. **Hover over annotations** — With many annotations visible, hovering should be snappier with no flicker (change #2). Verify hover highlight appears/disappears correctly.
3. **Select/deselect annotations** — Shift-click multiple annotations rapidly. Verify selection highlight updates correctly (changes #2, #3, #13).
4. **Drag-select many annotations** — Draw a selection rectangle over 200+ annotations. Should be significantly faster after changes #12 and #13 (R-tree + eliminated deepEqual overhead).
5. **Add new connections** — Create connections between annotations. Verify they appear on the canvas immediately (verifies the spread-revert fix for `addConnectionImpl`/`addMultipleConnections`).
6. **Change Z/Time slices** — Navigate through Z-stack or time series with many annotations. Benefits from channel-indexed lookup (change #4). R-tree rebuilds asynchronously after slice change (change #12).
7. **Timelapse mode** — Enable timelapse tracking with connected objects. Verify tracks render correctly and performance is improved with many connections (change #5).
8. **Tooltips with property values** — Enable annotation tooltips showing computed properties. Verify values display correctly with many annotations (change #11).
9. **Annotation list selection** — Select annotations from the annotation browser list. Verify table checkboxes, select-all, and deselect-all work correctly (change #13).
10. **Lasso-select with hidden annotations** — Disable "Draw annotations", then try lasso-select. Should select nothing (change #14).
11. **Lasso-select immediately after slice change** — Change Z/Time, then immediately lasso-select before R-tree finishes building. Should still work via linear fallback (change #12).

### Edge Cases

- Annotations that span multiple layers (same channel, different layers)
- Connections where parent or child is off-screen or on a hidden layer
- Rapid toggling of layer visibility with many annotations
- Mixed annotation types (points, lines, polygons) on the same layer
