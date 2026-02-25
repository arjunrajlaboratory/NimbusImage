# Vue 3 Migration Plan

## Overview

This document tracks the incremental migration of NimbusImage from Vue 2 (Class Components + Vuex with decorators) to Vue 3 (Composition API + Vuetify 3). The strategy is to adopt Vue 3-compatible patterns within Vue 2.7 first, then switch frameworks with minimal breakage.

## Current Status

**Phase 3 complete (Batches A–F). App fully running on Vue 3 + Vuetify 3 + Vite 6. Production build works. Full test suite passing.**

- **Phase 1:** 124/124 components migrated to `<script setup>` (Batches 1–19 + master merge)
- **Phase 2:** `$refs` converted, directive state migrated, `markRaw()` applied to all GeoJS objects
- **Phase 3 Batch A:** Package swap complete — Vue 3.5, Vuetify 3.12, Vue Router 4, Vuex 4, TypeScript 5.9, all init files rewritten
- **Phase 3 Batch B:** All mechanical code fixes complete — `Vue.set`/`Vue.delete` removed (8 files, ~50 calls), `.sync` → `v-model:` (11 instances, 9 files), `$listeners` removed, `defineOptions()` + `useAttrs()` applied
- **Phase 3 Batch C:** `getCurrentInstance()` eliminated from all components — replaced with `useRoute()`/`useRouter()`, `useTheme()`, `useTour()` composable, and direct function calls
- **Phase 3 Batch D:** All Vuetify 3 template fixes complete — ~400+ changes across 60+ files. Activator slots, prop renames, structural component renames, v-data-table rewrites, v-model protocol, color/theme system, and all edge cases resolved.
- **Runtime Fixes:** Visual walkthrough completed. Fixed @girder/components inject, vuedraggable 4.x compatibility, Vuetify icon aliases, missing component imports, v-select `item-title` migration (10 files), BreadCrumbs CSS/reactivity, home screen layout (file browser names, header row flex, row alignment, search bar, app bar title position, tab active indicator), Vue Router 4 "Discarded invalid param(s)" warnings (BreadCrumbs route-specific params, DatasetAndConfigurationRouter query mapper, useRouteMapper null guard), ImageViewer stale tile flicker during dataset transitions (useRouteMapper setup timing, early datasetLoading guard, proactive tile hiding). See VUE3_STEPS.md "Runtime Fixes" section.
- **Phase 3 Batch E:** Test suite fully recovered — migrated 118 test files from Vue Test Utils v1 to v2, eliminated ~1982 tsc errors, all 2073 tests passing.
- **Phase 3 Batch F:** Build toolchain upgraded — Vite 6.4, @vitejs/plugin-vue 6.0.4, Vitest 3.2, Sass 1.86+, vite-plugin-static-copy 3.2. Node version in `.npmrc` updated from 18.20.2 to 22.22.0. Production build now works.
- **TypeScript:** `pnpm tsc` has 0 errors (source and test files).
- **HMR fix:** Vite 6 HMR freeze resolved — patched vuex-module-decorators re-registration, added `import.meta.hot.accept()` to all store files, extracted `src/router.ts` to break circular import. See R37 in VUE3_STEPS.md.
- **Dev server:** App boots successfully on Vite 6. HMR works correctly — edits to store files and App.vue apply without freezes or full reloads.
- **Build:** `pnpm build` succeeds (production build).
- **Tests:** 118/118 test files passing, 2073/2073 tests passing, 0 failures.
- **Circular dependencies:** All ~6 root cycles fixed (type-only imports, dependency inversion, lazy imports, constant extraction). See R38 in VUE3_STEPS.md and "Circular Dependencies" section below.
- **Post-Phase 3 Fixes (P5–P11):** Vue Router 4 param discarding fixed in ZenodoImporter and App.vue `goToNewDataset` (complex objects passed as route params → `store.initializeUploadWorkflow` pattern). NewDataset `failedDataset` error now clears on name edit. Vuetify 3 `v-list-item` icon layout fixed in help/tour menu (`#prepend` slot). Global `--v-list-prepend-gap: 8px` override added. ImageViewer overlay buttons resized smaller with more spacing. HelpPanel redesigned as fullscreen translucent HUD overlay with `<kbd>` key badges and multi-column layout.

---

## Migration Strategy

### Phase 1: Composition API Migration — COMPLETE

All 124 components converted from Class API (`@Component` + decorators) to `<script setup>` syntax (Batches 1–19 + master merge). See "Components Migrated" appendix for per-batch details.

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

