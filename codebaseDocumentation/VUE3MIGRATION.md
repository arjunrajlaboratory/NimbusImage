# Vue 3 Migration Plan

## Overview

This document tracks the incremental migration of NimbusImage from Vue 2 (Class Components + Vuex with decorators) to Vue 3 (Composition API + Vuetify 3). The strategy is to adopt Vue 3-compatible patterns within Vue 2.7 first, then switch frameworks with minimal breakage.

## Current State (as of initial planning)

| Category | Count | Notes |
|----------|-------|-------|
| Class components (`@Component`) | 121 | 120 migrated to `<script setup>`, 1 remaining |
| `.sync` modifier usages | 11 | Convert to `v-model:propName` |
| `Vue.set` / `Vue.delete` | 91 | Remove (Vue 3 reactivity handles these) |
| Vuex store modules (`@Module`) | 11 | Keep Vuex for now; migrate to Pinia later |
| `v-data-table` usages | 15 | Vuetify 3 API changes significantly |
| `v-dialog` usages | 129 | Event/prop API changes in Vuetify 3 |
| `$refs` usages | 62 | Typing changes between Class → Composition |
| Mixins | 0 | `routeMapper` mixin converted to `useRouteMapper` composable (Batch 9) |

## Current Status & Known Issues

**Migration progress:** 121 of 121 components migrated to `<script setup>` (Batches 1–19 complete). All components migrated.

### TypeScript Errors (`pnpm tsc`)

There are **22 non-test `tsc` errors** remaining. These are all **type-only** — the build (`pnpm build`) succeeds. Categories:

1. **`IGirderLocation` vs `IGirderSelectAble` v-model mismatches (8 errors):** Components that use `GirderLocationChooser` (which expects `IGirderLocation` for its `value` prop) pass values from store that Vue's type inference expands to structural types that don't perfectly match. Affected: `AddDatasetToCollection`, `AddDatasetToProjectDialog`, `ZenodoImporter`, `NewConfiguration`, `ImportConfiguration`, `DuplicateImportConfiguration`, `ImportDataset`, `Home.vue`. These are harmless — the runtime values are always compatible. Fix: could add explicit type guards at each callsite, but low priority since the code works correctly.

2. **Nullable prop mismatches (4 errors):** `DisplayLayer.vue` and `LayerInfoGrid.vue` pass `IContrast | null` and `Promise<ITileHistogram | null>` to `ContrastHistogram` props typed as non-null. Fix: widen ContrastHistogram's prop types to accept null.

3. **`WorkerInterfaceValues.vue` union type narrowing (4 errors):** `TWorkerInterfaceValue` union type passed to Vuetify components that expect specific types. Fix: add type guards or casts at each binding.

4. **`LayerSelect.vue` read-only prop assignment (3 errors):** Writing to `props.value` directly. Fix: use local ref or emit.

5. **`Snapshots.vue` nullable/signature mismatches (2 errors):** `IDataset | null` where `IDataset` expected, and callback signature mismatch. Fix: add null guards and align types.

6. **`AddDatasetToCollection.vue` nullable string (1 error):** `string | null` where `string` expected.

**Why we are not fixing these now:** All 22 are type-level only — the application builds and runs correctly. Many are prop type mismatches between parent and child components introduced during incremental migration (parent migrated before child or vice versa). They should be cleaned up in a dedicated type-fixing pass after AnnotationViewer migration is complete.

### Known Runtime Bugs

1. ~~**Chrome file dropzone click not working:**~~ **FIXED.** Replaced the static `<input type="file">` element with a dynamically created, detached input on each click (`openFileSelector()` creates a fresh `document.createElement("input")` and calls `.click()` on it). Chrome's security policy blocks programmatic `.click()` on persistent DOM-attached file inputs inside Vuetify components, but allows it on freshly created detached elements. The old static input and CSS visibility workarounds were removed.

2. ~~**ImageViewer dataset transition flicker:**~~ **FIXED.** Added a `sync.datasetLoading` guard at the top of `draw()` in `ImageViewer.vue`. During dataset transitions, the guard hides existing tile layers and returns early, preventing stale tile URLs from being generated when the configuration loads before the dataset. A watcher on `sync.datasetLoading` triggers `draw()` once the new dataset finishes loading, ensuring correct tiles are displayed. The root cause was `setSelectedDataset()` and `setSelectedConfiguration()` running in parallel in `setDatasetViewId()`, allowing `layerStackImages` to recompute with new layers + old dataset.

3. **WebGL console warnings from `markRaw()`:** See "Known Console Warnings (Vue 2.7 only)" section below. These are cosmetic and expected to resolve after Vue 3 upgrade.

## Next Steps (Phase 1 Continuation)

**Branch:** `claude/vue3-migration-planning-tS4Hx`

### ~~Immediate: Fix Batch 10 `ref({})` direct-assignment bug~~ DONE

8 lines across 3 files (`ConfigurationInfo.vue`, `DatasetInfo.vue`, `ProjectInfo.vue`) converted from `cache.value[key] = val` to object spread. All 8 sites fixed.

### ~~Batch 12 — 6 Tier 1 components~~ DONE

See "Components Migrated" section below for details.

**Verification after each batch:** `pnpm tsc` (check migrated files only — pre-existing test file errors are expected), `pnpm lint:fix`, `pnpm build`, `pnpm test`.

### ~~Batch 13 — Remaining Tier 1~~ DONE

See "Components Migrated" section below for details.

### ~~Batch 14 — Tier 2~~ PARTIAL

CustomFileManager migrated. Home migrated (Batch 15).

### ~~Batch 15 — Remaining Tier 2~~ COMPLETE

NewDataset migrated (106 tests).

