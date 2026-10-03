# Tour System Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every guided tour run on the current UI by replacing the dated, license-incompatible Shepherd.js 8.3.1 engine with driver.js, hardening the tour controller so broken anchors fail loudly instead of silently skipping, and making the anchor contract typed and statically enforced.

**Architecture:** Keep the existing declarative layer (YAML tours → `TourManager` controller → `v-tour-trigger` directive + `tourBus`). Phase 1 swaps the rendering engine and hardens the controller while keeping the existing `#x-tourstep` id selectors, so broken anchors surface loudly. Phase 2 migrates anchors to typed `data-tour` attributes backed by a registry + a Vitest static guard, and re-targets the broken/content-coupled tours. Phase 3 is a manual browser walkthrough of every tour.

**Tech Stack:** Vue 3, TypeScript, Vuetify 4, Vite, Vitest, vue-router, driver.js (MIT), mitt event bus, YAML tours.

**Spec:** `docs/superpowers/specs/2026-05-29-tour-system-overhaul-design.md`

**Branch:** `tours/overhaul` (already created off `origin/master`).

---

## Reference: current files

- `src/plugins/tour.ts` — `TourManager` controller (417 lines, Shepherd-based).
- `src/plugins/tour-trigger.directive.ts` — `v-tour-trigger` directive; emits on `tourBus`.
- `src/plugins/tourBus.ts` — `mitt()` event bus.
- `src/plugins/tour.scss` — Shepherd popover styling.
- `src/store/model.ts:1592-1639` — tour types (`ITourStep`, `IExtendedShepherdStep`, `ITourMetadata`, `ITourConfig`, global props).
- `src/utils/strings.ts` — `toKebabCase`, `getTourStepId`, `getTourTriggerId`.
- `src/main.ts:108,135` — directive registration + `installTour`.
- `src/tours/*.yaml` — 8 tour definitions; `src/tours/TOURS.md` — docs.

## Reference: full anchor inventory (for Phase 2)

**Static anchor ids (42) by file** — migrate `id="X-tourstep"` → `data-tour="X"`:

| File | Anchors (without `-tourstep` suffix) |
|---|---|
| `src/App.vue` | object-list-button, filters-button, snapshots-button, settings-button, analyze-button, help-button, chat-button |
| `src/tools/creation/ToolCreation.vue` | tool-name, tool-creation-add-tool-button |
| `src/tools/creation/templates/AnnotationConfiguration.vue` | tool-creation-layer-select, tool-creation-tag-picker |
| `src/tools/toolsets/Toolset.vue` | add-tool |
| `src/components/ImageViewer.vue` | layer-info, lock-view, reset-view, reset-rotation |
| `src/components/NavigatorPanel.vue` | viewer-toolbar, timelapse-mode, timelapse-tags, timelapse-labels |
| `src/components/ZenodoImporter.vue` | zenodo-importer-import-dataset |
| `src/components/DisplayLayers.vue` | layer-controls |
| `src/components/ZenodoCommunityDisplay.vue` | zenodo-community-display |
| `src/components/DataIOMenu.vue` | data-io-button |
| `src/components/AnnotationBrowser/AnnotationList.vue` | annotation-list-content |
| `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue` | create-property-header, property-tag-picker, shape-selection, property-algorithm-select, create-property-button |
| `src/views/Home.vue` | upload-files, try-sample-dataset, configure-dataset-button, accept-defaults-button |
| `src/views/dataset/MultiSourceConfiguration.vue` | variables, assignments, transcode-checkbox, submit-button |
| `src/views/dataset/DatasetInfo.vue` | view-dataset-button |
| `src/views/dataset/NewDataset.vue` | dataset-name-input, dataset-description-input, upload-button |

**Trigger event names (20)** via `v-tour-trigger` — names without `-tourtrigger` suffix: object-list-button, filters-button, snapshots-button, settings-button, analyze-button, help-button, chat-button (App.vue); add-tool (Toolset.vue); timelapse-mode (NavigatorPanel.vue); zenodo-importer-import-dataset (ZenodoImporter.vue); data-io-button (DataIOMenu.vue); property-tag-picker, property-algorithm-select, create-property-button (PropertyCreation.vue); try-sample-dataset, configure-dataset, accept-defaults (Home.vue); view-dataset-button (DatasetInfo.vue); submit-button (MultiSourceConfiguration.vue); upload-button (NewDataset.vue).

**Dynamic anchors (data-dependent — EXEMPT from static guard)** via `getTourStepId(name)`: `src/tools/creation/ToolTypeSelection.vue`, `src/tools/toolsets/ToolItem.vue`, `src/components/WorkerInterfaceValues.vue`, `src/components/ZenodoCommunityDisplay.vue`.

**Tours referencing anchors that DO NOT exist in source (must be re-targeted in Phase 2):**
- `measure-objects-button`, `measure-objects-close-button`, `properties-header`, `properties-content` (in `CalculateBlobMetrics.yaml`, `WelcomeTourHome.yaml`) — hard-removed UI; re-target to current properties/measure panel anchors.
- `nucleus`, `dapi-blob`, `blob`, `gaussian-blur`, `sigma`, `parent-tag`, `my-first-nimbus-dataset` — data-dependent; rely on the Zenodo sample dataset (keep dynamic `getTourStepId`/`data-tour` targeting).

