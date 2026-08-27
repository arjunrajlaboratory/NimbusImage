---
name: nimbus-frontend
description: "Use when writing or modifying Vue 3 components, Vuex store modules, TypeScript interfaces, or Vuetify 4 UI in the src/ directory. Covers: <script setup> composition API, vuex-module-decorators (@Module, @Action, @Mutation), Vuetify 4 theming (CSS Cascade Layers, light/dark mode), select slot patterns (no .raw wrapper), dialog patterns, API client usage (GirderAPI.ts, AnnotationsAPI.ts), logging utilities (logWarning/logError instead of console.*), button conventions (5-role taxonomy — primary/secondary/tertiary/destructive/icon-only — with required variant and size), button loading states, @girder/components compatibility, and style guidelines."
---

# Nimbus Frontend Development

## Test mocks must model the real store's REPLACEMENT semantics

A mock that mutates state in place where the real store replaces it makes
tests silently vacuous. `AnalysisPanel.test.ts`'s `setPlots` did
`plots.length = 0; plots.push(...)` while the real `applyAnalysisPlots`
builds a new array. Vue short-circuits a computed whose value is unchanged
by identity, so `analysisPlots` never invalidated and **every watcher
downstream of it silently never re-ran** — a new test for plot-removal
behavior passed against code that did nothing.

It hid because an existing test appeared to cover removal: its watcher
happened to read `analysisPopulation`, which returns a fresh array each
evaluation, so that one re-fired for an unrelated reason.

Rules:
- Mock setters replace (`mocks.plots = [...next]`), matching the store.
- Booleans and other scalars are the same trap in reverse: an intermediate
  computed returning an unchanged `true` stops propagation, so a test that
  changes only downstream data may never re-run the watcher.
- Before trusting a new watcher test, make it FAIL once (revert the fix, or
  assert the opposite) — this one passed for the wrong reason first.

Two related mock traps, both of which make a test assert against something
the component never touched:

- **A `vi.mock` factory captures the spy it closes over.** Reassigning
  `mocks.someAction = vi.fn()` in `beforeEach` leaves the component calling
  the *original* spy while the test asserts on the new one — "expected spy
  to be called, number of calls: 0" with obviously working code. Use
  `mocks.someAction.mockClear()` instead.
- **A plain-object store mock is not reactive**, so a component watching
  `() => store.something` never fires when a test assigns to it. If the
  behavior under test is a watcher on store state, wrap the mock's default
  export in `reactive()` (`vi.mock("@/store", async () => { const { reactive }
  = await import("vue"); return { default: reactive({ … }) }; })`).

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

### Driving the AI panel (agent) from the console

To test the Nimbus AI panel (`src/store/aiPanel.ts`, `AiPanel.vue`) end-to-end without clicking, dispatch its actions on the live store. Two traps:

- **The actions register UNNAMESPACED.** `vuex-module-decorators` puts them in the global action map as `sendUserMessage`, `handleAuthenticatedUserChange`, etc. — NOT `aiPanel/sendUserMessage`. A namespaced dispatch is silently dropped (Vuex warns, resolves a no-op promise, nothing runs). Confirm with `store._actions['sendUserMessage']`.
- `sendUserMessage` runs the whole agent loop and only resolves when the turn ends — **don't await it** if you want to poll progress; fire it and read `store.state.aiPanel.items` / `.running` on a timer.

```js
const store = document.querySelector('#app').__vue_app__.config.globalProperties.$store;
store.commit('setAutoApprove', true);              // skip gated-action approval clicks
await store.dispatch('clearConversationAndStorage'); // full reset (memory + IndexedDB)
store.dispatch('sendUserMessage', 'Find the nuclei in this image.'); // fire, don't await
```

**Send exactly once, from a clean/hydrated state.** Two `sendUserMessage`s in quick succession start two overlapping runs that both push to the module-level `wireMessages`, nesting the tool-result blocks (`content: [[tool_result,…]]`). The next request then fails with Anthropic `400 … messages.N.content.0: Input should be an object`. This is not a create/run bug — it's conversation corruption from concurrent turns. (The UI's `send()` and the `sendUserMessage` guard both check `running`, but a stale in-flight run or leftover persisted conversation can still bite; a hard reload + `clearConversationAndStorage` gives a truly clean slate.) Related: `hydrating` (module var) blocks sends until a reloaded conversation finishes restoring — a dispatch right after reload can no-op; wait a beat. `clearConversation()` (no `force`) no-ops while `running`; use `clearConversationAndStorage`.

Agent tool executors live in `src/agent/executors.ts` (`executeAgentTool(name, input, ctx)`), importable in the Vite dev page for isolated testing: `await import('/src/agent/executors.ts?t=' + Date.now())` (the query-bust avoids a stale module cache). Worker tools save parameters under `tool.values.workerInterfaceValues`; `channelCheckboxes` values are `{channelIndex: true}` maps (a `true` value selects — key-presence alone does not).