### Phase 2: Remove Vue 2-Only Patterns — COMPLETE

**Status:** All actionable items done. Remaining items deferred to Phase 3 where they resolve automatically.

- **Remove `Vue.set()` / `Vue.delete()`** (56 occurrences, 11 files) — **Deferred to Phase 3.** Attempted and reverted: replacing `Vue.set()` in Vuex store mutations with object spread / direct assignment caused subtle reactivity bugs in Vue 2.7 (infinite render loops in directives, dataset loading failures). Vue 3's Proxy-based reactivity handles all `Vue.set` use cases automatically (`obj[newKey] = val`, `delete obj[key]`, `arr[idx] = val` all just work), so these replacements add risk now with no benefit. Remove `Vue.set`/`Vue.delete` during the Phase 3 framework switch when they become unnecessary.
- **~~Migrate directive state (`v-mousetrap.ts`, `v-description.ts`)~~** — DONE. Changed from `reactive({})` + `Vue.set()`/`Vue.delete()` to a non-reactive internal `_raw` object with a `ref({})` facade flushed on mutation. This prevents directive `update` hooks from creating dependency-tracking loops inside the parent component's render watcher (see "Directive State and Render Watcher Loops" gotcha below).
- **~~Convert `$refs` via `getCurrentInstance()`~~** — DONE. 2 usages converted:
  - `Toolset.vue`: Function ref array pattern for `v-for` dynamic refs
  - `AnnotationList.vue`: `Map<string, Element>` for dynamic annotation refs
- **Convert `.sync` to `v-model:`** (11 occurrences) — **Deferred to Phase 3.** `v-model:prop` syntax requires Vue 3's template compiler. The `.sync` modifier is the correct Vue 2 pattern and works fine in Vue 2.7.

### Phase 3: Framework Switch & Testing Upgrade — COMPLETE (Batches A–F)

This is the core Vue 3 + Vuetify 3 upgrade. All batches complete: package swap (A), mechanical code fixes (B), getCurrentInstance cleanup (C), Vuetify 3 template fixes (D), test suite recovery (E), and Vite 6 + Vitest 3 build toolchain upgrade (F).

#### Prerequisites (Hard Blockers) — ALL DONE

1. ~~**GeoJS `markRaw()` in AnnotationViewer.vue**~~ — **DONE.** Both `ImageViewer.vue` (Batch 18) and `AnnotationViewer.vue` now have full `markRaw()` coverage on all GeoJS annotation objects stored in reactive refs.
2. ~~**124/124 components migrated to `<script setup>`**~~ — **DONE.** All component logic is already in Composition API. The framework switch only fights framework syntax, not application architecture.
3. ~~**`pnpm tsc` reports 0 errors, `pnpm build` succeeds, `pnpm test` passes**~~ — **DONE.**

#### Testing Infrastructure Transition

Migrate from `@vue/test-utils` v1 to v2. Key breaking changes:

- **`createLocalVue` is removed.** Plugins (Vuetify, Vuex, Vue Router) must now be passed via the `global.plugins` array in `mount()` options:
  ```typescript
  // v1 (current)
  Vue.use(Vuetify);
  mount(Component, { vuetify: new Vuetify() });

  // v2 (Vue 3)
  mount(Component, {
    global: {
      plugins: [vuetify, store, router],
    },
  });
  ```
- **`propsData` renamed to `props`.**
- **`wrapper.vm` fully typed** for `<script setup>` components (no more `Wrapper<Vue>` — the test-shims.d.ts workaround becomes unnecessary).
- **`attachTo` cleanup is automatic** — no more manual `wrapper.destroy()` needed.

#### Framework Update Steps — Detailed Playbook

The app **will break** the moment the switch is flipped. This is expected. The playbook is about **controlled triaging**: fix things in strict order — compiler first, bundler second, runtime third — so you aren't chasing ghosts.

##### Step 1: Package Swap & Tooling Update

Before changing any application code, update the environment and dependencies.