**Known stale tour-name references to audit:** `src/store/model.ts:1654-1659` `WelcomeTourNames` maps `VIEWER → "WelcomeTourViewer"` and `ADVANCED_UPLOAD → "WelcomeTourAdvancedUpload"`, but the actual files are `IntroViewerTour.yaml` and `AdvancedUploadTour.yaml`. Fix in Phase 2 Task 14.

---

# Phase 1 — Engine swap + glue hardening

Outcome: driver.js replaces Shepherd; the controller drives one `highlight()` per step; failures are loud; multi-route tours self-navigate. Existing `#x-tourstep` ids are kept this phase.

## Task 1: Install driver.js, remove shepherd.js, confirm API

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add driver.js, remove shepherd.js**

Run:
```bash
pnpm remove shepherd.js
pnpm add driver.js
```
Expected: `driver.js` appears in `package.json` dependencies; `shepherd.js` removed.

- [ ] **Step 2: Confirm the installed driver.js API surface**

Run:
```bash
sed -n '1,80p' node_modules/driver.js/dist/driver.d.ts
```
Expected: confirms `driver(config)`, a `Driver` with `.highlight(step)`, `.moveNext()`, `.destroy()`, `.refresh()`, `.isActive()`; a `DriveStep` with `element` and `popover`; `Popover` with `title`, `description`, `side`, `align`, `showButtons`, `onNextClick`, `onPopoverRender`; `Config` with `overlayColor`, `overlayOpacity`, `stagePadding`, `popoverClass`, `disableActiveInteraction`. Note exact names; if any differ from those used below, adjust later tasks to match the real signatures.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: replace shepherd.js with driver.js"
```

## Task 2: Replace Shepherd-coupled tour types

**Files:**
- Modify: `src/store/model.ts:1592-1639`

- [ ] **Step 1: Remove the Shepherd import and Shepherd-coupled type**

In `src/store/model.ts`, delete the top-level `import Shepherd from "shepherd.js";` (line 3) and replace the `IExtendedShepherdStep` interface (lines 1608-1617) with an engine-neutral internal step type. Replace that block with:

```typescript
// Internal representation the TourManager builds from an ITourStep.
// Engine-neutral: holds everything the controller needs to render and advance.
export interface ITourStepRuntime {
  id: string;
  route: string;
  element?: string;
  title: string;
  text: string;
  position: "top" | "bottom" | "left" | "right";
  waitForElement: number;
  hasModalOverlay: boolean;
  showNextButton: boolean;
  onTriggerEvent?: string;
}
```

- [ ] **Step 2: Drop the unused stringified hooks from `ITourStep`**

In `ITourStep` (lines 1593-1606), remove the `beforeShow?: string;` and `onNext?: string;` fields (they are unused beyond debug logs and are being deleted). Leave the rest of `ITourStep` unchanged.

- [ ] **Step 3: Verify it compiles (will fail in tour.ts — expected)**

Run: `pnpm tsc 2>&1 | head -30`
Expected: errors ONLY in `src/plugins/tour.ts` (references to removed `IExtendedShepherdStep` / Shepherd). No errors elsewhere. These are fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add src/store/model.ts
git commit -m "refactor(tours): replace Shepherd-coupled step type with engine-neutral runtime type"
```

## Task 3: Rewrite TourManager on driver.js

**Files:**
- Modify: `src/plugins/tour.ts` (full rewrite of the engine-coupled parts)

This is the core task. The controller keeps owning: tour load, step sequencing, route checking + navigation, element waiting, event-driven advancement. Only the *render* of a step changes (driver.js `highlight()` instead of `shepherd.show()`).

- [ ] **Step 1: Replace imports and class fields**

Replace lines 1-22 of `src/plugins/tour.ts` with:

```typescript
import type { App } from "vue";
import type { Router } from "vue-router";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import "./tour.scss";
import { tourBus } from "./tourBus";
import { logError, logWarning } from "@/utils/log";
import { ITourConfig, ITourMetadata, ITourStepRuntime } from "@/store/model";

const DEFAULT_WAIT_MS = 8000; // datasetview loads images; give async UI room

export class TourManager {
  private driverObj: Driver | null = null;
  private steps: ITourStepRuntime[] = [];
  private currentStepIndex = 0;
  private isActive = false;
  private tours: Record<string, ITourMetadata> = {};
  private activeTriggerEvent: string | null = null;

  constructor(
    private router: Router,
    app: App,
  ) {
    app.config.globalProperties.$startTour = this.startTour.bind(this);
    app.config.globalProperties.$nextStep = this.nextStep.bind(this);
    app.config.globalProperties.$loadAllTours = this.loadAllTours.bind(this);
    app.config.globalProperties.$isTourActive = this.isTourActive.bind(this);

    this.router.afterEach(() => {
      if (this.isActive) {
        this.showCurrentStep();
      }
    });
  }

  public isTourActive(): boolean {
    return this.isActive;
  }
```

- [ ] **Step 2: Replace step loading + the show/advance core**