### Never assign a big per-annotation map to state without `markRaw`

`annotationStubs`, `hydratedAnnotations`, and `annotationCentroids` hold one
entry per annotation — up to ~700K. Every existing assignment wraps them in
`markRaw(...)`; a new mutation that forgets it hands Vue a raw Map to walk and
proxy entry by entry, and that cost dwarfs whatever the mutation was doing. A
whole-dataset recolor measured **16.9s** with the `markRaw` missing against
~5.5s with it — and the mutation itself was only ~0.5s of that.

Nothing static catches this: `tsc` and lint are happy, and any test with a
handful of fixture annotations is far too small to feel it. The tell is a
measured time that doesn't add up from its parts.

```typescript
// BAD: Vue proxies ~700K entries on assignment
this.annotationStubs = newStubs;

// GOOD: matches the nine other assignments to this map
this.annotationStubs = markRaw(newStubs);
```

`src/store/__tests__/rawStateMaps.test.ts` asserts `isReactive(...) === false`
after every mutation that replaces one of these maps — extend it when you add
another, rather than hand-checking. Verify a new row can fail by deleting only
the `markRaw` call (not the whole mutation — stashing the file reverts it
entirely and the test then fails for the wrong reason).

Note the *array* convention differs: `annotations` is a plain reactive array of
`markRaw`ed items (`setAnnotations` does `annotations.map(markRaw)`), so
`markRaw` goes on the items there, not the array.

### Store Edits Break HMR — Hard-Reload

Editing any `src/store/*.ts` while `pnpm run dev` runs corrupts the store: vuex-module-decorators registers getters at import time with no HMR accept handler, so a hot re-import double-registers → `[vuex] duplicate getter key` cascade and broken state (e.g. annotations stuck at 0). **Hard-reload the page after every store-module edit** before trusting any in-browser behavior. Component `.vue` edits HMR fine — prefer putting temporary instrumentation in `.vue` files.

### Actions That Throw Need `@Action({ rawError: true })`

`vuex-module-decorators` wraps **any** error thrown from a bare `@Action` in a generic `Error("ERR_ACTION_ACCESS_UNDEFINED: Are you trying to access this.someMutation()...")`, discarding the original message — unless the action is declared `@Action({ rawError: true })`. This is a library-wide behavior, not specific to one module.

Most actions in this codebase never throw (they log and return `null`/`false` on failure), so this rarely bites. It matters the moment an action is *designed* to throw so a caller can show the real failure reason (e.g. `addMultiSourceMetadata` throwing a storage-quota message for `MultiSourceConfiguration.vue` to display). Forgetting `rawError: true` silently replaces that message with the cryptic wrapper text — `tsc`/lint/tests all stay green because the action still rejects, just with the wrong message.

```typescript
// BAD: caller's catch block sees "ERR_ACTION_ACCESS_UNDEFINED: ..." instead
// of the real message
@Action
async doThing() {
  throw new Error("Helpful, specific reason");
}

// GOOD
@Action({ rawError: true })
async doThing() {
  throw new Error("Helpful, specific reason");
}
```

When writing a test for an action's thrown-error message, `expect(...).rejects.toThrow("substring")` is not a reliable regression check here: the wrapped error's message embeds the original error's `.stack` (which starts with `"Error: <original message>"`), so a substring match can pass even when `rawError` is missing. Assert the exact `.message` instead. See `src/store/index.test.ts` for the pattern (dispatches the real action instead of mocking `@/store`).

Two traps that let this ship a real bug even after the rule above was documented:

- **An action needs the flag if it merely *propagates*, not only if it contains `throw`.** Awaiting an API call or another action re-throws through your own decorator. `createProperty` has no `throw` and still emitted the blob — so a "grep action bodies for `throw`" audit misses exactly these.
- **Errors get re-wrapped at every `@Action` boundary they cross, across modules.** `createProperty → setProperties → updateConfigurationProperties → syncConfiguration` is four boundaries; one bare `@Action` anywhere on the path mangles the message. Audit every `src/store/*.ts`, not just `index.ts`.

See `references/store-module-patterns.md` for the audit commands, how to tell which callers actually display the message, and the vitest setup details (accessor getters are non-configurable — set `store.state.main.*` directly).

### One Logical Change → One Config Write

`syncConfiguration(key)` PUTs the **whole** key. So a caller that changes three fields by calling a single-field action three times issues three writes of the same key, and a rejection part-way through leaves the shared collection **partially updated while reporting failure** — the same false-reporting `rawError` exists to prevent, one level up. Two instances shipped before this was caught (`set_scale` writing `scales` up to 3×, `update_layer` writing `layers` 2× via `changeLayer` + `saveContrastInConfiguration`).

Validate everything first, then write once:

```typescript
// BAD: validates and persists per field. An invalid tStep leaves pixelSize
// already written — a partial update with no backend failure involved.
if (input.pixelSize) await apply("pixelSize", input.pixelSize);
if (input.tStep) await apply("tStep", input.tStep); // throws on a bad unit

// GOOD: validate all → assign all → one sync
const scales = {};
if (input.pixelSize) scales.pixelSize = validate("pixelSize", input.pixelSize);
if (input.tStep) scales.tStep = validate("tStep", input.tStep);
await main.saveScalesInConfiguration({ scales, throwOnError: true });
```

Interleaved *validation* is the easier half to miss: it fails with no backend involvement at all, so it can't be caught by testing backend rejections. When adding a batch action, keep the singular one — the interactive UI edits one field at a time and legitimately wants it (`ScaleSettings.vue`).

Existing in-codebase idioms for writing once:

- `changeLayer({ ..., sync: false })` per item, then a single `syncConfiguration({ key: "layers", throwOnError: true })` — see `set_layer_visibility`.
- A plural action that assigns all entries then syncs once — `saveScalesInConfiguration`, `setViewContrastOverrides`.
- An optional `delta` merged into an existing action's single write — `saveContrastInConfiguration({ layerId, contrast, delta })`.

Writes to genuinely *different* resources can't be merged (the configuration vs the dataset view are separate endpoints); say so at the call site rather than leaving it looking like an oversight.

### Watching Getters That Rebuild Their Return Object

`watch(() => someGetter, cb, { deep: true })` on a getter that returns a **new object on every read** fires on every dependency touch — including dependencies the getter reads but that don't change the output (`deep: true` skips the value comparison entirely). This shipped a real bug: a deep watch on `currentFilters` cleared the selection on every Z-scrub because the getter read `z` unconditionally. tsc/lint/reasoning all passed; only the live app caught it.

```typescript
// BAD: fires on every dependency touch
watch(() => annotationListServer.currentFilters, cb, { deep: true });

// GOOD: fires only when content genuinely changes; stringify's traversal
// still registers the nested reactive deps
watch(() => JSON.stringify(annotationListServer.currentFilters), cb);
```

Watch out for stringify cost on large objects.

**This bug recurs even after being fixed once nearby — grep for it.** A second, separate `watch([...9 getters...], cb, { deep: true })` in the same file (`AnnotationList.vue`'s "server-mode reactive refetch" block, a few lines below the `currentFilters` watch above) had the identical bug, confirmed via live instrumentation firing every 30-80ms with **zero** of the 9 tracked values actually changing. Each spurious firing called `setOptions({ page: 1 })`, silently resetting the server-paginated annotation list's page after every click-to-row navigation — while the *rows* stayed correct (the accompanying debounced refetch never settled long enough to fire), so only the page number/footer/Index column were wrong. This looked exactly like "clicking an annotation goes to the wrong spot in the list," and a plausible-looking `VDataTableServer` `update:options` stale-echo race was chased first as the cause (it even reproduced once) before instrumenting the watcher itself proved it was actually firing with no real change. **When you find and fix one instance of this pattern, `grep -n "deep:\s*true" src` for siblings in the same or related files before considering it fixed — a documented fix comment next to one watcher does not protect a copy-pasted watcher elsewhere.**

Not every `{ deep: true }` is this bug — it only applies when the watched source is a **getter function that rebuilds a fresh object/array on each call** (a Vuex/Pinia getter, a `computed`, or a plain function reading store state). A `ref()`/`reactive()` passed **directly** as the watch source (not wrapped in a function) is the correct, safe use of `deep: true` — Vue tracks its stable identity and only fires on genuine in-place mutations. Don't blanket-remove `deep: true` without checking which case you're in.

### Every `throttle`/`debounce` needs a `cancel()` in `onBeforeUnmount`

A trailing call that fires after teardown runs against a dead view — in
`AnnotationViewer.vue` that means `layer.annotations()` / `layer.draw()` on a
torn-down GeoJS map, or a store write from a component that no longer exists.
The teardown block already cancels them; the failure mode is *forgetting to add
the new one*, which nothing catches because the component unmounts fine and the
trailing call usually lands harmlessly.

Guard it with a test that records the throttles **at construction** — the
version that listed them by name stayed green while two uncancelled ones
shipped, and a version that scanned `wrapper.vm` only moved the hand-maintained
list to `defineExpose` (an unexposed throttle stays invisible there):

```ts
// top of the test file — delegates to real lodash, so timing is unchanged
const createdThrottles = vi.hoisted(() => [] as any[]);
vi.mock("lodash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lodash")>();
  const record = (w: any) => { createdThrottles.push(w); return w; };
  return { ...actual,
    throttle: (...a: any[]) => record((actual.throttle as any)(...a)),
    debounce: (...a: any[]) => record((actual.debounce as any)(...a)) };
});

// in the test
createdThrottles.length = 0;
wrapper = mountComponent();
expect(createdThrottles.length).toBeGreaterThanOrEqual(7);  // recording can break too
const named = createdThrottles.map((fn, i) => [
  Object.keys(vm).find((k) => vm[k] === fn) ?? `unexposed#${i}`,
  vi.spyOn(fn, "cancel"),
] as const);
wrapper.unmount();
expect(named.filter(([, s]) => !s.mock.calls.length).map(([n]) => n)).toEqual([]);
```

`<script setup>` bodies run per instance, so setup-scope throttles are created
during mount and land in the recording. One residual gap: a wrapper built lazily
inside a handler isn't recorded until that handler runs.

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

### `v-select` shows `[object Object]` — set `item-title` to match the item key

Vuetify's `VSelect` defaults to `item-title="title"` and `item-value="value"`. If your items are objects keyed differently, the selected display renders the raw object as **`[object Object]`** (selection still works because `item-value` happens to match).

This bit the tool-creation form: every `select` interface element in `public/config/templates.json` uses `{ text, value }` items, but the generic `VSelect` in `ToolConfigurationItem.vue` set no `item-title`, so **every non-submenu select in the Add-tool dialog** rendered `[object Object]`. Fix: pass `item-title="text"` (the app's convention) for select elements.

```vue
<!-- BAD: items are { text, value } but VSelect looks for `.title` -->
<v-select :items="[{ text: 'Point prompts', value: 'point' }]" />  <!-- [object Object] -->

