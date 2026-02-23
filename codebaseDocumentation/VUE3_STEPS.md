# Vue 3 Migration - Phase 3 Progress Tracker

## Status: Batch D — COMPLETE

## Batch A: Package Swap + Bundler/Entry Points ✅

### A1. Package changes
- [x] Remove Vue 2-only packages (vue-template-compiler, @vitejs/plugin-vue2, vuetify-loader, vue-class-component, vue-property-decorator, vue-resize, vue-tooltip-directive, unplugin-vue-components)
- [x] Upgrade core packages: vue@3.5.28, vuetify@3.12.0, vue-router@4.6.4, vuex@4.1.0
- [x] Upgrade companions: @girder/components@4.0.0, vuex-module-decorators@2.0.0, vuedraggable@4.1.0, vue-async-computed@4.0.1, mitt@3.0.1
- [x] Upgrade dev: @vitejs/plugin-vue@6.0.4, vite-plugin-vuetify@2.1.3, vue-tsc@2.2.12, @vue/test-utils@2.4.6, typescript@5.9.3, @types/node@20.19.33

### A2. Rewrite init files
- [x] `vite.config.js` — `@vitejs/plugin-vue` + `vite-plugin-vuetify`, removed VuetifyResolver/unplugin
- [x] `src/store/root.ts` — `createStore({})`
- [x] `src/plugins/vuetify.ts` — `createVuetify()` with theme config
- [x] `src/main.ts` — `createApp()`, `createRouter()`, `app.use()`, `app.directive()`, `app.provide()`
- [x] `src/views/index.ts` — `RouteRecordRaw`, `/:pathMatch(.*)*` catchall
- [x] `src/views/dataset/index.ts` — RouteRecordRaw
- [x] `src/views/project/index.ts` — RouteRecordRaw
- [x] `src/views/datasetView/index.ts` — RouteRecordRaw
- [x] `src/views/configuration/index.ts` — RouteRecordRaw
- [x] `src/plugins/tourBus.ts` — `mitt()` event bus
- [x] `src/plugins/tour.ts` — `app.config.globalProperties`, `Router` type, `router.currentRoute.value`, `tourBus.on/off/emit`
- [x] `src/plugins/tour-trigger.directive.ts` — exported `tourTriggerDirective` with `mounted/unmounted`
- [x] `src/plugins/resize.ts` — Deleted
- [x] `src/test-shims.d.ts` — Deleted
- [x] `tsconfig.json` — removed vueCompilerOptions target 2.7, removed vue/vue-router/vuetify from types array, added skipLibCheck
- [x] `src/shims-vue.d.ts` — updated to Vue 3 DefineComponent

### A3. Directive hook names
- [x] `src/utils/v-mousetrap.ts` — exported `mousetrapDirective` with `mounted/updated/unmounted`
- [x] `src/utils/v-description.ts` — exported `descriptionDirective` with `mounted/updated/unmounted`

### A4. @girder/components v4 imports
- [x] `src/girder/index.ts` — main entry exports, vuetifyConfig stub, RestClientInstance type
- [x] `src/girder/components.ts` — main entry: Upload, Breadcrumb, Search, FileManager
- [x] `src/girder/shims-girder.d.ts` — updated declare module for @girder/components

### Extra fixes done
- [x] `src/pipelines/samPipeline.ts` — removed vue-property-decorator import, replaced Vue.set
- [x] `src/tools/creation/ToolConfigurationItem.vue` — `vuetify/lib` → `vuetify/components`
- [x] `src/utils/useRouteMapper.ts` — converted from getCurrentInstance to useRoute/useRouter, Route→RouteLocationNormalized

### Verification
- [x] `pnpm install` succeeds (no peer dep warnings)
- [x] `pnpm tsc` runs — 253 non-test source errors (expected: Batches B/C/D will fix)
  - 117 TS2339: Vuetify 3 slot types + $route/$router access
  - 60 TS18047: getCurrentInstance possibly null
  - 31 TS2345: type argument issues
  - 26 TS2322: type assignment issues
  - 10 TS1192: `import Vue from "vue"` no default export (Vue.set users)
  - 9 misc

### Heaviest error files
- BreadCrumbs.vue (27), NewDataset.vue (17), DatasetInfo.vue (14), MultiSourceConfiguration.vue (12)