Replace the old `checkCurrentStep`, `waitForElement`, and `startTour` (old lines 45-322) with the new engine-neutral core below. Keep `loadTourConfig`, `loadAllTours`, `stopTour`, `nextStep`, and the trigger-listener helpers but adapt them (Steps 3-4).

```typescript
  async startTour(tourName: string) {
    const tour = await this.loadTourConfig(tourName);
    if (!tour) {
      return;
    }

    this.steps = tour.steps.map((step) => ({
      id: step.id,
      route: step.route,
      element: step.element,
      title: step.title,
      text: step.text,
      position: step.position ?? "bottom",
      waitForElement: step.waitForElement ?? DEFAULT_WAIT_MS,
      hasModalOverlay: step.modalOverlay ?? true,
      showNextButton: step.showNextButton !== false,
      onTriggerEvent: step.onTriggerEvent,
    }));
    this.currentStepIndex = 0;
    this.isActive = true;

    this.driverObj = driver({
      stagePadding: 8,
      popoverClass: "tour-popover",
      allowClose: true,
      overlayClickBehavior: "nextStep",
      onCloseClick: () => this.stopTour(),
    });

    await this.showCurrentStep();
  }

  // Renders the current step IF we are on its route; otherwise navigates there.
  private async showCurrentStep() {
    if (!this.isActive || !this.driverObj) {
      return;
    }
    if (this.currentStepIndex >= this.steps.length) {
      return this.stopTour();
    }

    const step = this.steps[this.currentStepIndex];

    // Route handling: navigate to the step's route if we are not there.
    const currentRoute = this.router.currentRoute.value.name;
    if (step.route && currentRoute !== step.route) {
      try {
        await this.router.push({ name: step.route });
      } catch (error) {
        logError(`[Tour] Failed to navigate to route "${step.route}":`, error);
      }
      // afterEach will re-invoke showCurrentStep once the route settles.
      return;
    }

    this.clearTriggerListener();

    // Wait for the target element (if the step targets one).
    if (step.element) {
      try {
        await this.waitForElement(step.element, step.waitForElement);
      } catch {
        // LOUD failure: do not silently skip. Show a recovery popover.
        return this.showMissingTargetPopover(step);
      }
    }

    this.renderStep(step);

    if (step.onTriggerEvent) {
      this.activeTriggerEvent = step.onTriggerEvent;
      tourBus.on(step.onTriggerEvent, this.handleTriggerAdvance);
    }
  }

  private renderStep(step: ITourStepRuntime) {
    if (!this.driverObj) {
      return;
    }
    const isLast = this.currentStepIndex === this.steps.length - 1;
    this.driverObj.highlight({
      element: step.element ?? "body",
      popover: {
        title: step.title,
        description: step.text,
        side: step.position,
        align: "center",
        // Modal step: dim + block interaction. Non-modal: transparent + interactive.
        showButtons: step.showNextButton ? ["next"] : [],
        nextBtnText: isLast ? "Done" : "Next",
        onNextClick: () => this.advance(),
        onPopoverRender: (popover) => {
          this.applyOverlayMode(step);
          this.appendProgress(popover.wrapper);
        },
      },
    });
    this.applyOverlayMode(step);
  }

  // driver.js overlay opacity is global; toggle a body class the SCSS keys off.
  private applyOverlayMode(step: ITourStepRuntime) {
    document.body.classList.toggle("tour-no-overlay", !step.hasModalOverlay);
  }

  private appendProgress(wrapper: HTMLElement) {
    const footer = wrapper.querySelector(".driver-popover-footer");
    if (!footer || footer.querySelector(".tour-progress")) {
      return;
    }
    const progress = document.createElement("span");
    progress.className = "tour-progress";
    progress.innerText = `${this.currentStepIndex + 1} of ${this.steps.length}`;
    footer.insertBefore(progress, footer.firstChild);
  }

  private showMissingTargetPopover(step: ITourStepRuntime) {
    if (!this.driverObj) {
      return;
    }
    logWarning(
      `[Tour] Target "${step.element}" for step "${step.id}" not found ` +
        `after ${step.waitForElement}ms. Showing recovery popover.`,
    );
    const isLast = this.currentStepIndex === this.steps.length - 1;
    document.body.classList.add("tour-no-overlay");
    this.driverObj.highlight({
      element: "body",
      popover: {
        title: "This step isn't available",
        description:
          "The screen for this step couldn't be found. You can skip it or " +
          "end the tour.",
        showButtons: ["next"],
        nextBtnText: isLast ? "End tour" : "Skip",
        onNextClick: () => this.advance(),
      },
    });
  }

  private advance = () => {
    this.clearTriggerListener();
    this.currentStepIndex++;
    this.showCurrentStep();
  };

  private handleTriggerAdvance = () => {
    this.advance();
  };

  private clearTriggerListener() {
    if (this.activeTriggerEvent) {
      tourBus.off(this.activeTriggerEvent, this.handleTriggerAdvance);
      this.activeTriggerEvent = null;
    }
  }
```

- [ ] **Step 3: Keep the MutationObserver `waitForElement` (engine-neutral)**

Add this method to the class (it is unchanged in behavior from the original except it is now reused):

```typescript
  private waitForElement(
    selector: string,
    timeout: number,
  ): Promise<Element> {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        return resolve(existing);
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }
```

