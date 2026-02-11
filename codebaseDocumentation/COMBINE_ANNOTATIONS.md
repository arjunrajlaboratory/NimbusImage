# Combine Annotations Feature Documentation

## Overview

The Combine Annotations feature allows users to merge two polygon (blob) annotations into a single annotation. This is useful for correcting segmentation errors or combining related objects that should be treated as one.

---

## User Guide

### Accessing the Tool

1. Open the tool panel
2. Select **Annotation Edits** from the tool categories
3. Choose **Click to combine** from the action dropdown

### Using the Tool

1. **First click**: Click on the first polygon annotation you want to combine. It will be highlighted to show it's selected.
2. **Second click**: Click on the second polygon annotation. The two annotations will be merged into one.

### Tolerance Setting

The tool has a configurable **Tolerance (pixels)** parameter (default: 2 pixels):

- **Overlapping polygons**: Always merge successfully
- **Adjacent polygons within tolerance**: Will be merged by creating a small connector region
- **Polygons farther apart than tolerance**: Operation is aborted, both annotations remain unchanged

### What Happens When Combining

- The **first clicked** annotation is updated with the combined shape
- The **second clicked** annotation is deleted
- Any **connections** referencing the second annotation are transferred to the first
- **Property values** on the deleted annotation are cleaned up automatically by the backend

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interaction                          │
│                    (AnnotationViewer.vue)                        │
├─────────────────────────────────────────────────────────────────┤
│  1. setNewAnnotationMode() - Sets point mode for click detection │
│  2. handleAnnotationCombine() - Two-click state machine          │
│     - First click: Store annotation ID in tool state             │
│     - Second click: Call combineAnnotations action               │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Store Action                              │
│                    (annotation.ts)                               │
├─────────────────────────────────────────────────────────────────┤
│  combineAnnotations({ firstAnnotationId, secondAnnotationId,     │
│                       tolerance })                               │
│  1. Fetch both annotations                                       │
│  2. Compute polygon union with tolerance                         │
│  3. Update first annotation with union coordinates               │
│  4. Transfer connections from second to first                    │
│  5. Delete second annotation                                     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Polygon Union Utility                        │
│                   (utils/polygonUnion.ts)                        │
├─────────────────────────────────────────────────────────────────┤
│  computePolygonUnionWithTolerance(coords1, coords2, tolerance)   │
│  1. Try standard union with polygon-clipping library             │
│  2. If single polygon result → return (polygons overlapped)      │
│  3. If multiple polygons → check distance between them           │
│     - If distance > tolerance → return null (abort)              │
│     - If distance ≤ tolerance → create connector and merge       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Files

### Frontend

| File | Purpose |
|------|---------|
| `src/components/AnnotationViewer.vue` | Tool interaction handling, two-click state machine |
| `src/store/annotation.ts` | `combineAnnotations` action with connection transfer logic |
| `src/store/index.ts` | Tool state initialization for combine_click action |
| `src/store/model.ts` | `ICombineToolState` interface and symbol |
| `src/utils/polygonUnion.ts` | Polygon union algorithm with tolerance support |
| `public/config/templates.json` | Tool template definition under "Annotation Edits" |

### Type Declarations

| File | Purpose |
|------|---------|
| `src/shims-polygon-clipping.d.ts` | TypeScript declarations for polygon-clipping library |

---

## Tool Configuration

The tool is defined in `public/config/templates.json` under the "Annotation Edits" tool:

```json
{
  "text": "Click to combine",
  "value": "combine_click",
  "description": "Click two blobs to merge them into one",
  "meta": {
    "interface": [
      {
        "name": "Tolerance (pixels)",
        "type": "text",
        "id": "tolerance",
        "meta": {
          "value": "2",
          "type": "number"
        }
      }
    ]
  }
}
```

The tool also inherits the "Annotations to edit" filter from the parent "Annotation Edits" tool, allowing users to restrict which annotations can be combined based on tags and layers.

---

## Algorithm Details

### Tolerance-Based Union

The `computePolygonUnionWithTolerance` function handles three cases:

1. **Overlapping polygons**: Standard polygon union produces a single result polygon

2. **Adjacent polygons within tolerance**:
   - Find closest points between polygon boundaries
   - Translate both polygons toward each other by the tolerance amount
   - Compute intersection of shifted polygons (creates connector region)
   - Union original polygons with connector
   - Return largest polygon from result

3. **Far-apart polygons**: Return `null` to abort the operation

### Closest Point Calculation

The algorithm finds the minimum distance between any two edges of the polygons:

1. For each edge in polygon A, check against each edge in polygon B
2. For each edge pair, compute point-to-segment distances for all four endpoints
3. Return the overall minimum distance and the corresponding points

### Fallback Connector

If the intersection of shifted polygons fails (edge case), a rectangular connector is created between the closest points with a width of 1 pixel.

---

## Connection Transfer Logic

When combining annotations, connections are handled as follows:

1. Find all connections where the second annotation is parent or child
2. For each connection:
   - Replace references to second annotation with first annotation
   - Skip if this would create a self-connection
   - Skip if the connection already exists (avoid duplicates)
3. Delete old connections and create new ones using batch API calls

---

## Tool State

The combine tool uses `ICombineToolState` to track the two-click interaction:

```typescript
export interface ICombineToolState {
  type: TCombineToolStateSymbol;
  selectedAnnotationId: null | string;
}
```

- `selectedAnnotationId: null` - No annotation selected (waiting for first click)
- `selectedAnnotationId: "abc123"` - First annotation selected (waiting for second click)

After combining (or clicking the same annotation twice), the state resets to `null`.

---

## Visual Feedback

The first selected annotation is highlighted using the same mechanism as the connection tool:

```typescript
get toolHighlightedAnnotationIds(): Set<string> {
  const state = this.selectedToolState;
  if (
    (state?.type === ConnectionToolStateSymbol ||
      state?.type === CombineToolStateSymbol) &&
    state.selectedAnnotationId
  ) {
    return new Set([state.selectedAnnotationId]);
  }
  return new Set();
}
```

---

## Error Handling

- **Annotations not found**: Logs error and returns `false`
- **Polygons too far apart**: Logs descriptive error message and returns `false`
- **Polygon clipping errors**: Caught and logged with `logError`
- **API errors**: Caught in try/catch, logged, and returns `false`

All errors use `logError` from `@/utils/log` for consistent logging.

---

## Dependencies

- **polygon-clipping** (`^0.15.7`): Robust polygon boolean operations library
  - Uses robust-predicates for numerical precision
  - Handles complex polygon shapes including holes

---

## Future Improvements

- [ ] Support combining more than two annotations at once
- [ ] Visual preview of the combined shape before confirming
- [ ] Undo support for combine operations
- [ ] Option to keep both original annotations and create a new combined one
