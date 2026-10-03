# Combine Annotations: Complete Worked Example

A full example of implementing a two-click annotation tool, from template to interaction logic.

## 1. Template Definition

In `public/config/templates.json`, under the "Annotation Edits" tool:

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
        "meta": { "value": "2", "type": "number" }
      }
    ]
  }
}
```

The tool inherits "Annotations to edit" filter from parent, restricting which annotations can be combined.

## 2. Tool State Interface

In `src/store/model.ts`:

```typescript
export const CombineToolStateSymbol = Symbol("CombineToolState");
export type TCombineToolStateSymbol = typeof CombineToolStateSymbol;

export interface ICombineToolState {
  type: TCombineToolStateSymbol;
  selectedAnnotationId: null | string;
}
```

State lifecycle:
- `selectedAnnotationId: null` - Waiting for first click
- `selectedAnnotationId: "abc123"` - First annotation selected, waiting for second click
- After action (or clicking same annotation), resets to `null`

## 3. Tool State Initialization

In `src/store/index.ts`, `setNewAnnotationMode()`:

```typescript
case "combine_click":
  toolState = {
    type: CombineToolStateSymbol,
    selectedAnnotationId: null,
  };
  break;
```

## 4. Interaction Logic

In `src/components/AnnotationViewer.vue`:

**Set annotation mode** in `setNewAnnotationMode()`:
```typescript
case "edit":
  if (actionValue === "combine_click") {
    this.interactionLayer.mode("point");
  }
  break;
```

**Handle clicks** in `handleAnnotationChange()`:
```typescript
case "annotationEdit": {
  if (actionValue === "combine_click") {
    await this.handleAnnotationCombine(annotation);
  }
  break;
}
```

**Two-click state machine** in `handleAnnotationCombine()`:
```typescript
async handleAnnotationCombine(annotation) {
  const state = this.selectedToolState as ICombineToolState;
  const clickedId = this.findAnnotationAtPoint(annotation);

  if (!clickedId) return;  // Clicked empty space

  if (!state.selectedAnnotationId) {
    // First click: store selection
    state.selectedAnnotationId = clickedId;
    return;
  }

  if (state.selectedAnnotationId === clickedId) {
    // Clicked same annotation: reset
    state.selectedAnnotationId = null;
    return;
  }

  // Second click: combine
  const tolerance = this.getToolSetting("tolerance") || 2;
  await annotationStore.combineAnnotations({
    firstAnnotationId: state.selectedAnnotationId,
    secondAnnotationId: clickedId,
    tolerance,
  });

  // Reset state
  state.selectedAnnotationId = null;
}
```

## 5. Store Action

In `src/store/annotation.ts`, `combineAnnotations()`:

```typescript
@Action
async combineAnnotations({
  firstAnnotationId,
  secondAnnotationId,
  tolerance,
}) {
  // 1. Fetch both annotations
  // 2. Compute polygon union with tolerance
  // 3. Update first annotation with union coordinates
  // 4. Transfer connections from second to first
  // 5. Delete second annotation
}
```

### Connection Transfer Logic
1. Find all connections where the second annotation is parent or child
2. Replace references to second with first
3. Skip self-connections and duplicates
4. Delete old connections, create new ones using batch API calls

## 6. Visual Feedback

First selected annotation is highlighted via `toolHighlightedAnnotationIds` computed property, shared with the connection tool.

## Reference

Full implementation details: `codebaseDocumentation/COMBINE_ANNOTATIONS.md`