- [ ] **Step 4: Adapt `stopTour`, `nextStep`, `loadTourConfig`, `loadAllTours`**

Replace `stopTour` and `nextStep` (old lines 329-360) with:

```typescript
  stopTour() {
    this.clearTriggerListener();
    document.body.classList.remove("tour-no-overlay");
    this.isActive = false;
    if (this.driverObj) {
      this.driverObj.destroy();
      this.driverObj = null;
    }
  }

  async nextStep(targetElementId?: string) {
    if (!this.isActive) {
      return;
    }
    if (targetElementId) {
      const targetIndex = this.steps.findIndex(
        (s) => s.element === `#${targetElementId}` || s.element === `[data-tour="${targetElementId}"]`,
      );
      this.currentStepIndex = targetIndex !== -1 ? targetIndex : this.currentStepIndex + 1;
    } else {
      this.currentStepIndex++;
    }
    this.clearTriggerListener();
    await this.showCurrentStep();
  }
```

Keep `loadTourConfig` and `loadAllTours` exactly as they are (old lines 324-327 and 362-384). Delete the old `setupStepListeners` / `removeStepListeners` / `handleNextStep` helpers (old lines 386-402) — replaced by `clearTriggerListener` / `handleTriggerAdvance`. Keep the `declare module "vue"` block and `installTour` export (old lines 405-417) unchanged.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 6: Lint**

Run: `pnpm lint 2>&1 | head -20`
Expected: no errors in `src/plugins/tour.ts` or `src/store/model.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/plugins/tour.ts src/store/model.ts
git commit -m "refactor(tours): rewrite TourManager on driver.js with loud failures and route auto-navigation"
```

## Task 4: Style the driver.js popover + overlay modes

**Files:**
- Modify: `src/plugins/tour.scss`

- [ ] **Step 1: Replace Shepherd styles with driver.js popover styles**

Replace the contents of `src/plugins/tour.scss` with theme-matching styles targeting driver.js classes. Include at minimum:

```scss
// driver.js popover, themed to match Vuetify.
.driver-popover.tour-popover {
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  max-width: 420px;

  .driver-popover-title {
    font-size: 1.1rem;
    font-weight: 600;
  }

  .driver-popover-footer {
    display: flex;
    align-items: center;
    gap: 8px;

    .tour-progress {
      margin-right: auto;
      font-size: 0.8rem;
      opacity: 0.7;
    }
  }
}

// Non-modal steps: hide the dimming overlay but keep the popover/stage.
body.tour-no-overlay .driver-overlay {
  opacity: 0 !important;
  pointer-events: none !important;
}
```

- [ ] **Step 2: Verify the build still compiles SCSS**

Run: `pnpm tsc 2>&1 | head -5 && pnpm build 2>&1 | tail -15`
Expected: build succeeds (or run `pnpm run dev` and confirm no SCSS errors in console).

- [ ] **Step 3: Commit**

```bash
git add src/plugins/tour.scss
git commit -m "style(tours): theme driver.js popover and add non-modal overlay mode"
```

## Task 5: Smoke-test one tour in the browser (verify engine works)

**Files:** none (manual verification)

- [ ] **Step 1: Start backend + frontend**

Run:
```bash
docker compose up -d
pnpm run dev
```
Expected: frontend on `http://localhost:5173`, Girder on `http://localhost:8080`.

- [ ] **Step 2: Drive the `WelcomeTourHome` tour via the browser**

Using Claude-in-Chrome (or manually): open `http://localhost:5173`, log in (`admin`/`password`), trigger the Welcome tour. Step through it.
Expected: driver.js popovers render and highlight; modal/non-modal steps dim/don't-dim correctly; Next/Done advances; the **missing-target recovery popover appears** on the known-broken steps (`my-first-nimbus-dataset`, `measure-objects-*`, `properties-*`) instead of silently skipping. This confirms Phase 1 surfaces breakage loudly.

- [ ] **Step 3: Record findings**

Note which steps hit the recovery popover — this is the authoritative worklist for Phase 2 re-targeting. No commit (observation only).

---

# Phase 2 — Anchor registry + data-tour migration + static guard

Outcome: all static anchors/triggers live in a typed registry; components use `data-tour`; a Vitest test fails CI if a tour references an anchor/trigger not in the registry or not used by a component; broken tours re-targeted.

## Task 6: Create the anchor + trigger registry

**Files:**
- Create: `src/tours/anchors.ts`

- [ ] **Step 1: Write the registry**

Create `src/tours/anchors.ts` enumerating every static anchor and trigger from the inventory above:

```typescript
// Single source of truth for static tour anchor names and trigger-event names.
// Components attach `:data-tour="TOUR_ANCHORS.x"`; YAML targets `[data-tour="x"]`.
// Trigger names are used by `v-tour-trigger` and by YAML `onTriggerEvent`.
// Data-dependent anchors (built at runtime via getTourAnchorId) are NOT listed
// here and are exempt from the static guard.

export const TOUR_ANCHORS = {
  // App.vue
  objectListButton: "object-list-button",
  filtersButton: "filters-button",
  snapshotsButton: "snapshots-button",
  settingsButton: "settings-button",
  analyzeButton: "analyze-button",
  helpButton: "help-button",
  chatButton: "chat-button",
  // ToolCreation.vue
  toolName: "tool-name",
  toolCreationAddToolButton: "tool-creation-add-tool-button",
  // AnnotationConfiguration.vue
  toolCreationLayerSelect: "tool-creation-layer-select",
  toolCreationTagPicker: "tool-creation-tag-picker",
  // Toolset.vue
  addTool: "add-tool",
  // ImageViewer.vue
  layerInfo: "layer-info",
  lockView: "lock-view",
  resetView: "reset-view",
  resetRotation: "reset-rotation",
  // NavigatorPanel.vue
  viewerToolbar: "viewer-toolbar",
  timelapseMode: "timelapse-mode",
  timelapseTags: "timelapse-tags",
  timelapseLabels: "timelapse-labels",
  // ZenodoImporter.vue
  zenodoImporterImportDataset: "zenodo-importer-import-dataset",
  // DisplayLayers.vue
  layerControls: "layer-controls",
  // ZenodoCommunityDisplay.vue
  zenodoCommunityDisplay: "zenodo-community-display",
  // DataIOMenu.vue
  dataIoButton: "data-io-button",
  // AnnotationList.vue
  annotationListContent: "annotation-list-content",
  // PropertyCreation.vue
  createPropertyHeader: "create-property-header",
  propertyTagPicker: "property-tag-picker",
  shapeSelection: "shape-selection",
  propertyAlgorithmSelect: "property-algorithm-select",
  createPropertyButton: "create-property-button",
  // Home.vue
  uploadFiles: "upload-files",
  trySampleDataset: "try-sample-dataset",
  configureDatasetButton: "configure-dataset-button",
  acceptDefaultsButton: "accept-defaults-button",
  // MultiSourceConfiguration.vue
  variables: "variables",
  assignments: "assignments",
  transcodeCheckbox: "transcode-checkbox",
  submitButton: "submit-button",
  // DatasetInfo.vue
  viewDatasetButton: "view-dataset-button",
  // NewDataset.vue
  datasetNameInput: "dataset-name-input",
  datasetDescriptionInput: "dataset-description-input",
  uploadButton: "upload-button",
} as const;

export const TOUR_TRIGGERS = {
  objectListButton: "object-list-button",
  filtersButton: "filters-button",
  snapshotsButton: "snapshots-button",
  settingsButton: "settings-button",
  analyzeButton: "analyze-button",
  helpButton: "help-button",
  chatButton: "chat-button",
  addTool: "add-tool",
  timelapseMode: "timelapse-mode",
  zenodoImporterImportDataset: "zenodo-importer-import-dataset",
  dataIoButton: "data-io-button",
  propertyTagPicker: "property-tag-picker",
  propertyAlgorithmSelect: "property-algorithm-select",
  createPropertyButton: "create-property-button",
  trySampleDataset: "try-sample-dataset",
  configureDataset: "configure-dataset",
  acceptDefaults: "accept-defaults",
  viewDatasetButton: "view-dataset-button",
  submitButton: "submit-button",
  uploadButton: "upload-button",
} as const;

// Set of all known static anchor names, for the static guard.
export const ALL_TOUR_ANCHORS = new Set<string>(Object.values(TOUR_ANCHORS));
export const ALL_TOUR_TRIGGERS = new Set<string>(Object.values(TOUR_TRIGGERS));
```

- [ ] **Step 2: Type-check + commit**

Run: `pnpm tsc 2>&1 | head -5`
Expected: no errors.
```bash
git add src/tours/anchors.ts
git commit -m "feat(tours): add typed anchor + trigger registry"
```

## Task 7: Add data-tour helpers for dynamic anchors

**Files:**
- Modify: `src/utils/strings.ts`

- [ ] **Step 1: Add data-tour-oriented helpers (keep old ones until migration done)**

Append to `src/utils/strings.ts`:

```typescript
// data-tour value for a runtime-named entity (tool/tag/param/title).
// Data-dependent — NOT in the static registry, exempt from the static guard.
export function getTourAnchorId(name: string): string {
  return toKebabCase(name);
}
```

- [ ] **Step 2: Type-check + commit**

Run: `pnpm tsc 2>&1 | head -5`
```bash
git add src/utils/strings.ts
git commit -m "feat(tours): add getTourAnchorId helper for data-dependent anchors"
```

## Task 8: Write the static guard test (TDD)