<!-- GOOD -->
<v-select :items="items" item-title="text" item-value="value" />
```

When you add a non-submenu `select` to a tool template, or render options in a `v-select`, always confirm `item-title` matches the item objects' label key.

### Don't `v-model` a computed that reads a non-reactive pipeline node

`ComputeNode.output` / `ManualInputNode.output` (in `src/pipelines/computePipeline.ts`) is a **plain field, not a Vue ref** (pipeline nodes are `markRaw`'d for perf). A `computed` whose getter reads `node.output` registers **no reactive dependency**, so it never re-evaluates when the node's value changes. Bind a control's `v-model` to such a computed and the control **snaps back to its stale value** on the next render — e.g. a dropdown that "looks selected" but always displays the old option, or a slider that jumps back.

```ts
// BAD: getter reads node.output (non-reactive) → v-model display reverts
const promptMode = computed({
  get: () => promptModeNode.value?.output ?? "point",
  set: (v) => promptModeNode.value?.setValue(v),
});

// GOOD: a reactive ref is the UI source of truth; push into the node on change,
// and seed the ref from config/state on mount + when the tool state changes.
const promptMode = ref<TPromptMode>("point");
watch(promptMode, (v) => segState.value?.nodes.input.promptMode.setValue(v));
```

Reactive **state** fields (from `reactive(...)` in the tool-state factory) are fine to read in computeds — only raw `markRaw`'d node `.output` reads are the trap.

### VRow Density — and `dense` everywhere else

On `<v-row>`, the boolean `dense` prop is deprecated. Use `density="comfortable"`:
```vue
<v-row density="comfortable" align="center">
```

The substitution is **visually identical** — VRow maps
`density === 'comfortable' || dense` to the same `v-row--density-comfortable`
class, so `dense` still works and the only symptom is
`[Vuetify UPGRADE] 'dense' is deprecated` in the console. Don't trust
Vuetify's own JSDoc here: `makeVRowProps` says `@deprecated use
density="compact"` while the runtime warning and the class mapping both say
`comfortable`. `comfortable` is the behaviour-preserving one.

**The warning is one-shot per mounted row, not per render.** `deprecate()` is
called from `VRow.setup()`, so re-rendering or updating an existing row never
repeats it — which is exactly why you cannot "re-trigger" it by toggling the UI
that contains it, and why it is usually already gone by the time you attach a
console listener. See the `in-browser-testing` skill for the capture order this
forces.

**`VRow` is the only component that warns.** `deprecate('dense', …)` is called
in exactly one place in Vuetify 4 (`VRow.setup()`). So a `dense` on anything
else is *silent* — and dead: `VCard`, `VListSubheader`, and our own
`tag-picker` / `docker-image-select` / `property-worker-menu` declare no `dense`
prop, so Vue passes it through to the root element as a stray DOM attribute that
styles nothing.

**Delete those; don't convert them.** `VListSubheader` has no `density` prop
either, so a swap is just a different dead attribute. `VCard` *does* have one,
so a swap there newly tightens title/subtitle/text padding — an unrequested
visual change. This is the trap in a scripted sweep: a regex that rewrites
`dense` → `density="comfortable"` on every tag it matches is wrong on most of
them, and a regex restricted to `<v-[a-z-]+` misses the custom-component
instances entirely (they need the opposite treatment, so they can't just be
ignored).

`src/vuetifyDeprecations.test.ts` scans every `.vue` template for a boolean
`dense` on any tag and fails the build, so this can't silently come back.
Extend that test rather than hand-grepping when auditing a new Vuetify
deprecation.

### Icon names: check `@mdi/font` 5.9.55, not the MDI website

`@mdi/font` here is pinned at **5.9.55**, several major versions behind what
mdi.dev documents. A name that doesn't exist in the installed font fails
**silently and invisibly**: Vuetify sets the class, no `::before` rule matches,
and the icon renders as blank space. `tsc`, lint and every component test stay
green — the only symptom is a gap a human notices in a screenshot, which is
exactly how `mdi-gradient-horizontal` shipped on a menu item. The sweep that
followed found two more (`mdi-sitemap-outline`, added after 5.x, in two places;
`mdi-save`, renamed to `mdi-content-save` in 5.x).

Never write an icon name from memory or from current MDI docs — grep the
installed font:

```bash
grep -c '^\.mdi-sitemap-outline::before' node_modules/@mdi/font/css/materialdesignicons.css   # 0 → blank icon
```

`src/__tests__/mdiIconNames.test.ts` enforces this across all of `src/`, so a
bad name now fails the suite instead of shipping. Its one exclusion is itself
(it quotes non-existent names in its own prose). In the browser, the direct
evidence is `getComputedStyle(el, "::before").content` — a codepoint means the
glyph resolved, `none`/`normal` means the class matched no rule.

Common 5.9.55 gotchas: no `-outline` variant for many icons; `save` →
`content-save`; `gradient` has no `-horizontal`/`-vertical` suffix.

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

### Wide dialogs: `class="wide-dialog"` when using percentage or `vw` widths

Vuetify ships `.v-dialog { width: 50% }` on the outer overlay wrapper. The `width` / `max-width` props on `<v-dialog>` only size the inner `.v-overlay__content` — so `width="60%"` actually renders at 60% of that 50% box (= 30% of viewport), and `width="70vw"` is silently clamped to 50vw.

Whenever a dialog needs a percentage or `vw` width, opt in with `class="wide-dialog"`. The shared rule lives in `src/style.scss` (look for `.wide-dialog.v-dialog { width: auto }`) and lets the prop size against the viewport directly.

```vue
<!-- Bad: width prop silently shrinks to 30% of viewport -->
<v-dialog v-model="open" width="60%">…</v-dialog>

