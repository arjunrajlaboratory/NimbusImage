# Tool Interaction Patterns (Detailed)

## GeoJS Interaction Layer

`AnnotationViewer.vue` manages a GeoJS interaction layer (`this.interactionLayer`) that handles user interactions. The layer's `mode()` method determines what happens on mouse events.

### Setting Annotation Modes

Set in `setNewAnnotationMode()` based on the active tool's `type` field:

```typescript
// Standard GeoJS annotation modes (set via interactionLayer.mode())
this.interactionLayer.mode("point");     // Single click
this.interactionLayer.mode("line");      // Draw line
this.interactionLayer.mode("polygon");   // Draw polygon
this.interactionLayer.mode("rectangle"); // Draw rectangle
this.interactionLayer.mode(null);        // No built-in mode (for custom handling)
```

### Custom Mouse Handling (null mode)

For tools that don't use GeoJS's built-in annotation creation, set mode to `null` and bind events with `geoOn`:

```typescript
case "myTool":
  this.interactionLayer.mode(null);
  // Bind custom click handler using geoOn
  this.annotationLayer.geoOn(
    geojs.event.mouseclick, this.handleMyToolClick
  );
  break;
```

### Cleanup Pattern

Always unbind custom events with `geoOff` when the component is destroyed or when switching tools:

```typescript
// In beforeDestroy() or when switching away from the tool:
this.annotationLayer.geoOff(geojs.event.mouseclick, this.handleMyToolClick);
this.annotationLayer.geoOff(geojs.event.mousemove, this.handleMyToolMove);
```

## Tool Type Mapping

The `setNewAnnotationMode()` switch uses the tool configuration's `type`, not the template `type` directly. Common cases:

```typescript
switch (this.selectedToolConfiguration?.type) {
  case "create":       // Annotation creation tools
  case "tagging":      // Tag/untag click tools
  case "snap":         // Snap-to tools (e.g., circleToDot)
  case "connection":   // Connection tools (click or polygon)
  case "select":       // Selection tools (pointer or polygon)
  case "edit":         // Annotation edit tools (combine_click, blob_edit)
  case "samAnnotation": // SAM tools (mode null, custom pipeline)
  case "segmentation": // Worker segmentation (mode null)
}
```

## Hit Testing

Find existing annotations at a click location:

```typescript
const fakeAnnotation = {
  coordinates: [clickCoords],
  shape: "point"
};
const hits = this.getSelectedAnnotationsFromAnnotation(
  fakeAnnotation
);
// Returns array of annotation IDs that overlap the click point
```

## Two-Click State Machine Pattern

Used by connection tool and combine tool:

```typescript
interface IToolState {
  type: TToolStateSymbol;
  selectedAnnotationId: null | string;
}

// In handleAnnotationChange():
case "myTwoClickTool": {
  const state = this.selectedToolState as IToolState;
  if (!state.selectedAnnotationId) {
    // First click: store selection
    state.selectedAnnotationId = clickedAnnotationId;
    // Visual feedback: highlight selected
  } else {
    // Second click: perform action
    await performAction(
      state.selectedAnnotationId,
      clickedAnnotationId
    );
    // Reset state
    state.selectedAnnotationId = null;
  }
  break;
}
```

## Visual Feedback for Selected Annotations

Highlight annotations during multi-click interactions:

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

## GeoJS Events Reference

Events are accessed via `geojs.event.*` constants and bound with `geoOn`/`geoOff`:

```typescript
import geojs from "geojs";

// Binding
this.annotationLayer.geoOn(geojs.event.mouseclick, handler);
// Unbinding
this.annotationLayer.geoOff(geojs.event.mouseclick, handler);
```

| Event constant | Trigger |
|-------|---------|
| `geojs.event.mouseclick` | Single click on map |
| `geojs.event.mousemove` | Mouse movement |
| `geojs.event.mousedown` | Mouse button pressed |
| `geojs.event.mouseup` | Mouse button released |
| `geojs.event.zoom` | Zoom level change |

## Updating Annotations After Tool Action

```typescript
// Update single annotation
await annotationStore.updateAnnotationsPerId({
  annotationsById: {
    [annotationId]: { tags: newTags }
  },
});

// Delete annotation
await annotationStore.deleteAnnotation(annotationId);

// Create new annotation
await annotationStore.addAnnotationForFrame({
  annotationData,
  frame
});
```
