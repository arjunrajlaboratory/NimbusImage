# Stub Annotations: Incremental Mock-to-Backend Migration

**Date:** 2026-04-11
**Branch:** `feature/stub-annotations`
**Status:** Design approved

## Problem

The stub annotation system has a working mock mode (all annotations loaded fully, stubs derived client-side, hydration from local array) and a non-working backend mode (stubs from server, hydration via API). The backend integration was attempted as a single large change that modified loading, hydration, iteration source, rendering logic, and the bypass condition simultaneously. When rendering broke, it was impossible to isolate the cause.

### Root Cause

The `needsStubSystem` bypass in `layerAnnotations` (`AnnotationViewer.vue`) falls through to `renderData = annotation`. In mock mode, `annotation` is a full `IAnnotation` with `.coordinates`, so `isHydratedAnnotation()` returns true and shapes render correctly. In backend mode, `annotation` is a stub (no `.coordinates`), so everything renders as dots regardless of what's in `hydratedAnnotations`.

## Strategy

Revert the frontend backend-integration changes. Keep the working mock. Replace one data source at a time, testing at each step.

### What to Keep (unchanged)

- **Backend endpoints**: `GET /upenn_annotation/stubs` and `POST /upenn_annotation/hydrate` (in `annotation.py`)
- **Backend tests**: `test_stubs.py`
- **Frontend API methods**: `getAnnotationStubs()`, `hydrateAnnotations()`, `toStub()` in `AnnotationsAPI.ts`
- **All committed stub system code**: types, utilities, spatial index, store state/mutations/getters, AnnotationViewer rendering, tests

### What to Revert (uncommitted changes)

All changes in the working tree that introduced backend-mode branching:

- `annotation.ts`: `stubOnlyMode` flag, `annotationsForIteration` getter, `setAnnotationStubsFromBackend()`, `removeAnnotationStubs()`, `_hydrateFromBackend()`, modified `fetchAnnotations()` (count-based branching), modified `deleteAnnotations`/`combineAnnotations`, named module export
- `AnnotationViewer.vue`: `annotationsForIteration` refs (3 places), direct `hydratedAnnotations` reactive dependency, inline hydration lookup, `stubStateChanged` logic
- `filters.ts`: `annotationsForIteration`
- 6 component files + `annotationImport.ts`: `annotationsForIteration` references
- All test mock updates adding `annotationsForIteration`

## Migration Steps

### Step 1: Revert to Working Mock

`git checkout` the uncommitted frontend files (keeping `AnnotationsAPI.ts` additions and backend files). Verify: `pnpm tsc` passes, `pnpm test` passes, app renders annotations as shapes.

### Step 2: Decouple Stub Loading

**Goal:** Stubs come from the server endpoint; full annotations still loaded for hydration.

Changes to `fetchAnnotations()`:
1. Fetch full annotations as before (populate `annotations[]`)
2. ALSO fetch stubs from `getAnnotationStubs()`
3. In `setAnnotations()`, use server stubs instead of computing them client-side
4. Everything else unchanged -- hydration Step 7 still reads `this.annotations[idx]`

**What this tests:** That server-computed centroids/estimatedRadius match client-computed ones closely enough for correct rendering. If stubs from the server have different values, we'll see it immediately while the full annotations are still there for comparison.

**Verification:** Stub dots appear at correct positions, shapes render identically to Step 1.

### Step 3: Replace Local Hydration with Backend Hydration

**Goal:** Hydration reads from the backend API instead of the local `annotations[]` array.

Changes to `updateVisibilityAndHydration()` Step 7:
1. Instead of `this.annotations[idx]`, call `hydrateAnnotations(idsToFetch)`
2. Use the module-level async function pattern (extract async work outside `@Action`)
3. Keep `annotations[]` populated as a safety net (still loaded in `fetchAnnotations`)
4. Handle the async nature: initial render shows stubs, then shapes appear after HTTP response

**What this tests:** Async hydration timing, reactive dependency on `hydratedAnnotations`, whether the draw cycle correctly re-renders when hydrated data arrives.

**Verification:** Annotations render as shapes (with a brief stub-to-shape transition on initial load). Pan/zoom triggers re-hydration from API.

**Key gotcha:** The `needsStubSystem` bypass. Since `annotations[]` is still fully populated and `frameCount <= maxVisible` (the full-fetch path), `needsStubSystem = false` and the bypass uses the local `annotation` object (which has coordinates). So the async hydration is actually redundant in this step -- the bypass still works. This is fine; it means Step 3 can't break rendering. We're just exercising the API path.

### Step 4: Drop the Full Annotations Array

**Goal:** `fetchAnnotations()` loads stubs only, `annotations[]` is empty.

This is the step where the bypass bug must be fixed. Changes:

1. `fetchAnnotations()`: count-based branching (under threshold: full fetch as before; over threshold: stubs only)
2. Add `stubOnlyMode` flag, `annotationsForIteration` getter
3. Fix `layerAnnotations` bypass: when `stubOnlyMode = true`, always consult `hydratedAnnotations` regardless of `needsStubSystem`
4. Update component references to use `annotationsForIteration`
5. Handle deletion in stub-only mode (`removeAnnotationStubs`)

**The critical fix** (not present in the failed attempt): The bypass condition must account for stub-only mode:
```typescript
// Old (broken): skips hydration lookup when frameCount <= maxVisible
const needsStubSystem = stubsSize > 0 && frameCount > maxVisible;

// Fixed: always use stub system when in stub-only mode
const needsStubSystem = stubOnlyMode || (stubsSize > 0 && frameCount > maxVisible);
```

**Verification:** With a dataset exceeding `maxVisible`, annotations load as stubs, hydrate to shapes on viewport, and re-hydrate on pan/zoom.

## Future Work (not part of this migration)

- **Hash-random hydration selection**: The current size-based approach (largest first) works well for mixed-size annotations but can produce spatial clustering with uniform-size datasets. A hash-based random selection from the visible set distributes hydration evenly. Consider a hybrid: size-based for the viewport tier, hash-random for the off-viewport tier.
- **Accumulating cache with LRU eviction**: Once the backend path works, switch from replace-on-update to accumulate + evict to minimize re-fetching during pan.
- **Debounced fetch batching**: Batch rapid viewport changes into single hydration requests.