<!-- Good: class lets the 60% prop apply to the viewport -->
<v-dialog v-model="open" width="60%" class="wide-dialog">…</v-dialog>
```

When **not** to add the class:
- `max-width` in pixels (e.g. `max-width="500px"`) — works correctly without the class on any reasonable screen.
- `max-width="33vw"` and similar — `vw` max-widths smaller than 50vw fit inside the default wrapper, so the class is unnecessary.
- Dialogs with no width prop — they rely on the implicit 50% wrapper as a sane default; adding the class would let them shrink to content width, which is usually not what's wanted for confirmation-style dialogs.

If you see a dialog with a `width="N%"` or `width="Nvw"` prop and no `wide-dialog` class, it's almost certainly rendering narrower than intended — add the class.

## API Calls

Use the API classes from store — never put `girderRest.get(...)` in components:

```typescript
import store from "@/store";
const result = await store.api.someMethod();
```

## Opening a palette from a component that has no palette registry

App.vue owns palette (right/left panel) visibility in local refs, so a
component mounted under the route tree — anything inside `ImageViewer` /
`AnnotationViewer` — cannot open one by emitting an event. Ask through the
main store instead: `store.requestPaletteOpen(["analysisPanel",
"filtersPanel"])` sets `paletteOpenRequests`; App.vue watches it, opens each
in order, and clears the list. Order matters — open the *primary* palette
first, then its companion (Filters hosts alongside Analysis and the Object
Browser); the other order closes the palette just opened.
`TRequestablePalette` in `model.ts` is a subset of App.vue's `PaletteId`, so
keep them in step — that is what makes a renamed palette a compile error
rather than a click that does nothing. Same shape as the older
`isAnnotationPanelOpen` hatch used by the Timelapse panel.

## A count computed after filtering must say it was filtered

Every count the UI prints from `filteredAnnotations`, `viewportAnnotationCount`,
or any id set that survived filters/gates is a *filtered* number. Printed
without a cue, it reads as data loss the moment a filter is restored from a
saved configuration — the reported case was a HUD reading "Showing 826 of 826
in view" in a viewport visibly holding thousands, because a saved lasso gate
cut 708,983 to 72,925.

- The cue belongs **next to the number**, not on a palette badge across the
  window. A badge that was visible the whole time did not prevent the report.
- Count constraints through `src/utils/activeConstraints.ts` —
  `collectActiveConstraints` / `countActiveConstraints` — never with a fresh
  ad-hoc sum. The Filters badge, the Analysis badge and the HUD suffix all
  read that one list; a new narrowing filter that skips it is invisible on
  all three. See `codebaseDocumentation/ACTIVE_CONSTRAINT_CUES.md`.

## Logging

**Never use `console.log`, `console.warn`, or `console.error`** — eslint will reject them.

```typescript
import { logWarning, logError } from "@/utils/log";

