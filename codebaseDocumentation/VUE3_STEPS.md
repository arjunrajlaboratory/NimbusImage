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
- [ ] `pnpm run dev` — needs visual walkthrough
- [ ] `pnpm build` — needs test

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
