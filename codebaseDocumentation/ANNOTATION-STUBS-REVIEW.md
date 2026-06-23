# Stub Annotation Branch Code Review

Review date: 2026-06-23

## Resolution (2026-06-23)

All six findings addressed on `feature/stub-annotations`. Each fix was
generalized to an error pattern and the whole branch audited for other
instances (none beyond those below).

- **#1 selection skips unhydrated stubs (P1) — FIXED.** `AnnotationViewer.vue`
  selection now resolves a candidate to its stub when the full annotation is
  absent (`resolveSelectionCandidate`), gating on `stub.location` and testing
  containment against `stub.centroid` (drag) or the rendered dot (`shouldSelectStub`,
  click). All four paths (spatial-index drag, fallback drag, global centroid,
  click) updated. Geometry-only handlers (`handleAnnotationEdits`) explicitly
  narrow to hydrated annotations, preserving prior behavior. `filterAnnotations`
  is now generic over `TAnnotationOrStub` (reads only tags/channel). Regression
  tests added (click + drag stub selection in `AnnotationViewer.test.ts`).
- **#2 delete-unselected no-op in stub mode (P1) — FIXED.**
  `deleteUnselectedAnnotations` now derives from the stub-aware
  `allAnnotationIds` getter instead of `this.annotations` (which is empty in
  stub mode), mirroring the other dataset-wide actions.
- **#3 dataset reset leaks stub cache/index (P1) — FIXED.**
  `resetAnnotationStateImpl()` now clears `annotationStubs`, `hydratedAnnotations`,
  `visibleAnnotationIds`, viewport counts, `averageStubRadius`, `stubOnlyMode`,
  `annotationSpatialIndex.clear()`, and cancels the in-flight viewport hydration
  task.
- **#4 PV-driven sort row duplication (P1) — FIXED.** On a pure property sort,
  the PV-driven first segment is restricted to docs that have the sort key, so
  it no longer overlaps the no-value tail. Regression test added (RED/GREEN
  verified; full backend suite 251 passed).
- **#5 clearing values filter leaves old values (P2) — FIXED.**
  `updateValuesFilter()` always writes `values: []` on empty input (empty ==
  "do not filter", confirmed in `filters.ts`). Existing test updated to the
  corrected behavior.
- **#6 stub store tests drifted (P2) — PARTIALLY ADDRESSED.** Added the
  explicit regression coverage Codex requested for the unhydrated-stub selection
  (#1). The broader `annotationStubs.test.ts` mini-store rewrite (it still
  asserts the obsolete "hydrate first 20%" strategy that production
  `setAnnotations` no longer uses) is deferred as a dedicated test-refactor —
  noted as a follow-up to avoid cascading changes across the 900-line copied
  mini-store in this pass.

Scope: `feature/stub-annotations`, focused on the stub/hydration data path, annotation viewer/list behavior, backend list/stub endpoints, property-value lazy loading, and nearby tests.

Verification run:

- `pnpm vitest run src/components/AnnotationBrowser/AnnotationList.test.ts src/components/AnnotationViewer.test.ts src/store/__tests__/annotationStubs.test.ts src/store/__tests__/filters.test.ts src/utils/__tests__/annotationStubUtils.test.ts src/utils/__tests__/debouncedAbortable.test.ts src/utils/__tests__/visibilityBudget.test.ts src/utils/__tests__/propertyValues.test.ts`
  - Passed: 8 files, 451 tests.
  - Note: the run prints repeated Vuetify/JSDOM CSS `@layer` parse warnings, but exits successfully.
- `pnpm tsc`
  - Passed.

Backend Girder plugin tests were reviewed but not run in this pass.

## Findings

### 1. Drag/click selection skips unhydrated stubs in stub-only mode

Severity: P1

Files:

- `src/components/AnnotationViewer.vue:1623`
- `src/components/AnnotationViewer.vue:1672`
- `src/components/AnnotationViewer.vue:1710`

`getSelectedAnnotationsFromAnnotation()` now builds spatial indexes over `TAnnotationOrStub`, but when it handles candidates it immediately calls `getAnnotationFromId()` and requires `annotation.coordinates`. In stub-only mode, `getAnnotationFromId()` returns only hydrated annotations because `annotations[]` is empty and most displayed annotations are intentionally stub-only. As a result:

- Click selection cannot select visible unhydrated stub dots.
- Drag selection skips displayed unhydrated stubs.
- The global centroid-index pass, which is supposed to select non-visible annotations in the region, also skips unhydrated stubs before it can use their centroid/location.

This contradicts the architecture note's selection guarantee that region selection/deletion should capture all annotations in the area, not just the currently hydrated subset. It also blocks downstream operations that depend on selection, including tagging, connections, combine, and hydrate-on-selection.

Suggested fix: make selection return IDs rather than full `IAnnotation` where possible, or teach the candidate path to use `annotationStore.getStub(id)` when the full annotation is absent. For stub-only drag selection, use the stub `location` for frame gating and the stub `centroid` for containment; if precision is required, select/hydrate candidates first and refine after hydration. Add a test where `annotationStore.stubOnlyMode = true`, a visible GeoJS feature has `isStub: true`, `getAnnotationFromId()` returns `undefined`, and selection still picks the stub ID.

### 2. Viewer action-panel "Delete Unselected" is a no-op in stub-only mode

