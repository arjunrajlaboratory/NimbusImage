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

## Reference

For projects store implementation details, read: `codebaseDocumentation/PROJECTS.md`
