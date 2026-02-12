# Vue 3 Migration Plan

## Overview

This document tracks the incremental migration of NimbusImage from Vue 2 (Class Components + Vuex with decorators) to Vue 3 (Composition API + Vuetify 3). The strategy is to adopt Vue 3-compatible patterns within Vue 2.7 first, then switch frameworks with minimal breakage.

## Current State (as of initial planning)

| Category | Count | Notes |
|----------|-------|-------|
| Class components (`@Component`) | 108 | 81 already migrated to `<script setup>` |
| `.sync` modifier usages | 11 | Convert to `v-model:propName` |
| `Vue.set` / `Vue.delete` | 91 | Remove (Vue 3 reactivity handles these) |
| Vuex store modules (`@Module`) | 11 | Keep Vuex for now; migrate to Pinia later |
| `v-data-table` usages | 15 | Vuetify 3 API changes significantly |
| `v-dialog` usages | 129 | Event/prop API changes in Vuetify 3 |
| `$refs` usages | 62 | Typing changes between Class → Composition |
| Mixins | 0 | None to migrate |

## Migration Strategy

### Phase 1: Composition API Migration (Current)

Convert components from Class API (`@Component` + decorators) to `<script setup>` syntax. This is fully supported in Vue 2.7 and is the standard Vue 3 pattern.

**Approach:** Start with leaf components (no child component dependencies), then work inward toward complex components.

**Key pattern translations:**

| Vue 2 Class API | Vue 2.7+ Composition API |
|-----------------|--------------------------|
| `@Prop() name!: Type` | `defineProps<{ name: Type }>()` |
| `@Emit('name')` | `const emit = defineEmits<{...}>()` |
| `@VModel()` / computed get/set | `v-model` with computed or `:value` + `@input` |
| `@Watch('prop')` | `watch(() => prop, callback)` |
| `this.$store` | `import { useStore } from 'vuex'` |
| `@Component({ inheritAttrs: false })` | Dual `<script>` blocks (until Vue 3.3 `defineOptions`) |
| `this.$refs.foo` | `const foo = ref<InstanceType<typeof Foo>>()` |

**Known limitations in Vue 2.7:**
- `defineOptions()` not available until Vue 3.3 — use dual `<script>` blocks for `inheritAttrs: false`
- `$vnode.data` for class/style passthrough is Vue 2-only — will need `useAttrs()` in Vue 3
- Template ref typing differs between Class Components and Composition API — use `any` during mixed-mode migration

### Phase 2: Remove Vue 2-Only Patterns

These can be done incrementally alongside Phase 1:

- **Remove `Vue.set()` / `Vue.delete()`** (~94 occurrences): Most can be replaced with direct property assignment or object spread (Vue 3's Proxy reactivity handles new properties). **Exception:** GeoJS-related `Vue.set` calls (in `ImageViewer.vue`, `AnnotationViewer.vue`) must be replaced with direct assignment + `markRaw()` — see "GeoJS & Vue 3 Proxy Reactivity" section.
- **Convert `.sync` to `v-model:`** (11 occurrences): `<component :prop.sync="val">` → `<component v-model:prop="val">`. Works in Vue 2.7.
- **Audit `$refs` usage** (62 occurrences): Ensure template refs work with Composition API components. Mixed-mode typing may need `any` temporarily.

### Phase 3: Vuetify 3 Preparation

Vuetify 3 has significant API changes. Mitigation strategies:

**Wrapper components:** Create thin wrappers in `src/components/ui/` for heavily-used Vuetify components. When Vuetify 3 arrives, update only the wrapper.

Priority wrappers:
- `v-dialog` (129 usages) — event names change (`@input` → `@update:modelValue`)
- `v-data-table` (15 usages) — API overhaul in Vuetify 3
- Form validation — Vuetify 3 removes built-in validation; will need VeeValidate or similar

**Icon migration:** Current `mdi-*` string usage works with `@mdi/js` in both versions.

### Phase 4: Store Migration (Future)

Currently using Vuex with `vuex-module-decorators` (11 modules). Plan:
1. Keep Vuex during Composition API migration
2. Install Pinia alongside Vuex when ready
3. Migrate one store module at a time (start with smallest: `properties.ts`)
4. Eventually remove Vuex

### Phase 5: Vue 3 + Vuetify 3 Switch (Future)

Once most components use Composition API and Vuetify wrappers are in place:
1. Update Vue 2.7 → Vue 3
2. Update Vuetify 2 → Vuetify 3
3. Update wrapper components for new APIs
4. Apply `markRaw()` protection to GeoJS objects (see below)
5. Fix remaining incompatibilities
6. Full regression testing

### GeoJS & Vue 3 Proxy Reactivity (Critical — Phase 5 Preparation)

Vue 3 replaces `Object.defineProperty` (Vue 2) with **ES6 Proxies** for reactivity. Libraries like GeoJS (and similar WebGL/Canvas wrappers) rely on strict object identity (`this === that`) and internal private slots. When Vue 3 wraps a GeoJS instance in a Proxy, it breaks these internal checks, causing:

1. **Identity failures:** GeoJS cannot recognize its own instances
2. **Performance cliffs:** Vue attempts to deeply observe massive graphical objects
3. **Crashes:** "Illegal invocation" errors when accessing internal slots via a Proxy

**The fix:** Use `markRaw()` to tell Vue NOT to proxy GeoJS objects. This can be done now (Vue 2.7 supports `markRaw` from `vue`) and is forward-compatible with Vue 3.

#### Current State

`ImageViewer.vue` already uses `markRaw()` in 3 places (for `imageLayers` array and `params`), but **most GeoJS objects in `IMapEntry` are unprotected**. `AnnotationViewer.vue` has **no `markRaw()` usage at all**.

#### Affected Objects in `ImageViewer.vue`

The `IMapEntry` interface (`src/store/model.ts:1600-1614`) holds these GeoJS objects that all need `markRaw()`:

| Field | Currently Protected? | Notes |
|-------|---------------------|-------|
| `map` | No | Core GeoJS map instance |
| `imageLayers` | Yes (`markRaw([])`) | Array is marked raw; items pushed in need protection too |
| `params` | Yes (`markRaw(params)`) | Already protected |
| `annotationLayer` | No | GeoJS annotation layer |
| `workerPreviewLayer` | No | GeoJS feature layer |
| `workerPreviewFeature` | No | GeoJS feature |
| `textLayer` | No | GeoJS feature layer |
| `timelapseLayer` | No | GeoJS annotation layer |
| `timelapseTextLayer` | No | GeoJS feature layer |
| `interactionLayer` | No | GeoJS annotation layer |
| `uiLayer` | No | GeoJS UI layer (optional) |

**Fix in `_setupMap()`:**

```typescript
const mapentry: IMapEntry = {
  map: markRaw(map),
  imageLayers: [],                              // Reactive array (for DOM updates)
  params: markRaw(params),
  annotationLayer: markRaw(annotationLayer),
  workerPreviewLayer: markRaw(workerPreviewLayer),
  textLayer: markRaw(textLayer),
  timelapseLayer: markRaw(timelapseLayer),
  timelapseTextLayer: markRaw(timelapseTextLayer),
  workerPreviewFeature: markRaw(workerPreviewFeature),
  interactionLayer: markRaw(interactionLayer),
  // ... baseLayerIndex, etc.
};
```

**Fix in `_setupTileLayers()`:** Wrap items pushed into `imageLayers`:

```typescript
mapentry.imageLayers.push(markRaw(newMap));
```

#### Affected Objects in `AnnotationViewer.vue`

These class properties hold GeoJS annotation objects that must be wrapped in `markRaw()` at every assignment site:

| Property | Assignment Count | Key Methods |
|----------|-----------------|-------------|
| `pendingAnnotation` | ~3 | `createGeoJSAnnotation`, null resets |
| `selectionAnnotation` | ~2 | `samPromptToAnnotation` |
| `samPromptAnnotations` | ~2 | Array of annotations |
| `samUnsubmittedAnnotation` | ~3 | GeoJS annotation from SAM |
| `samLivePreviewAnnotation` | ~3 | GeoJS annotation from SAM |
| `cursorAnnotation` | ~2 | `geojs.createAnnotation("circle")` |
| `dragGhostAnnotation` | ~2 | `geojsAnnotationFactory(...)` |

**Pattern for every GeoJS annotation assignment:**

```typescript
// BEFORE (current)
this.cursorAnnotation = geojs.createAnnotation("circle");

// AFTER (Vue 3-safe)
this.cursorAnnotation = markRaw(geojs.createAnnotation("circle"));
```

**For arrays:** Wrap individual items, not the array itself (so Vue can track array length changes):

```typescript
// BEFORE
newAnnotations.push(newAnnotation);

// AFTER
newAnnotations.push(markRaw(newAnnotation));
```

#### `Vue.set` Interaction with `markRaw`

The 94 `Vue.set()` calls across the codebase fall into two categories:

1. **Simple reactive property sets** (most cases): Replace with direct assignment in Vue 3. Vue 3's Proxy reactivity tracks new property additions automatically.
2. **GeoJS object stores** (e.g., `Vue.set(this.maps, mllidx, mapentry)` in ImageViewer): These can become direct assignment BUT the value must be wrapped in `markRaw()` first.

**Important:** Do NOT blindly remove `Vue.set` for GeoJS-related assignments without adding `markRaw()`. The combination `Vue.set` → direct assignment + `markRaw()` is the correct migration path for these objects.

#### Verification Checklist (Post-Migration)

After applying `markRaw()` changes, verify:

1. **Map pan/zoom** — smooth without console errors (tests `ImageViewer` map instance)
2. **Layer toggling** — layers appear/disappear correctly (tests `imageLayers` reactivity)
3. **Drawing tools** — cursor appears, can draw circles/polygons (tests cursor/ghost instances)
4. **Edit mode** — can drag existing annotations (tests `dragGhostAnnotation` identity)
5. **SAM tools** — prompts appear, preview renders (tests SAM annotation instances)

#### When to Apply These Changes

These `markRaw()` additions can be done:
- **Now (Phase 1):** Safe to add during Composition API migration of ImageViewer/AnnotationViewer. `markRaw` is a no-op performance hint in Vue 2.7 — it won't break anything.
- **Phase 5 (required):** Must be in place before the Vue 3 switch or the app will crash.

## Components Migrated

### Batch 1 — Leaf Components
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `SelectAllNoneChips.vue` | 19 | `defineEmits` only |
| `SwitchToggle.vue` | 50 | `defineProps`, emit-based v-model |
| `ColorPickerMenu.vue` | 75 | Dual script blocks, `getCurrentInstance()`, `inheritAttrs` |

### Batch 2 — Leaf Components
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `AlertDialog.vue` | 60 | `ref()`, computed v-model, `defineExpose()` |
| `HotkeySelection.vue` | 85 | Computed get/set for v-model, external lib (Mousetrap) |
| `NimbusTooltip.vue` | 40 | `withDefaults()` for prop defaults |

### Batch 3 — Mixed Leaf & Store-Connected Components
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ToolIcon.vue` | 47 | `defineProps`, `computed()` for icon mapping |
| `AnnotationActionPanel.vue` | 65 | `defineProps`, `defineEmits`, `ref()`, clipboard API |
| `UISettings.vue` | 37 | `getCurrentInstance()` for `$vuetify.theme.dark` |
| `PixelScaleBarSetting.vue` | 27 | `computed({ get, set })` for store binding |
| `UserProfileSettings.vue` | 32 | `getCurrentInstance()` for `$router`, store import |
| `TagSelectionDialog.vue` | 81 | Computed get/set for `.sync` dialog, `ref()` local state, `defineExpose()` |
| `ColorSelectionDialog.vue` | 62 | Same dialog `.sync` pattern, radio group state |
| `ChannelSelect.vue` | 54 | `@VModel` → computed get/set + `emit("input")`, `withDefaults()` |
| `ChannelCheckboxGroup.vue` | 75 | Bidirectional `watch()` for nested v-model mutation, top-level init |
| `CircleToDotMenu.vue` | 40 | `watch()` + `onMounted()` replacing `@Watch` + `mounted()` |

### Batch 4 — Store-Connected & Props-Heavy Components
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ServerStatus.vue` | 103 | Store getters → `computed()`, `@/store/sync` import |
| `HelpPanel.vue` | 105 | Map-based grouping computeds, utility imports |
| `RecentDatasets.vue` | 90 | `defineProps` with function props, `defineEmits` |
| `RecentProjects.vue` | 125 | `withDefaults`, helper methods become plain functions |
| `CollectionItemRow.vue` | 107 | `getCurrentInstance()` for `$router.push`, local interface |
| `FileItemRow.vue` | 99 | `ref()` for local state, `withDefaults`, auto-registered child |
| `LayerInfoGrid.vue` | 109 | 6 store-delegating methods become plain functions |
| `AnalyzePanel.vue` | 84 | `withDefaults`, event relay in template |
| `DisplaySlice.vue` | 158 | 5 props, complex validation logic, removed unused store import |
| `DisplayLayerGroup.vue` | 148 | Template ref array (`ref<T[]>([])`), computed get/set, `vuedraggable` |

### Batch 5 — Annotation Browser, Filters, & Worker Interface Components
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ContrastPanels.vue` | 39 | Options API → `computed()`, auto-registered child |
| `ROIFilters.vue` | 43 | filterStore methods → plain functions, `computed()` |
| `AnnotationBrowser.vue` | 37 | `ref()` for local state, filterStore import, auto-registered children |
| `PropertyFilterSelector.vue` | 81 | `ref()` for dialog/search, store-delegating functions |
| `TagCloudPicker.vue` | 204 | `defineProps`+`defineEmits`, `watch()` for bidirectional sync, `onMounted()` |
| `TagFilterEditor.vue` | 78 | Computed get/set for VModel proxy, `.sync` stays for Vue 2.7 |
| `AnnotationIdFilters.vue` | 100 | `ref()` for dialog state, ID parsing logic preserved |
| `AnnotationFilters.vue` | 107 | 4 computed get/set proxying store, removed unused local state |
| `LayerSelect.vue` | 64 | `Vue.set` → array spread, `watch()` + `onMounted()` |
| `TagPicker.vue` | 78 | Template ref for combobox, `nextTick` import, removed unused `layers` getter |
| `WorkerInterfaceValues.vue` | 186 | `withDefaults`, `watch()` for workerInterface, `getTourStepId` auto-available |

**Key Phase 2 cleanups in this batch:**
- `LayerSelect.vue`: Removed `Vue.set(arr, arr.length, val)` → array spread `[...arr, val]`
- `TagPicker.vue`: Removed unused `get layers()` getter
- `AnnotationFilters.vue`: Removed unused `tagSearchInput` and `show` local state

### Batch 6 — Dialog Components, Store-Connected & Parent Components
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `SettingsPanel.vue` | 24 | Options API `data()` → `ref()`, trivial wrapper |
| `FileDropzone.vue` | 69 | `@VModel` → `defineProps`+`defineEmits`+computed get/set |
| `PropertyWorkerMenu.vue` | 51 | `@VModel` → computed get/set, removed 3 unused locals |
| `DockerImageSelect.vue` | 81 | `@VModel` → computed get/set, `onMounted()` for fetch |
| `AnnotationToggles.vue` | 137 | 6 computed get/set proxying store, module-level const |
| `ProgressBarGroup.vue` | 149 | Store getters → `computed()`, complex grouping logic preserved |
| `LargeImageDropdown.vue` | 153 | `@Watch` + `mounted` → `watch()` + `onMounted()`, computed get/set |
| `ValueSlider.vue` | 199 | 7 `@Prop` → `withDefaults`, `getCurrentInstance()` for emit |
| `DeleteConnections.vue` | 129 | Dialog, `as const satisfies` preserved, async submit |
| `GirderLocationChooser.vue` | 107 | Async imports → synchronous, `getCurrentInstance()` for emit |
| `IndexConversionDialog.vue` | 240 | `@Watch` → `watch()`, CSV generation, dialog pattern |
| `AnnotationExport.vue` | 293 | 3 `@Watch` → 3 `watch()`, `onMounted()`, bulk export |
| `AnnotationImport.vue` | 274 | `@Watch` → `watch()`, JSON file parsing, import options |
| `JobsLogs.vue` | 375 | Consolidated duplicate imports, removed wrapper method |
| `AnnotationActions.vue` | 145 | 4 stores, 5 children, undo/redo, removed unused `propertyIds` |

**Key cleanups in this batch:**
- `PropertyWorkerMenu.vue`: Removed 3 unused locals (`show`, `running`, `previousRunStatus`) and unused store imports
- `JobsLogs.vue`: Consolidated duplicate store imports (`store` and `main`), removed `formatDateString` wrapper method
- `GirderLocationChooser.vue`: Converted async component imports to regular synchronous imports
- `AnnotationActions.vue`: Removed unused `propertyIds` computed

### Batch 7 — Tool System, Views, Layout & Annotation Properties
| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `DockerImage.vue` | 69 | `@Prop` → `defineProps`, `@Watch` → `watch()`, `$emit` → `defineEmits` |
| `ToolEdition.vue` | 103 | Template ref for child component, `watch(() => props.tool, reset)` |
| `TagAndLayerRestriction.vue` | 136 | 3× `@Watch` → 3 `watch()` calls, removed unused `tagSearchInput` |
| `ToolConfigurationItem.vue` | 106 | Dynamic `<component :is>` with auto-registered imports, computed get/set |
| `ToolItem.vue` | 113 | Custom directives `v-mousetrap`/`v-tour-trigger`, `$attrs`/`$listeners`, jobs store |
| `Dataset.vue` | 88 | `getCurrentInstance()` for `$route`, `watch(() => vm.$route, ...)` |
| `ImportDataset.vue` | 95 | `getCurrentInstance()` for `$router.push()`, async store API |
| `DuplicateImportConfiguration.vue` | 101 | `getCurrentInstance()` for `$router.back()`, girderResources store |
| `ImportConfiguration.vue` | 129 | `$route.query` fallback for computed, girderResources store |
| `Viewer.vue` | 114 | 3 stores, removed unused `ContrastPanels` import |
| `UserMenuLoginForm.vue` | 196 | VModel pattern → `defineProps`+`defineEmits`+computed, `import.meta.env` |
| `UserMenu.vue` | 109 | `getCurrentInstance()` for `$route.name` init, 2× `watch()` on same handler |
| `Property.vue` | 186 | Kept `Vue.set()` for Vuex mutation (Phase 2), removed unused imports |
| `PropertyList.vue` | 145 | Removed unused `store`, `filterStore`, `TagFilterEditor` imports |

**Key cleanups in this batch:**
- `TagAndLayerRestriction.vue`: Removed unused `tagSearchInput` local state
- `Viewer.vue`: Removed unused `ContrastPanels` import
- `Property.vue`: Removed unused `TagFilterEditor` and `LayerSelect` imports/registrations
- `PropertyList.vue`: Removed unused `store`, `filterStore`, `TagFilterEditor` imports

**Key patterns in this batch:**
- Route-dependent views use `getCurrentInstance()!.proxy` for `$route`/`$router` access
- `ToolConfigurationItem` dynamic `<component :is>` works with auto-registered imports in `<script setup>`
- `ToolItem` preserves `v-on="$listeners"` and `v-bind="$attrs"` (still valid in Vue 2.7 `<script setup>`)
- `Property.vue` retains `Vue.set()` calls for Vuex store mutations — Phase 2 cleanup

### Batch 8 — Dialogs, Settings, Tool System & Annotation Properties

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `MovieDialog.vue` | 280 | v-model dialog pattern, computed get/set, `MovieFormat` enum in template scope |
| `AddCollectionToProjectFilterDialog.vue` | 176 | `@Watch` → `watch()`, `onMounted` for async fetch |
| `AddToProjectDialog.vue` | 239 | `withDefaults(defineProps)`, dialog v-model, tabs |
| `AddCollectionToProjectDialog.vue` | 245 | Nearly identical to AddToProjectDialog but for collections |
| `AddDatasetToProjectDialog.vue` | 194 | `.sync` binding retained (Phase 2), `Promise.all` async |
| `AnnotationContextMenu.vue` | 201 | 4 `@Prop` → `defineProps`, computed get/set for showMenu |
| `PropertyBody.vue` | 217 | Refactored side effect out of computed into `watch()` |
| `ScaleSettings.vue` | 235 | Computed get/set pairs, unit conversion, `withDefaults` |
| `ZenodoCommunityDisplay.vue` | 241 | `withDefaults`, `onMounted` async, ZenodoAPI, tour helpers |
| `ViewerSettings.vue` | 278 | `@Debounce` → lodash `debounce()`, 12 computed get/set pairs |
| `SamToolMenu.vue` | 260 | `@Debounce` → lodash `debounce()`, 4 `watch()` calls |
| `AnnotationConfiguration.vue` | 346 | Dual `<script>` for `IAnnotationSetup` export, `Vue.set()`, `getCurrentInstance()` for tour, 5 `watch()` |
| `ToolTypeSelection.vue` | 605 | Dual `<script>` for `TReturnType` export, `nextTick()`, `onMounted` fetch |
| `ToolConfiguration.vue` | 255 | Dynamic `$refs` → function ref pattern `getRefSetter()`, `Vue.set()` retained |
| `PropertyCreation.vue` | 342 | 5 `@Watch` → 5 `watch()` calls, 3 stores, name deduplication |

**Key patterns in this batch:**
- `@Debounce` decorator → lodash `debounce()` directly (ViewerSettings, SamToolMenu)
- Dynamic `$refs[item.id]` → `:ref="getRefSetter(item.id)"` with curried function (ToolConfiguration)
- Dual `<script>` blocks for named type/interface exports (AnnotationConfiguration, ToolTypeSelection)
- Tour plugin methods via `getCurrentInstance()!.proxy.$isTourActive()` / `$startTour()` (AnnotationConfiguration)
- `Vue.set()` retained for nested reactive mutations (AnnotationConfiguration, ToolConfiguration) — Phase 2 cleanup
- `DockerImageSelect` value prop updated to accept `string | null`
- `PropertyBody` refactored: side effect in computed moved to separate `watch()`

**Also fixed:**
- `ToolCreation.vue` (not migrated): Updated `$refs.toolConfiguration` cast for `<script setup>` component type
- `AnalyzePanel.test.ts`: Updated stub selector for `<script setup>` PropertyCreation

## Next Candidates

Good candidates for the next migration batch, ordered by complexity:

**Blocked on mixin conversion:**
- `ConfigurationSelect.vue`, `NewConfiguration.vue` — require converting `routeMapper` mixin to composable first

**Medium components with store access:**
- `AnnotationFilterDialog.vue`
- `AnnotationCSVDialog.vue`
- `ExportDialog.vue`

**Large/complex components (migrate last):**
- `AnnotationViewer.vue` (~3,160 lines) — consider splitting into composables first
- `ImageViewer.vue` — GeoJS integration, test rendering thoroughly
- `src/store/index.ts` (~2,477 lines) — consider splitting before Pinia migration

## Testing Strategy

Pair each migration batch with tests:

1. **Composable tests** — Pure function tests, easy to write
2. **Component tests** — Vue Test Utils with mount/shallowMount
3. **Store tests** — Test modules in isolation

Framework: Vitest (already configured). Run with `pnpm test`.

### Component Test Setup

**Dependencies:** `@vue/test-utils@1` (v1 for Vue 2, v2 for Vue 3), `jsdom` environment.

**Vitest config** (`vitest.config.js`): Uses `environment: "jsdom"` for DOM-based component tests. The `db/**` directory is excluded to avoid permission errors from MongoDB data files.

**Mounting pattern for Vuetify components:**

```typescript
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import MyComponent from "./MyComponent.vue";

// Use global Vue.use — do NOT use createLocalVue (causes "multiple instances" errors)
Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(MyComponent, {
    vuetify: new Vuetify(),
    propsData: { ...props },
  });
}
```

**Vuetify dialogs** (`v-dialog`) require a `[data-app]` element and `attachTo`:

```typescript
function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);
  return mount(MyDialogComponent, {
    vuetify: new Vuetify(),
    attachTo: app,
  });
}
// Call wrapper.destroy() in each test to clean up
```

**`<script setup>` components** only expose what's in `defineExpose()` on `wrapper.vm`. Internal `ref()` and `computed()` values are not accessible — test via DOM output or exposed methods instead.

**Mocking external libraries** (e.g., Mousetrap):

```typescript
vi.mock("mousetrap", () => ({
  default: {
    record: vi.fn((callback) => callback(["ctrl+s"])),
  },
}));
```

**Mocking Vuex store modules** (for components that import store singletons):

```typescript
vi.mock("@/store", () => ({
  default: {
    dataset: {
      channels: [0, 1, 2],
      channelNames: new Map([[0, "DAPI"], [1, "GFP"]]),
    },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: { selectedAnnotationIds: ["id1", "id2"] },
}));
```

**Important:** `vi.mock` factories are hoisted — do not reference variables declared outside the factory. Use `vi.fn()` directly inside the factory instead.

**Transitive store imports:** Even when stubbing child components (e.g., `stubs: { TagPicker: true }`), the child's module-level imports still execute. Mock any stores imported transitively by the child component.

### Known Test Warnings

- **"Multiple instances of Vue detected"**: Vuetify warning in test environments. Harmless; caused by module resolution in vitest. Using global `Vue.use(Vuetify)` instead of `createLocalVue` minimizes this.
- **"Invalid prop type: null is not a constructor"**: Vue 2.7 quirk with union types like `Element | string` in `defineProps`. Resolves with Vue 3.
- **"Unable to locate target [data-app]"**: Vuetify dialog warning. Use the `attachTo` pattern above to fix.

## Migration Patterns & Gotchas

Patterns and pitfalls discovered during Batches 1–6. Follow these when migrating remaining components.

### `defineExpose` is required for test access

In `<script setup>`, internal `ref()`, `computed()`, and functions are **not** accessible via `wrapper.vm` unless explicitly exposed. Every migrated component must include `defineExpose` for any property or method that tests access.

```typescript
// At the end of <script setup>
defineExpose({ myRef, myComputed, myMethod });
```

**Props ARE still accessible** on `wrapper.vm` without `defineExpose` — Vue 2.7 puts them on the instance automatically. Only script-internal bindings need exposing.

### `@VModel` → defineProps + defineEmits + computed get/set

```typescript
// Class style
@VModel({ type: String }) image!: string;

// Composition API
const props = defineProps<{ value: string }>();
const emit = defineEmits<{ (e: "input", value: string): void }>();
const image = computed({
  get: () => props.value,
  set: (val: string) => emit("input", val),
});
```

### `getCurrentInstance()` for non-standard emits

For components that emit events not declared in `defineEmits` (e.g., `update:dialog` for `.sync` props, or `input` emitted outside a computed setter):

```typescript
const vm = getCurrentInstance()!.proxy;
vm.$emit("update:dialog", value);
vm.$emit("input", selected.value);
```

### Async component imports → synchronous in Vue 2.7

Vue 2.7 does **not** have `defineAsyncComponent`. Convert `() => import(...)` patterns to regular synchronous imports during migration.

### `@Watch` → `watch()`

```typescript
// Class: @Watch("value", { immediate: true })
// Composition:
watch(() => props.value, (newVal) => { ... }, { immediate: true });
```

### `vi.mock` hoisting — never reference outer variables

`vi.mock()` factories are hoisted above all `const`/`let` declarations. Referencing variables from outside the factory causes `ReferenceError`.

```typescript
// BAD — ReferenceError
const mockStore = { dataset: null };
vi.mock("@/store", () => ({ default: mockStore }));

// GOOD — inline data, import after mock
vi.mock("@/store", () => ({
  default: { dataset: null },
}));
import store from "@/store"; // import AFTER vi.mock to get mocked reference
```

### Custom directives must be registered in tests

Components using `v-description` (or other custom directives) need the directive registered before mounting:

```typescript
Vue.directive("description", {});
```

### Test-first migration cycle

Follow this order for each component:

1. Write `*.test.ts` alongside the component
2. Run tests against current (class-style) code — verify pass
3. Migrate component to `<script setup>`
4. Add `defineExpose` for all test-accessed internals
5. Re-run tests — verify pass
6. After full batch: `pnpm tsc && pnpm lint && pnpm build`

## Risk Areas

- **GeoJS Proxy Reactivity** (Critical): Vue 3's Proxy-based reactivity will break GeoJS object identity checks, causing crashes and performance cliffs. `ImageViewer.vue` and `AnnotationViewer.vue` require `markRaw()` on all GeoJS instances before the Vue 3 switch. See "GeoJS & Vue 3 Proxy Reactivity" section for full details.
- **AnnotationViewer.vue** (3,160 lines): Most complex component. Break into composables before full migration. Contains 7 GeoJS annotation properties that need `markRaw()` protection.
- **ImageViewer.vue** (~1,500 lines): GeoJS map/layer management. Already has partial `markRaw()` usage but 9 of 11 `IMapEntry` fields are unprotected. Must complete `markRaw()` coverage.
- **Store interdependencies**: 11 Vuex modules with cross-references. Map dependencies before Pinia migration.
- **`$vnode.data` access**: Used in ColorPickerMenu for class/style passthrough. Vue 2-only API.
- **Template ref typing**: Mixed Class + Composition components cause type mismatches during incremental migration.
- **Vuetify v-data-table**: Significant API differences in v3. Abstract usage early.