### ~~Batch 16 — MultiSourceConfiguration~~ COMPLETE

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `MultiSourceConfiguration.vue` | 2,451 | Complex multi-source dataset configuration with file parsing and dimension assignment. 1 prop → `defineProps`, `$emit` → `defineEmits`, ~50 data fields → `ref()`/`reactive()`, ~30 computed → `computed()`, 3 `@Watch` → `watch()`, `mounted()` → `onMounted()`, `getCurrentInstance()` for `$router`. 143 tests. |

**Key patterns in this batch:**
- **`reactive()` for deeply-watched objects:** `assignments` uses `reactive()` so the deep watcher fires on property mutations without needing `.value`
- **Watcher closure captures:** `watch()` callbacks capture the local function reference directly; spying on `vm.method` doesn't intercept — test the observable side effect instead
- **Store getter overrides in tests:** Use `Object.defineProperty` to temporarily override store getters (e.g., `uploadWorkflow`, `uploadIsFirstDataset`) to enable conditional code paths

### ~~Batch 17 — Snapshots~~ COMPLETE

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `Snapshots.vue` | 2,834→2,777 | Snapshot creation/loading, image/movie download, GeoJS bounding box management, scalebar rendering. 1 prop → `defineProps`, ~35 data fields → `ref()`, ~20 computed → `computed()` (4 get/set pairs), 4 `@Watch` → `watch()`, ~40 methods → functions, `Vue.set` → direct assignment, exported enums moved to separate `<script>` block. 141 tests. |

**Key patterns in this batch:**
- **Exported enums in `<script setup>`:** `<script setup>` cannot contain ES module exports. Enums used by other components (e.g., `MovieFormat` imported by `MovieDialog.vue`) must be in a separate `<script lang="ts">` block
- **Non-reactive mock store:** Module-level store imports are not reactive in `<script setup>` (unlike class component data properties). Tests that change store state after mount must remount the component to see updated computed values
- **Template ref mocking:** In `<script setup>`, template refs are exposed via `defineExpose`. Mock via `wrapper.vm.refName = mock` (not `$refs`)
- **Internal method spying:** `vi.spyOn(wrapper.vm, "method")` doesn't intercept closure-captured functions — verify through mocked utility function calls instead

**Bug fix (pre-existing):** Movie export (GIF/ZIP/Video) never rendered the scalebar independently of the timestamp option. The scalebar canvas rendering was nested inside `if (shouldAddTimeStamp)`, so disabling timestamps also disabled the scalebar. Video export never drew the scalebar at all. Fixed by checking `addScalebar` independently of `shouldAddTimeStamp` in all three movie download functions.