**Tooling:**
- Disable **Vetur** VS Code extension, install **Vue - Official** (formerly Volar)
- Install **Vue.js devtools for Vue 3** (the Vue 2 devtools won't work)
- Update AI context (CLAUDE.md, workspace rules) to state the project is now **Vue 3, Vuetify 3, Vue Router 4** — prevents AI assists from generating Vue 2/Vuetify 2 syntax

**Dependencies:**
```bash
# Remove Vue 2 specifics
pnpm remove vue-template-compiler @vitejs/plugin-vue2

# Upgrade core packages (Vue 3 compatible versions of router/store)
pnpm add vue@^3.4.0 vuetify@^3.5.0 vue-router@4 vuex@4
pnpm add -D @vitejs/plugin-vue

# Upgrade test utils
pnpm add -D @vue/test-utils@^2.4.0
```

##### Step 2: Bundler & Entry Point (`vite.config.ts` & `main.ts`)

Get Vite to understand the new Vue version, then update how Vue boots up.

**Vite Config:** Swap the plugin:
```typescript
// vite.config.ts
import vue from '@vitejs/plugin-vue';
// replace vue2() with vue() in your plugins array
```

**`main.ts` Initialization:** Vue 3 removes the global `Vue` object. Switch to `createApp`:
```typescript
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import store from './store';
import vuetify from './plugins/vuetify'; // Update this file for Vuetify 3 export

const app = createApp(App);
app.use(router);
app.use(store);
app.use(vuetify);
app.mount('#app');
```

**Vuetify 3 plugin (`plugins/vuetify.ts`):** Must export a Vuetify instance created with `createVuetify()` instead of `new Vuetify()`.

**Vue Router 4:** Must switch from `new VueRouter()` to `createRouter()` + `createWebHistory()`.

**Vuex 4:** Must switch from `new Vuex.Store()` to `createStore()`.

##### Step 3: Type Check First (`pnpm tsc`) — Do NOT Open Browser Yet

Let TypeScript be the guide. Run `pnpm tsc --noEmit` before trying to load the app.

**`pnpm tsc` vs `vue-tsc`:** During iterative work, `pnpm tsc` is faster and checks `.ts` files only. `vue-tsc --noEmit` (installed as `vue-tsc@2.2.12`) is the Vue-aware checker powered by Volar — it also validates types inside `<template>` blocks (e.g., wrong prop types, missing slots). Run `vue-tsc` as a final gate once Batch D is complete. It's also what `vite build` uses internally for type-checked production builds.

1. **Delete `src/test-shims.d.ts` immediately** — it will cause conflicting types with `@vue/test-utils` v2
2. **Router/Store type fixes:** Vue Router 4 and Vuex 4 have different instantiation signatures (`createRouter`, `createWebHistory`, `createStore`). Fix these in their respective setup files
3. **Vuetify prop errors:** Expect dozens of type errors for Vuetify components (removed props, changed event signatures). Fix at the compiler level first — e.g., `v-dialog`'s `.sync`/`@input` → `v-model`

##### Step 4: Component Triage (Global Find & Replace) — Batches B & C DONE

**`Vue.set` and `Vue.delete` removal — DONE (Batch B1):**
~50 calls across 8 files converted. `import Vue from "vue"` removed from all non-test source files. Where `Vue` was used only as a type, replaced with `import type { ComponentPublicInstance }`.
- `Vue.set(obj, key, val)` → `obj[key] = val`
- `Vue.set(arr, idx, val)` → `arr.splice(idx, 1, val)` (for element replacement)
- `Vue.set(arr, arr.length, val)` → `arr.push(val)`
- `Vue.delete(obj, key)` → `delete obj[key]`

**`.sync` modifier → `v-model:` — DONE (Batch B2):**
11 instances across 9 files converted. ESLint `vue/no-v-model-argument` warnings expected until eslint config updated for Vue 3.

**`$listeners` removal — DONE (Batch B3):**
Removed `v-on="$listeners"` from `ToolItem.vue` and `CustomFileManager.vue` (both already had `v-bind="$attrs"`).

**`$scopedSlots` → `$slots`:**
No instances found — already clean.

**Dual `<script>` blocks → `defineOptions()` — DONE (Batch B4):**
`ColorPickerMenu.vue` converted.

**`$vnode.data` access → `useAttrs()` — DONE (Batch B5):**
`ColorPickerMenu.vue` converted.

**`getCurrentInstance()` cleanup — DONE (Batch C):**
All `getCurrentInstance()!.proxy` usage eliminated from components:
- `$route`/`$router` → `useRoute()` / `useRouter()` from `vue-router`
- `$vuetify.theme` → `useTheme()` from `vuetify`
- Tour plugin methods → `useTour()` composable (`src/utils/useTour.ts`)
- `$emit` via `getCurrentInstance()` → already using `defineEmits`

##### Step 5: Vuetify 3 Template Fixes — DONE (Batch D)

All Vuetify 3 template incompatibilities resolved (~400+ changes across 60+ files):

- **D1:** Activator slot API (`{on, attrs}` → `{props: activatorProps}`) — 21 files
- **D2:** Mechanical prop renames (size, variant, density, icon position, minor renames) — 50+ files
- **D3:** Removed `.native` event modifier — 5 files
- **D4:** v-tooltip directive → component, NimbusTooltip rewrite, location props — 20+ files
- **D5:** Structural renames (expansion-panel, list-item, simple-table, tabs-items, subheader) — 30+ files
- **D6:** Overlay prop updates (v-menu, v-dialog, v-navigation-drawer, v-app-bar) — 15 files
- **D7:** Color/theme system (hyphenated colors, CSS utility classes, theme selectors) — 25+ files
- **D8:** v-data-table rewrites (headers, slots, selection, click:row signature) — 5 tables
- **D9:** v-model protocol (`value`/`input` → `modelValue`/`update:modelValue`) — 26+ components + all parents
- **D10:** Edge cases, type error cleanup, verified 0 non-test `pnpm tsc` errors

##### Step 6: Test Suite Recovery — Batch E ✅

Migrated all 118 test files from Vue Test Utils v1 / Vue 2 patterns to Vue Test Utils v2 / Vue 3 patterns. Eliminated ~1982 tsc errors in test files. **Result: 118/118 test files passing, 2073/2073 tests passing, 0 failures.**

Key changes:
1. Created `test/setup.ts` — global Vuetify 3 plugin, directive stubs, `visualViewport`/`ResizeObserver` polyfills, vue-router mock via `importOriginal` + `inject()` with real symbols
2. Created `test/helpers.ts` — `routeProvider()`/`routerProvider()` helpers for per-test route/router overrides
3. Removed `import Vue from "vue"`, `Vue.use(Vuetify)`, `Vue.use(Vuex)`, `Vue.directive(...)` from all test files (~113 files)
4. Renamed `propsData:` → `props:` (~70 files), moved `mocks:`/`stubs:` → `global: {}` (~70 files)
5. Removed `wrapper.destroy()` calls (~39 files, 982 occurrences)
6. Replaced `Vue.nextTick()` → `nextTick()` from `vue` (~28 files)
7. Migrated 18 test files from `global.mocks.$route/$router` to `global.provide` with real vue-router symbols
8. Fixed Vuetify 3-specific test issues: `shallowMount` stubs not rendering slots (custom stubs with `<slot />`), `Vue.observable` → `reactive()`, `toBe` → `toStrictEqual` for reactive proxies

See VUE3_STEPS.md "Batch E" section for full details.

#### Known Vuetify 3 Migration Challenges — ALL RESOLVED (Batch D)

- **`v-data-table`:** All 5 tables rewritten (D8). Headers use `{ title, key }`, slot syntax updated, `@click:row` signature updated for V3 `(event, { item })`.
- **`v-dialog` / `v-menu`:** Activator slots (D1), overlay props (D6), and v-model protocol (D9) all converted.
- **Form validation:** Vuetify 3's built-in validation still works for our use cases (no VeeValidate needed).
- **Icon migration:** `mdi-*` string usage works in both versions — no changes needed (confirmed).

#### GeoJS & Vue 3 Proxy Reactivity — DONE

Vue 3 replaces `Object.defineProperty` (Vue 2) with **ES6 Proxies** for reactivity. GeoJS objects rely on strict object identity and WebGL internal slots — Proxy wrapping breaks them ("Illegal invocation" crashes).

**Fix applied:** `markRaw()` on all GeoJS objects stored in reactive refs. This is a no-op in Vue 2.7 and prevents Proxy wrapping in Vue 3.

**Coverage:**
- `ImageViewer.vue`: All GeoJS objects in `IMapEntry` fields (maps, layers, features) — done in Batch 18
- `AnnotationViewer.vue`: All 7 reactive GeoJS refs (`cursorAnnotation`, `pendingAnnotation`, `selectionAnnotation`, `samUnsubmittedAnnotation`, `samLivePreviewAnnotation`, `dragGhostAnnotation`, `samPromptAnnotations` items) — done post-Phase 2

**What does NOT need `markRaw()`:** GeoJS objects in local function variables (e.g., the `newAnnotations` array in `drawNewAnnotations`, the `drawnGeoJSAnnotations` Map) — these are plain JS, never stored in reactive state, so Vue won't proxy them.

**Pattern for future GeoJS code:**
```typescript
// Wrap when storing in a ref
someRef.value = markRaw(geojs.createAnnotation("circle"));

// For arrays of GeoJS objects in refs: wrap each item
newAnnotations.push(markRaw(newAnnotation));

// DON'T wrap local variables — they're not reactive
const localAnnotation = geojs.annotation.pointAnnotation(opts); // fine as-is
```

### Phase 4: Store Migration (Future)

Post-stabilization. Once the app is running on Vue 3 + Vuetify 3:

Currently using Vuex with `vuex-module-decorators` (11 modules). Plan:
1. Keep Vuex during the framework switch
2. Install Pinia alongside Vuex when ready
3. Migrate one store module at a time (start with smallest: `properties.ts`)
4. Eventually remove Vuex

## Appendix: Components Migrated (Batches 1–19 + Master Merge)

Historical record of each migration batch. Key patterns discovered in each batch are documented here for reference; the most important ones are consolidated in "Migration Patterns & Gotchas" above.

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

**Note:** `src/store/index.ts` (~2,477 lines) is not a Vue component but should be considered for splitting before the Pinia migration (Phase 4).

### Master Merge — Project Sharing Feature (3 new components + 6 conflict resolutions)

Merged master's "Project Sharing and Permission Propagation" feature into the migration branch. Master added 3 new class-style components and modified 6 existing ones. All 3 new components were migrated to `<script setup>`, and all 6 conflicts were resolved by keeping our `<script setup>` code and porting master's new sharing logic.

**New components migrated:**

| Component | Lines | Key Patterns |
|-----------|-------|-------------|
| `SharingStatusDisplay.vue` | 106 | Pure display, `defineProps` only, imports `accessLevelLabel`/`accessLevelColor` utils |
| `SharingStatusIcon.vue` | 133 | 3 props, 3 `computed()` (`iconName`, `iconColor`, `displayedUsers`), module-level const |
| `ShareProject.vue` | 537 | Computed get/set for v-model dialog, 14+ `ref()`, confirmation pattern (`showConfirm`/`executeConfirmedAction`/`pendingAction`), `watch(dialog)` for fetch on open |

**Conflict resolutions (ported sharing logic into existing `<script setup>` components):**

| Component | Changes Ported |
|-----------|---------------|
| `AddCollectionToProjectFilterDialog.vue` | Added `isShared`/`isPublic` props, `showPermissionConfirm` ref, `confirmAdd()` gating function, permission confirmation dialog |
| `AddDatasetToProjectDialog.vue` | Same pattern as above for datasets |
| `ShareDataset.vue` | Added `isResourceAdmin` computed (checks user level 2), conditional template for admin vs non-admin |
| `ConfigurationInfo.vue` | Added sharing state refs, `fetchSharingInfoData()`, `getDatasetSharingInfo()`, `SharingStatusDisplay`/`SharingStatusIcon` integration |
| `DatasetInfo.vue` | Same sharing integration pattern as ConfigurationInfo |
| `ProjectInfo.vue` | Added `shareDialog`, `projectAccessInfo`, `isProjectPublic`/`isProjectShared` computeds, `fetchAccessInfo()`, `ShareProject` dialog |

**New utility files (auto-merged from master):**
- `src/utils/accessLevel.ts` — `accessLevelLabel()` and `accessLevelColor()` helpers
- `src/utils/sharingInfo.ts` — `fetchSharingInfo()` for configuration/dataset sharing status

**After this merge:** 124 of 124 components migrated to `<script setup>` (100%).

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

### `Vue.set`/`Vue.delete` — keep until Phase 3

**Deferred.** Removing `Vue.set()`/`Vue.delete()` from Vuex store mutations and component code was attempted and reverted. While the replacement patterns are correct in isolation, they cause subtle reactivity bugs when applied across the codebase in Vue 2.7:

1. **Infinite render loops:** Replacing `reactive({})` + `Vue.set()` with `ref({})` + object spread in directive state caused dependency-tracking loops (see "Directive State and Render Watcher Loops" below).
2. **Dataset loading failures:** Replacing `Vue.set()` in Vuex mutations with object spread changed watcher behavior — replacing entire objects (new reference) vs. adding properties in-place (same reference) triggers different sets of watchers, causing cascading reactivity differences that are hard to debug.

**Decision:** Vue 3's Proxy-based reactivity handles all `Vue.set` use cases automatically. Removing `Vue.set` in Vue 2.7 adds risk with no functional benefit. Remove during the Phase 3 framework switch.

**Components still using `Vue.set`/`Vue.delete`:** `annotation.ts`, `index.ts`, `properties.ts`, `girderResources.ts`, `jobs.ts`, `AnnotationConfiguration.vue`, `ToolConfiguration.vue`, `Property.vue`, `samPipeline.ts`.

### `Vue.set`/`Vue.delete` → object spread for `ref({})` (component-level only)

**Still relevant for component-level `ref<Record<...>>()` objects** (NOT Vuex state). When a `<script setup>` component uses `ref({})` to hold a local record, Vue 2.7 cannot detect new property additions via direct assignment:

```typescript
// BAD — new key NOT reactive in Vue 2.7
const overrides = ref<Record<string, string>>({});
overrides.value[newChannel] = color;        // Vue can't see this!

// GOOD — replacing .value triggers reactivity
overrides.value = { ...overrides.value, [newChannel]: color };
```

This gotcha applies to component-local `ref({})` objects only. For Vuex store state, keep using `Vue.set()` until Phase 3.

### Directive state and render watcher loops

**Critical gotcha discovered during Phase 2.** Custom directives (`v-description`, `v-mousetrap`) that maintain module-level reactive state must NOT use `ref({})` with direct `.value` reads/writes in their `update` hooks.

**Root cause:** In Vue 2, directive `update` hooks run during the component's render watcher evaluation (inside `_update()`, which is called within `Watcher.get()` while `Dep.target` is set). Any reactive reads inside the hook (e.g., `descriptions.value`) get tracked as dependencies of the **parent component's render watcher**, not the directive's own logic. If the hook also writes to the same reactive source, it re-queues the render watcher, creating an infinite loop.

**Trigger condition:** Template uses inline object literals for directive values (e.g., `v-description="{ section: '...', ... }"`). Since `{} !== {}`, the `value === oldValue` identity check always fails, so the `update` hook always runs `unbind` + `bind`, which reads and writes `descriptions.value` every render.

**Fix (applied):** Use a plain (non-reactive) `_raw` object for internal bookkeeping, and a `ref({})` facade that consumers read. The directive hooks only write to `_raw` and call `flush()` which writes (but never reads) the ref:

```typescript
const _raw: Record<string, Data> = {};        // not reactive
export const data = ref<Record<string, Data>>({}); // consumers read this

function flush() {
  data.value = { ..._raw }; // setter only — no dep.depend(), just dep.notify()
}

function bind(el, value) {
  _raw[id] = value;
  flush(); // safe: only triggers notify, doesn't track as render dep
}
```

Additionally, the `update` hook uses shallow content comparison (not reference identity) to skip no-op updates from inline object literals:

```typescript
update(el, { value, oldValue }) {
  if (shallowEqual(value, oldValue)) return; // content check, not reference
  unbind(el);
  bind(el, value);
}
```

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

**Future-proofing note (array replacement):** This array-replacement pattern is also strictly required for any future transition to `shallowRef`. `shallowRef` only tracks `.value` reassignment — it completely ignores internal mutations like `.push()` or `.splice()`. By enforcing the spread/replacement pattern now, the state management code is already compatible. Note: for annotations specifically, `markRaw()` is already applied to individual items (see "Annotation Store `markRaw()` Strategy" in Risk Areas), so `shallowRef` is not needed — the items are already excluded from Vue's proxy system.

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

## Risk Areas

- ~~**GeoJS Proxy Reactivity**~~ (Resolved): Both `ImageViewer.vue` and `AnnotationViewer.vue` now have full `markRaw()` coverage on all GeoJS objects in reactive refs.
- **AnnotationViewer.vue** (~3,310 lines): Migrated (Batch 19). Full `markRaw()` coverage. 244 tests passing.
- **ImageViewer.vue** (~1,395 lines): Migrated (Batch 18). Full `markRaw()` coverage. 106 tests passing.
- ~~**HMR freeze (Vite 6)**~~ (Resolved): vuex-module-decorators re-registration during HMR caused multi-minute freezes. Fixed with `import.meta.hot.accept()`, idempotent `registerModule` patch, and router extraction. See "HMR Store Re-registration" section below.
- ~~**Circular dependencies**~~ (Resolved): All ~6 root cycles fixed via type-only imports, dependency inversion (pass API as parameter), lazy imports, and constant extraction. See R38 in VUE3_STEPS.md.
- **Store interdependencies**: 11 Vuex modules with cross-references. Map dependencies before Pinia migration.
- **`$vnode.data` access**: Used in ColorPickerMenu for class/style passthrough. Vue 2-only API.
- **Template ref typing**: Mixed Class + Composition components cause type mismatches during incremental migration.
- **Vuetify v-data-table**: Significant API differences in v3. Complex usages (especially `AnnotationList.vue` with `$children` access) require complete rewrites. See Phase 3 notes.
- ~~**Vue 3 Proxy performance on large arrays**~~ (Resolved): `markRaw()` is applied to all annotation objects in `AnnotationsAPI.ts:135` (API responses) and `annotation.ts:865` (cloned for editing), plus `propertyValues` (in `properties.ts:166`), `annotationCentroids` (in `annotation.ts:461/474/495/499`), and `annotationConnections` (in `AnnotationsAPI.ts:274` via `toConnection`). All large read-only data structures are now excluded from Vue's proxy system. See "Annotation Store `markRaw()` Strategy" below.

### Annotation Store `markRaw()` Strategy

**Status: Applied and verified with 26K annotations on Vue 3.**

The annotation store uses `markRaw()` on all large read-only data structures to prevent Vue 3's Proxy system from wrapping them. This is the optimal pattern for large collections of read-mostly data:

- **`AnnotationsAPI.ts:135`** — Every annotation parsed from API responses is wrapped with `markRaw()` before entering the store
- **`AnnotationsAPI.ts:274`** — Every connection parsed from API responses is wrapped with `markRaw()` via `toConnection()`
- **`annotation.ts:865`** — Annotations cloned for editing (`structuredClone`) are re-wrapped with `markRaw()`
- **`annotation.ts:461/474/499`** — Each centroid entry is wrapped with `markRaw()` when added
- **`annotation.ts:495`** — The `annotationCentroids` dict itself is marked raw on reset (`markRaw({})`) to prevent proxy traps during bulk 26K key assignments
- **`annotation.ts:500`** — The `annotationIdToIdx` dict is marked raw on reset (`markRaw({})`) for the same reason
- **`properties.ts:166`** — The entire `propertyValues` object is wrapped with `markRaw()` in `updatePropertyValues` (single mutation chokepoint)

**NOT marked raw:** `propertyStatuses` — has direct in-place mutations (`status.running = true`) that require reactivity.

**Why `markRaw()` is better than `shallowRef` for this use case:**
- `shallowRef` on the array would still create Proxy wrappers for items when accessed through the reactive array (lazy but cumulative)
- `markRaw()` on each item permanently marks it with `__v_skip: true`, so Vue never creates a Proxy regardless of access path
- The array container itself stays reactive, so `watch()` on the array still fires when annotations are added/removed (via array replacement pattern)
- Trade-off: mutations to individual annotation properties are not reactive — but this is correct, because annotations are always replaced wholesale (never mutated in place)

**Memory profile (26K annotations, measured on Vue 3):**

| Data | Raw Size | Proxy Overhead | `markRaw`? |
|------|----------|---------------|------------|
| `annotations` (26K items) | 9.4 MB | ~0 MB | Yes |
| `propertyValues` (26K entries, 5 nested each) | 22.2 MB | ~0 MB | Yes |
| `annotationCentroids` (26K entries) | 1.8 MB | ~0 MB | Yes |
| `annotationConnections` | variable | ~0 MB | Yes |
| `annotationIdToIdx` (26K entries) | 0.8 MB | ~0 MB | Yes (dict) |
| Total store data | ~42 MB | ~0 MB | — |
| Total JS heap | ~530 MB | — | — |

The ~530MB heap is dominated by GeoJS tile caches (~400MB+), canvas rendering (~42MB), and Vue's dependency tracking infrastructure (~35MB est.), not by proxy overhead. The `markRaw()` strategy eliminates virtually all proxy overhead on store data.

### HMR Store Re-registration (Vite 6) — RESOLVED

**Problem:** After upgrading to Vite 6, any code edit during development triggered a multi-minute browser freeze. Two separate issues contributed:

1. **vuex-module-decorators re-registration cascade.** The library's `@Module({ dynamic: true })` decorator calls `store.registerModule()` at class-definition time (in `registerDynamicModule()` at `vuex-module-decorators/dist/esm/index.js:150-159`). It does not check whether the module is already registered. When Vite 6 HMR re-evaluates a store file, the decorator blindly re-registers the module, causing:
   - "duplicate getter" warnings from Vuex (getters cannot be redefined)
   - State reset to initial values (registerModule overwrites existing state)
   - Massive Vue reactivity cascades as every reactive subscriber re-evaluates

   Vite 6 is more aggressive than Vite 5 about invalidating transitive dependencies. An edit to any file imported by a store module cascades up through all 13 store modules, then into 80+ Vue components that import those stores. Each store module re-registers during this cascade, compounding the problem.

2. **Circular import preventing HMR on App.vue.** The dependency chain `App.vue → store/index.ts → (dynamic import) main.ts → App.vue` formed a cycle. Even though the store used `await import("@/main")` (a dynamic import), Vite's HMR module graph still tracked it as a dependency, causing Vite to fall back to a full page reload whenever App.vue was edited.

**Solution (three complementary layers):**

**Layer 1 — `import.meta.hot.accept()` on all store files.**
Each store module (13 files) and `useRouteMapper.ts` now call `import.meta.hot.accept()` at the end of the file. This makes each module self-accepting for HMR, preventing cascades from propagating to all importing Vue components. Without this, an edit to a utility file would cascade through every store → every component, causing a full re-render of the entire app.

**Layer 2 — Idempotent `registerModule` patch in `src/store/root.ts`.**
The Vuex store's `registerModule` method is monkey-patched (only in dev, behind `import.meta.hot` guard) to:
1. Check if the module already exists in `store.state`
2. If it does: `unregisterModule()` first, then `registerModule()` with `preserveState: true`
3. If it doesn't: call the original `registerModule()` normally

The `preserveState: true` option is critical — it tells Vuex to keep the existing runtime state (loaded dataset, annotations, user session, etc.) while picking up new/changed getters, actions, and mutations from the re-evaluated module.

**Layer 3 — Extract `src/router.ts` to break circular import.**
Router creation (`createRouter` + `createWebHashHistory` + routes) was moved from `main.ts` to a dedicated `src/router.ts` file. The store's dynamic import was changed from `await import("@/main")` to `await import("@/router")`. This breaks the `App.vue → store → main.ts → App.vue` cycle, allowing Vite to apply HMR patches to App.vue without a full page reload.

**Key insight:** Layers 1 and 2 are complementary, not redundant. Layer 2 makes re-registration safe (no state loss, no duplicate getters). Layer 1 makes it fast (prevents unnecessary cascade propagation). Without Layer 1, every edit would still trigger re-evaluation of all 13 stores and 80+ components — safe, but slow. Without Layer 2, if a store file IS re-evaluated (e.g., when edited directly), the re-registration would still cause duplicate getter warnings and state loss.

### Circular Dependencies — RESOLVED

**Status: All ~6 root cycles fixed.** See R38 in VUE3_STEPS.md for full details.

**Root cycles and how they were fixed:**

| # | Cycle | Fix |
|---|-------|-----|
| 1 | `store/images.ts` ↔ `store/index.ts` | Added `api` parameter to `getBandOption()`, removed store import from images.ts |
| 2 | `store/model.ts` ↔ `store/GirderAPI.ts` | `import type { ITileMeta }` (type-only, erased at compile time) |
| 3 | `store/jobs.ts` ↔ `store/progress.ts` | Extracted `jobStates` to `jobConstants.ts`, lazy `import("./progress")` in jobs.ts |
| 4 | `store/properties.ts` ↔ `store/filters.ts` | Lazy `import("./filters")` at 2 call sites in properties.ts |
| 5 | `store/model.ts` ↔ `pipelines/samPipeline.ts` | `import type { TSamNodes }` (type-only) |
| 6 | `store/index.ts → router.ts → views → store` | Pass `routeQuery` from UI layer into `setDatasetViewId()`, removed router import from store |

**Additional cleanup:**
- `store/model.ts` → `store/images.ts`: `import type { ITileHistogram }` (type-only)
- `components/FileManagerOptions.vue`: Deleted unused `GirderLocationChooser` import

**Remaining Vue component cycles (low priority — SFCs self-accept HMR):**
- `components/Snapshots.vue` ↔ `components/MovieDialog.vue` — investigated, found to be one-way only (not actually circular)
- `components/CustomFileManager.vue` → `components/FileManagerOptions.vue` → `components/GirderLocationChooser.vue` — partially resolved by removing unused GirderLocationChooser import

**Techniques used (for future reference):**
1. **`import type`** — TypeScript erases these at compile time, breaking runtime cycles for type-only references
2. **Dependency inversion** — Pass dependencies as parameters (e.g., `api` parameter on `getBandOption`) instead of importing the module that provides them
3. **Lazy `import()`** — Replace static `import X from "./X"` with `await import("./X")` at call sites in async functions. Breaks the static cycle while preserving runtime behavior
4. **Constant extraction** — Move shared constants (e.g., `jobStates`) to a dedicated file that both modules import from
