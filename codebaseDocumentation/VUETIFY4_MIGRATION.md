# Vuetify 4 Migration

## Overview

Migrated from Vuetify 3.12 to Vuetify 4.0.5. Vuetify 4 introduces CSS Cascade Layers, full MD3 adoption, and several API changes.

## Changes Made

### Package Updates
- `vuetify`: `^3.12.0` → `^4.0.0` (resolved to 4.0.5)
- `vite-plugin-vuetify`: kept at `^2.1.3` (compatible via `vuetify: ">=3"` peer dep)

### SCSS / Vite Config
- Removed `silenceDeprecations: ["legacy-js-api"]` from `vite.config.js` — Vuetify 4 uses the modern Sass API, so the workaround is no longer needed.

### Select/Combobox Slot Item Structure
Vuetify 4 removed the `.raw` wrapper from select slot items. Items are now passed directly.

**Before (Vuetify 3):**
```html
<template v-slot:item="{ item }">
  {{ item.raw.displayName }}
</template>
```

**After (Vuetify 4):**
```html
<template v-slot:item="{ item }">
  {{ item.displayName }}
</template>
```

Files changed:
- `src/components/LargeImageDropdown.vue`
- `src/components/DockerImageSelect.vue`
- `src/components/TagPicker.vue`
- `src/components/ViewerSettings.vue`

**Note:** The `#item` slot name itself did NOT change (contrary to some online sources claiming it was renamed to `#internalItem`).

### VRow `dense` Prop Deprecated
Vuetify 4 deprecates the boolean `dense` prop on `v-row`. Replaced with `density="comfortable"` across 10 occurrences in 6 files.

### `!important` Cleanup
With CSS Cascade Layers, custom styles (outside layers) automatically win over Vuetify's layered styles. Removed 61 `!important` declarations that were only needed to beat Vuetify specificity.

Kept ~35 `!important` declarations that override:
- `@girder/components` styles (not in Vuetify's CSS layers)
- z-index stacking contexts
- GeoJS widget styles

### Vuetify Defaults (density)
Added `density: "comfortable"` defaults for `VList`, `VListItem`, `VCheckbox`, and `VCheckboxBtn` in `src/plugins/vuetify.ts`. Vuetify 4's default density is tighter than Vuetify 3's, and `@girder/components` expects the V3 spacing.

### CustomFileManager CSS Fixes
`@girder/components` v4.0.0 bundles Vuetify 3 CSS (~6.9MB, un-layered) which competes with our Vuetify 4 layered CSS. The file manager required targeted CSS overrides:

- `table-layout: fixed; width: 100%` on the table to prevent horizontal overflow
- Explicit column widths: checkbox (40px), size (90px), content (remaining space)
- `white-space: nowrap` on the file size column
- `display: flex !important` on `.select-cursor` rows for inline icon/text layout

## Known Compatibility Issues

### @girder/components
- `@girder/components@4.0.0` depends on `vuetify: ^3.10.1` — no Vuetify 4-compatible version exists yet
- Girder components run against Vuetify 4 at runtime despite being built for Vuetify 3
- The bundled Vuetify 3 CSS (un-layered) competes with Vuetify 4's layered CSS
- Custom CSS overrides in `CustomFileManager.vue` compensate for this; they can be simplified once `@girder/components` releases a Vuetify 4-compatible version

### Theme API
`$vuetify.theme.current.dark` continues to work in Vuetify 4. Used in:
- `src/components/SwitchToggle.vue`
- `src/components/ContrastHistogram.vue`
- `src/components/AnnotationBrowser/AnnotationProperties.vue`

### Breakpoints
Vuetify 4 changed breakpoint values (`md`: 960→840px, `xl`: 1920→1545px). No `useDisplay()` usage was found in the codebase, so this had no impact.

### Elevation
Vuetify 4 reduced elevation levels from 0-24 to 0-5. All usages in the codebase were ≤3, so no changes were needed.

## What Was NOT Changed
- `v-data-table` `#item` slot — this is a VDataTable slot, not VSelect, and was not affected
- `v-breadcrumbs` `#item` slot — not affected
- `dense` prop on custom components (`tag-picker`, `docker-image-select`, etc.) — these are app-level props, not Vuetify deprecations
- `@girder/components` version — staying at 4.0.0 until a Vuetify 4-compatible release