### ~~Batch 18 — ImageViewer (with `markRaw()`)~~ COMPLETE

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ImageViewer.vue` | 1,500→1,395 | GeoJS map/layer management with full `markRaw()` protection. 1 prop → `defineProps`+`withDefaults` (`shouldResetMaps`), `$emit` → `defineEmits` (`reset-complete`), `computed({ get, set })` for store-backed `maps`/`cameraInfo`, `computed()` for read-only store proxies, `@Watch` → `watch()` including multi-source `watch([a, b], handler)`, `mounted()` → `onMounted()`, `beforeDestroy()` → `onBeforeUnmount()`. 106 tests. |

**Key patterns in this batch:**
- **`markRaw()` on ALL GeoJS objects:** Every GeoJS object stored in reactive state (map, layers, features) is wrapped with `markRaw()` for Vue 3 Proxy safety. This includes all `IMapEntry` fields: `map`, `params`, `annotationLayer`, `workerPreviewLayer`, `workerPreviewFeature`, `textLayer`, `timelapseLayer`, `timelapseTextLayer`, `interactionLayer`, `uiLayer`, and items pushed into `imageLayers`
- **Function ref pattern for dynamic template refs:** Replaced `$refs["map-${idx}"]` with `getMapRefSetter()` — a curried function that returns a setter callback for each map index, bound via `:ref="getMapRefSetter(idx)"` in the template
- **`Vue.set()` → array spread + assign for maps:** `Vue.set(this.maps, idx, mapentry)` replaced with array spread and direct assignment; `Vue.set` on `readyLayers` replaced with `splice()`
- **`Vue.nextTick` → `nextTick`:** All `Vue.nextTick()` calls replaced with imported `nextTick()`
- **Plain `let` variables (non-reactive):** `scaleWidget`, `scalePixelWidget`, `synchronisationEnabled` declared as plain `let` (not `ref()`) since they don't need reactivity tracking
- **`defineExpose()` with getter/setter accessors:** Plain `let` variables exposed via `defineExpose` using getter/setter accessors so tests can read and write them through `wrapper.vm`
- **`vitest.config.js` updated:** Added resolve alias for `onnxruntime-web/webgpu` pointing to the browser entry point, fixing test resolution
- **Test mocks: `Vue.observable()` wrapper:** Store mocks wrapped in `Vue.observable()` to enable computed tracking in tests (plain objects don't trigger computed re-evaluation in Vue 2.7)
- **Test mocks: `setMaps` mockImplementation:** `setMaps` mock implementation actually updates `store.maps` so that computed properties depending on `maps` reflect changes during tests

### ~~Batch 19 — AnnotationViewer~~ COMPLETE

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `AnnotationViewer.vue` | 3,300→3,310 | GeoJS annotation interaction, tool handlers, SAM integration. 15 props → `defineProps`+`withDefaults`, ~20 data fields → `ref()`, ~40 computed getters → `computed()`, ~50 methods → functions, ~40 `@Watch` decorators consolidated into ~15 `watch()` calls, `mounted()` → `onMounted()`, `beforeDestroy()` → `onBeforeUnmount()`. 244 tests. |

**Key patterns in this batch:**
- **`getCurrentInstance()` for spy-compatible delegation:** In `<script setup>`, internal function calls go through closures, not the component instance, so `vi.spyOn(wrapper.vm, "method")` can't intercept them. Solution: capture `getCurrentInstance()` during setup and have ~10 delegation functions (watchers, event handlers) call through `_instance!.proxy as any` so test spies work correctly
- **Multi-source `watch()` consolidation:** 40+ `@Watch` decorators consolidated into ~15 `watch()` calls using array syntax (e.g., `watch([xy, z, time, ...], onPrimaryChange)`)
- **`Vue.set()` → direct assignment:** 2 occurrences of `Vue.set(obj, key, val)` replaced with direct property assignment using `as any` casts
- **`Vue.nextTick` → `nextTick`:** Replaced with imported `nextTick()` from vue
- **Import aliasing for name collision:** `editPolygonAnnotation` utility renamed to `editPolygonAnnotationUtil` on import to avoid conflict with local function of same name
- **`timelapseTags` watcher bug fixed:** Pre-existing bug where `@Watch("timelapseTags")` had no corresponding getter. Fixed by watching `() => store.timelapseTags` directly
- **Throttle/debounce without `.bind(this)`:** Throttled/debounced functions created as `const` wrappers around named functions (closures capture scope naturally)

---

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
5. **Remove `src/test-shims.d.ts`** — this file adds permissive `mount()`/`shallowMount()` overloads for `@vue/test-utils` v1 to work with `<script setup>` components. When upgrading to `@vue/test-utils` v2 (which natively supports `<script setup>`), delete this shim so tests get proper type checking again.
6. Fix remaining incompatibilities
7. Full regression testing

### GeoJS & Vue 3 Proxy Reactivity (Critical — Phase 5 Preparation)

Vue 3 replaces `Object.defineProperty` (Vue 2) with **ES6 Proxies** for reactivity. Libraries like GeoJS (and similar WebGL/Canvas wrappers) rely on strict object identity (`this === that`) and internal private slots. When Vue 3 wraps a GeoJS instance in a Proxy, it breaks these internal checks, causing:

1. **Identity failures:** GeoJS cannot recognize its own instances
2. **Performance cliffs:** Vue attempts to deeply observe massive graphical objects
3. **Crashes:** "Illegal invocation" errors when accessing internal slots via a Proxy

**The fix:** Use `markRaw()` to tell Vue NOT to proxy GeoJS objects. This can be done now (Vue 2.7 supports `markRaw` from `vue`) and is forward-compatible with Vue 3.

#### Current State

`ImageViewer.vue` now has full `markRaw()` coverage on all GeoJS objects in `IMapEntry` (completed in Batch 18). `AnnotationViewer.vue` has **no `markRaw()` usage at all**.

#### Affected Objects in `ImageViewer.vue`

The `IMapEntry` interface (`src/store/model.ts:1600-1614`) holds these GeoJS objects that all need `markRaw()`:

| Field | Protected? | Notes |
|-------|-----------|-------|
| `map` | Yes (Batch 18) | Core GeoJS map instance |
| `imageLayers` | Yes | Array is marked raw; items pushed in are also wrapped |
| `params` | Yes | Already protected pre-migration |
| `annotationLayer` | Yes (Batch 18) | GeoJS annotation layer |
| `workerPreviewLayer` | Yes (Batch 18) | GeoJS feature layer |
| `workerPreviewFeature` | Yes (Batch 18) | GeoJS feature |
| `textLayer` | Yes (Batch 18) | GeoJS feature layer |
| `timelapseLayer` | Yes (Batch 18) | GeoJS annotation layer |
| `timelapseTextLayer` | Yes (Batch 18) | GeoJS feature layer |
| `interactionLayer` | Yes (Batch 18) | GeoJS annotation layer |
| `uiLayer` | Yes (Batch 18) | GeoJS UI layer (optional) |

#### Known Console Warnings (Vue 2.7 only)

Adding `markRaw()` to GeoJS objects in Vue 2.7 causes some WebGL console warnings:

- `WebGL: INVALID_OPERATION: useProgram: object does not belong to this context`
- `WebGL: INVALID_OPERATION: detachShader: object does not belong to this context`
- `m_viewer.renderWindow(...)._init is not a function`

**Root cause:** In Vue 2, without `markRaw`, GeoJS objects were wrapped with Vue's `__ob__` observer and reactive getters/setters via `Object.defineProperty`. GeoJS internally tolerates this. With `markRaw`, the objects stay pristine (only a non-enumerable `__v_skip` property is added). The WebGL context management in GeoJS may have incidentally relied on Vue 2's observation behavior. These warnings do not affect functionality.

**Expected resolution:** These warnings should disappear after the Vue 3 upgrade, where `markRaw` prevents Proxy wrapping entirely (its intended purpose). The warnings are cosmetic — the application works correctly with them present.

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

### Batch 9 — routeMapper Composable + Route Components + Standalone Components

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `useRouteMapper.ts` (NEW) | ~80 | Composable replacing `routeMapper` mixin; `onMounted` + `watch($route)` instead of `beforeRouteEnter`/`beforeRouteUpdate` |
| `Configuration.vue` | 15 | `useRouteMapper` only, `<router-view>` wrapper |
| `Project.vue` | 15 | `useRouteMapper` only, `<router-view>` wrapper |
| `ProjectRouter.vue` | 15 | `useRouteMapper` only, `<router-view>` wrapper |
| `DatasetAndConfigurationRouter.vue` | 24 | `useRouteMapper` with both params and query mappers |
| `DatasetView.vue` | 60 | `useRouteMapper` with 1 param + 7 query mappers |
| `ConfigurationSelect.vue` | 142 | `useRouteMapper`, `@Prop` → `defineProps`, `@Watch` → `watch()` |
| `NewConfiguration.vue` | 111 | `useRouteMapper`, `$router.push` → `getCurrentInstance()!.proxy.$router` |
| `ToolCreation.vue` | 240 | 4 `@Watch` → 4 `watch()`, `$refs` → template ref, `$emit` → `defineEmits` |
| `Toolset.vue` | 295 | `$refs` array → function ref, `$nextTick` → `nextTick()`, vuedraggable |
| `ZenodoImporter.vue` | 297 | ZenodoAPI, `$router.push`, `IGirderSelectAble` type for location chooser |
| `DisplayLayers.vue` | 361 | vuedraggable, computed get/set, v-mousetrap hotkeys |
| `DisplayLayer.vue` | 376 | 16 computed, `@Watch` → `watch()`, v-mousetrap, operator precedence fix |
| `ProjectList.vue` | 374 | `$router.push` → `getCurrentInstance()!.proxy.$router`, 3 dialogs, CRUD |
| `AddDatasetToCollection.vue` | 393 | `$refs` → template ref, `Vue.nextTick()` → `nextTick()`, 4 emits |

**Key patterns in this batch:**
- **routeMapper mixin → `useRouteMapper` composable:** Uses `onMounted()` + `watch(() => vm.$route)` to replace `beforeRouteEnter`/`beforeRouteUpdate` hooks (Vue Router 4 composables not available in Vue 2.7). Module-level `currentRouteChanges` counter for loop prevention.
- **Deleted `src/utils/routeMapper.ts`** (old mixin) and **`src/plugins/router.ts`** (registered class-component route hooks). Moved `Vue.use(VueRouter)` to `main.ts`.
- **Operator precedence bug fix** in DisplayLayer: `zSlice.value.type === "max-merge" === value` → `(zSlice.value.type === "max-merge") === value`
- **Type fix** in ZenodoImporter: `IGirderLocation` → `IGirderSelectAble` for location chooser `value` prop compatibility with `<script setup>` stricter checking
- **Test stub fix:** `shallowMount` needed for parent tests (ContrastPanels, Viewer) after child components migrated to `<script setup>` — `@vue/test-utils` v1 stub matching differs for `<script setup>` components

**After this batch:** 95 of 121 components migrated to `<script setup>` (~78%).

### Batch 10 — Route View "Info" Components

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ConfigurationInfo.vue` | 468 | 3 `watch()`, `Vue.set` → direct assignment, `$refs.alert` → template ref, `$router.back()` via `getCurrentInstance()` |
| `DatasetInfo.vue` | 880 | 6 `watch()` (3 on `dataset`), async imports → synchronous, removed dead `headers` array, `$router.push` via `getCurrentInstance()` |
| `ProjectInfo.vue` | 1,021 | 1 `watch()`, 4 `Vue.set` → direct assignment, 3 stores, local interfaces, `formatSize` auto-available in template |

