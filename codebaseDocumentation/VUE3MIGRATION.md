# Vue 3 Migration Plan

## Overview

This document tracks the incremental migration of NimbusImage from Vue 2 (Class Components + Vuex with decorators) to Vue 3 (Composition API + Vuetify 3). The strategy is to adopt Vue 3-compatible patterns within Vue 2.7 first, then switch frameworks with minimal breakage.

## Current State (as of initial planning)

| Category | Count | Notes |
|----------|-------|-------|
| Class components (`@Component`) | 108 | 16 already migrated to `<script setup>` |
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

- **Remove `Vue.set()` / `Vue.delete()`** (91 occurrences): Replace with direct property assignment or object spread. In Vue 3's Proxy-based reactivity, these are unnecessary.
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
4. Fix remaining incompatibilities
5. Full regression testing

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

## Next Candidates

Good candidates for the next migration batch, ordered by complexity:

**Small UI components:**
- `FileDropzone.vue` (~61 lines)
- `HelpPanel.vue` (~105 lines)
- `RecentProjects.vue` (~125 lines)

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

## Risk Areas

- **AnnotationViewer.vue** (3,160 lines): Most complex component. Break into composables before full migration.
- **Store interdependencies**: 11 Vuex modules with cross-references. Map dependencies before Pinia migration.
- **`$vnode.data` access**: Used in ColorPickerMenu for class/style passthrough. Vue 2-only API.
- **Template ref typing**: Mixed Class + Composition components cause type mismatches during incremental migration.
- **Vuetify v-data-table**: Significant API differences in v3. Abstract usage early.
