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

## Reference

For projects store implementation details, read: `codebaseDocumentation/PROJECTS.md`
