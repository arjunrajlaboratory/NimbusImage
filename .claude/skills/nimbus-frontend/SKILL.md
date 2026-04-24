---
name: nimbus-frontend
description: "Use when writing or modifying Vue 3 components, Vuex store modules, TypeScript interfaces, or Vuetify 4 UI in the src/ directory. Covers: <script setup> composition API, vuex-module-decorators (@Module, @Action, @Mutation), Vuetify 4 theming (CSS Cascade Layers, light/dark mode), select slot patterns (no .raw wrapper), dialog patterns, API client usage (GirderAPI.ts, AnnotationsAPI.ts), logging utilities (logWarning/logError instead of console.*), button loading states, @girder/components compatibility, and style guidelines."
---

# Nimbus Frontend Development

## Component Patterns

### Script Setup (Composition API)

All 121 components use `<script setup lang="ts">`:

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";

const props = defineProps<{
  value: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const localState = ref("");

const computedValue = computed(() => props.value.toUpperCase());

watch(() => props.value, (newVal) => {
  localState.value = newVal;
});

onMounted(() => {
  // lifecycle hook
});
</script>
```

### Store Access

```typescript
import store from "@/store";
import annotationStore from "@/store/annotation";

// Direct usage in <script setup> — no `this` needed
store.someAction();
annotationStore.filteredAnnotations;
```

Store modules still use `vuex-module-decorators` with `@Module`, `@Mutation`, and `@Action` decorators.

For advanced store patterns (routeMapper, form change detection, caching with batch loading): read `references/store-module-patterns.md`

## Vuetify 4 Patterns

### CSS Cascade Layers

Vuetify 4 wraps all styles in CSS `@layer` declarations. Custom styles (outside layers) automatically win over Vuetify's defaults — no specificity wars.

**Key implications:**
- Most `!important` overrides for Vuetify are unnecessary — remove them
- `:deep()` selectors targeting Vuetify internals "just work" without specificity tricks
- **Exception:** `@girder/components` bundles Vuetify 3 CSS (un-layered), so `!important` IS still needed when overriding Girder component styles

### Light/Dark Mode Theming

```typescript
// In <script setup>
import { useTheme } from "vuetify";
const theme = useTheme();
const isDark = computed(() => theme.current.value.dark);
```

```vue
<!-- In templates -->
<div :class="{
  'v-theme--light': !$vuetify.theme.current.dark,
  'v-theme--dark': $vuetify.theme.current.dark
}">
```

Theme config in `src/plugins/vuetify.ts`:
```typescript
defaultTheme: Persister.get("theme", "dark") === "dark" ? "dark" : "light",
```

Vuetify 4 changed the default theme from `"light"` to `"system"`. Our config sets it explicitly.

### Theme-Aware Styling

**Option 1: Vuetify Components** (preferred) — auto-inherit theme.

**Option 2: Theme classes in SCSS**
```scss
.v-theme--dark & {
  background: rgba(255, 255, 255, 0.05);
}
.v-theme--light & {
  background: rgba(0, 0, 0, 0.05);
}
```

**Option 3: CSS Variables**
```scss
.my-element {
  color: rgb(var(--v-theme-primary));
  background: rgb(var(--v-theme-surface));
}
```

### Select/Combobox Slot Items (No `.raw` Wrapper)

Vuetify 4 removed the `.raw` wrapper from select slot items. Items are passed directly. This applies to ALL slot types: `#item`, `#chip`, and `#selection`.

**Object items** — access properties directly:
```vue
<!-- Vuetify 4: access properties directly on object items -->
<v-select :items="items" item-title="displayName">
  <template v-slot:item="{ item, props: itemProps }">
    <v-list-item v-bind="itemProps">
      <template #title>{{ item.displayName }}</template>
      <template #subtitle>{{ item.description }}</template>
    </v-list-item>
  </template>
</v-select>
```

**String items** — `item` IS the string, not a wrapped object. Do NOT use `item.title`:
```vue
<!-- BAD: item.title is undefined on a string — renders empty chips -->
<v-combobox :items="tagList" chips multiple>
  <template v-slot:chip="{ item, props: chipProps }">
    <v-chip v-bind="chipProps">{{ item.title }}</v-chip>  <!-- WRONG -->
  </template>
</v-combobox>

<!-- GOOD: use item directly for string items -->
<v-combobox :items="tagList" chips multiple>
  <template v-slot:chip="{ item, props: chipProps }">
    <v-chip v-bind="chipProps">{{ item }}</v-chip>  <!-- CORRECT -->
  </template>
</v-combobox>
```

**The `#item` slot name did NOT change** (contrary to some sources claiming rename to `#internalItem`).

### VRow Density

`dense` prop is deprecated. Use `density="comfortable"`:
```vue
<v-row density="comfortable" align="center">
```

### v-menu / v-dialog Initial State