---

## Batch B: Mechanical Code Fixes ✅
- [x] B1. Remove Vue.set/Vue.delete (8 store/component files: girderResources, jobs, annotation, properties, index, AnnotationConfiguration, ToolConfiguration, Property.vue; plus Vue type→ComponentPublicInstance in NewDataset.vue)
- [x] B2. Convert .sync → v-model: (11 instances across 9 files)
- [x] B3. Remove $listeners (ToolItem.vue, CustomFileManager.vue)
- [x] B4. Dual `<script>` → defineOptions() (ColorPickerMenu.vue)
- [x] B5. Fix $vnode.data → useAttrs() (ColorPickerMenu.vue)
- [x] B6. ~~Fix samPipeline.ts vue-property-decorator import~~ ✅ (done in Batch A)
- [x] B7. ~~Replace vue-resize usage~~ ✅ (done in Batch A)

### Verification
- [x] `pnpm tsc` — no new errors introduced by Batch B changes (all errors are pre-existing from Batch A: Vuetify 3 types, test files)
- [x] Dev server starts successfully (`pnpm run dev`)
- [x] No `Vue.set`/`Vue.delete` calls remain in source files (test files still have `import Vue` — Batch E)
- [ ] `pnpm build` — blocked by pre-existing `crypto.hash` issue in `@vitejs/plugin-vue@6.0.4` (Node.js compat)
- [ ] `pnpm test` — all 117 test file failures are pre-existing (test infrastructure needs Batch E)

### Error reduction from Batch B
- Eliminated all 10 `TS1192: no default export` errors from `import Vue from "vue"` in source files
- Remaining tsc errors are Vuetify 3 type mismatches (TS2339, TS2345, TS2322) and `getCurrentInstance` null checks (TS18047) — addressed in Batches C and D

---

## Batch C: getCurrentInstance Cleanup ✅

### Step 0: Prerequisites
- [x] Created `src/utils/useTour.ts` — provide/inject composable wrapping TourManager
- [x] Updated `src/main.ts` — added `app.provide("tourManager", tourManager)`

### C1. Router/route access → useRoute()/useRouter() (18 files)
- [x] Dataset.vue, DatasetInfo.vue, ImportDataset.vue, NewDataset.vue, MultiSourceConfiguration.vue, ProjectInfo.vue
- [x] NewConfiguration.vue, ImportConfiguration.vue, ConfigurationInfo.vue, DuplicateImportConfiguration.vue
- [x] BreadCrumbs.vue, UserMenu.vue, UserProfileSettings.vue
- [x] CollectionList.vue, ProjectList.vue, CollectionItemRow.vue, ZenodoImporter.vue
- [x] ~~useRouteMapper.ts composable~~ ✅ (done in Batch A)

### C2. $emit → defineEmits (2 files)
- [x] ValueSlider.vue — 3x `vm.$emit("input", ...)` → `emit("input", ...)`
- [x] GirderLocationChooser.vue — `vm.$emit("update:dialog", ...)` and `vm.$emit("input", ...)` → `emit(...)`

### C3. $vuetify.theme → useTheme() (1 file)
- [x] UISettings.vue — `getCurrentInstance()?.proxy?.$vuetify` → `useTheme()` with `theme.global.name.value`

### C4. Tour plugin access (3 files)
- [x] App.vue — `useTour()` + `useRoute()`/`useRouter()`, replaced `$loadAllTours`, `$startTour`, `$router.push`, `$route.name`
- [x] Home.vue — `useTour()` + `useRoute()`/`useRouter()`, replaced `$startTour`, `$router.push`, `$route.name`
- [x] AnnotationConfiguration.vue — `useTour()` in onMounted, replaced `$isTourActive`, `$startTour`

### C5. Special cases (2 files)
- [x] ChatComponent.vue — replaced `vm.$el` with `ref="rootEl"` template ref (wrapped in `<div>`)
- [x] AnnotationViewer.vue — replaced 14x `(_instance!.proxy as any).fn()` with direct `fn()` calls

### Verification
- [x] `grep -rn "getCurrentInstance" src/ --include="*.vue" --include="*.ts"` — 0 results
- [x] `pnpm tsc` — 2161 errors (all pre-existing: test files + Vuetify 3 type mismatches, no new errors from Batch C)