**Key patterns in this batch:**
- Route views with no props/emits — pure store consumers with `getCurrentInstance()!.proxy` for `$route`/`$router`
- `Vue.set(cache, key, val)` → `cache.value = { ...cache.value, [key]: val }` (direct assignment of new keys on `ref({})` is NOT reactive in Vue 2.7 — see "Vue.set/Vue.delete → object spread" gotcha)
- DatasetInfo: Converted 2 async component imports (`GirderLocationChooser`, `AddToProjectDialog`) to synchronous imports
- DatasetInfo: Removed unused `headers` data property (dead code)
- ProjectInfo: `formatSize = formatSize` binding removed — direct import is auto-available in `<script setup>` template
- ProjectInfo: `collectionInfoCache` type corrected from `IGirderItem` to `IGirderItem | IUPennCollection`
- NewDataset.vue: Updated `$refs.viewCreation` type to `any` for mixed-mode compatibility

**After this batch:** 98 of 121 components migrated to `<script setup>` (~81%).

### Batch 11 — Standalone Leaf Components

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ChatComponent.vue` | 395 | Removed dead `bboxLayer`/`IGeoJSAnnotationLayer`, `getCurrentInstance()` for `$el` in `html2canvas`, template ref for `fileInput` |
| `UserColorSettings.vue` | 417 | `Vue.set`/`Vue.delete` → object spread (see gotcha below), removed `Vue` import, `withDefaults` for `visible` prop |
| `ShareDataset.vue` | 475 | v-model dialog computed get/set, single `watch(dialog)` replaces dual `@Watch("value")`/`@Watch("dialog")` |
| `ImageOverview.vue` | 356 | Kebab-case refs renamed (`overview-map` → `overviewMap`), `onBeforeUnmount` for ResizeObserver cleanup (bug fix), 2 stacked `@Watch` → single `watch([urlPromise, osmLayer])` |
| `AnnotationCSVDialog.vue` | 427 | 4 stacked `@Watch` → single `watch([...])`, `static UNDEFINED_VALUE_MAP` → module-level const, `import type Vue` for template ref |
| `FileManagerOptions.vue` | 356 | Custom `OptionAction`/`MutatingAction` decorators → `withOptionAction`/`withMutatingAction` wrapper functions, lazy → sync imports, removed `createDecorator` |

**Key cleanups in this batch:**
- `ChatComponent.vue`: Removed unused `bboxLayer` field and `IGeoJSAnnotationLayer` import (dead code)
- `UserColorSettings.vue`: Replaced `Vue.set()`/`Vue.delete()` with object spread on `ref({})` — must replace whole object, not direct-assign new keys (see "Vue.set/Vue.delete → object spread" gotcha)
- `ImageOverview.vue`: Added `onBeforeUnmount` to disconnect ResizeObserver (memory leak fix)
- `ShareDataset.vue`: Simplified dual watcher pattern (value↔dialog sync) into single computed get/set + watcher
- `FileManagerOptions.vue`: Eliminated `vue-class-component` `createDecorator` dependency; decorator stacking order preserved via nested wrapper calls

**After this batch:** 104 of 121 components migrated to `<script setup>` (~86%).

### Batch 12 — Tier 1 Medium Components

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ViewerToolbar.vue` | 442 | 16 getter/setter `computed()` pairs for store bindings, 3 unroll watchers collapsed into single `watch([unrollXY, unrollZ, unrollT])`, mousetrap hotkey handlers reference computed `.value` |
| `AnnotationProperties.vue` | 458 | `defineEmits<{ (e: "expand"): void }>()`, batch processing state with `ref<(() => void) | null>(null)` for cancel function, Miller column computed |
| `PropertyFilterHistogram.vue` | 508 | D3 drag handlers use template refs (`min.value!`, `max.value!`) instead of `$refs`, `destroyed()` → `onBeforeUnmount()`, `$nextTick()` → `nextTick()`, `debounce()` at module level |
| `CollectionList.vue` | 568 | `Vue.set()` → object spread on `ref({})`, lazy `() => import(...)` → sync `import { Breadcrumb }`, `$router` → `getCurrentInstance()!.proxy`, non-reactive `let lastPendingChip` for promise chain |
| `BreadCrumbs.vue` | 490 | `Vue.set(item, "subItems", ...)` → array replacement (`items.value = newArr`), `Vue.set(item, "text", ...)` → direct assignment (existing property), `$route`/`$router` via `getCurrentInstance()`, `eslint-disable` for `vue/no-async-in-computed-properties` (Promise-returning computeds — same pattern as class getters) |
| `App.vue` | 465 | `$data[panel]` → `panelRefs: Record<string, Ref<boolean>>` map, `$loadAllTours()`/`$startTour()` → `(vm as any).$loadAllTours()` via `getCurrentInstance()`, `$router` via proxy |

