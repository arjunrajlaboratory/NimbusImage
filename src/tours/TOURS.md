# Tour System Documentation

## Overview

The tour system provides a declarative way to create guided tours through the
application's interface. Tours are defined in YAML files in `src/tours/`,
making them easy to maintain and modify without changing application code.

The engine is **driver.js** (not Shepherd.js — all Shepherd references are
obsolete).

Relevant files:

| File | Purpose |
|------|---------|
| `src/plugins/tour.ts` | `TourManager` class — loads YAML, drives driver.js |
| `src/plugins/tour.scss` | driver.js popover and overlay styles |
| `src/plugins/tour-trigger.directive.ts` | `v-tour-trigger` directive |
| `src/plugins/tourBus.ts` | Tiny event bus wiring triggers → TourManager |
| `src/tours/anchors.ts` | Static anchor + trigger name registry (single source of truth) |
| `src/tours/anchors.test.ts` | Static guard — fails CI if a YAML references an unknown anchor/trigger |
| `src/tours/TOURS.md` | This file |

## Anchor Convention

### Static anchors (compile-time known)

Bind the `data-tour` attribute in the template using the typed registry:

```vue
<v-btn :data-tour="TOUR_ANCHORS.helpButton">Help</v-btn>
```

In a tour YAML step, target the element with a single-quoted `[data-tour="..."]`
selector:

```yaml
element: '[data-tour="help-button"]'
```

All static anchor names live in `src/tours/anchors.ts` (`TOUR_ANCHORS` object).
The values are kebab-case strings that must match what appears in the YAML.

### Data-dependent anchors (runtime names)

Anchors built from runtime data — e.g. a tool name, tag name, or parameter
name — use the `getTourAnchorId` helper from `@/utils/strings`:

```vue
<div :data-tour="getTourAnchorId(tool.name)">...</div>
```

```yaml
element: '[data-tour="nucleus"]'
```

Data-dependent anchors are **NOT** listed in `anchors.ts` and are **exempt**
from the static guard. The guard's `DATA_DEPENDENT` set in `anchors.test.ts`
whitelists the values that YAML files are allowed to target.

## Trigger Convention

Interactive steps that advance only after the user performs an action use
`v-tour-trigger` on the element and `onTriggerEvent` in the YAML.

**Component template** — bind using the typed registry:

```vue
<v-btn
  v-tour-trigger="TOUR_TRIGGERS.helpButton"
  @click="openHelp"
>
  Help
</v-btn>
```

`v-tour-trigger` emits the bare name (e.g. `"help-button"`) on the element's
click event via the tour event bus.

**YAML step** — reference the bare name (no `-tourtrigger` suffix):

```yaml
onTriggerEvent: "help-button"
showNextButton: false
```

All static trigger names live in `src/tours/anchors.ts` (`TOUR_TRIGGERS`
object).

> **Old convention removed:** The previous system used `id="x-tourstep"` and
> `v-tour-trigger="'x-tourtrigger'"` with suffix-decorated strings. Both
> suffixes (`-tourstep`, `-tourtrigger`) have been removed. Use `data-tour` +
> the registry instead.

## The Registry and Static Guard

`src/tours/anchors.ts` is the **single source of truth** for all static anchor
and trigger names. It exports:

- `TOUR_ANCHORS` — typed object mapping component-local key → kebab-case anchor
  name. Components bind `:data-tour="TOUR_ANCHORS.<key>"`.
- `TOUR_TRIGGERS` — typed object mapping key → bare trigger name. Components
  bind `v-tour-trigger="TOUR_TRIGGERS.<key>"`.
- `ALL_TOUR_ANCHORS` / `ALL_TOUR_TRIGGERS` — `Set<string>` views used by the
  static guard.

`src/tours/anchors.test.ts` runs four Vitest checks on every commit:

1. Every YAML `element` selector resolves to a known static anchor OR is in
   `DATA_DEPENDENT`.
2. Every YAML `onTriggerEvent` is a known trigger OR is in `DATA_DEPENDENT`.
3. Every key in `TOUR_ANCHORS` is referenced by some component via
   `TOUR_ANCHORS.<key>` (no dead registrations).
4. Every key in `TOUR_TRIGGERS` is referenced by some component via
   `TOUR_TRIGGERS.<key>` (no dead registrations).

**Keep the guard green.** If you add a new anchor in a component, register it
in `anchors.ts`. If you add a data-dependent anchor that YAML targets, add its
runtime value to `DATA_DEPENDENT` in the test file.

## TourManager Controller Behaviour

Knowing these behaviours helps when authoring tour steps:

