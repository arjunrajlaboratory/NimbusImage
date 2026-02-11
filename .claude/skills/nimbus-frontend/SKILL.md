---
name: nimbus-frontend
description: "Use when writing or modifying Vue 2 components, Vuex store modules, TypeScript interfaces, or Vuetify UI in the src/ directory. Covers: vue-property-decorator class components, vuex-module-decorators (@Module, @Action, @Mutation), Vuetify 2 theming (light/dark mode), dialog patterns, API client usage (GirderAPI.ts, AnnotationsAPI.ts), logging utilities (logWarning/logError instead of console.*), button loading states, and style guidelines."
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
  - TodoWrite
user-invocable: true
---

# Nimbus Frontend Development

## Component Patterns

### Class-Style Components

```typescript
import { Vue, Component, Prop, Watch } from "vue-property-decorator";

@Component
export default class MyComponent extends Vue {
  @Prop({ required: true }) readonly value!: string;

  localState = "";

  get computedValue() {
    return this.value.toUpperCase();
  }

  @Watch("value")
  onValueChange(newVal: string) {
    this.localState = newVal;
  }

  mounted() {
    // lifecycle hook
  }
}
```

### Store Access

```typescript
import store from "@/store";
import annotationStore from "@/store/annotation";

// In component
readonly store = store;
readonly annotationStore = annotationStore;

// Use in methods
this.store.someAction();
```

For advanced store patterns (routeMapper, form change detection, caching with batch loading): read `references/store-module-patterns.md`

## Light/Dark Mode Theming

### Checking Theme State

```typescript
get isDarkMode() {
  return this.$vuetify.theme.dark;
}
```

### Theme-Aware Styling

**Option 1: Vuetify Components** (preferred)
Use `v-card`, `v-dialog`, `v-btn` - they automatically inherit the theme.

**Option 2: Theme Classes in SCSS**

```scss
.my-component.theme--dark {
  background: rgba(255, 255, 255, 0.05);
}
.my-component.theme--light {
  background: rgba(0, 0, 0, 0.05);
}
```

**Option 3: Dynamic Class Binding**

```vue
<div :class="{ 'theme--light': !$vuetify.theme.dark, 'theme--dark': $vuetify.theme.dark }">
```

**Option 4: CSS Variables**

```scss
.my-element {
  color: var(--v-primary-base);
  background: var(--v-background-base);
}
```

### Theme Persistence

```typescript
import { Persister } from "@/store/Persister";
const isDark = Persister.get("theme", "dark") === "dark";
this.$vuetify.theme.dark = true;
```

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

Use the API classes from store:

```typescript
import { api } from "@/store/GirderAPI";
const result = await api.someMethod();
```

## Logging

**Never use `console.log`, `console.warn`, or `console.error`** - eslint will reject them.

```typescript
import { logWarning, logError } from "@/utils/log";

logWarning("Something unexpected happened");
logError("An error occurred", error);
```

## Vuetify Patterns

### Button Loading States

When using `:loading` on `v-btn`, the default slot content is replaced with just a spinner. To show custom loading content, use the `loader` slot:

```vue
<v-btn
  :loading="isLoading"
  :disabled="isLoading"
  :min-width="isLoading ? 260 : undefined"
  @click="doAction"
>
  <template v-slot:loader>
    <v-progress-circular
      indeterminate
      size="18"
      width="2"
      class="mr-2"
    ></v-progress-circular>
    Loading...
  </template>
  <v-icon>mdi-check</v-icon>
  Submit
</v-btn>
```

Use `:min-width` to ensure the button expands to fit longer loading text.

## Style Guidelines

- Use scoped SCSS: `<style lang="scss" scoped>`
- Prefer Vuetify components over custom HTML
- Use `!important` sparingly - only when overriding Vuetify internals
- Keep custom colors as SCSS variables at the top of style blocks

## Codebase Documentation References

- When working on batch processing: read `references/batch-processing-patterns.md`
- When working on projects feature: read `codebaseDocumentation/PROJECTS.md`
- When working on sharing UI: read `codebaseDocumentation/SHARING.md`
- When working on annotation combining: read `codebaseDocumentation/COMBINE_ANNOTATIONS.md`