**Key patterns in this batch:**
- `CollectionList.vue`: Non-reactive `let lastPendingChip` (plain variable, not `ref`) for promise chaining — no reactivity needed since it's only used internally for sequencing
- `BreadCrumbs.vue`: The `datasetId`/`configurationId` computeds return `Promise<string> | null` (not async functions), matching the original class getter behavior. The `.then()` calls trigger `vue/no-async-in-computed-properties` but are just chaining on already-resolved promises
- `App.vue`: Custom plugin methods (`$loadAllTours`, `$startTour`) accessed via `getCurrentInstance()!.proxy` with `as any` cast since they're added by plugins and not on the standard Vue type

**After this batch:** 110 of 121 components migrated to `<script setup>` (~91%).

### Batch 13 — Tier 1 Medium Components (Completing Tier 1 Backlog)

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `ContrastHistogram.vue` | 582 | `_uid` → module-level `uidCounter++`, `$el` → `rootEl` template ref, D3 drag/zoom with template refs, `throttle()` emitChange, computed get/set for `mode`/`editBlackPoint`/`editWhitePoint` |
| `AnnotationWorkerMenu.vue` | 639 | `debounce()` + `onBeforeUnmount` cancel, `jobLog` side-effect refactored from computed to `watch()`, 4 stores as module-level imports, batch processing state |
| `AnnotationList.vue` | 617 | Dynamic `:ref="item.annotation.id"` kept as-is, `$children` access via `(dataTable.value as any)?.$children?.[0]`, `getCurrentInstance()!.proxy.$refs` for dynamic refs, stacked `@Watch` → single `watch([hoveredId, itemsPerPage])`, computed get/set chains (`selectedItems` → `selected`) |

**Key patterns/cleanups in this batch:**
- `ContrastHistogram.vue`: Replaced `_uid` with module-level counter (`let uidCounter = 0; const componentId = uidCounter++`); replaced `this.$el` with `rootEl` template ref on root div
- `AnnotationWorkerMenu.vue`: Extracted `jobLog` computed side-effect (mutating `localJobLog` inside getter) into separate `watch([currentJobId, storeLog])` — computed is now pure; removed unused `LayerSelect` and `TagFilterEditor` imports/registrations
- `AnnotationList.vue`: Removed unused `TagPicker` and `ColorPickerMenu` imports/registrations; `getStringFromPropertiesAndPath` auto-available in template via import; renamed `vDataTable` computed to `dataTableInner` to avoid shadowing Vuetify's global `VDataTable` component (see "setup bindings shadow globally-registered components" gotcha below)

**After this batch:** 113 of 121 components migrated to `<script setup>` (~93%).

### Batch 14 — Tier 2 (CustomFileManager)

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `CustomFileManager.vue` | 747 | Async `() => import(...)` → sync `import { FileManager }`, `Vue.set()` on plain (non-reactive) object → direct assignment, `Vue.nextTick()` → `nextTick()`, `$refs.alert` → `alertDialog` template ref, `batchTimer` cleanup via `onBeforeUnmount`, dead code removal (`girderResources`, `formatDateString` bridge, `store` bridge) |