| Behaviour | Detail |
|-----------|--------|
| **Auto-navigation** | If a step has a `route` that differs from the current route, the controller calls `router.push({ name: route })` and waits for `afterEach` before rendering. |
| **Missing element recovery** | If `waitForElement` elapses before the target element appears, a "This step isn't available" recovery popover appears (Skip / End tour). Steps never silently vanish. |
| **Non-modal / interactive steps** | `modalOverlay: false` removes the dark overlay so the user can interact with the UI normally while the popover is open. |
| **Trigger events** | `onTriggerEvent` names a tour-bus event. The controller listens for it and calls `advance()`. It clears the listener on every step transition. |
| **Element wait timeout** | `waitForElement` (default **8000 ms**) is per-step. Increase it for steps on slow-loading routes. |
| **Progress indicator** | The popover footer always shows "N of M". |
| **Overlay cleanup** | `stopTour()` removes the `tour-no-overlay` body class and destroys the driver.js instance cleanly. |

## Step Options Reference

These are the fields of `ITourStep` (defined in `src/store/model.ts`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | `string` | required | Unique identifier for the step (used in logs) |
| `route` | `string` | required | Route name where the step should appear; triggers auto-navigation |
| `element` | `string` | — | CSS selector for the target element (`[data-tour="x"]`) |
| `title` | `string` | required | Step title shown in the popover |
| `text` | `string` | required | Step body text |
| `position` | `"top"\|"bottom"\|"left"\|"right"` | `"bottom"` | Popover side |
| `waitForElement` | `number` | `8000` | Milliseconds to wait for `element` before showing recovery popover |
| `modalOverlay` | `boolean` | `true` | `false` → no overlay, UI is interactive |
| `showNextButton` | `boolean` | `true` | `false` → hide the Next button (use with `onTriggerEvent`) |
| `onTriggerEvent` | `string` | — | Bare trigger name; step advances when the bus emits this event |

> **Removed hooks:** `beforeShow` and `onNext` string hooks are gone. Do not
> add them back. Use `onTriggerEvent` for interaction-gated advancement.

## Example Tour YAML

```yaml
name: My Feature Tour
entryPoint: datasetview
popular: false
category: Analysis
steps:
  - id: intro-step
    route: datasetview
    title: "Welcome"
    text: "Let's walk through this feature."
    position: "bottom"
    modalOverlay: true

  - id: highlight-button
    route: datasetview
    element: '[data-tour="analyze-button"]'
    title: "Analyze"
    text: "Click here to open the analysis panel."
    position: "right"
    waitForElement: 5000
    modalOverlay: true
    showNextButton: false
    onTriggerEvent: "analyze-button"

  - id: interactive-step
    route: datasetview
    element: '[data-tour="create-property-button"]'
    title: "Create a property"
    text: "Now create a property. This step has no modal overlay so you can interact freely."
    position: "left"
    modalOverlay: false
    showNextButton: false
    onTriggerEvent: "create-property-button"

  - id: done
    route: datasetview
    title: "Done!"
    text: "You've completed the tour."
    position: "bottom"
    showNextButton: true
```

## How to Start a Tour

### From a Vue component (Options API)

```typescript
this.$startTour("WelcomeTourHome");
```

### From a Vue component (Composition API)

```typescript
import { getCurrentInstance } from "vue";

const instance = getCurrentInstance();
instance?.proxy?.$startTour("WelcomeTourHome");
```

### Via the `useTour` composable (if available in your scope)

```typescript
const { startTour } = useTour();
startTour("WelcomeTourHome");
```

The tour name must match the YAML filename (without `.yaml`) under `src/tours/`.
The `WelcomeTourNames` map in `src/store/model.ts` provides the correct
filenames for the four welcome-tour variants.

## Creating a New Tour

1. Create `src/tours/MyTour.yaml` following the structure above.
2. For each target element that is not already anchored:
   - Add a key + value to `TOUR_ANCHORS` in `src/tours/anchors.ts`.
   - Bind `:data-tour="TOUR_ANCHORS.<key>"` in the component template.
3. For each trigger:
   - Add a key + value to `TOUR_TRIGGERS` in `src/tours/anchors.ts`.
   - Bind `v-tour-trigger="TOUR_TRIGGERS.<key>"` in the component template.
4. Run `pnpm exec vitest run src/tours/anchors.test.ts` to confirm the static
   guard passes.
5. Start the tour in a component or the browser console with `$startTour("MyTour")`.

## Best Practices

1. Use `modalOverlay: false` when the user must interact with the UI to progress.
2. Set a generous `waitForElement` on steps that load after async data (e.g. `5000`).
3. Pair `showNextButton: false` with `onTriggerEvent` so the user cannot bypass
   the required interaction.
4. Steps without an `element` render the popover centred over `body` — useful
   for purely instructional steps.
5. Keep step text concise; the popover is small.
6. Group related tours under the same `category` so they appear together in the
   tour browser.
7. Test tours under both fast and slow network conditions (adjust
   `waitForElement` accordingly).
