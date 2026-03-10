# Annotation Performance Optimizations

Branch: `codex/perf-audit-annotation-viewer`

## Summary

Performance optimizations targeting the annotation rendering pipeline and store operations, focused on reducing unnecessary work when annotations are drawn, styled, selected, or filtered. The biggest gains come from reusing existing GeoJS annotations instead of clearing and redrawing everything, and from replacing O(n) linear scans with O(1) Set/Map lookups.

## Changes

### 1. GeoJS Annotation Reuse (AnnotationViewer.vue)

**What:** `drawAnnotationsNoThrottle()` no longer calls `clearOldAnnotations(true)` (which removed all annotations). Instead it calls `clearOldAnnotations(false)` which selectively removes only stale annotations, then draws only new ones.

**How:** Each GeoJS annotation now stores an `annotationRef` (the IAnnotation object reference) and connections store `parentAnnotationRef`/`childAnnotationRef`. During cleanup, identity comparison (`annotationRef === annotation`) determines if the annotation is still current — if the reference matches, the annotation is kept. If the underlying data changed (new object from backend), the old GeoJS annotation is removed and a new one drawn.

**Why:** Previously, every call to `drawAnnotationsNoThrottle` destroyed all GeoJS annotations and recreated them from scratch. With hundreds of annotations on screen, this caused significant DOM/canvas churn during panning, zooming, and slice changes.

**Implication:** The `color` check in `clearOldAnnotations` was replaced by reference identity. This works because annotation objects are replaced (not mutated) when their data changes. If annotation mutation patterns change in the future, this assumption would need revisiting.

### 2. Hover/Select Restyle Separation (AnnotationViewer.vue)

**What:** `hoveredAnnotationId` and `selectedAnnotations` were removed from the primary watcher (which triggers full redraw) and placed in a separate watcher that calls `restyleAnnotations()` instead.

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

**Why:** `Array.includes()` is O(n) per call. When called inside a filter over another array, the total becomes O(n*m). Set lookup is O(1).

**Implication:** Straightforward improvement with no behavioral change.

### 4. `displayableAnnotationsByChannel` Computed (AnnotationViewer.vue)

**What:** Extracted channel-based annotation grouping into its own computed property (`displayableAnnotationsByChannel`), shared between `layerAnnotations` and `getDisplayedAnnotationIdsAcrossTime`.

**Why:** Previously, `layerAnnotations` built its own channel map on every evaluation. `getDisplayedAnnotationIdsAcrossTime` iterated all annotations for every layer even when only a subset matched the layer's channel. The shared computed avoids redundant grouping and narrows iteration scope.

**Implication:** Also fixes a minor inefficiency in `getDisplayedAnnotationIdsAcrossTime` where the inner `if (annotation.channel === layer.channel)` check is now redundant (annotations are already grouped by channel). The check remains as a safety guard but could be removed.

### 5. Timelapse Track Index Maps (AnnotationViewer.vue)

**What:** `drawTimelapseTrack` now builds `annotationsById` (Map) and `connectionsByAnnotationId` (Map) indexes before the main loop, and uses `Map.get()` for lookups instead of `Array.find()` and inner loops.

**Why:** The old code iterated all connections for every annotation (O(annotations * connections)) and used `Array.find()` to look up connected annotations (O(annotations) per lookup). Now both are O(1) lookups after an O(n) indexing pass.

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

## Vue 3 Reactivity Consideration

Several mutations were initially changed from array spread (`this.arr = [...this.arr, ...items]`) to `.push()` for performance. However, Vue 3's `watch()` uses `Object.is()` for change detection — `.push()` keeps the same array reference, so watchers won't fire.

**Reverted to spread:** `selectAnnotations`, `addMultipleConnections`, `addConnectionImpl` (all have active watchers in AnnotationViewer.vue).

**Kept as .push():** `activateAnnotations` (no watchers on this array).

## What Remains to Test

### UI Scenarios (ordered by expected impact)

1. **Pan/zoom with many annotations** — Load a dataset with 500+ annotations, pan and zoom. Should feel smoother due to annotation reuse (change #1).

2. **Hover over annotations** — With many annotations visible, hovering should be snappier with no flicker (change #2). Verify hover highlight appears/disappears correctly.

3. **Select/deselect annotations** — Shift-click multiple annotations rapidly. Verify selection highlight updates correctly (changes #2, #3).

4. **Add new connections** — Create connections between annotations. Verify they appear on the canvas immediately (verifies the spread-revert fix for `addConnectionImpl`/`addMultipleConnections`).

5. **Change Z/Time slices** — Navigate through Z-stack or time series with many annotations. Benefits from channel-indexed lookup (change #4).

6. **Timelapse mode** — Enable timelapse tracking with connected objects. Verify tracks render correctly and performance is improved with many connections (change #5).

7. **Tooltips with property values** — Enable annotation tooltips showing computed properties. Verify values display correctly with many annotations (change #11).

8. **Annotation color changes** — Change an annotation's color or layer color. Verify the annotation updates on canvas (tests that reference identity check works when annotation objects are replaced).

### Edge Cases

- Annotations that span multiple layers (same channel, different layers)
- Connections where parent or child is off-screen or on a hidden layer
- Rapid toggling of layer visibility with many annotations
- Mixed annotation types (points, lines, polygons) on the same layer