logWarning("Something unexpected happened");
logError("An error occurred", error);
```

## Error Reporting (Sentry)

`@sentry/vue` is wired in `src/main.ts`, gated on `VITE_SENTRY_DSN` at build time. When the DSN is unset, no Sentry code is loaded — local installs and OSS users pay zero runtime cost. Uncaught Vue errors and async exceptions (`window.onerror`/`unhandledrejection`) are reported automatically via the Vue integration installed at init; you don't need to wrap component code in try/catch just to report errors.

To capture an error or message manually from a component, dynamic-import the package so the no-DSN path stays free of any Sentry reference:

```typescript
if (import.meta.env.VITE_SENTRY_DSN) {
  const Sentry = await import("@sentry/vue");
  Sentry.captureException(err, { tags: { feature: "my-feature" } });
}
```

In practice almost no component should need this — let the global handler do its job. Local testing: see `CLAUDE.md` § "Error Reporting (Sentry)" for `.env.local` setup and the `setTimeout` test recipe.

## Buttons — five-role taxonomy

Every `<v-btn>` should declare an explicit **`variant`** and **`size`**. Omitting them falls back to Vuetify's `elevated` default at default size, which looks generic and out of place against the Linear-inspired theme.

| Role | Props | Use |
|---|---|---|
| Primary | `variant="flat" color="primary" size="small"` | The one main action of a view or dialog |
| Primary positive | `variant="flat" color="success" size="small"` | View / Go / Start CTAs |
| Secondary | `variant="outlined" color="primary" size="small"` | Supporting actions |
| Tertiary / text | `variant="text" size="small"` | Cancel, low-emphasis, inline |
| Destructive (confirmed) | `variant="flat" color="error" size="small"` | The irreversible button in a confirm dialog |
| Destructive (inline) | `variant="text" color="error" size="small"` | The trigger that opens a confirm dialog (use `mdi-delete`, not `mdi-close`) |
| Informational | `variant="text" color="info" size="small"` | View log / inspect detail / open help — actions that read rather than mutate |
| Icon-only | `variant="text" icon size="small"` | Toolbar / row actions; wrap in `v-tooltip` if ambiguous |

**Color tokens — never use literals.** Use `error`/`success`/`warning`/`secondary`, not `red`/`green`/`orange`/`grey`. Semantic tokens are theme-aware.

**Dialog action bar pattern:**
```vue
<v-card-actions class="button-bar">
  <v-btn variant="text" size="small" @click="close">Cancel</v-btn>
  <v-btn variant="flat" color="primary" size="small" @click="save">Save</v-btn>
</v-card-actions>
```
Never two filled buttons. For destructive confirms, swap `color="primary"` → `color="error"` on the right button.

**`:to` vs `@click`:** a `v-btn` with `:to` renders as `<a>`, one with `@click` renders as `<button>`. `src/style.scss` makes form elements inherit `font-family` so they match; for groups of buttons that must look identical, use the same action type across all of them so they share the underlying tag.

Full guide: `codebaseDocumentation/BUTTON_CONVENTIONS.md`

### Loading state

```vue
<v-btn
  variant="flat"
  color="primary"
  size="small"
  :loading="isLoading"
  :disabled="isLoading"
  @click="doAction"
>
  <template v-slot:loader>
    <v-progress-circular indeterminate size="18" width="2" class="mr-2" />
    Loading...
  </template>
  <v-icon start>mdi-check</v-icon>
  Submit
