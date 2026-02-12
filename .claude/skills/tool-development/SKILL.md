---
name: tool-development
description: "Use when creating a new annotation tool, modifying tool templates in public/config/templates.json, adding tool types to TToolType in model.ts, implementing tool interaction logic in AnnotationViewer.vue, or working with the tool selection UI. Covers: template JSON structure, interface element types (annotation, select, checkbox, radio, tags, dockerImage), submenu patterns, tool type registration, GeoJS interaction layer, mouse event handling, hit testing, and worker-based tool configuration."
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
  - TodoWrite
user-invocable: true
---

# NimbusImage Tool Development

Tools are configured through JSON templates (`public/config/templates.json`) and implemented in Vue components. The system supports manual annotation, selection, AI-powered, worker-based, and custom interaction tools.

## Template Structure

```json
{
  "name": "Tool Section Name",
  "type": "toolType",
  "shortName": "Optional short name",
  "interface": [
    {
      "name": "Interface Element Name",
      "id": "elementId",
      "type": "elementType",
      "isSubmenu": true,
      "advanced": false,
      "meta": {}
    }
  ]
}
```

### Interface Element Types

| Type | Component | Purpose |
|------|-----------|---------|
| `annotation` | AnnotationConfiguration | Shape selection |
| `select` | v-select | Dropdown options |
| `checkbox` | v-checkbox | Boolean toggle |
| `radio` | v-radio-group | Single choice |
| `tags` | TagPicker | Tag selection |
| `dockerImage` | Worker selector | Docker worker tools |
| `restrictTagsAndLayer` | TagAndLayerRestriction | Filter annotations |

### Submenu Interface

One interface element should have `isSubmenu: true`. This creates tool variants in the selection dialog. For `select` type submenus, each item in `meta.items` becomes a separate tool option.

## Adding a New Tool

### Step 1: Define Template

Add to `templates.json`:

```json
{
  "name": "My Tool Category",
  "type": "myTool",
  "interface": [
    {
      "name": "Tool Mode",
      "id": "mode",
      "type": "select",
      "isSubmenu": true,
      "meta": {
        "items": [
          {
            "text": "Mode A",
            "value": "mode_a",
            "description": "Brief description of Mode A"
          }
        ]
      }
    }
  ]
}
```

### Step 2: Add Type Definition

In `src/store/model.ts`, add to `TToolType`:

```typescript
export type TToolType =
  | "annotation"
  | "selection"
  // ... existing types
  | "myTool";
```

### Step 3: Implement Logic

In `src/components/AnnotationViewer.vue`:

**Set annotation mode** in `setNewAnnotationMode()`:
```typescript
case "myTool":
  this.interactionLayer.mode("point"); // or null for custom handling
  break;
```

**Handle annotations** in `handleAnnotationChange()`:
```typescript
case "myTool":
  // Process the annotation/interaction
  break;
```

## Tool Descriptions

```json
{
  "text": "Tool Name",
  "value": "tool_value",
  "description": "Brief action-oriented description"
}
```

Keep descriptions under 50 characters. Use action verbs: "Click to...", "Draw to...", "Select...".

## Featured Tools

Configure `public/config/featuredTools.json`:

```json
{
  "featuredTools": ["Tool Name 1", "Tool Name 2"]
}
```

Names must match the `text` field exactly.

## Docker Worker Tools

Worker-based tools use the `dockerImage` interface type. Workers are registered with labels:

- `interfaceName` - Display name
- `interfaceCategory` - Category for grouping
- `description` - Tool description
- `isAnnotationWorker` - Must be set for annotation workers
- `annotationShape` - Default output shape

## Common Patterns

### Direct Mouse Handling

For tools that don't create visible annotations during interaction:

```typescript
case "myTool":
  this.interactionLayer.mode(null);
  this.annotationLayer.geoOn(geojs.event.mouseclick, this.handleMyToolClick);
  break;
```

### Hit Testing

Find annotations at a click location:

```typescript
const fakeAnnotation = { coordinates: [clickCoords], shape: "point" };
const hits = this.getSelectedAnnotationsFromAnnotation(fakeAnnotation);
```

### Updating Annotations

```typescript
await annotationStore.updateAnnotationsPerId({
  annotationsById: { [annotationId]: { tags: newTags } },
});
```

## Category Colors

Tools are color-coded by category. To add a new category color, edit `ToolTypeSelection.vue`:

1. Add SCSS variable: `$color-mycategory: #hexcolor;`
2. Add to `categoryClassMap`: `"My Category": "category-mycategory"`
3. Add class: `.category-mycategory { @include category-colors($color-mycategory); }`

## References

- For detailed GeoJS interaction patterns: read `references/tool-interaction-patterns.md`
- For a complete worked example (combine annotations tool): read `references/combine-annotations-example.md`
- For SAM tool architecture: read `codebaseDocumentation/SAM2_MIGRATION.md`
