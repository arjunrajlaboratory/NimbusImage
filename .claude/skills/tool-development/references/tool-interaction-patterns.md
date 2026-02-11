# Tool Interaction Patterns (Detailed)

## GeoJS Interaction Layer

`AnnotationViewer.vue` manages a GeoJS annotation layer that handles user interactions. The annotation mode determines what happens on mouse events.

### Annotation Modes

Set in `refreshAnnotationMode()` based on the active tool type:

```typescript
// Standard GeoJS annotation modes
this.geoJSAnnotationMode = "point";     // Single click
this.geoJSAnnotationMode = "line";      // Draw line
this.geoJSAnnotationMode = "polygon";   // Draw polygon
this.geoJSAnnotationMode = "rectangle"; // Draw rectangle
this.geoJSAnnotationMode = null;        // Custom handling (bind events manually)
```

### Custom Mouse Handling (null mode)

For tools that don't use GeoJS's built-in annotation creation:

```typescript
case "myTool":
  this.geoJSAnnotationMode = null;
  // Bind custom click handler
  this.annotationLayer.bindEvent(
    "mouseclick", this.handleMyToolClick
  );
  break;
```

### Cleanup Pattern

Always unbind custom events when switching tools:

```typescript
// In refreshAnnotationMode(), before setting new mode:
this.annotationLayer.bindEvent("mouseclick", null);
this.annotationLayer.bindEvent("mousemove", null);
```

## Temporary Annotations

For visual feedback during multi-click interactions:

```typescript
// Create temporary visual annotation
const tempAnnotation = this.annotationLayer.createAnnotation("polygon", {
  coordinates: previewCoords,
  style: {
    strokeColor: "yellow",
    strokeWidth: 2,
    fill: false,
  },
});

// Remove after interaction completes
this.annotationLayer.removeAnnotation(tempAnnotation);
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

Common events available on the annotation layer:

| Event | Trigger |
|-------|---------|
| `mouseclick` | Single click on map |
| `mousemove` | Mouse movement |
| `mousedown` | Mouse button pressed |
| `mouseup` | Mouse button released |
| `geojs.annotation.state` | Annotation state change |
| `geojs.annotation.add_before` | Before annotation added |

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
