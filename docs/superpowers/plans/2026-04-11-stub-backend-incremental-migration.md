# Stub Backend Incremental Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the stub annotation system from a frontend-only mock to real backend endpoints, one data source at a time, maintaining a working system at every step.

**Architecture:** The mock currently loads all annotations fully, builds stubs locally, and hydrates synchronously from the local array. We revert the failed backend integration, then incrementally replace: (1) stub source → server, (2) hydration source → server, (3) drop full annotation array.

**Tech Stack:** Vue 3 + Vuex (vuex-module-decorators), TypeScript, GeoJS, Girder REST API

---

### Task 1: Revert Frontend Backend Integration

Revert all uncommitted changes that introduced backend-mode branching. Keep the new API methods in `AnnotationsAPI.ts` and backend files untouched.

**Files:**
- Revert: `src/store/annotation.ts` (to HEAD)
- Revert: `src/components/AnnotationViewer.vue` (to HEAD)
- Revert: `src/store/filters.ts` (to HEAD)
- Revert: `src/components/AnnotationBrowser/AnnotationImport.vue` (to HEAD)
- Revert: `src/components/AnnotationBrowser/AnnotationList.vue` (to HEAD)
- Revert: `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue` (to HEAD)
- Revert: `src/components/AnnotationBrowser/DeleteConnections.vue` (to HEAD)
- Revert: `src/components/AnnotationContextMenu.vue` (to HEAD)
- Revert: `src/components/TagCloudPicker.vue` (to HEAD)
- Revert: `src/utils/annotationImport.ts` (to HEAD)
- Revert: `src/components/AnnotationViewer.test.ts` (to HEAD)
- Revert: `src/components/TagCloudPicker.test.ts` (to HEAD)
- Revert: `src/components/AnnotationBrowser/AnnotationList.test.ts` (to HEAD)
- Revert: `src/components/AnnotationBrowser/DeleteConnections.test.ts` (to HEAD)
- Revert: `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.test.ts` (to HEAD)
- Keep as-is: `src/store/AnnotationsAPI.ts` (has new API methods we want)
- Keep as-is: `devops/girder/plugins/AnnotationPlugin/` (backend endpoints)
- Keep as-is: `codebaseDocumentation/ANNOTATION-STUBS.md`

- [ ] **Step 1: Revert all frontend files except AnnotationsAPI.ts**

```bash
git checkout HEAD -- \
  src/store/annotation.ts \
  src/components/AnnotationViewer.vue \
  src/store/filters.ts \
  src/components/AnnotationBrowser/AnnotationImport.vue \
  src/components/AnnotationBrowser/AnnotationList.vue \
  src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue \
  src/components/AnnotationBrowser/DeleteConnections.vue \
  src/components/AnnotationContextMenu.vue \
  src/components/TagCloudPicker.vue \
  src/utils/annotationImport.ts \
  src/components/AnnotationViewer.test.ts \
  src/components/TagCloudPicker.test.ts \
  src/components/AnnotationBrowser/AnnotationList.test.ts \
  src/components/AnnotationBrowser/DeleteConnections.test.ts \
  src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.test.ts
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm tsc`
Expected: 0 errors

- [ ] **Step 3: Verify tests pass**

Run: `pnpm test`
Expected: All tests pass (same count as before revert)

- [ ] **Step 4: Commit**

```bash
git add src/store/annotation.ts src/components/AnnotationViewer.vue \
  src/store/filters.ts src/components/AnnotationBrowser/ \
  src/components/AnnotationContextMenu.vue src/components/TagCloudPicker.vue \
  src/utils/annotationImport.ts src/components/AnnotationViewer.test.ts \
  src/components/TagCloudPicker.test.ts
git commit -m "revert: remove frontend backend-integration, restore working mock

Keep AnnotationsAPI.ts stub/hydrate methods and backend endpoints
for incremental migration. Revert all component and store changes
that introduced stubOnlyMode, annotationsForIteration, and async
backend hydration."
```

---

### Task 2: Use Server Stubs for Stub Map (Keep Full Annotations for Everything Else)

Replace client-side stub computation in `setAnnotations()` with server-provided stubs. The full `annotations[]` array remains populated and used for hydration and all other consumers. This tests that server stubs have correct centroids/radii.