Vuetify 4's `v-menu` respects the initial `v-model` value immediately on mount. Vuetify 3 deferred it. If you set `v-model` to `true` before mount, the menu WILL open. Guard with conditions:
```typescript
// Only auto-open when appropriate
menuOpen.value = route.name === "root" && !store.isLoggedIn;
```

### Global Defaults

Configured in `src/plugins/vuetify.ts`. Vuetify 4's default density is tighter than V3. We set `density: "comfortable"` for list/checkbox components to maintain V3 spacing (needed for `@girder/components` compatibility):
```typescript
defaults: {
  VList: { density: "comfortable" },
  VListItem: { density: "comfortable" },
  VCheckbox: { color: "primary", density: "comfortable" },
  VCheckboxBtn: { density: "comfortable" },
}
```

## @girder/components Compatibility

`@girder/components@4.0.0` depends on `vuetify: ^3.10.1` — no Vuetify 4-compatible version exists yet. Key issues:

- Girder bundles ~6.9MB of Vuetify 3 CSS (un-layered), which competes with Vuetify 4 layered CSS
- `!important` is still needed when overriding Girder component styles
- `CustomFileManager.vue` has targeted CSS overrides for the file manager table layout
- See `codebaseDocumentation/VUETIFY4_MIGRATION.md` for full details

### GirderFileManager Prop Names

GirderFileManager (from `@girder/components`) uses **Vuetify 3 prop naming**, not Vuetify 4. Key props:

- `itemsPerPage` (kebab: `items-per-page`) — sets default page size. **NOT** `initialItemsPerPage`.
- `itemsPerPageOptions` (kebab: `items-per-page-options`) — array of page size choices.

These props are defined in `node_modules/@girder/components/src/components/FileManager.vue`. If you use a wrong prop name, it silently falls through as an unrecognized attribute and the component uses its internal default (10).

### Overriding Girder DataTable Row Styles

Girder's `DataTable.vue` renders a `v-data-table-server` with `<tr>` > `<td>` rows. The DOM structure is:

```html
<tr class="v-data-table__tr">
  <td class="...">checkbox</td>
  <td>icon + #row slot content</td>
  <td class="text-right">file size</td>
</tr>
```

To override row styles from a parent component:
- Use **unscoped** `<style>` blocks (scoped styles can't reach into Girder internals)
- Target `table tr` and `table tr td` — these cover both raw elements and Vuetify class selectors (`.v-data-table__tr`, `.v-data-table__td`) since they're the same DOM nodes. No need to duplicate selectors for both.
- `!important` is required because Girder's bundled Vuetify 3 CSS is un-layered
- Scope overrides with a parent wrapper class (e.g., `.browse-expanded .custom-file-manager-wrapper`) to avoid leaking globally

### Persisting User Preferences with Persister

For UI preferences that should survive page reloads (expand/collapse states, view modes, etc.), use `Persister` from `@/store/Persister`:

```typescript
import Persister from "@/store/Persister";

// Read with default
const expanded = ref(Persister.get("myPreferenceKey", false));

// Write on change
function toggle() {
  expanded.value = !expanded.value;
  Persister.set("myPreferenceKey", expanded.value);
}
```

Persister wraps `localStorage` with JSON serialization. It's already used for theme, tour status, and browse mode preferences.

## Dialogs

```vue
<v-dialog v-model="dialogOpen" max-width="600px">
  <v-card>
    <v-card-title>Title</v-card-title>
    <v-card-text>Content</v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn @click="dialogOpen = false">Close</v-btn>
    </v-card-actions>
  </v-card>
</v-dialog>
```

## API Calls

Use the API classes from store — never put `girderRest.get(...)` in components:

```typescript
import store from "@/store";
const result = await store.api.someMethod();
```

## Logging

**Never use `console.log`, `console.warn`, or `console.error`** — eslint will reject them.

```typescript
import { logWarning, logError } from "@/utils/log";

logWarning("Something unexpected happened");
logError("An error occurred", error);
```

## Button Loading States

```vue
<v-btn :loading="isLoading" :disabled="isLoading" @click="doAction">
  <template v-slot:loader>
    <v-progress-circular indeterminate size="18" width="2" class="mr-2" />
    Loading...
  </template>
  <v-icon>mdi-check</v-icon>
  Submit
</v-btn>
```

## Style Guidelines

- Use scoped SCSS: `<style lang="scss" scoped>`
- Prefer Vuetify components over custom HTML
- `!important` is rarely needed thanks to CSS Cascade Layers — only use for overriding `@girder/components` or non-Vuetify third-party styles
- Keep custom colors as SCSS variables at the top of style blocks

## Codebase Documentation References

- Vuetify 4 migration details: read `codebaseDocumentation/VUETIFY4_MIGRATION.md`
- When working on batch processing: read `references/batch-processing-patterns.md`
- When working on projects feature: read `codebaseDocumentation/PROJECTS.md`
- When working on sharing UI: read `codebaseDocumentation/SHARING.md`
- When working on annotation combining: read `codebaseDocumentation/COMBINE_ANNOTATIONS.md`