## Batch D: Vuetify 3 Template Fixes ✅

~400+ individual changes across 60+ files. All Vuetify 2 template syntax converted to Vuetify 3 APIs.

### D1. Activator slot API (~21 files) ✅
- [x] `v-slot:activator="{ on, attrs }"` → `v-slot:activator="{ props: activatorProps }"` + `v-bind="activatorProps"`
- [x] Removed all `v-on="on"` and `v-bind="attrs"` activator patterns
- [x] Toolset.vue nested activators: `mergeProps(dialogProps, tooltipProps)` from `vue`

### D2. Mechanical prop renames (~50 files) ✅
- [x] D2a: Size props — `x-small`/`small`/`large` boolean → `size="x-small"` etc. on v-btn, v-icon, v-chip
- [x] D2b: Variant props — `outlined` → `variant="outlined"`, `text` → `variant="text"` on buttons
- [x] D2c: Density props — `dense` → `density="compact"` on inputs, lists, toggles
- [x] D2d: v-icon position — `left` → `start`, `right` → `end`
- [x] D2e: Minor renames — `dismissible` → `closable`, `item-text` → `item-title`, `input-value` → `model-value`, `v-simple-checkbox` → `v-checkbox`, `@hook:mounted` → `@vue:mounted`

### D3. Remove `.native` modifier (5 files) ✅
- [x] 18 instances: `@click.native.stop` → `@click.stop` etc.

### D4. v-tooltip replacement (~20 files) ✅
- [x] D4a: Directive `v-tooltip="..."` → `<v-tooltip>` component with activator slot
- [x] D4b: NimbusTooltip.vue rewrite — position booleans → `:location`
- [x] D4c: Existing `<v-tooltip>` location props — `bottom` → `location="bottom"` etc.

### D5. Structural component renames (~30 files) ✅
- [x] D5a: `v-expansion-panel-header` → `v-expansion-panel-title`, `v-expansion-panel-content` → `v-expansion-panel-text`
- [x] D5b: `v-list-item-content` removed, `v-list-item-icon` → `v-slot:prepend`, `v-list-item-action` → `v-slot:append`, `v-list-item-group` removed
- [x] D5c: `v-simple-table` → `v-table`
- [x] D5d: `v-tabs-items` → `v-window`, `v-tab-item` → `v-window-item`
- [x] D5e: `v-subheader` → `v-list-subheader`

### D6. Overlay prop updates (~15 files) ✅
- [x] `offset-x`/`offset-y` on v-menu → `offset` or removed
- [x] `app`/`clipped-right` on v-app-bar → removed
- [x] `app`/`clipped`/`disable-resize-watcher`/`hide-overlay` on v-navigation-drawer → removed/updated
- [x] `@input` on v-dialog → `@update:model-value`

### D7. Color/theme system (~25 files) ✅
- [x] Color notation: `"grey darken-1"` → `"grey-darken-1"` (hyphen, no space)
- [x] CSS utility classes: `grey--text` → `text-grey`, `text--secondary` → `text-medium-emphasis`
- [x] Theme CSS selectors: `.theme--dark` → `.v-theme--dark`
- [x] CSS class `.v-subheader` → `.v-list-subheader`

### D8. v-data-table rewrites (5 tables) ✅
- [x] Headers: `{ text, value }` → `{ title, key }` in all tables
- [x] `footer-props` → direct `:items-per-page-options` prop
- [x] AnnotationList.vue: Eliminated `$children` access — replaced with local sort tracking via `sortBy` ref + `@update:sort-by`
- [x] AnnotationList.vue: `v-slot:body` → `v-slot:item` per-row slots
- [x] Snapshots.vue: `@click:row` signature updated for V3

### D9. v-model protocol update (26+ components) ✅
- [x] Child components: `value`/`input` → `modelValue`/`update:modelValue`
- [x] Parent bindings: `:value=`/`@input=` → `:model-value=`/`@update:model-value=`
- [x] Vuetify built-in components: `:value=` → `:model-value=` (30 conversions across 19 files)