</v-btn>
```

## Memory Diagnostics

`window.__nimbusMem` is registered globally for browser-console memory monitoring (zero overhead unless enabled via `__nimbusMem.enable()`). Useful when investigating memory leaks, comparing memory pressure across changes, or sanity-checking a new cache.

Quick API: `__nimbusMem.enable()`, `snapshot('label')`, `print()`, `compare('a','b')`, `export()`.

For the full API, recorded fields, the load-order constraint (don't import stores at top level — register from `main.ts`), instructions for adding new counters or auto-snapshot points, and the cherry-pick procedure for cross-branch comparison: read `codebaseDocumentation/MEMORY_DEBUGGING.md`.

## ONNX / SAM Pipeline (`src/pipelines/onnxModels.ts`, `samPipeline.ts`)

The SAM tools run ONNX models (`onnxruntime-web`, WebGPU) whose WASM loaders and model files are fetched from `/onnx-wasm/` and `/onnx-models/`. Three failure modes here have bitten us in **production only** — they pass locally because the Vite dev server serves assets instantly and with correct MIME types.

- **`.mjs` served as `text/plain` (prod nginx).** Modern `onnxruntime-web` dynamically `import()`s `.mjs` WASM loaders (e.g. `ort-wasm-simd-threaded.asyncify.mjs`) from `env.wasm.wasmPaths`. Production static files are served by **nginx in the AWSDeploy repo** (`templates/startup_haproxy.tftpl`), which uses stock `include mime.types;`. Stock `mime.types` maps `.js` but **not `.mjs`**, so `.mjs` falls through to `text/plain` and the browser refuses the ES-module import (*"Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/plain"*). `.wasm` is unaffected (it *is* in stock `mime.types` as `application/wasm`), which is why pre-`.mjs` versions never hit this. Fix lives in **AWSDeploy** (`types { text/javascript mjs; }`), not in this repo — don't add a frontend workaround. Also: `env.wasm.wasmPaths` must be **root-absolute** (`/onnx-wasm/`), or the loader specifier resolves against the current SPA route path.

- **Concurrent session creation → `multiple calls to 'initWasm()' detected`.** onnxruntime-web initializes its shared WASM/WebGPU backend lazily on the first `InferenceSession.create()`, and that init is **not reentrant**. The SAM pipeline creates the encoder (`samPipeline.ts` `createEncoderSession`) and decoder (`createDecoderSession`) sessions from two independent `ComputeNode`s that fire on the same tick, so both creates race the backend init. The window is sub-millisecond locally (loaders served instantly) but wide in prod (each is a network fetch), so it fails deterministically **only when deployed**. `createOnnxInferenceSession` **serializes the `create()` step** through a module-level promise chain so the backend initializes exactly once — keep it that way. Model *downloads* stay parallel; only `create()` is gated. (Pipeline-node compute errors log `this.fun.name`, which is **minified** in prod — `[f2n]`/`[p2n]` are the mangled session-creation functions, not meaningful names.)

- **HTML-shell cache poisoning.** A missing model path is answered with the `index.html` app shell at HTTP 200 (SPA fallback); caching that permanently breaks the tool (*"Failed to load model because protobuf parsing failed"*, INVALID_PROTOBUF). `fetchModelBuffer`/`warmModelCache` detect it (content-type + first byte `0x3c` `<`) and self-heal by dropping the poisoned cache entry.

**General promise pattern (Codex P2, PR #1237):** when you start an async op eagerly but defer its consumer behind a chain — `chain.then(() => started.then(...))` — the `started` promise can reject *before* any handler is attached, which the runtime reports as an **unhandled rejection** (noise in the console and in Sentry) even though a later handler eventually catches it. Settle it into a non-rejecting result the instant it starts, then re-throw inside the chain:

```typescript
const settled = started.then(
  (value) => ({ ok: true as const, value }),
  (error) => ({ ok: false as const, error }),
);
const gated = chain.then(() =>
  settled.then((r) => {
    if (!r.ok) throw r.error;
    return use(r.value);
  }),
);
```

## Native File / Folder Pickers (`src/utils/fileUpload.ts`)

Folder upload (picker button + drag-and-drop) is centralized in `src/utils/fileUpload.ts`: `selectFiles()`, `selectFilesFromFolder()`, `getFilesFromDrop(event)`, and `filterFilesByAccept(files, accept)`. Extraction is delegated to the `file-selector` library (recurses into dropped folders, normalizes `<input>` change events). Two traps here each shipped as a silent "pick a folder and nothing happens":

- **Never use a window-`focus` timeout to detect dialog cancellation.** The detached-`<input>` trick (`document.createElement('input'); input.click()`) needs to know when the dialog closes. A tempting fallback is "when the window regains focus, wait Nms; if no `change` fired, treat as cancel." This **loses a race for `webkitdirectory` folder picks**: Chrome interposes an *"Upload N files to this site?"* confirmation, and `input.files` isn't populated (no `change`) until the user accepts it — often **seconds** after the window already refocused when the OS dialog closed. The focus-timeout fires in that gap and resolves with an empty selection, discarding the real folder (measured live: focus at +4.5s, timeout resolves `[]` at +5.0s, real `change` ignored at +7.0s). Regular single-file picks have no confirmation dialog, so `change` wins the race there — which is why the bug looks like "only folders are broken." **No focus heuristic can ever work for folders** because focus returns before the files are known. Rely on the standardized `cancel` event (dismissal) + `change` (selection); both are supported in every browser we target (Chrome 113+, Firefox 91+, Safari 16.4+), so no fallback is needed.

- **A picker promise that never resolves is indistinguishable from "nothing happened."** `file-selector`'s `fromEvent` can reject (an unreadable directory entry, a `getAsFileSystemHandle` failure). If the `await fromEvent(...)` inside the picker's settle handler throws *after* the `settled` guard is set, `resolve()` is never called and every `await selectFilesFromFolder()` **hangs forever**; on the drop path it surfaces as an unhandled rejection. Wrap extraction in try/catch → `logError(...)` + resolve/return `[]` so an error degrades to "no selection."

- **`accept` filtering is caller-applied for folder/DnD only.** The native `<input :accept>` is enforced by the browser for click-to-select, but folder selection and drag-and-drop **bypass it entirely** — that's why `filterFilesByAccept` exists and is called on those two paths (not on the native `onChange`). Caveat: folder/DnD files frequently have an empty `file.type` (browsers assign no MIME to `.tif`/`.nd2`/`.czi`), so **prefer extension tokens** (`.tif,.nd2`) over MIME tokens (`image/*`) in any `accept` you pass — a MIME token silently drops empty-`type` files.

## Style Guidelines

- Use scoped SCSS: `<style lang="scss" scoped>`
- Prefer Vuetify components over custom HTML
- `!important` is rarely needed thanks to CSS Cascade Layers — only use for overriding `@girder/components` or non-Vuetify third-party styles
- Keep custom colors as SCSS variables at the top of style blocks

## Verification Gates

Before claiming a frontend change done:

1. `pnpm tsc` — type check
2. `pnpm lint:ci` — zero warnings
3. `pnpm test` — vitest. **Known artifact:** after a backend `tox` run, ~10 test FILES under `.tox/**` fail ("Failed to resolve import @playwright/test") — vitest's glob picks up girder's bundled specs. These are spurious; only failures outside `.tox/` paths are real. CI is unaffected (clean checkout).
4. **In-browser verification for anything user-facing** — tsc/lint/vitest green does not mean the UI works (pointer-events, layering, watcher-firing, and store-corruption bugs all passed every static gate). See the in-browser-testing skill; remember to hard-reload after store edits.

Component-level test patterns (AnnotationViewer harness, GeoJS mocks): see the nimbus-geojs skill and `codebaseDocumentation/FRONTEND_COMPONENT_TESTING.md`.

### A mock that cannot represent the bug makes its tests meaningless

Worse than a mock returning the wrong constant is a mock that models *none* of
the real action's effect. `addAnalysisPlot` was a bare `vi.fn()`, so
`mockFilters.analysisPlots` stayed empty no matter what the code under test
did. Nine tests passed against it — and none of them could observe whether the
executor's plot had actually landed, which is precisely the state the bug
produced (the store refuses at its cap by no-oping, and the executor went on
to configure and report a plot that did not exist).

The rule: **a mocked action must reproduce the state change its caller depends
on, including its refusal behaviour.** If the real action appends, the mock
appends; if the real one silently no-ops past a cap, the mock does too. When a
test needs extra side effects on top, factor the default into a helper and
call it, rather than replacing the implementation and silently dropping the
effect the code under test is checking for:

```ts
function appendAnalysisPlot(id: string) { /* what the real action does */ }
beforeEach(() => { mock.addAnalysisPlot.mockImplementation(appendAnalysisPlot); });
// A test layering extra behaviour composes rather than replaces:
mock.addAnalysisPlot.mockImplementation((id) => { appendAnalysisPlot(id); ...extra... });
```

Also reset such state in **every** `describe`'s `beforeEach`, not just the
first — a test that flips a cap flag or swaps an API stub mid-await leaks it
into every later block.

### A mock that returns a fixed value can fail your test for the wrong reason

Shared mocks in this repo return constants chosen for the tests that existed when they were written, and a new test inherits them silently. The failure looks like a bug in the code under test, not in the harness.

- `geojs.util.distance2dToLineSquared` returns **100** and `pointInPolygon` returns **false** in `AnnotationViewer.test.ts`. Any line hit test compares against a squared tolerance (36 for the 6 px connection tolerance), so it can never match until the test sets `mockReturnValue(1)`.
- `mockGeoJSAnnotation` doesn't derive `coordinates()` from the `vertices` option, so a feature built by the real draw path has correct `options()` and no usable geometry.
- `geojsAnnotationFactory` drops its options argument unless you re-forward it — assertions on a feature's constructed `style` see `undefined`.

Before concluding "the code doesn't work", check what the relevant mock actually returns. Equally: when a component test needs a *component* to do something, prefer asserting the side effect the component owns over re-deriving geometry through the mock.

**Unmount components that register global listeners.** A wrapper left mounted by an earlier test keeps its `window` listener attached, so the next test's dispatch fires it too and a spy is called twice. Track the wrapper and unmount it in `afterEach`. If you see "expected 1 call, got 2", suspect a leaked mount before suspecting the code — and then ask whether the *product* can also mount that component more than once, because that is the same bug in production.

## Codebase Documentation References

- Vuetify 4 migration details: read `codebaseDocumentation/VUETIFY4_MIGRATION.md`
- Button taxonomy and patterns: read `codebaseDocumentation/BUTTON_CONVENTIONS.md`
- When working on batch processing: read `references/batch-processing-patterns.md`
- When working on projects feature: read `codebaseDocumentation/PROJECTS.md`
- When working on sharing UI: read `codebaseDocumentation/SHARING.md`
- When working on annotation combining: read `codebaseDocumentation/COMBINE_ANNOTATIONS.md`
