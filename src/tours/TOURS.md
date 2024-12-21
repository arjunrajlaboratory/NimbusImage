# Tour System Documentation

## Overview
The tour system provides a declarative way to create guided tours through the application's interface. It uses YAML configuration files to define tours, making them easy to maintain and modify without changing application code.

Relevant files include:
- `src/plugins/tour.ts` - Tour plugin
- `src/plugins/tour.scss` - Tour styles
- `src/plugins/tour-trigger.directive.ts` - Tour trigger directive
- `src/plugins/tourBus.ts` - Tour event bus
- `src/main.ts` - Tour initialization; added to router
- `src/tours/TOURS.md` - This file
- `src/tours/testTourUpload.yaml` - Example tour

## Philosophy
The tour system follows a declarative approach, where:
- Tours are defined in YAML files rather than code
- Components remain unaware of the tour system
- User interactions are handled through directives rather than explicit event handling
- Tour logic stays centralized in the tour configuration

## Creating a Tour
Tours are defined in YAML files in the `src/tours` directory. Each tour consists of metadata and a series of steps.

In your component template, you can set elements for the tour to stop at using `id="mytourstop-tourstep"`:

```vue
<v-checkbox
id="mytourstop-tourstep"
/>
``` 

To use interactions to advance the tour, use the `v-tour-trigger` directive:
```vue
<v-checkbox
v-tour-trigger="'tour-checkbox-clicked-tourtrigger'"
v-model="someValue"
/>
```

The `-tourstep` and `-tourtrigger` suffixes are used to make the IDs easier to find in the code.

### Basic Structure

```yaml
name: My Tour # Display name of the tour
entryPoint: root # Starting route
popular: true # (Optional) Show in popular tours
category: Analysis # (Optional) Group tours by category
steps:
  - id: step1-tourstep # Unique identifier for the step
    route: root # Route where this step should appear
    element: "#my-button-tourstep" # CSS selector for the target element
    title: "Step Title" # Title shown in the popup
    text: "Description" # Content shown in the popup
    position: "bottom" # Popup position (top, bottom, left, right)
```

### Step Options
| Option | Type | Description |
|--------|------|-------------|
| `id` | string | Unique identifier for the step |
| `route` | string | Route name where the step should be shown |
| `element` | string | CSS selector for the target element |
| `title` | string | Step title |
| `text` | string | Step description |
| `position` | string | Popup position (top, bottom, left, right) |
| `waitForElement` | number | Timeout (ms) to wait for element to appear |
| `modalOverlay` | boolean | Whether to show a modal overlay (default: true) |
| `beforeShow` | string | JavaScript code to execute before showing step |
| `onNext` | string | JavaScript code to execute before advancing |
| `onTriggerEvent` | string | Event name to wait for before advancing |
| `showNextButton` | boolean | Whether to show the Next button (default: true) |

### Modal vs Non-Modal Steps
Steps can be modal (with overlay) or non-modal:
```yaml
steps:
id: modal-step-tourstep
modalOverlay: true # Shows dark overlay, focuses attention
# ... other options
id: non-modal-step-tourstep
modalOverlay: false # No overlay, allows interaction with UI
# ... other options
```

### Event-Driven Steps
Some steps may require user interaction before advancing. These use the `onTriggerEvent` option:

```yaml
steps:
id: interactive-step
element: "#some-checkbox-tourstep"
onTriggerEvent: "tour-checkbox-clicked-tourtrigger"
showNextButton: false # Hide the Next button, require interaction
# ... other options
```

In your component template, use the `v-tour-trigger` directive:
```vue
<v-checkbox
v-tour-trigger="'tour-checkbox-clicked-tourtrigger'"
v-model="someValue"
/>
```

## Example Tour
Here's a complete example of a timelapse analysis tour:

```yaml
name: Time lapse analysis
entryPoint: datasetview
popular: true
category: Analysis
steps:
  - id: timelapse-mode-tourstep
    route: datasetview
    element: "#timelapse-mode-tourstep"
    title: "Timelapse Mode"
    text: "Enable timelapse mode to view the dataset as a timelapse"
    position: "bottom"
    waitForElement: 5000
    modalOverlay: true
    beforeShow: "return console.log('About to show timelapse mode step')"
    onTriggerEvent: "tour-timelapse-mode-clicked-tourtrigger"
  - id: timelapse-labels-tourstep
    route: datasetview
    element: "#timelapse-labels-tourstep"
    title: "Timelapse Labels"
    text: "Enable labels for the timelapse"
    position: "right"
    waitForElement: 5000
    modalOverlay: false # Allow interaction with UI
    onTriggerEvent: "timelapse-labels-tourtrigger"
```

This tour:
1. Starts at the dataset view
2. Shows a modal step highlighting the timelapse mode toggle
3. Waits for user to click the toggle
4. Shows a non-modal step about labels
5. Waits for user to interact with labels before completing

## Best Practices
1. Use meaningful step IDs; end with "-tourstep" to make them easier to find
2. Keep text concise and clear
3. Use modal overlays for important steps
4. Use non-modal steps when users need to interact with UI
5. Set reasonable `waitForElement` timeouts
6. Use `beforeShow` and `onNext` hooks sparingly
7. Prefer declarative `onTriggerEvent` over imperative hooks
8. End trigger event names with "-tourtrigger" to make them easier to find
9. Group related tours in the same category
10. Test tours with both fast and slow loading conditions

## Technical Details
The tour system uses:
- Shepherd.js for the tour UI
- Vue directives for event handling
- Vue Router for navigation
- Event bus for decoupled communication

Tours are loaded dynamically and can be started using:
```typescript
this.$startTour('tourName');
```
