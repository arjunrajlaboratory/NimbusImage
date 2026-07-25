# Vuex Store Module Patterns (Detailed)

## Standard Module Structure

```typescript
import { Module, VuexModule, Mutation, Action } from "vuex-module-decorators";
import store from "@/store";

@Module({ dynamic: true, store, name: "myModule" })
export class MyModule extends VuexModule {
  // State
  items: IItem[] = [];
  currentItemId: string | null = null;

  // Getter (computed from state)
  get currentItem(): IItem | null {
    return this.items.find(
      (i) => i.id === this.currentItemId
    ) || null;
  }

  // Mutation (synchronous state change)
  @Mutation
  setCurrentItemId(id: string | null) {
    this.currentItemId = id;
  }

  // Action (async, can call mutations)
  @Action
  async setSelectedItem(id: string | null): Promise<void> {
    this.setCurrentItemId(id);
    if (id && !this.getItemById(id)) {
      await this.fetchItem(id);
    }
  }
}

export default getModule(MyModule);
```

## routeMapper Pattern

Syncs URL params with Vuex store bidirectionally:

```typescript
// src/views/ProjectRouter.vue
export default routeMapper({
  projectId: {
    parse: String,
    get: () => projects.currentProjectId,
    set: (value: string) => projects.setSelectedProject(value),
  },
});
```

**How it works:**
- When URL changes -> calls `set()` to update store
- When store changes -> updates URL via `router.replace()`
- Prevents infinite loops via `currentRouteChanges` counter

**Route hierarchy example:**
```
/project                  -> ProjectRouter.vue (maps param)
  /project/:projectId     -> Project.vue (routeMapper)
    (default child)        -> ProjectInfo.vue (actual view)
```

## Form Change Detection Pattern

Track original values to enable/disable Save buttons:

```typescript
metadata: IFormData = { ... };
originalMetadata: IFormData = { ... };

// Initialize both with same values (deep copy arrays)
initializeMetadata() {
  const values = { ...fromSource, keywords: [...keywords] };
  this.metadata = { ...values, keywords: [...values.keywords] };
  this.originalMetadata = {
    ...values, keywords: [...values.keywords]
  };
}

// Detect changes
get hasMetadataChanges(): boolean {
  return (
    this.metadata.title !== this.originalMetadata.title ||
    JSON.stringify(this.metadata.keywords) !==
      JSON.stringify(this.originalMetadata.keywords)
  );
}

// Reset original after save
async saveMetadata() {
  await api.save(this.metadata);
  this.originalMetadata = {
    ...this.metadata,
    keywords: [...this.metadata.keywords]
  };
}
```

## Caching with Batch Loading Pattern

Load related data efficiently to avoid N+1 API calls:

```typescript
// Cache objects indexed by ID
datasetInfoCache: { [id: string]: IGirderFolder } = {};

// Batch fetch on load (single request for all IDs)
async fetchDatasetInfo() {
  const allIds = new Set<string>();
  // Collect all needed IDs
  for (const d of this.items) allIds.add(d.datasetId);

  // Single batch request
  await this.girderResources.batchFetchResources({
    folderIds: Array.from(allIds),
  });

  // Update local cache from global cache
  for (const id of allIds) {
    const folder = this.girderResources.watchFolder(id);
    if (folder) Vue.set(this.datasetInfoCache, id, folder);
  }
}
```

## Set-then-fetch Pattern

Set ID first, then fetch data lazily. Allows UI to show loading state:

```typescript
@Action
async setSelectedProject(projectId: string | null) {
  // 1. Set ID immediately (UI can react)
  this.setCurrentProjectId(projectId);
  // 2. Fetch if not cached
  if (projectId && !this.getProjectById(projectId)) {
    await this.fetchProject(projectId);
  }
}
```

## Actions That Throw: `rawError: true` and How to Test Them

`vuex-module-decorators` wraps every `@Action` body in its own try/catch. If the body throws and the action was declared as plain `@Action` (no options), the library **replaces** the caught error with a new one:

```
Error: ERR_ACTION_ACCESS_UNDEFINED: Are you trying to access this.someMutation()
or this.someGetter inside an @Action?
That works only in dynamic modules.
If not dynamic use this.context.commit("mutationName", payload) and
this.context.getters["getterName"]
<stack of "Could not perform action <name>">
<original error's stack>
```

This happens regardless of *why* the action threw — the message text is generic boilerplate about accessing mutations/getters, which is almost never the actual problem. It exists so that genuinely buggy `this.someMutation()` calls inside an action fail loudly, but it has the side effect of eating deliberate, meaningful `throw`s too.

Opt out per-action with `{ rawError: true }`:

```typescript
// The action is *designed* to throw a specific, user-facing message on
// failure, so callers must see it unmangled.
@Action({ rawError: true })
async addMultiSourceMetadata(payload: IAddMultiSourceMetadataPayload) {
  try {
    // ...
    if (!success) {
      throw new Error(quotaExceededMessage(jobLog) ?? "Failed to transcode...");
    }
    return itemId;
  } catch (error) {
    sync.setSaving(error as Error);
    throw error; // rawError: true means this reaches the caller unchanged
  }
}
```

Default to a bare `@Action` (log-and-return-null/false on failure) unless a caller specifically needs to branch on or display the failure reason. Reach for `rawError: true` only when the action throws on purpose.

### Propagating counts as throwing

An action does not need a `throw` of its own to need `rawError: true`. Any action that `await`s something that rejects — an API call, or another action — re-throws that rejection through its own decorator, which wraps it. `propertyStore.createProperty` has no `throw` anywhere in its body and still returned the `ERR_ACTION_ACCESS_UNDEFINED` blob:

```typescript
// Needs rawError: true — both awaits propagate on failure.
@Action({ rawError: true })
async createProperty(property: IAnnotationPropertyConfiguration) {
  const newProperty = await this.propertiesAPI.createProperty(property); // rejects
  if (newProperty) {
    await this.setProperties([...this.properties, newProperty]); // also rejects
  }
  return newProperty;
}
```

This is the blind spot that let a real defect through: an audit that greps action bodies for `throw` finds the deliberate throwers and misses every pure propagator. Grep for the *callers* that read a message instead (below).

### Every boundary in the chain needs it

`this.someOtherAction()` inside an `@Action` dispatches through the store again (these are dynamic modules), so it passes through that action's decorator too. An error therefore gets re-wrapped once per boundary it crosses, and **one missing `rawError` anywhere in the chain mangles the message** — fixing only the outermost or innermost action does nothing. The `create_property` chain crosses four:

```
createProperty → setProperties → updateConfigurationProperties → syncConfiguration
(properties.ts)  (properties.ts)  (index.ts)                      (index.ts)
```

Chains cross module boundaries, so audit **every** `src/store/*.ts`, not just `index.ts`. A sweep limited to `index.ts` is what left `properties.ts` broken.

### Deciding whether a caller actually needs the message

`rawError: true` is safe to add — it never changes *whether* an action throws, only which error object escapes — but check the caller so the comment you write is true, and so you know the user impact:

- **Renders it** → user-facing bug. `UserMenuLoginForm.vue` does `errorMessage.value = (error as Error).message` and shows it in a `v-alert`, so a failed `signUp` displayed the blob instead of "login already in use".
- **Logs it** (`logError("...", error)`) → console/Sentry quality only.
- **Shows generic text** ("See the console for details") → log quality only; the UI string is unaffected.

One thing that looks like a gap but is not: `ServerStatus.vue` renders `sync.lastError.message`, yet the sync indicator was never affected by missing `rawError`. `setSaving(error)` is called from *inside* the action's own catch, so it receives the original error before any decorator wrapping. Don't "fix" that path.

### Auditing

```bash
# 1. Bare @Action with a throw close below it — the deliberate throwers.
#    Returns nothing as of this writing: every such action now has the flag,
#    so any hit is a new one. Misses propagators (see above).
grep -rn "@Action$" -A8 src/store/*.ts | grep "throw "

# 2. Higher-signal, and catches propagators: callers that display a store
#    error's message. Quote --include — zsh expands it bare and the command
#    fails with "no matches found".
grep -rn "as Error).message" src/ --include="*.vue"
```

Query 2 is the one that matters: trace each hit back through **every** action on the path and confirm each boundary is `{ rawError: true }`. Query 1 is a cheap supplement, not a substitute — it structurally cannot see the propagator case, which is how the last defect reached review.

### Testing the real dispatch path (not a mocked one)

Most store tests mock `@/store`/`./index` entirely (see `aiPanel.test.ts`, `toolSuggestions.test.ts`, `MultiSourceConfiguration.test.ts`) because `Main` is heavy to construct. That's fine for testing *callers* of an action, but it can't catch a missing `rawError: true` — the mock just returns/throws whatever the test tells it to, bypassing vuex-module-decorators entirely.

To regression-test the wrapping behavior itself, dispatch the **real** action from the real singleton (`import main from "./index"`), mocking only the leaf API calls it touches (`main.api.*` via `vi.spyOn`) and any other dynamic-module dependencies (e.g. `jobs.addJob`). Importing `store/index.ts` directly works fine in the vitest/jsdom environment — `Main`'s constructor only builds a `RestClient` and reads `localStorage`, no network calls — see `src/store/index.test.ts`.

The key pitfall when writing the assertion: `expect(promise).rejects.toThrow("substring")` does a **substring** check against `error.message`. The wrapped `ERR_ACTION_ACCESS_UNDEFINED` message embeds the original error's `.stack` (whose first line is `"Error: <original message>"`), so a substring match can pass even when `rawError: true` is missing from the action — the test would never catch the regression it's meant to catch. Capture the message and assert it with `toBe(...)` (exact equality) instead:

```typescript
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

const message = await messageOf(main.addMultiSourceMetadata({ ...payload }));
expect(message).toBe("This operation needs 9.7 MB of storage, ...");
```

Two setup details for these real-dispatch tests:

**Getters and state on the accessor are non-configurable.** `vi.spyOn(main, "isLoggedIn", "get")` throws `TypeError: Cannot redefine property`, and `(main as any).girderUser = ...` throws `Cannot set property ... which has only a getter`. Set the underlying Vuex state instead:

```typescript
import store from "./root";
function setLoggedIn(loggedIn: boolean) {
  (store.state as any).main.girderUser = loggedIn ? { _id: "u1" } : null;
}
```

Protected mutations are reachable for setup via a cast — `(main as any).setConfigurationImpl({ id, data })` — which is usually less work than driving the real load path.

**Some actions can't be reached this way.** `signUp` builds its own `RestClient` internally, and `RestClient` assigns `post`/`get` as *own instance properties* in its constructor (not on the prototype), so there is no seam: `vi.spyOn(RestClient.prototype, "post")` doesn't exist to spy on, and mocking `@/girder` wholesale collides with `store/index.ts`'s module-level girder init. Don't sink time into it — verify that one by inspection and lean on the coverage of the sibling actions.

## Reference

For projects store implementation details, read: `codebaseDocumentation/PROJECTS.md`