**Files:**
- Modify: `src/store/AnnotationsAPI.ts` (already has `getAnnotationStubs` and `toStub` from uncommitted changes — verify they're present)
- Modify: `src/store/annotation.ts:1319-1355` (`fetchAnnotations` action)
- Modify: `src/store/annotation.ts:597-692` (`setAnnotations` mutation — add option to accept server stubs)

- [ ] **Step 1: Verify AnnotationsAPI.ts has the stub methods**

Read `src/store/AnnotationsAPI.ts` and confirm `getAnnotationStubs()`, `hydrateAnnotations()`, and `toStub()` are present from the uncommitted changes. If they were reverted (they shouldn't have been — Task 1 skipped this file), re-add them.

The methods should look like:

```typescript
async getAnnotationStubs(datasetId: string): Promise<IAnnotationStub[]> {
  const response = await this.client.get("upenn_annotation/stubs", {
    params: { datasetId },
  });
  return (response.data as any[]).map(this.toStub);
}

async hydrateAnnotations(annotationIds: string[]): Promise<IAnnotation[]> {
  if (annotationIds.length === 0) {
    return [];
  }
  const response = await this.client.post(
    "upenn_annotation/hydrate",
    annotationIds,
  );
  return (response.data as any[]).map(this.toAnnotation);
}

toStub = (item: any): IAnnotationStub => {
  const {
    _id,
    tags,
    shape,
    channel,
    location,
    datasetId,
    color,
    centroid,
    estimatedRadius,
  } = item;
  return markRaw({
    id: _id,
    tags,
    shape,
    channel,
    location,
    color: color ?? null,
    centroid,
    estimatedRadius,
  });
};
```

- [ ] **Step 2: Add a `setStubsFromServer` mutation to `annotation.ts`**

This mutation replaces the stub map and spatial index with server-provided data, WITHOUT touching `annotations[]`, `annotationIdToIdx`, or `annotationCentroids` (those are still built from the full annotations in `setAnnotations`).

Add this new mutation after `setAnnotations()` (after line 692 in committed code):

```typescript
@Mutation
public setStubsFromServer(stubs: IAnnotationStub[]) {
  const newStubs = new Map<string, IAnnotationStub>();
  const spatialItems: { id: string; x: number; y: number }[] = new Array(
    stubs.length,
  );

  for (let idx = 0; idx < stubs.length; ++idx) {
    const stub = stubs[idx];
    newStubs.set(stub.id, stub);
    spatialItems[idx] = {
      id: stub.id,
      x: stub.centroid.x,
      y: stub.centroid.y,
    };
  }

  this.annotationStubs = markRaw(newStubs);
  annotationSpatialIndex.bulkLoad(spatialItems);
}
```

- [ ] **Step 3: Modify `fetchAnnotations` to also fetch server stubs**

In `annotation.ts`, the committed `fetchAnnotations()` (line 1319) fetches annotations and connections in parallel. Add a third parallel fetch for stubs. After `setAnnotations()`, call `setStubsFromServer()` to replace the client-computed stubs with server stubs.

Replace the body of the try block in `fetchAnnotations()`:

```typescript
const datasetId = main.dataset.id;
const annotationsPromise = this.annotationsAPI.getAnnotationsForDatasetId(
  datasetId,
);
const connectionsPromise = this.annotationsAPI.getConnectionsForDatasetId(
  datasetId,
);
const stubsPromise = this.annotationsAPI.getAnnotationStubs(datasetId);

const [annotations, connections, stubs] = await Promise.all([
  annotationsPromise,
  connectionsPromise,
  stubsPromise,
]);
this.setConnections(connections?.length ? connections : []);
this.setAnnotations(annotations?.length ? annotations : []);
// Replace client-computed stubs with server stubs
// (server computes centroid/estimatedRadius in the aggregation pipeline)
if (stubs?.length) {
  this.setStubsFromServer(stubs);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `pnpm tsc`
Expected: 0 errors

- [ ] **Step 5: Verify tests pass**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/store/annotation.ts src/store/AnnotationsAPI.ts
git commit -m "feat: fetch server stubs in parallel with full annotations

setAnnotations still builds stubs from full data, then
setStubsFromServer replaces them with server-computed
centroids/estimatedRadius. All other behavior unchanged —
hydration still reads from local annotations[] array."
```

**Manual verification (requires running backend):** Load a dataset with annotations. Open browser console. Check that stub dots appear at correct positions and shapes render identically to before. Compare a few `annotationStore.annotationStubs.get(id).centroid` values between this build and the previous commit to verify server centroids match client centroids.

---

### Task 3: Replace Local Hydration with Backend Hydration

Change Step 7 in `updateVisibilityAndHydration()` to call the backend `hydrateAnnotations()` endpoint instead of looking up `this.annotations[idx]`. The full `annotations[]` array is still loaded (from Task 2's `fetchAnnotations`) so the `needsStubSystem` bypass still works. This step exercises the async hydration path and the reactive dependency chain.

**Files:**
- Modify: `src/store/annotation.ts:1889-1903` (Step 7 of `updateVisibilityAndHydration`)
- Modify: `src/store/annotation.ts:1905` (change `export default` to named export for module-level function)
- Modify: `src/components/AnnotationViewer.vue:400-445` (add reactive dependency on `hydratedAnnotations`)

- [ ] **Step 1: Change module export to named variable**

The module-level `_hydrateFromBackend` function needs to call mutations on the module instance. Change the export at the bottom of `annotation.ts` (committed line 1905):

Replace:
```typescript
export default getModule(Annotations);
```

With:
```typescript
const annotationModule = getModule(Annotations);
export default annotationModule;
```

- [ ] **Step 2: Add `_hydrateFromBackend` module-level function**

Add this after the module export (after the new `export default annotationModule;` line), before the HMR block:

```typescript
/**
 * Hydrate annotations from the backend, outside the Vuex action proxy.
 * vuex-module-decorators breaks this/state/mutation access after await,
 * so we run the async fetch as a plain function and commit directly
 * to the module instance.
 */
import type AnnotationsAPI from "./AnnotationsAPI";
async function _hydrateFromBackend(
  api: AnnotationsAPI,
  idsToFetch: string[],
  keepEntries: { id: string; annotation: IAnnotation }[],
) {
  if (idsToFetch.length > 0) {
    try {
      const fetched = await api.hydrateAnnotations(idsToFetch);
      const newEntries = fetched.map((a) => ({
        id: a.id,
        annotation: a,
      }));
      annotationModule.setHydratedAnnotations([
        ...keepEntries,
        ...newEntries,
      ]);
    } catch (error) {
      logError(
        `Hydration fetch failed: ${(error as Error).message}`,
      );
    }
  } else {
    annotationModule.setHydratedAnnotations(keepEntries);
  }
}
```

- [ ] **Step 3: Modify Step 7 to use backend hydration**

Replace the committed Step 7 block in `updateVisibilityAndHydration()` (lines 1889-1903):

Replace:
```typescript
    // Step 7: Hydrate — sync from local data (mock), async from backend (future)
    // Mock strategy: all annotations are in memory, hydrate synchronously.
    // When the backend stub API exists, replace this with an async fetch:
    //   const annotations = await this.annotationsAPI.getAnnotationsByIds(idsToHydrate);
    const entries: { id: string; annotation: IAnnotation }[] = [];
    for (const id of idsToHydrate) {
      const idx = this.annotationIdToIdx[id];
      if (idx !== undefined) {
        entries.push({ id, annotation: this.annotations[idx] });
      }
    }
    this.setHydratedAnnotations(entries);
```

With:
```typescript
    // Step 7: Hydrate from backend API
    // Capture state synchronously, then fire async hydration outside
    // the Vuex action proxy (vuex-module-decorators breaks after await).
    const hydratedCache = this.hydratedAnnotations;
    const api = this.annotationsAPI;
    const idsToFetch = idsToHydrate.filter(
      (id) => !hydratedCache.has(id),
    );
    const keepEntries = idsToHydrate
      .filter((id) => hydratedCache.has(id))
      .map((id) => ({
        id,
        annotation: hydratedCache.get(id)!,
      }));
    _hydrateFromBackend(api, idsToFetch, keepEntries);
```

- [ ] **Step 4: Add reactive dependency on `hydratedAnnotations` in `layerAnnotations`**

In `AnnotationViewer.vue`, the `layerAnnotations` computed (line ~400) needs to recompute when `hydratedAnnotations` changes. The committed code uses `annotationStore.getForRendering(id)` which returns a function — Vue doesn't track the state it reads internally.

Add a direct read of `hydratedAnnotations` at the top of the computed, and use it for the hydration lookup:

In `layerAnnotations` computed, after line `const { maxVisible } = annotationStore.visibilityConfig;` (line ~407), add:

```typescript
    // Direct read creates reactive dependency so layerAnnotations
    // recomputes when async hydration completes
    const hydratedAnnotations = annotationStore.hydratedAnnotations;
```

Then replace the rendering data lookup (line ~441-443):

Replace:
```typescript
        const renderData: TAnnotationOrStub = needsStubSystem
          ? annotationStore.getForRendering(annotation.id) ?? annotation
          : annotation;
```

With:
```typescript
        const renderData: TAnnotationOrStub = needsStubSystem
          ? hydratedAnnotations.get(annotation.id)
            ?? annotationStore.annotationStubs?.get(annotation.id)
            ?? annotation
          : annotation;
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `pnpm tsc`
Expected: 0 errors

- [ ] **Step 6: Verify tests pass**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/store/annotation.ts src/components/AnnotationViewer.vue
git commit -m "feat: hydrate annotations from backend API instead of local array

Step 7 of updateVisibilityAndHydration now calls the hydrate
endpoint. Full annotations[] still loaded so the needsStubSystem
bypass works (annotations have coordinates). This exercises the
async hydration path and reactive dependency chain without risk
of rendering breakage."
```

**Manual verification (requires running backend):** Load a dataset. Annotations should still render as shapes. Check Network tab — you should see `POST /upenn_annotation/hydrate` requests on load and when panning/zooming. The hydrate response returns full annotations that replace the locally-computed hydration cache. Visually identical to before.

**Important note:** At this step, the `needsStubSystem` bypass still fires for most frames (since `annotations[]` is fully populated and `frameCount <= maxVisible`). The backend hydration IS called but its results go into `hydratedAnnotations` which the bypass path doesn't consult. This is expected and correct — the backend path is exercised without risk. Step 4 will make it matter.

---

### Task 4: Drop Full Annotations Array for Large Datasets

When the annotation count exceeds `maxVisible`, fetch only stubs (no full annotations). This is where the bypass bug from the failed attempt must be fixed: `layerAnnotations` must consult `hydratedAnnotations` even when `frameCount <= maxVisible`, if we're in stub-only mode.

**Files:**
- Modify: `src/store/annotation.ts` (add `stubOnlyMode`, `annotationsForIteration`, modify `fetchAnnotations`, `deleteAnnotations`, `allAnnotationIds`, `inactiveAnnotationIds`, `getAnnotationFromId`, `annotationTags`)
- Modify: `src/components/AnnotationViewer.vue` (fix bypass, use `annotationsForIteration`)
- Modify: `src/store/filters.ts` (use `annotationsForIteration`)
- Modify: 6 component files + `annotationImport.ts` (use `annotationsForIteration`)
- Modify: 5 test files (add `annotationsForIteration` to mocks)

This is the largest task. Each sub-step changes one thing.

- [ ] **Step 1: Add `stubOnlyMode` state and `annotationsForIteration` getter**

In `annotation.ts`, add the state field after `isDeletingAnnotations` (line ~73):

```typescript
  // When true, annotations[] is empty and all metadata lives in annotationStubs.
  // Rendering uses the stub system; hydration fetches from backend on demand.
  stubOnlyMode: boolean = false;
```

Add the getter after `annotationTags` (line ~119):

```typescript
  /**
   * Returns an array for iteration by components that need metadata
   * (id, channel, location, tags, shape, color) but not coordinates.
   * In normal mode: returns annotations[].
   * In stub-only mode: returns stubs cast to IAnnotation[].
   */
  get annotationsForIteration(): IAnnotation[] {
    if (!this.stubOnlyMode) {
      return this.annotations;
    }
    return Array.from(this.annotationStubs.values()) as unknown as IAnnotation[];
  }
```

Set `this.stubOnlyMode = false;` at the end of `setAnnotations()` (after clearing hydration cache, line ~690).

- [ ] **Step 2: Update getters that need to work in stub-only mode**

Update `allAnnotationIds` (line ~75):
```typescript
  get allAnnotationIds() {
    if (this.stubOnlyMode) {
      return Array.from(this.annotationStubs.keys());
    }
    return this.annotations.map((annotation: IAnnotation) => annotation.id);
  }
```

Update `inactiveAnnotationIds` (line ~88):
```typescript
  get inactiveAnnotationIds() {
    const activeIds = new Set(this.activeAnnotationIds);
    return this.allAnnotationIds.filter(
      (id: string) => !activeIds.has(id),
    );
  }
```

Update `getAnnotationFromId` (line ~96):
```typescript
  get getAnnotationFromId() {
    return (annotationId: string) => {
      const hydrated = this.hydratedAnnotations.get(annotationId);
      if (hydrated) return hydrated;
      const idx = this.annotationIdToIdx[annotationId];
      return idx === undefined ? undefined : this.annotations[idx];
    };
  }
```

Update `annotationTags` (line ~104):
```typescript
  get annotationTags() {
    const tagSet: Set<string> = new Set();
    if (this.stubOnlyMode) {
      for (const stub of this.annotationStubs.values()) {
        for (const tag of stub.tags) {
          tagSet.add(tag);
        }
      }
    } else {
      for (const { tags } of this.annotations) {
        for (const tag of tags) {
          tagSet.add(tag);
        }
      }
    }
    return tagSet;
  }
```

- [ ] **Step 3: Add `removeAnnotationStubs` mutation**

Add after `setStubsFromServer` (added in Task 2):

```typescript
  @Mutation
  public removeAnnotationStubs(ids: string[]) {
    const newStubs = new Map(this.annotationStubs);
    const newHydrated = new Map(this.hydratedAnnotations);
    const newCentroids = { ...this.annotationCentroids };
    for (const id of ids) {
      newStubs.delete(id);
      newHydrated.delete(id);
      delete newCentroids[id];
      annotationSpatialIndex.remove(id);
    }
    this.annotationStubs = markRaw(newStubs);
    this.hydratedAnnotations = markRaw(newHydrated);
    this.annotationCentroids = markRaw(newCentroids);
  }
```

- [ ] **Step 4: Modify `fetchAnnotations` for count-based branching**

Replace the try block body in `fetchAnnotations()`:

```typescript
      const datasetId = main.dataset.id;
      // Always fetch connections in parallel with the count check
      const connectionsPromise =
        this.annotationsAPI.getConnectionsForDatasetId(datasetId);

      // Check count to decide: full fetch (under threshold) or stubs (over)
      const count = await this.annotationsAPI.getAnnotationCount(datasetId);
      const { maxVisible } = this.visibilityConfig;

      if (count <= maxVisible) {
        // Under threshold: full fetch + server stubs
        const [annotations, connections, stubs] = await Promise.all([
          this.annotationsAPI.getAnnotationsForDatasetId(datasetId),
          connectionsPromise,
          this.annotationsAPI.getAnnotationStubs(datasetId),
        ]);
        this.setConnections(connections?.length ? connections : []);
        this.setAnnotations(annotations?.length ? annotations : []);
        if (stubs?.length) {
          this.setStubsFromServer(stubs);
        }
      } else {
        // Over threshold: stubs only, hydrate on demand
        const [stubs, connections] = await Promise.all([
          this.annotationsAPI.getAnnotationStubs(datasetId),
          connectionsPromise,
        ]);
        this.setConnections(connections?.length ? connections : []);
        // Set empty annotations first (resets state), then load stubs
        this.setAnnotations([]);
        if (stubs?.length) {
          this.setStubsFromServer(stubs);
          this.setStubOnlyMode(true);
        }
      }
```

Add the `setStubOnlyMode` mutation:

```typescript
  @Mutation
  public setStubOnlyMode(mode: boolean) {
    this.stubOnlyMode = mode;
  }
```

- [ ] **Step 5: Modify `deleteAnnotations` for stub-only mode**

In `deleteAnnotations` action (find the section that filters `this.annotations` after the API call), replace:

```typescript
      const idsSet = new Set(ids);
      this.setAnnotations(
        this.annotations.filter(
          (annotation: IAnnotation) => !idsSet.has(annotation.id),
        ),
      );
```

With:
```typescript
      if (this.stubOnlyMode) {
        this.removeAnnotationStubs(ids);
      } else {
        const idsSet = new Set(ids);
        this.setAnnotations(
          this.annotations.filter(
            (annotation: IAnnotation) => !idsSet.has(annotation.id),
          ),
        );
      }
```

- [ ] **Step 6: Fix the bypass in `layerAnnotations` (the critical fix)**

In `AnnotationViewer.vue`, the `layerAnnotations` computed needs to know about `stubOnlyMode`. The bypass condition must always engage the stub system when in stub-only mode, because `annotation` objects from `annotationsForIteration` are stubs without coordinates.

Replace:
```typescript
      const needsStubSystem = stubsSize > 0 && frameCount > maxVisible;
```

With:
```typescript
      const needsStubSystem = annotationStore.stubOnlyMode
        || (stubsSize > 0 && frameCount > maxVisible);
```

- [ ] **Step 7: Update `displayableAnnotations` to use `annotationsForIteration`**

In `AnnotationViewer.vue`, `displayableAnnotations` computed (line ~360):

Replace:
```typescript
    : annotationStore.annotations;
```

With:
```typescript
    : annotationStore.annotationsForIteration;
```

- [ ] **Step 8: Update `unrolledCentroidCoordinates` to use `annotationsForIteration`**

In `AnnotationViewer.vue` (line ~519):

Replace:
```typescript
    for (const annotation of annotationStore.annotations) {
```

With:
```typescript
    for (const annotation of annotationStore.annotationsForIteration) {
```

- [ ] **Step 9: Update `updateVisibility` to use `annotationsForIteration`**

In `AnnotationViewer.vue` (line ~3180):

Replace:
```typescript
    store.filteredDraw ? filteredAnnotations.value : annotationStore.annotations
```

With:
```typescript
    store.filteredDraw ? filteredAnnotations.value : annotationStore.annotationsForIteration
```

- [ ] **Step 10: Update `filters.ts` to use `annotationsForIteration`**

In `src/store/filters.ts`, the `filteredAnnotations` getter (find `annotation.annotations.filter`):

Replace:
```typescript
    return annotation.annotations.filter((annotation: IAnnotation) => {
```

With:
```typescript
    return annotation.annotationsForIteration.filter((annotation: IAnnotation) => {
```

- [ ] **Step 11: Update remaining component files**

In each of these files, replace `annotationStore.annotations` with `annotationStore.annotationsForIteration` at the specific location noted:

**`src/components/AnnotationBrowser/AnnotationImport.vue`** — two occurrences:
- `annotationStore.annotations.length` → `annotationStore.annotationsForIteration.length` (in the checkbox label)
- Same in the dialog card text

**`src/components/AnnotationBrowser/AnnotationList.vue`** — one occurrence:
- `annotationStore.annotations.length < 5000` → `annotationStore.annotationsForIteration.length < 5000`

**`src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue`** — one occurrence:
- `for (const annotation of annotationStore.annotations)` → `for (const annotation of annotationStore.annotationsForIteration)`

**`src/components/AnnotationBrowser/DeleteConnections.vue`** — one occurrence:
- `annotationStore.annotations` in the filter → `annotationStore.annotationsForIteration`

**`src/components/AnnotationContextMenu.vue`** — one occurrence:
- `annotationStore.annotations.filter` → `annotationStore.annotationsForIteration.filter`

**`src/components/TagCloudPicker.vue`** — one occurrence:
- `annotationStore.annotations.filter` → `annotationStore.annotationsForIteration.filter`

**`src/utils/annotationImport.ts`** — one occurrence:
- `for (const { id } of annotationStore.annotations)` → `for (const { id } of annotationStore.annotationsForIteration)`

- [ ] **Step 12: Update test mocks**

Each test file that mocks the annotation store needs `annotationsForIteration` added. This getter should mirror `annotations` in test mode (since tests use under-threshold data).

**`src/components/AnnotationViewer.test.ts`**: In the `vi.mock("@/store/annotation", ...)` block, after creating the reactive state object, add:

```typescript
  Object.defineProperty(state, "annotationsForIteration", {
    get() {
      return state.annotations;
    },
    enumerable: true,
  });
  return { default: state };
```

**`src/components/TagCloudPicker.test.ts`**: Same pattern — add `annotationsForIteration` property that returns `annotations`.

**`src/components/AnnotationBrowser/AnnotationList.test.ts`**: Same pattern.

**`src/components/AnnotationBrowser/DeleteConnections.test.ts`**: Same pattern.

**`src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.test.ts`**: Same pattern.

- [ ] **Step 13: Add `stubStateChanged` check to `clearOldAnnotations`**

In `AnnotationViewer.vue`, in the `clearOldAnnotations` function (line ~768), when `clearAll` is false, annotations that changed from stub to hydrated (or vice versa) need to be redrawn. Add this check:

After the existing check (line ~774-776):
```typescript
        const annotation = getAnnotationFromId.value(girderId);
        const layer = store.getLayerFromId(layerId);
```

Add:
```typescript
        // Check if stub/hydrated state changed
        const wasStub = geoJsAnnotation.options("isStub");
        const layerData = layerAnnotations.value
          .get(layerId)?.get(girderId);
        const isNowHydrated = layerData
          ? isHydratedAnnotation(layerData)
          : false;
        const stubStateChanged = wasStub === isNowHydrated;
```

And add `!stubStateChanged` to the keep condition:
```typescript
        if (
          layer &&
          annotation &&
          layerDisplaysAnnotation.value(layer.id, annotation.id) &&
          annotation.color === color &&
          !stubStateChanged
        ) {
          return;
        }
```

- [ ] **Step 14: Verify TypeScript compiles**

Run: `pnpm tsc`
Expected: 0 errors

- [ ] **Step 15: Verify tests pass**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 16: Commit**

```bash
git add src/store/annotation.ts src/components/AnnotationViewer.vue \
  src/store/filters.ts src/components/AnnotationBrowser/ \
  src/components/AnnotationContextMenu.vue src/components/TagCloudPicker.vue \
  src/utils/annotationImport.ts src/components/AnnotationViewer.test.ts \
  src/components/TagCloudPicker.test.ts
git commit -m "feat: stub-only mode for large datasets with fixed bypass

Datasets exceeding maxVisible load stubs only from backend.
The critical fix: needsStubSystem now activates when stubOnlyMode
is true, regardless of frameCount vs maxVisible. This ensures
hydratedAnnotations is always consulted when annotations[] is
empty, preventing the 'everything renders as dots' bug from the
previous attempt."
```

**Manual verification (requires running backend):**
1. Load a small dataset (under 10K annotations) — should behave identically to master (full fetch, no stub system)
2. Load a large dataset (over 10K annotations) — should load quickly as stubs (dots), then hydrate to shapes in the viewport
3. Pan/zoom on the large dataset — shapes should appear/disappear as the viewport changes
4. Select annotations on the large dataset — selection should work
5. Delete annotations on the large dataset — should remove correctly

---

### Task 5: Update ANNOTATION-STUBS.md Documentation

Update the living documentation to reflect the new incremental architecture.

**Files:**
- Modify: `codebaseDocumentation/ANNOTATION-STUBS.md`

- [ ] **Step 1: Update Phase 5 status and implementation notes**

Update the "Frontend Integration (Phase 5)" section to reflect that the incremental migration is complete. Remove or mark as resolved the "Unresolved Issues" sections about hydrated annotations not rendering and the bypass bug. Add a note about the incremental migration approach that was taken.

Key points to document:
- The bypass fix: `needsStubSystem = stubOnlyMode || (stubsSize > 0 && frameCount > maxVisible)`
- The dual-fetch strategy in Step 2 (server stubs + full annotations under threshold)
- The module-level `_hydrateFromBackend` pattern
- Future work: hash-random hydration, LRU cache, debounced fetch batching

- [ ] **Step 2: Commit**

```bash
git add codebaseDocumentation/ANNOTATION-STUBS.md
git commit -m "docs: update ANNOTATION-STUBS.md for incremental migration"
```