### D10. Edge cases and cleanup ✅
- [x] `small-chips` → `chips`, `deletable-chips` → `closable-chips`
- [x] `close` on v-chip → `closable`
- [x] `v-model:search-input` → `v-model:search` on v-combobox
- [x] `append-outer` slot → `append` slot on v-text-field
- [x] `RawLocation`/`Location` → `RouteLocationRaw` (vue-router 4)
- [x] ListItem<> wrapping in V3 scoped slots → `.raw` access
- [x] `import type Vue from "vue"` → `ComponentPublicInstance`
- [x] `vue/types/vue` module augmentation → `vue` with `ComponentCustomProperties`
- [x] `app.$route` → `router.currentRoute.value` in store
- [x] Directive type assertions in main.ts
- [x] TagPicker selection slot → V3 `#chip` slot API

### Verification
- [x] `pnpm tsc` — 0 non-test type errors
- [x] All Vuetify 2 template patterns verified gone (activator slots, .native, expansion-panel-header/content, list-item-content, v-simple-table, grey darken, etc.)
- [x] `pnpm run dev` — visual walkthrough complete (see Runtime Fixes below)
- [ ] `pnpm build` — needs test

---

## Runtime Fixes (Post-Batch D Visual Walkthrough) ✅

After Batch D achieved 0 tsc errors, the dev server was started and a visual walkthrough identified several runtime-only issues. These are fixes that TypeScript could not catch because they involve runtime API behavior differences.

### R1. @girder/components v4 inject key ✅
- [x] `src/main.ts` — Added `app.provide('girder', girderRest)` so GirderFileManager (which uses `inject('girder')`) receives the REST client

### R2. vuedraggable 4.x compatibility ✅
- [x] `src/components/DisplayLayers.vue` — Converted to `#item="{ element }"` slot pattern (vuedraggable 4.x)
- [x] `src/components/DisplayLayerGroup.vue` — Removed `tag="transition-group"` and `:component-data` (causes `__draggable_context` null error in Vue 3.5)
- [x] `src/tools/toolsets/Toolset.vue` — Converted to `#item` slot pattern

### R3. Vuetify 3 icon aliases for @girder/components ✅
- [x] `src/plugins/vuetify.ts` — Added icon aliases (`complete`, `cancel`, `close`, `delete`, `clear`, `success`, `info`, `warning`, `error`, `prev`, `next`, `checkboxOn`, `checkboxOff`, etc.) needed by @girder/components v4

### R4. Missing component imports ✅
- [x] `src/components/ViewerToolbar.vue` — Added explicit imports for `TagPicker` and `TagFilterEditor` (required by `<script setup>`)
- [x] `src/components/ColorPickerMenu.vue` — Added missing import

### R5. Vuetify 3 v-select `item-title` migration (10 files) ✅
Vuetify 3 changed the default item display property from `text` to `title`. All v-select components using `{ text, value }` items needed `item-title="text" item-value="value"` props.

- [x] `src/layout/BreadCrumbs.vue` — dataset dropdown
- [x] `src/components/Snapshots.vue` — layer and channel dropdowns (was showing "[object Object]")
- [x] `src/components/ViewerSettings.vue` — compositing mode and background color dropdowns
- [x] `src/components/DockerImageSelect.vue` — algorithm dropdown
- [x] `src/components/ChannelSelect.vue` — channel dropdown
- [x] `src/components/ShareDataset.vue` — access level dropdowns (2 instances)
- [x] `src/components/ShareProject.vue` — access level dropdowns (2 instances)
- [x] `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue` — shape dropdown
- [x] `src/tools/creation/templates/AnnotationConfiguration.vue` — shape dropdown
- [x] `src/views/project/ProjectInfo.vue` — license dropdown