**Files:**
- Create: `src/tours/anchors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tours/anchors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { load } from "js-yaml";
import { ALL_TOUR_ANCHORS, ALL_TOUR_TRIGGERS } from "./anchors";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

// Anchors that are intentionally data-dependent (built via getTourAnchorId).
// Tours may target these even though they are not in the static registry.
const DATA_DEPENDENT = new Set<string>([
  "nucleus",
  "dapi-blob",
  "blob",
  "gaussian-blur",
  "sigma",
  "parent-tag",
  "my-first-nimbus-dataset",
]);

function allYamlFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => join(here, f));
}

function selectorToAnchor(selector: string): string | null {
  // Accept [data-tour="x"] form only (post-migration).
  const m = selector.match(/^\[data-tour="([a-z0-9-]+)"\]$/);
  return m ? m[1] : null;
}

// Read all component source once so we can assert anchors/triggers are USED.
function allComponentSource(): string {
  let out = "";
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".vue") || entry.name.endsWith(".ts")) {
        out += readFileSync(full, "utf8");
      }
    }
  };
  walk(srcRoot);
  return out;
}

describe("tour anchors", () => {
  const source = allComponentSource();

  it("every YAML element selector resolves to a known or data-dependent anchor", () => {
    const problems: string[] = [];
    for (const file of allYamlFiles()) {
      const tour: any = load(readFileSync(file, "utf8"));
      for (const step of tour.steps ?? []) {
        if (!step.element) continue;
        const anchor = selectorToAnchor(step.element);
        if (anchor == null) {
          problems.push(`${file}: step "${step.id}" selector "${step.element}" is not a [data-tour="..."] selector`);
          continue;
        }
        if (!ALL_TOUR_ANCHORS.has(anchor) && !DATA_DEPENDENT.has(anchor)) {
          problems.push(`${file}: step "${step.id}" targets unknown anchor "${anchor}"`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every YAML onTriggerEvent is a known trigger", () => {
    const problems: string[] = [];
    for (const file of allYamlFiles()) {
      const tour: any = load(readFileSync(file, "utf8"));
      for (const step of tour.steps ?? []) {
        if (!step.onTriggerEvent) continue;
        if (!ALL_TOUR_TRIGGERS.has(step.onTriggerEvent)) {
          problems.push(`${file}: step "${step.id}" uses unknown trigger "${step.onTriggerEvent}"`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every registered static anchor is actually used by a component (data-tour=)", () => {
    const unused = [...ALL_TOUR_ANCHORS].filter(
      (a) => !source.includes(`data-tour="${a}"`) && !source.includes(`data-tour='${a}'`),
    );
    expect(unused, `Registered anchors not found in any component: ${unused.join(", ")}`).toEqual([]);
  });

  it("every registered trigger is actually used by a component (v-tour-trigger)", () => {
    const unused = [...ALL_TOUR_TRIGGERS].filter((t) => !source.includes(`'${t}'`) && !source.includes(`"${t}"`));
    expect(unused, `Registered triggers not found in any component: ${unused.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Ensure `js-yaml` is available for the test**

Run: `node -e "require('js-yaml')" 2>&1 || pnpm add -D js-yaml @types/js-yaml`
Expected: either already present, or installed as a dev dependency.

- [ ] **Step 3: Run the test — expect FAIL**

Run: `pnpm test src/tours/anchors.test.ts 2>&1 | tail -30`
Expected: FAILS — the first test reports YAML selectors that are still `#x-tourstep` (not `[data-tour=...]`), and the "used by a component" tests report anchors not yet migrated. This proves the guard works before migration.

- [ ] **Step 4: Commit the (failing) guard**

```bash
git add src/tours/anchors.test.ts package.json pnpm-lock.yaml
git commit -m "test(tours): add static guard for anchor/trigger contract (currently red)"
```

## Task 9: Migrate component anchors + triggers to data-tour / registry

Migrate **file by file** using this recipe. After each file, run `pnpm tsc` and the relevant part of the guard. The full inventory (which anchors live in which file) is in the Reference section above.

**Recipe per anchor:** `id="NAME-tourstep"` → `:data-tour="TOUR_ANCHORS.camelName"` (import `TOUR_ANCHORS` from `@/tours/anchors`). For dynamic ones, `:id="getTourStepId(x)"` → `:data-tour="getTourAnchorId(x)"`.
**Recipe per trigger:** `v-tour-trigger="'NAME-tourtrigger'"` → `v-tour-trigger="TOUR_TRIGGERS.camelName"` and update the directive consumer (the directive value is the raw event name — drop the `-tourtrigger` suffix; ensure YAML `onTriggerEvent` matches the bare name).

> **Trigger-name decision:** triggers drop the `-tourtrigger` suffix to match the registry value (e.g. `object-list-button`). The directive emits the registry value; YAML `onTriggerEvent` uses the same bare value. Update both sides together per file.

- [ ] **Step 1: Migrate `src/App.vue`** (7 anchors + 7 triggers — largest)

Import `TOUR_ANCHORS, TOUR_TRIGGERS` from `@/tours/anchors`. Replace each `id="object-list-button-tourstep"` with `:data-tour="TOUR_ANCHORS.objectListButton"` etc., and each `v-tour-trigger="'object-list-button-tourtrigger'"` with `v-tour-trigger="TOUR_TRIGGERS.objectListButton"` (and the 6 siblings). Run `pnpm tsc 2>&1 | head -5` (expect clean). Commit:
```bash
git add src/App.vue && git commit -m "refactor(tours): migrate App.vue anchors/triggers to data-tour registry"
```

- [ ] **Step 2: Migrate the remaining component files**

Apply the same recipe to each file below (anchors and any triggers per the inventory). Commit after each with message `refactor(tours): migrate <file> to data-tour registry`:
`src/tools/creation/ToolCreation.vue`, `src/tools/creation/templates/AnnotationConfiguration.vue`, `src/tools/toolsets/Toolset.vue`, `src/components/ImageViewer.vue`, `src/components/NavigatorPanel.vue`, `src/components/ZenodoImporter.vue`, `src/components/DisplayLayers.vue`, `src/components/ZenodoCommunityDisplay.vue`, `src/components/DataIOMenu.vue`, `src/components/AnnotationBrowser/AnnotationList.vue`, `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue`, `src/views/Home.vue`, `src/views/dataset/MultiSourceConfiguration.vue`, `src/views/dataset/DatasetInfo.vue`, `src/views/dataset/NewDataset.vue`.

- [ ] **Step 3: Migrate dynamic anchors**

In `src/tools/creation/ToolTypeSelection.vue`, `src/tools/toolsets/ToolItem.vue`, `src/components/WorkerInterfaceValues.vue`, and the dynamic `:id` in `src/components/ZenodoCommunityDisplay.vue`: replace `:id="getTourStepId(x)"` with `:data-tour="getTourAnchorId(x)"`. Update their `.test.ts` expectations accordingly. Commit.

- [ ] **Step 4: Verify type-check + lint**

Run: `pnpm tsc 2>&1 | head -10 && pnpm lint 2>&1 | head -10`
Expected: clean.

## Task 10: Update tour YAML selectors to data-tour

**Files:**
- Modify: all `src/tours/*.yaml`

- [ ] **Step 1: Rewrite every `element:` selector**

In each YAML, change `element: "#NAME-tourstep"` → `element: '[data-tour="NAME"]'` (NAME without the `-tourstep` suffix). Change every `onTriggerEvent: "NAME-tourtrigger"` → `onTriggerEvent: "NAME"` (bare name matching `TOUR_TRIGGERS`). Leave commented-out `# element:` lines as-is or delete them.

- [ ] **Step 2: Run the static guard for unmigrated/unknown anchors**

Run: `pnpm test src/tours/anchors.test.ts 2>&1 | tail -30`
Expected: the first two tests now pass for migrated tours; remaining failures should ONLY be the known-broken anchors (`measure-objects-*`, `properties-header`, `properties-content`) — fixed in Task 11.

- [ ] **Step 3: Commit**

```bash
git add src/tours/*.yaml
git commit -m "refactor(tours): point YAML tours at data-tour selectors and bare trigger names"
```

## Task 11: Re-target the hard-removed anchors

**Files:**
- Modify: components owning the current properties/measure UI; `src/tours/CalculateBlobMetrics.yaml`, `src/tours/WelcomeTourHome.yaml`; `src/tours/anchors.ts`

- [ ] **Step 1: Locate the current properties/measure UI**

Run:
```bash
grep -rIn "measure\|Measure" src/components/AnnotationBrowser/AnnotationProperties --include="*.vue" | head
```
Expected: identifies the current component(s) and elements that replaced the removed `measure-objects-button`, `measure-objects-close-button`, `properties-header`, `properties-content` chrome.

- [ ] **Step 2: Add registry entries + `data-tour` anchors to the current elements**

Add new constants to `TOUR_ANCHORS` in `src/tours/anchors.ts` for the current equivalents (e.g. `measureObjectsButton: "measure-objects-button"` if the button still exists, or a new name matching the current UI). Attach `:data-tour="TOUR_ANCHORS.x"` to the corresponding current elements.

- [ ] **Step 3: Update the two tours to target the new anchors**

In `CalculateBlobMetrics.yaml` and `WelcomeTourHome.yaml`, repoint the affected steps' `element:` to the new `[data-tour="..."]` selectors (or remove steps whose UI no longer exists, choosing the closest current equivalent).

- [ ] **Step 4: Static guard fully green**

Run: `pnpm test src/tours/anchors.test.ts 2>&1 | tail -20`
Expected: ALL four tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tours/anchors.ts src/tours/*.yaml src/components
git commit -m "fix(tours): re-target removed measure/properties anchors to current UI"
```

## Task 12: Wire content-coupled tours to the Zenodo sample dataset

**Files:**
- Modify: content-dependent tours and the sample-dataset entry path as needed

- [ ] **Step 1: Confirm the sample dataset path the app already uses for tours**

Run:
```bash
grep -rIn "sample\|Zenodo\|community" src/components/ZenodoCommunityDisplay.vue src/views/Home.vue | head
```
Expected: identifies how the app pulls the Zenodo sample dataset that contains the named tools/tags (`Nucleus`, `DAPI blob`, etc.).

- [ ] **Step 2: Ensure content tours assume that dataset's entities**

Confirm the data-dependent anchors (`nucleus`, `dapi-blob`, `blob`, `gaussian-blur`, `sigma`) resolve when the Zenodo sample dataset is loaded. These remain dynamic (`getTourAnchorId`) and are exempt from the static guard; verification happens in Phase 3.

- [ ] **Step 3: Commit any wiring changes**

```bash
git add -A && git commit -m "fix(tours): align content tours with the Zenodo sample dataset entities"
```

## Task 13: Remove dead `getTourStepId`/`getTourTriggerId` if unused

**Files:**
- Modify: `src/utils/strings.ts`

- [ ] **Step 1: Check for remaining usages**

Run:
```bash
grep -rIn "getTourStepId\|getTourTriggerId" src --include="*.vue" --include="*.ts" | grep -v "strings.ts" | grep -v ".test.ts"
```
Expected: no production usages remain (all migrated to `getTourAnchorId` / registry).

- [ ] **Step 2: Delete the now-unused helpers**

If Step 1 returns nothing, remove `getTourStepId` and `getTourTriggerId` from `src/utils/strings.ts` (keep `toKebabCase` and `getTourAnchorId`). Update any `.test.ts` references.

- [ ] **Step 3: Type-check + commit**

Run: `pnpm tsc 2>&1 | head -5`
```bash
git add src/utils/strings.ts && git commit -m "chore(tours): remove unused getTourStepId/getTourTriggerId helpers"
```

## Task 14: Fix stale tour-name references + docs

**Files:**
- Modify: `src/store/model.ts:1654-1659`; `src/tours/TOURS.md`

- [ ] **Step 1: Reconcile `WelcomeTourNames` with actual YAML filenames**

In `src/store/model.ts`, fix the mapping so each `WelcomeTourTypes` points to an existing YAML file (`VIEWER → "IntroViewerTour"`, `ADVANCED_UPLOAD → "AdvancedUploadTour"`), OR rename the YAML files to match the mapping — whichever matches how `$startTour` is invoked. Confirm by:
```bash
grep -rIn "WelcomeTourNames\|startTour(" src --include="*.vue" --include="*.ts" | head
```

- [ ] **Step 2: Update TOURS.md**

Rewrite `src/tours/TOURS.md`: document the `data-tour` convention, the `anchors.ts` registry, the static guard, driver.js as the engine (not Shepherd), and how `onTriggerEvent` uses bare trigger names. Remove the `id="...-tourstep"` and Shepherd references.

- [ ] **Step 3: Full verification + commit**

Run: `pnpm tsc 2>&1 | head -5 && pnpm lint 2>&1 | head -5 && pnpm test src/tours/anchors.test.ts 2>&1 | tail -10`
Expected: all clean/green.
```bash
git add src/store/model.ts src/tours/TOURS.md
git commit -m "docs(tours): update TOURS.md for data-tour/driver.js; fix WelcomeTourNames mapping"
```

---

# Phase 3 — Manual browser walkthrough

Outcome: every tour verified end-to-end in a real browser with captured evidence; stragglers fixed.

## Task 15: Prepare the environment

- [ ] **Step 1: Backend + sample dataset**

Run: `docker compose up -d && pnpm run dev`. Log in (`admin`/`password`). Import/open the Zenodo sample dataset used by content tours.
Expected: app runs; sample dataset available with the named tools/tags.

## Task 16: Walk through every tour and capture evidence

For EACH tour below, drive it end-to-end in the browser (Claude-in-Chrome), verify highlight/position/timing/advancement and modal vs non-modal behavior, and capture a screenshot or GIF. If a step fails, fix the anchor/registry/YAML, re-run the static guard, and re-test.

- [ ] **Step 1: `WelcomeTourHome`** (28 steps, multi-route, content-coupled) — capture GIF.
- [ ] **Step 2: `IntroViewerTour`** — capture screenshots.
- [ ] **Step 3: `AdvancedUploadTour`** (multi-route: root→newdataset→multi→dataset→datasetview) — capture GIF; verify route auto-navigation.
- [ ] **Step 4: `CalculateBlobMetrics`** — verify re-targeted measure/properties anchors.
- [ ] **Step 5: `AddManualBlobToolTour`** — verify content anchors on sample dataset.
- [ ] **Step 6: `WorkingWithTags`** — capture screenshot.
- [ ] **Step 7: `testTimelapseTour`** — verify timelapse anchors + event triggers.
- [ ] **Step 8: `TestToolTourstep`** — verify dynamic tool-type anchors.

- [ ] **Step 9: Final verification + commit any fixes**

Run: `pnpm tsc && pnpm lint:ci && pnpm test src/tours/anchors.test.ts`
Expected: all green.
```bash
git add -A && git commit -m "test(tours): browser-verified all tours on driver.js; fix stragglers"
```

## Task 17: Finalize

- [ ] **Step 1: Full test suite + build**

Run: `pnpm test 2>&1 | tail -20 && pnpm build 2>&1 | tail -10`
Expected: tests pass; build succeeds.

- [ ] **Step 2: Push branch and open PR**

```bash
git push -u origin tours/overhaul
```
Then open a PR summarizing: engine swap (Shepherd→driver.js, license + bundle win), loud-failure glue, data-tour registry + static guard, re-targeted/broken tours, and attach the captured tour GIFs/screenshots.

---

## Self-review notes

- **Spec coverage:** B (data-tour + registry) → Tasks 6,9,10; C (engine swap) → Tasks 1-4; D (glue hardening: loud failure, auto-nav, waits, drop eval) → Tasks 2,3; E (re-target + Zenodo sample) → Tasks 11,12; F (static guard + walkthrough) → Tasks 8,15-16; G phasing → Phase order matches engine-first. All covered.
- **Dynamic-anchor exemption** is explicit in the guard (`DATA_DEPENDENT` set) per the approved design.
- **driver.js API risk:** Task 1 Step 2 confirms the real `.d.ts` signatures before the rewrite; if `onPopoverRender`/`showButtons`/`nextBtnText`/overlay-opacity-via-class differ in the installed version, adjust Task 3/4 to match (the controller structure stays the same).