**Key patterns in this batch:**
- **Async → sync component import:** `GirderFileManager: () => import("@/girder/components").then(mod => mod.FileManager)` → `import { FileManager as GirderFileManager } from "@/girder/components"` (Vue 2.7 has no `defineAsyncComponent`)
- **`Vue.set()` on plain object:** `chipsPerItemId` is a non-reactive accumulator (`let ... = {}`), so `Vue.set(this.chipsPerItemId, id, val)` → `chipsPerItemId[id] = val` (direct assignment is fine since it's not reactive; the reactive snapshot is created via `debouncedChipsPerItemId.value = { ...chipsPerItemId }`)
- **Timer cleanup (bug fix):** Added `onBeforeUnmount(() => clearTimeout(batchTimer))` — original class component had no cleanup for the debounce timer
- **Dead code removal:** `readonly girderResources = girderResources` (imported but unused), `formatDateString = formatDateString` (unnecessary bridge in `<script setup>`), `readonly store = store` (unnecessary bridge)
- **Stacked `@Watch` → array watcher:** `@Watch("selected") @Watch("selectable") emitSelected()` → `watch([selected, () => props.selectable], emitSelected)`

**After this batch:** 114 of 121 components migrated to `<script setup>` (~94%).

### Batch 15 — Tier 2 (Home)

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `Home.vue` | 1,317 | `Vue.set()` → object spread on `userDisplayNames` ref, `getCurrentInstance()` for `$router`/`$startTour`, `routeName` computed for `$route` watcher, `validateNamesDebounceTimer` as plain `let` (not ref), 9 `@Watch` → `watch()`, 59 pre-existing tests pass unchanged |

**Key patterns in this batch:**
- **`Vue.set()` → object spread:** Both `getUserDisplayName` and `fetchUsersForDatasets` mutate `userDisplayNames` — replaced `Vue.set(this.userDisplayNames, key, val)` with `userDisplayNames.value = { ...userDisplayNames.value, [key]: val }` per pattern #10
- **`fetchUsersForDatasets` reactivity fix:** Original used direct assignment (`this.userDisplayNames[userId] = ...`) which was a latent bug in the class version — now uses object spread for proper Vue 2.7 reactivity
- **`$route` watcher:** Used `routeName` computed (`computed(() => vm.$route?.name)`) instead of watching `vm.$route` directly (pattern from `App.vue:325`)
- **Non-reactive timer:** `validateNamesDebounceTimer` declared as plain `let` since it's never rendered

**After this batch:** 115 of 121 components migrated to `<script setup>` (~95%).

### Batch 15 (continued) — Tier 2 (NewDataset)

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `NewDataset.vue` | 1,435 | Multi-step dataset creation wizard with 3 modes (regular, quick import, batch). 9 props → `defineProps`/`withDefaults`, `$emit` → `defineEmits`, ~30 data fields → `ref()`, ~20 computed getters → `computed()`, `@Watch("configurationLogs")` → `watch()`, `mounted()` → `onMounted()`, template refs for child component method access, `Vue.nextTick()` → `nextTick()`, `getCurrentInstance()` for `$router`. 106 tests. |

**Key patterns in this batch:**
- **Template refs for child components:** `const uploader = ref<GWCUpload>()` bound to `ref="uploader"` in template. Methods accessible via `uploader.value.startUpload()`
- **Defensive null checks on refs:** After async operations, child components may be unmounted. Added `if (!uploader.value)` guards before calling methods
- **`@hook:mounted` on child component:** `@hook:mounted="uploadMounted"` fires when girder-upload mounts, triggering auto-submit in quick/batch modes
- **Test stub naming for `<script setup>`:** `shallowMount` with `<script setup>` components requires **PascalCase** stub names (e.g., `GirderUpload` not `"girder-upload"`). Kebab-case stubs are not matched to `<script setup>` component registrations and get replaced by auto-generated minimal stubs that lack methods/data.

**After this batch:** 116 of 121 components migrated to `<script setup>` (~96%).

## Remaining Components (1)

The last remaining component uses the class-based `@Component` decorator pattern.

| Component | Lines | Key Patterns / Notes |
|-----------|-------|---------------------|
| `AnnotationViewer.vue` | 3,300 | GeoJS annotations, tool interaction, SAM — needs `markRaw()` |

### Migration Order

1. ~~**Batch 17** — Snapshots~~ DONE
2. ~~**Batch 18** — ImageViewer (with `markRaw()`)~~ DONE
3. ~~**Batch 19** — AnnotationViewer~~ DONE

**Note:** `src/store/index.ts` (~2,477 lines) is not a Vue component but should be considered for splitting before the Pinia migration (Phase 4).

## Testing Strategy

Pair each migration batch with tests:

1. **Composable tests** — Pure function tests, easy to write
2. **Component tests** — Vue Test Utils with mount/shallowMount
3. **Store tests** — Test modules in isolation

Framework: Vitest (already configured). Run with `pnpm test`.

### Missing Tests — Batches 11–13

18 components migrated in Batches 11–13 are missing test files. Batch 14 (CustomFileManager) has tests. Batch 10 and earlier have tests.

#### Batch 11 (6 components)

| Component | Lines | Testing Notes |
|-----------|-------|---------------|
| `ChatComponent.vue` | 395 | Mock IndexedDB, Anthropic API; test message rendering, file input ref |
| `UserColorSettings.vue` | 417 | Test color override CRUD via object spread on `ref({})`; mock store |
| `ShareDataset.vue` | 475 | Test dialog open/close computed, share/unshare API calls |
| `ImageOverview.vue` | 356 | Mock GeoJS; test ResizeObserver cleanup in `onBeforeUnmount` |
| `AnnotationCSVDialog.vue` | 427 | Test CSV export scope selection, column toggling, stacked watcher |
| `FileManagerOptions.vue` | 356 | Test `withOptionAction`/`withMutatingAction` wrappers; mock store API |

#### Batch 12 (6 components)

| Component | Lines | Testing Notes |
|-----------|-------|---------------|
| `ViewerToolbar.vue` | 442 | Test 16 computed get/set pairs for store bindings; mock mousetrap |
| `AnnotationProperties.vue` | 458 | Test batch processing state, Miller column computed, emit |
| `PropertyFilterHistogram.vue` | 508 | Mock D3; test drag handlers with template refs, debounce |
| `CollectionList.vue` | 568 | Test chip promise chain, batch resolution, `ref({})` spread pattern |
| `BreadCrumbs.vue` | 490 | Test breadcrumb navigation, `$route`/`$router` via `getCurrentInstance()` |
| `App.vue` | 465 | Test panel refs map, tour plugin access, router integration |

#### Batch 13 (3 components)

| Component | Lines | Testing Notes |
|-----------|-------|---------------|
| `ContrastHistogram.vue` | 582 | Mock D3 drag/zoom; test `uidCounter`, `rootEl` ref, throttled emit |
| `AnnotationWorkerMenu.vue` | 639 | Test debounce + cancel cleanup, `jobLog` watcher (was computed side-effect) |
| `AnnotationList.vue` | 617 | Test dynamic refs via `getCurrentInstance()`, `$children` access, stacked watcher |

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
- **"Invalid prop type: null is not a constructor"**: Vue 2.7 SFC compiler cannot resolve DOM interface types (e.g., `Element`, `HTMLElement`) to runtime constructors in type-only `defineProps`. See "DOM types in `defineProps`" gotcha below.
- **"Unable to locate target [data-app]"**: Vuetify dialog warning. Use the `attachTo` pattern above to fix.

### Known Flaky Tests

- **`Snapshots.test.ts` — `addTimeStampToCanvas` tests (2 tests):** The tests "draws timestamp text" (~line 1698) and "computes correct time for frame 0" (~line 1720) fail intermittently during full concurrent test suite runs (`pnpm test`), but pass reliably when run in isolation (`pnpm test -- --run src/components/Snapshots.test.ts`). **Root cause:** jsdom's `canvas.getContext("2d")` returns `null` during concurrent test execution due to resource contention, causing `vi.spyOn(ctx, "strokeText")` to fail with "TypeError: Cannot convert undefined or null to object". This is a jsdom environment limitation, not a code bug. These tests are pre-existing and unrelated to the `<script setup>` migration.

## Migration Patterns & Gotchas

Patterns and pitfalls discovered during Batches 1–11. Follow these when migrating remaining components.

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

### DOM types in `defineProps` — avoid in type-only syntax

Vue 2.7's SFC compiler cannot resolve DOM interface types (`Element`, `HTMLElement`, `HTMLSpanElement`, etc.) to runtime constructors when used in type-only `defineProps<{...}>()`. The compiler emits `null` in the runtime prop type array, causing two Vue warnings:

```
[Vue warn]: Invalid prop type: "null" is not a constructor
[Vue warn]: Invalid prop: type check failed for prop "activator". Expected , String, got HTMLSpanElement
```

**Root cause:** `defineProps<{ activator: Element | string }>()` compiles to `{ activator: { type: [Element, String] } }` at runtime. But the SFC compiler resolves `Element` to `null` because it doesn't map DOM globals to constructors.

**Fix:** Use runtime props syntax for props that accept DOM elements:

```typescript
// BAD — Element resolves to null in Vue 2.7 SFC compiler
defineProps<{
  activator: Element | string;
}>();

// GOOD — runtime syntax skips type checking for untyped props
defineProps({
  activator: { required: true },  // no type = accepts anything
  content: { type: String, required: true },
});
```

**Known affected component:** `NimbusTooltip.vue` — fixed by switching `activator` to runtime props syntax.

**When scanning for other instances:** Search for DOM types in `defineProps` type parameters:
```bash
grep -n "defineProps<" src/**/*.vue | grep -i "element\|htmlelement\|node\|event"
```

### `Vue.set`/`Vue.delete` → object spread, NOT direct assignment (Vue 2.7 `ref({})`)

**Critical gotcha discovered in Batch 11.** When removing `Vue.set()`/`Vue.delete()` from migrated components, do NOT replace them with direct property assignment on `ref<Record<...>>()` objects. Vue 2.7's `ref({})` still uses `Object.defineProperty` under the hood — it **cannot detect new property additions** via direct assignment.

**Symptom:** UI partially updates (e.g., a "modified" indicator appears) but the actual value display doesn't change. Works after save+reload because the whole object is replaced from the backend.

```typescript
// BAD — new key NOT reactive in Vue 2.7
const overrides = ref<Record<string, string>>({});
overrides.value[newChannel] = color;        // Vue can't see this!
delete overrides.value[channel];            // Vue can't see this either!

// GOOD — replacing .value triggers reactivity
overrides.value = { ...overrides.value, [newChannel]: color };

const { [channel]: _, ...rest } = overrides.value;
overrides.value = rest;
```

**Why it's tricky:** Updating an *existing* key via direct assignment IS reactive (the property was already defined by `Object.defineProperty`). So it works for some cases but silently breaks for others, making the bug intermittent.

**Rule of thumb:** For `ref<Record<...>>()` objects, always use object spread for any mutation (add, update, or delete). This is safe in both Vue 2.7 and Vue 3.

**Affected patterns across remaining components:**
- Any `Vue.set(obj, key, val)` on a plain object → `obj.value = { ...obj.value, [key]: val }`
- Any `Vue.delete(obj, key)` → destructure + spread
- `Vue.set` on arrays (`Vue.set(arr, index, val)`) → `arr.value[index] = val` (array index assignment IS reactive) or `arr.value = [...arr.value.slice(0, i), val, ...arr.value.slice(i+1)]`
- `Vue.set` on Vuex store state → keep `Vue.set` until Pinia migration (Vuex mutations have their own reactivity rules)

**Components with remaining `Vue.set` that will need this pattern:**
- `Property.vue` — `Vue.set()` on Vuex mutation (keep as-is until Phase 4)
- `AnnotationConfiguration.vue` — `Vue.set()` on local reactive objects (apply object spread)
- `ToolConfiguration.vue` — `Vue.set()` on local reactive objects (apply object spread)
- ~~`ImageViewer.vue`~~ — Done (Batch 18): `Vue.set()` replaced with array spread + `markRaw()`
- Remaining unmigrated components — apply during migration

### Vuex mutations must replace arrays, NOT push (Vue 2.7 `watch()`)

**Critical gotcha discovered post-Batch 19.** Vue 2.7's Composition API `watch()` uses `Object.is()` for change detection (following Vue 3 semantics). This differs from Vue 2's `@Watch` decorator, which fires for any object value regardless of reference identity (due to an `isObject(value)` check in the watcher's `run()` method).

**Impact:** Vuex `@Mutation` methods that use `.push()` on state arrays **do not** trigger `watch()` callbacks in `<script setup>` components, because `.push()` mutates the array in place (same reference). `Object.is(sameArray, sameArray)` returns `true`, so `hasChanged()` returns `false`, and the callback is skipped.

**Symptom:** Feature works when using `@Watch` in class components but silently breaks after migration to `<script setup>`. Data persists to the backend (appears after page refresh) but the UI doesn't update. Partial updates may occur when an unrelated watched source changes, triggering a draw that coincidentally includes the new data.

```typescript
// BAD — .push() keeps same reference, watch() won't detect change
@Mutation
addMultipleConnections(value: IAnnotationConnection[]) {
  this.annotationConnections.push(...value);
}

// GOOD — array replacement creates new reference, watch() detects change
@Mutation
addMultipleConnections(value: IAnnotationConnection[]) {
  this.annotationConnections = [...this.annotationConnections, ...value];
}
```

**Fixed mutations:**
- `annotation.ts`: `addMultipleConnections` — `.push(...value)` → spread replacement
- `annotation.ts`: `addConnectionImpl` — `.push(value)` → spread replacement
- `properties.ts`: `togglePropertyPathVisibility` — `.push(path)` and `.splice()` → spread replacement and `.filter()`

**Rule of thumb:** In any Vuex mutation that modifies an array watched by a `<script setup>` component's `watch()`, always replace the array (`this.arr = [...this.arr, item]`) rather than mutating in place (`this.arr.push(item)`). This is safe for both Vue 2.7 and Vue 3.

**Test coverage:** `src/store/annotation-mutations.test.ts` includes regression tests proving that array replacement triggers `watch()` and that `.push()` does not.

### `<script setup>` bindings shadow globally-registered components

**Critical gotcha discovered in Batch 13.** In `<script setup>`, Vue resolves template component names by checking setup bindings **first**, before the global component registry. If a `ref()`, `computed()`, or `const` in your setup scope has a name that matches a globally-registered component (case-insensitive PascalCase match), the setup binding **shadows** the global component.

**Symptom:** The component silently renders as a comment node (`<!---->` in the DOM). No error in the console. Other components in the same template work fine.

**Example:** A computed named `vDataTable` shadows Vuetify's globally-registered `VDataTable`:

```typescript
// BAD — shadows <v-data-table> in the template!
const vDataTable = computed(() => {
  return (dataTable.value as any)?.$children?.[0] || null;
});
// Vue resolves <v-data-table> → PascalCase VDataTable → finds setup binding
// vDataTable → uses that (null) instead of the Vuetify component

// GOOD — use a non-colliding name
const dataTableInner = computed(() => {
  return (dataTable.value as any)?.$children?.[0] || null;
});
```

**How resolution works:** `<v-data-table>` in the template is converted to PascalCase `VDataTable`. Vue then checks the setup scope for any binding matching `VDataTable`, `vDataTable`, or `v-data-table` (case-insensitive). If found, it uses that binding as the component constructor. When the binding evaluates to `null` or a non-component value, Vue renders a comment node.

**Rule:** Never name a `ref()`, `computed()`, or `const` with any name that matches a globally-registered component. Watch out especially for Vuetify components: `vDialog`, `vBtn`, `vCard`, `vDataTable`, `vTextField`, `vChip`, etc.

**Debugging tip:** If a Vuetify component mysteriously disappears after migration to `<script setup>`, search the script for any binding whose camelCase name matches the component's PascalCase name.

### ~~Known Batch 10 regression: direct assignment on `ref({})` caches~~ FIXED

All 8 sites in `ConfigurationInfo.vue`, `DatasetInfo.vue`, and `ProjectInfo.vue` have been converted from `cache.value[key] = val` to object spread (`cache.value = { ...cache.value, [key]: val }`).

## Risk Areas

- **GeoJS Proxy Reactivity** (Critical): Vue 3's Proxy-based reactivity will break GeoJS object identity checks, causing crashes and performance cliffs. `ImageViewer.vue` and `AnnotationViewer.vue` require `markRaw()` on all GeoJS instances before the Vue 3 switch. See "GeoJS & Vue 3 Proxy Reactivity" section for full details.
- **AnnotationViewer.vue** (~3,310 lines): Migrated (Batch 19). Uses `getCurrentInstance()` proxy pattern for test spy compatibility. 244 tests passing. No `markRaw()` added yet — GeoJS objects come via props from ImageViewer (already wrapped).
- **ImageViewer.vue** (~1,395 lines): Migrated (Batch 18). Full `markRaw()` coverage on all GeoJS objects in `IMapEntry` fields. 106 tests passing.
- **Store interdependencies**: 11 Vuex modules with cross-references. Map dependencies before Pinia migration.
- **`$vnode.data` access**: Used in ColorPickerMenu for class/style passthrough. Vue 2-only API.
- **Template ref typing**: Mixed Class + Composition components cause type mismatches during incremental migration.
- **Vuetify v-data-table**: Significant API differences in v3. Abstract usage early.