Severity: P1

Files:

- `src/components/AnnotationViewer.vue:15`
- `src/store/annotation.ts:1241`

The annotation list toolbar has a server-mode workaround for deleting unselected rows, but the floating `AnnotationActionPanel` in `AnnotationViewer.vue` still wires `@delete-unselected` directly to `annotationStore.deleteUnselectedAnnotations`. That store action computes unselected IDs from `this.annotations`, which is intentionally empty in stub-only mode:

```ts
const unselectedIds = this.annotations
  .filter((annotation) => !selectedIds.has(annotation.id))
  .map((annotation) => annotation.id);
```

So in large datasets the action panel can show "Delete Unselected" after a selection, call the backend with an empty ID list, and leave all unselected annotations untouched.

Suggested fix: make the store action stub-aware. If the intended action is dataset-wide, compute from `this.allAnnotationIds` in stub-only mode. If the intended action is filter/list-scoped, expose a separate server-list action that uses `/upenn_annotation/list/ids`; do not leave the shared store method silently empty.

### 3. Dataset reset leaves the large stub cache and spatial index alive

Severity: P1

Files:

- `src/store/index.ts:1397`
- `src/store/annotation.ts:366`
- `src/store/annotation.ts:377`

`setSelectedDataset()` calls `resetAnnotationState()` when switching/clearing datasets. The reset mutation now clears the old full `annotations[]`, but it does not clear the new stub-only state:

- `annotationStubs`
- `hydratedAnnotations`
- `visibleAnnotationIds`
- `viewportAnnotationCount` / `viewportRenderedCount`
- `averageStubRadius`
- `stubOnlyMode`
- the module-level `annotationSpatialIndex`
- any pending viewport hydration task

For a 708K-annotation dataset, clearing the selected dataset or navigating away can still retain the large stub map and spatial index until a later `fetchAnnotations()` happens to call `setAnnotations([])`. That is both a memory leak and a stale-state risk.

Suggested fix: extend `resetAnnotationStateImpl()` with the same clearing semantics as an empty annotation load, including `annotationSpatialIndex.clear()`, empty raw maps/sets, zeroed counts, `stubOnlyMode = false`, and cancellation of any pending/in-flight viewport hydration task.

### 4. PV-driven property sort can duplicate rows when a PV doc lacks the sort key

Severity: P1

File: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py:423`

The PV-driven pure property sort path paginates over all property-value docs for the dataset, including docs that do not contain the sort key. Then `_pvDrivenPage()` appends a no-value tail from the annotation collection when `len(rows) < limit`:

- `_pvDrivenPagePipeline()` includes PV docs with `_hasSortValue = 0`.
- `_noValueTail()` matches annotations whose joined `_pv.values.<sortKey>` is `None`, which includes the same "PV doc exists but sort key is missing" annotations.
- Those annotations can therefore appear once from the PV-driven rows and again from the no-value tail.

Example to add as a regression test: three annotations where one has `values.p.Area`, one has a PV doc with only `values.q.Other`, and one has no PV doc. Sorting by `["p", "Area"]` with a limit larger than the present-value count should return three unique annotation IDs, with the latter two in the missing-value tail. The current shape can duplicate the `q.Other` row and omit another missing row.

Suggested fix: for pure property sort, have the PV-driven first segment match only docs where the sort key exists/non-null, then append the complete missing-value tail once. Alternatively, keep the current first segment but make the tail exclude IDs already returned and compute the offset against the full missing set precisely.

### 5. Clearing a values-mode property filter leaves the old values active

Severity: P2

File: `src/components/AnnotationBrowser/AnnotationProperties/PropertyFilterHistogram.vue:308`

`updateValuesFilter()` only writes to the filter store when `parsedValues.length` is non-zero. If a user deletes all text from the values textarea, the previous `propertyFilter.values` remain in the store, so the UI looks cleared while the old values filter continues to apply.

Suggested fix: always update the filter store, using `values: []` for an empty parse. The backend/client filter builders already treat an empty values list as "do not filter."

### 6. Stub store tests have drifted from production behavior

Severity: P2 test coverage

File: `src/store/__tests__/annotationStubs.test.ts:397`

`annotationStubs.test.ts` uses a copied mini-store instead of importing the real annotation module. That can be reasonable for speed, but the copy still asserts the old "hydrate first 20%" mock-data strategy while production `setAnnotations()` now clears `hydratedAnnotations` and hydrates through `updateVisibilityAndHydration`. The tests pass because they are testing the copied implementation, not the current store behavior.

Suggested fix: either update the mini-store to match production behavior or replace these cases with pure utility tests plus a thin integration test against the real mutation/action boundary. Also add explicit regression coverage for the unhydrated-stub selection and stub-mode `deleteUnselectedAnnotations()` cases above.

## Notes

- The server-side list endpoint has solid input validation for malformed property paths, invalid sort fields, bad `idConstraints`, non-string `idSubstring`, and non-list value filters.
- The annotation list component itself handles server-mode selected/unselected deletion more carefully than the shared store action; the issue is the viewer action panel and any other direct store caller.
- ROI filtering in server list mode is explicitly not supported and is surfaced as a notice. ROI filtering in client lazy drawing uses centroid fallback, which appears to be an intentional approximation rather than an accidental coordinate access bug.