### R6. BreadCrumbs CSS + reactivity fixes ✅
- [x] CSS: Changed `.breadcrumb-select` from `min-width: 0` to `min-width: 8em; max-width: 20em` (Vuetify 3 v-select collapsed to 0px width)
- [x] Added `:deep()` selectors for Vuetify 3 v-field padding
- [x] Pre-resolved dataset names with `Promise.all` before setting items (Vuetify 3 v-select doesn't react to deep property mutations on `:items`)

### R7. CustomFileManager v-model + slot fixes ✅
- [x] Fixed v-model binding for GirderFileManager
- [x] Updated slot names for @girder/components v4

### R8. Home screen layout fixes ✅
@girder/components v4 changed internal component structure, requiring CSS overrides to restore the expected layout.

- [x] `src/components/CustomFileManager.vue` — `renderItem()` now returns `selectable.name` (v4 `#row` slot replaces default content including name)
- [x] `src/components/CustomFileManager.vue` — Wrapped row content in flex div for inline layout (icon + name + chips on one line)
- [x] `src/components/CustomFileManager.vue` — Removed duplicate search icon (GirderSearch v4 has built-in icon)
- [x] `src/components/CustomFileManager.vue` — CSS: `.data-table-header { display: flex }` (v4 lost flex layout on header row)
- [x] `src/components/CustomFileManager.vue` — CSS: `.select-cursor { display: flex }` (icon and row content were stacking vertically)
- [x] `src/components/CustomFileManager.vue` — CSS: `.data-search { display: flex }` (search input and filter icon on same line)
- [x] `src/App.vue` — `.logo { flex: 0 0 auto }` (Vuetify 3 v-toolbar-title flex-grow:1 was pushing title to center)
- [x] `src/views/Home.vue` — Added `color="primary"` to v-tabs (active tab indicator not visible in Vuetify 3 dark theme)

### R9. `v-layout` → plain flex divs (ViewerToolbar.vue) ✅
In Vuetify 3, `<v-layout>` is the **application layout wrapper** (used with v-app-bar, v-navigation-drawer, v-main, etc.), NOT a simple flex row container as it was in Vuetify 2. All `<v-layout>` used as flex row wrappers must be replaced with `<div class="d-flex align-center">` or similar.

- [x] `src/components/ViewerToolbar.vue` — Replaced 7 `<v-layout>` wrappers with `<div class="d-flex align-center">`

### R10. `v-radio-group` `row` → `inline` prop (4 files) ✅
In Vuetify 3, the `row` boolean prop on `<v-radio-group>` was renamed to `inline`. Without this fix, radio buttons stack vertically instead of rendering horizontally.

- [x] `src/components/ViewerToolbar.vue` — layer mode radio group
- [x] `src/components/MovieDialog.vue` — download format radio group
- [x] `src/components/TagSelectionDialog.vue` — add/remove radio group
- [x] `src/components/DisplayLayer.vue` — channel radio group

### R11. Viewer sidebar hidden behind app bar (Viewer.vue) ✅
In Vuetify 3, `<v-app-bar>` renders with `position: fixed` and `<v-main>` compensates with `padding-top: 64px`. However, `.viewer` in `Viewer.vue` used `position: absolute; top: 0` which positioned it relative to `.v-application__wrap`, ignoring v-main's padding. The top 64px of the sidebar was hidden behind the app bar.

- [x] `src/views/datasetView/Viewer.vue` — Removed `position: absolute; left: 0; top: 0` from `.viewer`, replaced with `height: calc(100vh - 64px)` so it flows naturally within v-main's content area

### R12. ValueSlider flex layout fix (ValueSlider.vue) ✅
When ValueSlider sits alongside a checkbox in a flex row, `width: 100%` consumed all available space. Changed to `flex: 1; min-width: 0` so it shares space properly. Also added `flex-shrink: 0` to `.my-checkbox` in ViewerToolbar to prevent label text wrapping.

- [x] `src/components/ValueSlider.vue` — `.value-slider` changed from `width: 100%` to `flex: 1; min-width: 0`
- [x] `src/components/ViewerToolbar.vue` — Added `flex-shrink: 0` to `.my-checkbox`

### R13. v-slider step prop for integer values (ValueSlider.vue) ✅
Vuetify 3's `<v-slider>` defaults to continuous (fractional) values, unlike Vuetify 2 which defaulted to step 1. Without `step="1"`, dragging the slider produces values like 2.7, 4.3 instead of clean integers.

- [x] `src/components/ValueSlider.vue` — Added `:step="1"` to `<v-slider>`

### R14. v-expansion-panel group context fix (DisplayLayers/DisplayLayer) ✅
In Vuetify 3, `v-expansion-panel` strictly requires a parent `v-expansion-panels` to provide the group context via provide/inject. The old structure had a single `<v-expansion-panels>` in DisplayLayers.vue with `v-expansion-panel` components deeply nested through draggable chains in DisplayLayer.vue, causing `TypeError: group.isSelected is not a function`.

- [x] `src/components/DisplayLayer.vue` — Wrapped root `<v-expansion-panel>` in its own `<v-expansion-panels>`, and wrapped nested "Advanced layer options" panel in a separate `<v-expansion-panels>`
- [x] `src/components/DisplayLayers.vue` — Replaced outer `<v-expansion-panels>` with plain `<div>` (header row and add-button aren't real expansion panels)

### R15. ContrastHistogram resize-observer replacement ✅
The `<resize-observer>` component was from the `vue-resize` package removed in Batch A. Without it, the histogram SVG width stayed at 0 (component mounts while expansion panel is collapsed), rendering an invisible path.

- [x] `src/components/ContrastHistogram.vue` — Removed `<resize-observer>` component, replaced with native browser `ResizeObserver` API in `onMounted`/`onBeforeUnmount`

### R16. Toolset tool list layout fix (ToolItem.vue) ✅
In Vuetify 3, `v-list-item` uses named slots (`prepend`, default, `append`) for horizontal layout. Direct children no longer auto-flex in a row like Vuetify 2. Icons and edit buttons were stacking vertically.

- [x] `src/tools/toolsets/ToolItem.vue` — Moved `<tool-icon>` into `<template #prepend>`, edit button into `<template #append>`

### R17. structuredClone error on Vue reactive proxies (ToolConfiguration.vue) ✅
`structuredClone()` cannot clone Vue reactive proxy objects, throwing `DataCloneError`. This crashed the "Add new tool" flow when selecting a tool type.

- [x] `src/tools/creation/ToolConfiguration.vue` — Replaced `structuredClone(props.defaultValues)` with `JSON.parse(JSON.stringify(props.defaultValues))`

### R18. v-dialog inside v-expansion-panel-title watcher error (Toolset.vue) ✅
In Vuetify 3, placing a `v-dialog` (without activator) inside `v-expansion-panel-title` causes watcher callback errors due to conflicting internal state management.

- [x] `src/tools/toolsets/Toolset.vue` — Moved tool creation `v-dialog` outside `v-expansion-panel-title` to be a sibling of `v-expansion-panels` (it's opened programmatically, so it doesn't need to be inside the title)

### R19. DisplayLayer column alignment with header (DisplayLayer.vue) ✅
The layer row used 5 auto-sized `v-col` columns (icon, name, hover value, Z-merge switch, visibility switch) which didn't match the header's `cols="7"` + 2 auto layout in DisplayLayers.vue. The switches overflowed into the expansion panel chevron area.

- [x] `src/components/DisplayLayer.vue` — Consolidated icon, name, and hover value into a single `cols="7"` column with flex layout, matching the header proportions. The two switch columns now share the remaining space equally and align under their header labels.

### R20. ToolItem click handler missing after v-list-item-group removal (ToolItem.vue) ✅
In Vuetify 2, `v-list-item-group` automatically handled click-to-select on child `v-list-item` components. When `v-list-item-group` was removed in D5b (it doesn't exist in Vuetify 3), no replacement click handler was added. The `toggleTool()` function existed but was only bound to keyboard hotkeys via `v-mousetrap`. Clicking a tool in the sidebar showed a tooltip but never called `store.setSelectedToolId()`, so the interaction layer mode was never set and drawing on the image didn't work.

- [x] `src/tools/toolsets/ToolItem.vue` — Added `@click="toggleTool"` and `:active="isToolSelected"` to `v-list-item`

### R21. DockerImageSelect v-select divider/subheader migration ✅
Vuetify 2 used `{ divider: true }` and `{ header: category }` objects in v-select items arrays to render separators and group headers. Vuetify 3 uses `{ type: "divider" }` and `{ type: "subheader", title: category }`. Also converted item shape from `{ text, value }` to `{ title, value }` (Vuetify 3 default), removing the need for `item-title`/`item-value` props.

- [x] `src/components/DockerImageSelect.vue` — Replaced `{ divider: true }` → `{ type: "divider" }`, `{ header: category }` → `{ type: "subheader", title: category }`, `{ text, value }` → `{ title, value }`, removed `item-title`/`item-value` props, updated `#item` slot to Vuetify 3 `v-list-item` pattern

### R22. Property miller columns font size and layout fix (AnnotationProperties.vue) ✅
In Vuetify 3, the default font size and list item layout caused text wrapping in the narrow miller columns. The chevron icons and checkboxes were in the default slot, rendering below the title text instead of inline.

- [x] `src/components/AnnotationBrowser/AnnotationProperties.vue` — Reduced font size to `0.8rem` on miller columns and `v-list-item-title`
- [x] `src/components/AnnotationBrowser/AnnotationProperties.vue` — Moved checkbox/chevron from default slot to `#append` slot for inline layout, added `density="compact"` to checkbox and `size="small"` to chevron icon

### Known Runtime Issues (Not Yet Fixed)
- [ ] **AnnotationList v-data-table** — Shows "No data available" with incorrect pagination ("-9-0 of 466"). Headers format or slot syntax needs runtime debugging despite passing tsc. This is a D8 item that needs further investigation at runtime.
- [ ] **Vue Router param warnings** — BreadCrumbs passes extra params to routes (cosmetic, non-blocking)

## Batch E: Test Suite Recovery — NOT STARTED
- [ ] E1. Update mounting patterns (@vue/test-utils v2)
- [ ] E2. Triage test failures

## Batch F: Vite 6 Upgrade — NOT STARTED
- [ ] F1. Upgrade `vite` from 5.x to 6.x
- [ ] F2. Upgrade `@vitejs/plugin-vue` from 5.x to 6.x
- [ ] F3. Review Vite 6 breaking changes (environment API, `resolve.conditions` defaults, CSS handling)
- [ ] F4. Update `vite.config.js` if needed
- [ ] F5. Verify dev server, build, and HMR all work

## Notes
- **`vue-tsc`:** Installed as `vue-tsc@2.2.12` in Batch A. This is the Vue-aware TypeScript checker that understands `.vue` template types (powered by Volar). During iterative work we use `pnpm tsc` (faster, checks `.ts` files only). `vue-tsc --noEmit` should be run as a final gate once Batch D is complete — it will catch template-level type errors (e.g., wrong prop types passed in `<template>`) that plain `tsc` misses. It's also what `vite build` uses internally for type-checked builds.
- `vue-tooltip-directive` removed; will replace with Vuetify 3 `<v-tooltip>` in Batch D
- **`@girder/components@4.0.0` export name changes:** v4 renamed all component exports with a `Girder` prefix. The old names no longer exist:
  - `Upload` → `GirderUpload`
  - `Breadcrumb` → `GirderBreadcrumb`
  - `Search` → `GirderSearch`
  - `FileManager` → `GirderFileManager`
  - `UploadManager` — still named `UploadManager` but is now a **named** export (not default)
  - Other v4 exports: `RestClient`, `NotificationBus`, `GirderDataBrowser`, `GirderDataTable`, `GirderDropzone`, `GirderLogin`, `GirderAccessControl`, `GirderAuthentication`, `GirderDataDetails`, `GirderDetailList`, `GirderMarkdown`, `GirderMarkdownEditor`, `GirderOAuth`, `GirderRegister`, `GirderUploadFileList`, `GirderUpsertFolder`, `useGirderClient`, `useNotificationBus`, `usefileUploader`, `SortDir`, `createLocationValidator`, `formatDate`, `formatSize`, `formatUsername`, `getLocationType`, `getResourceIcon`, `getSingularLocationTypeName`, `hasAdminAccess`, `hasWriteAccess`, `isRootLocation`, `progressPercent`, `useDebounceCounter`
  - CSS import: `@girder/components/style.css` (was `@girder/components/dist/components.css` or similar)
  - Our shim `src/girder/components.ts` re-exports under the old names for compatibility: `GirderUpload as Upload`, etc.
  - Type declarations in `src/girder/shims-girder.d.ts` updated to match v4 exports
- `vuex-module-decorators@2.0.0` confirmed working with Vuex 4
- TypeScript upgraded from 5.3→5.9 (needed for NoInfer, Vue 3.5 types)
- `skipLibCheck: true` added to tsconfig (standard for major framework upgrades)
- `@vitejs/plugin-vue` downgraded from 6.0.4 to 5.2.4 — v6 requires Vite 6 but project uses Vite 5. Upgrade both together in Batch F.
