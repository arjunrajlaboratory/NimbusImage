# NimbusImage Tools

## The template file

The file `public\config\templates.json` contains the template for all the available tools.
The whole file is a list of objects, each of which describes a tool.
A tool corresponds to a section with several buttons in the tool creation dialog.

It has the following properties:
- name: a string used as section name for several tools of the same type.
- type: a string which identifies the tool. It is used for example to chose the icon of the tool or the annotation mode when the tool is selected (see `refreshAnnotationMode` in `AnnotationViewer.vue`).
- shortName: an optional string, used for the auto naming of tools.
- interface: a list of objects describing all the options the tool has during creation. Each object will be an "interface element". These objects are described below.

An interface element has the following properties:
- name: a string used by the UI as title for the interface element.
- id: the key used in `IToolConfiguration["values"]` to store the value for this interface element. For example, if `tool` is of type `IToolConfiguration` and one of the interface elements this tool's template is named `foo`, then `tool.values.foo` will be the value given to this interface element during the tool creation.
- type: a string which defines which component will be used during tool creation. For example checkbox, radio, select, annotation... The list of currently available type is in `typeToComponentName` in `ToolConfigurationItem.vue`. For example, the `restrictTagsAndLayer` type will add a component named `tag-and-layer-restriction` which is in `TagAndLayerRestriction.vue`. In the previous example, the type then determines what will be in `tool.values.foo`.
- isSubmenu: optional boolean flag set to true for at most one (and usually exactly one) of the interface element of a tool. This flag can be used on all interface element that are handled by the computed attribute `submenus` in `ToolTypeSelection.vue`. It will define the number and the role of the buttons for each section in the tool creation type selection.
- advanced: optional boolean, defaults to false. If true, this interface element should be considered advanced and hidden in an expansion panel. The exception is the `annotation` interface element type which ignores this flag and add interface element both in advanced and not advanced sections (see `basicInternalTemplate` and `advancedInternalTemplate` in `ToolConfiguration.vue`).
- meta: this object depends on the type of the interface element. For example, an interface element of type `select` has a `items` key in its meta object which lists all the possible options (name, id and a meta element containing other interface elements).

## Adding a tool

To add a tool, first add its template in the `template.json` as described above. You can create a brand new tool to the list (which will appear as a section during tool creation), but you can also add an option to a `select` interface element which is a submenu (which will appear as a clickable line during tool creation).

If you create a new tool type, add it to the typescript type `TToolType` in `model.ts`.

You will then need to edit different parts of the code depending on the role of the tool.
The most basic tools (for example the selection tool) change these parts of the code:
- In `refreshAnnotationMode` in `AnnotationViewer.vue`, you can choose the annotation mode when the tool is selected.
- In `handleAnnotationChange` in `AnnotationViewer.vue`, you can choose what happens a new annotation is added by the tool.

## Example: "Snap to" manual annotation tools

### The template

This tool has the type `snap`. It is the tool type, and should not be confused with the interface types in the interface list of the tool.
The interface list has two elements: one of id `snapTo` and type `select` and one of id `connectTo` and type `restrictTagsAndLayer`.

The submenu of the tool is the interface element of id `snapTo`. It means that each item in the `meta.items` of this `select` will be an option in the tool type selection during tool creation. For example, if the user chooses the item "Snap circle to dot", then `tool.value.snapTo` will be the entire selected item from the template (including text, value, and meta) which means that `tool.value.snapTo.value` will be `"circleToDot"`. You can see that this is used in `Toolset.vue` to add the slider for the radius of the tool (the `circle-to-dot-menu`).

In `updateInterface` of `ToolConfiguration.vue`, the values of the tool are checked to see if they contain a `meta.interface`. This is how the interface elements which are in `meta.interface` next to the select item of value `circleToDot` are added to the interface. Thanks to this mechanism, the interface elements of type `select` can add other interface elements depending on the selected items.

The last interface element of id `connectTo` is a simple interface element, with the only particularity that it is a custom component that is used for the UI. This is the `TagAndLayerRestriction.vue` file which contains the logic and the UI for this interface element.

### The logic

You can look for all the occurences of `case "snap":` in the code. There are two occurrences:
- One to set the cursor mode to polygon or set it to point and add a cursor annotation depending on if the tool is a circle to dot or not.
- One to handle the click of the user and add an annotation accordingly.

## Example: "Click to tag" tool

### The template

This tool has the type `tagging`. Like other tools that have different modes (e.g. the connection tool), it uses a select interface element as a submenu to provide different tagging actions. Currently, it only has "Click to tag", but could be extended to include actions like "Lasso to tag multiple" in the future.

The interface list has two key elements:
1. The submenu interface element (id: `action`, type: `select`) which defines the available tagging actions
2. The tags interface element (id: `tags`, type: `tags`) which uses the TagPicker component to let users select which tags to apply

The tool uses the `tags` interface type which maps to the `tag-picker` component in `ToolConfigurationItem.vue`. This component provides a consistent tag selection interface across the application.

### The logic

The tool follows a similar pattern to the click-connect tool, but simplified since it only needs to handle single clicks rather than pairs of clicks. Key points:

1. In `refreshAnnotationMode()`, it:
   - Sets annotation mode to null
   - Sets up a direct mouseclick event handler instead of using annotation mode
   - This avoids creating visible temporary point annotations

2. The click handler:
   - Creates a temporary "fake" point annotation just for hit testing
   - Uses `getSelectedAnnotationsFromAnnotation()` to find what was clicked
   - Updates the clicked annotation's tags using `updateAnnotationsPerId()`
   - No temporary annotation is visible to the user

This pattern of using direct mouse events rather than annotation mode is useful when:
- You want to avoid visible temporary annotations
- You need more direct control over the interaction
- The tool is doing simple point-and-click operations

The tool demonstrates how to:
- Add new interface types to the template system
- Reuse existing components (TagPicker)
- Handle mouse interactions directly when appropriate
- Follow existing patterns while simplifying them for simpler use cases

## Featured Tools Configuration

The file `public/config/featuredTools.json` configures which tools appear in the "Featured" section at the top of the tool selection dialog.

```json
{
  "featuredTools": ["Blob", "Cellpose-SAM", "Piscis spot detection"]
}
```

- Tools are displayed in the order listed in the array
- Tool names must match exactly the `text` property of the tool in `templates.json` or the `interfaceName` label from docker workers
- Invalid or duplicate names will produce console warnings in the browser developer tools
- If the file doesn't exist or fails to load, no featured section is shown

## Tool Descriptions

Tools can have optional descriptions that appear below the tool name in the selection dialog. To add a description to a tool:

1. **For submenu items in `templates.json`**: Add a `description` field to items in a `select` interface element:

```json
{
  "text": "Click to tag",
  "value": "tag_click",
  "description": "Click annotations to add tags",
  "meta": { ... }
}
```

2. **For manual annotation tools**: Descriptions are defined in `src/store/index.ts` in the `availableToolShapes` array.

3. **For docker worker tools**: The description comes from the `description` label in the worker's Docker image metadata.

Descriptions should be brief (under 50 characters) and explain what the tool does in action-oriented language (e.g., "Click to select individual annotations" rather than "This tool selects annotations").
