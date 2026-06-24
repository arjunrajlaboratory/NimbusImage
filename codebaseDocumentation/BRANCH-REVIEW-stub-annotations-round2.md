# Branch Review (Round 2) — feature/stub-annotations

Second-pass review findings and remediation tracking. Each finding records its
fix approach (TDD where possible), the test that proves it, and a status.

**Status legend:** ⬜ open · 🔧 in progress · ✅ fixed (test green) · ⏭️ deferred / won't-fix (with reason)

## Verification summary (final)

- **Frontend:** `pnpm tsc` clean (0 errors); `pnpm lint:ci` clean (0 warnings); full `vitest run src/` — **138 files / 2400 tests green**. New tests added for F1 (geometry fingerprint / drawn keep-check), F2 (stub/hydrated refresh on edit), F5 (spatial-index upsert), F11 (empty-list select-all), F12 (array-as-leaf).
- **Backend:** `tox` — **284 tests green**, flake8 clean. New tests for F3, F4, F7, F10, F17.
- **Rebuilt backend (`docker compose build girder && up -d`)** and live-smoke-tested the rebuilt container: F3 bad offset/limit → 400, F4 non-dict filters → 400 (`/list` and `/list/ids`), F17 `[[]]` → 400, valid `/list` → 200, refactored `/stubs` (F13) → 200. List row shape correct (`_id` + centroid, no coordinates).
- **F19** accepted/won't-fix in app code (decided 2026-06-24): rate limiting will be done at the HAProxy proxy layer later. No app change.

All 20 findings resolved: 18 fixed, 1 (F19) accepted/documented, plus the F20 sub-items.

---

## Findings

### Finding 1 — In-place geometry edits are not repainted (incremental draw keeps stale feature)
- **Severity:** High · **Category:** Correctness (rendering)
- **Files:** `src/components/AnnotationViewer.vue:684`, `src/utils/annotation.ts:417-426` (`drawnFeatureUnchanged`)
- **Problem:** The incremental draw keep-check compares only layer existence, `color`, and stub/shape state — never `coordinates`. A polygon-slice edit mutates `coordinates` on the same id/color/hydrated-state, so the stale GeoJS feature is kept and `drawNewAnnotations` skips it. The edit never repaints until a forced full clear.
- **Fix approach:** Add a geometry fingerprint (e.g. coordinate-derived token) to the draw-state comparison so a coordinate change makes `drawnFeatureUnchanged` return `false`. TDD the predicate.
- **Test:** `src/utils/__tests__/annotationStubUtils.test.ts` — `drawnFeatureUnchanged` returns false when the geometry key differs.
- **Status:** ✅ fixed — added float-safe `coordinatesFingerprint` + `geometryKeyForRender` helpers; `drawnFeatureUnchanged` now compares the rendered-geometry key (5th param). `createGeoJSAnnotation` stamps `geometryKey` into the GeoJS feature options; `clearOldAnnotations` reads it back. New tests cover fingerprint stability/vertex-move/count-change/sub-integer-move, `geometryKeyForRender` for hydrated+stub, and the in-place-edit keep-decision. 360 tests green across viewer + stub utils + store stubs; `pnpm tsc` clean.

### Finding 2 — `setAnnotationsAtIndices` leaves `annotationStubs`/`hydratedAnnotations` stale
- **Severity:** High · **Category:** Correctness (cache invalidation)
- **Files:** `src/store/annotation.ts:745-763`
- **Problem:** The non-stub-only `updateAnnotationsPerId` path commits via `setAnnotationsAtIndices`, which updates only `annotations[]`/centroids/idx — not `annotationStubs` or `hydratedAnnotations`. Canvas rendering reads those maps when `needsStubSystem` is true (any frame > `maxVisible`), so color/tag/coordinate edits resolve to the stale stub/hydrated copy and don't repaint.
- **Fix approach:** In `setAnnotationsAtIndices`, rebuild the stub for each updated id and refresh any present hydrated entry (mirroring `setAnnotation:730-739`).
- **Test:** store test — after `setAnnotationsAtIndices`, `annotationStubs.get(id)` and `hydratedAnnotations.get(id)` reflect the new color/tags/coordinates.
- **Status:** ✅ fixed — `setAnnotationsAtIndices` now rebuilds the stub, refreshes the hydrated entry if present, and repositions the spatial index when the centroid moved. 4 new tests in `annotationStubs.test.ts` (color/tags/hydrated/spatial), all green (50/50). Test follows the repo's replicated-store convention (real module is too coupled to import) with the replica kept in lockstep with the real mutation.

### Finding 3 — `offset`/`limit` parsing throws uncaught 500 on public `/list`
- **Severity:** Medium · **Category:** Error Handling / Security
- **Files:** `devops/.../server/api/annotation.py:654-655`
- **Problem:** `int(body.get("offset"/"limit"))` raises `ValueError`/`TypeError` before the `try/except` around `listPage`, producing a 500 on a public endpoint.
- **Fix approach:** Add an int-or-400 helper in `validation.py` and use it for offset/limit.
- **Test:** pytest — POST `/list` with `offset: "abc"` / `limit: [1,2]` → 400 (`testNonIntegerOffsetReturns400`, `testNonIntegerLimitReturns400`).
- **Status:** ✅ fixed — added `requireInt` in `validation.py`; `listAnnotations` now does `max(0, requireInt(...))` / `max(1, requireInt(...))` (parse-or-400, then preserve the existing clamp).

### Finding 4 — Truthy non-dict `filters` → AttributeError 500 on `/list` & `/list/ids`
- **Severity:** Medium · **Category:** Error Handling / Security
- **Files:** `server/api/annotation.py:626,651`, `server/helpers/validation.py:133`
- **Problem:** `body.get("filters") or {}` only replaces falsy values; a string/list `filters` reaches `validateListInputs` which does `filters.get(...)` → AttributeError → 500.
- **Fix approach:** Guard `isinstance(filters, dict)` at the top of `validateListInputs`.
- **Test:** pytest — `filters: "not-a-dict"` (list) → 400 on both `/list` and `/list/ids` (`testNonDictFiltersReturns400OnList`, `...OnIds`).
- **Status:** ✅ fixed — `validateListInputs` now raises 400 when `filters` is not a dict.

### Finding 5 — Spatial index `insert` has no upsert; re-add leaks a stale node
- **Severity:** Medium · **Category:** Correctness (edge case)
- **Files:** `src/utils/spatialIndex.ts:28-32`
- **Problem:** `insert` doesn't remove an existing entry for the id first, so re-adding orphans the old RBush node; a later `remove` can't clean it up and `queryBox` returns a stale location.
- **Fix approach:** Make `insert` upsert-safe (`if (this.itemById.has(id)) this.remove(id)`).
- **Test:** `spatialIndex.test.ts` — insert id, insert same id at new location, remove id → query returns nothing at either location (`upserts when an id is inserted again`).
- **Status:** ✅ fixed — `insert` now removes any existing node for the id first. Also let me simplify the F2 spatial-index update to a single `insert` (no explicit remove). 10/10 spatialIndex tests green.

### Finding 6 — `annotationsForIteration` launders stubs through `as unknown as IAnnotation[]`
- **Severity:** Low · **Category:** Type Safety
- **Files:** `src/store/annotation.ts:157-164` and consumers
- **Problem:** Double cast disables the compiler at the stub-vs-full boundary.
- **Fix approach:** Return `TAnnotationOrStub[]`; narrow consumers via `isHydratedAnnotation`. Verify with `tsc`.
- **Test:** `pnpm tsc` clean (compile-time concern); affected vitest suites green (244 tests).
- **Status:** ✅ fixed — getter now returns the honest union (removed `as unknown as`). Consumers widened: `filters.ts` callback + `annotationTestPoints` (now `TAnnotationOrStub`, guarded), `AnnotationViewer` `displayableAnnotationsByChannel`/`layerAnnotations`/`updateVisibility`, `AnnotationContextMenu`, `TagCloudPicker`. `AnnotationList.filteredItems` narrows via `isHydratedAnnotation` (client list path is non-stub only). `AnnotationCSVDialog` prop widened to the union with the single `.name` read guarded. `tsc` clean (0 errors).

### Finding 7 — `listCount` (PV-driven path) can over-count vs. returnable rows
- **Severity:** Low · **Category:** Correctness (count/page)
- **Files:** `server/models/annotation.py` `listCount` vs `_pvDrivenPagePipeline`
- **Problem:** Count counts PV docs directly; the page pipeline joins back to annotations with a non-preserving `$unwind`, dropping orphan PV docs. `total` can exceed returnable rows.
- **Fix approach:** Count through the same join for the PV-driven path.
- **Test:** pytest — orphan PV doc present → `total` equals number of returned rows (`testPropertyFilterCountExcludesOrphanValueDocs`).
- **Status:** ✅ fixed — `listCount` PV-driven branch now `$lookup`+non-preserving `$unwind` to the annotation before `$count`, matching the page pipeline.

### Finding 8 — Under-threshold `fetchAnnotations` double-fetches (annotations + stubs)
- **Severity:** Low · **Category:** Performance
- **Files:** `src/store/annotation.ts:1664-1683`
- **Problem:** ≤threshold branch fetches full annotations and stubs; full annotations are a superset and stubs are built client-side cheaply at this size.
- **Fix approach:** Drop `getAnnotationStubs` in the under-threshold branch; pass `serverStubsFollow:false`.
- **Test:** No dedicated test — `fetchAnnotations` lives in the heavily-coupled store module (not unit-testable in isolation). Behavior-preserving: the under-threshold path now passes a bare array to `setAnnotations`, whose client-side stub/centroid/spatial-index build is already covered by `annotationStubs.test.ts`. `tsc` clean.
- **Status:** ✅ fixed — under-threshold branch fetches only full annotations + connections; `setAnnotations(bare array)` builds stubs client-side.

### Finding 9 — `flashNote` timers not cleared on unmount
- **Severity:** Low · **Category:** Lifecycle cleanup
- **Files:** `src/components/UISettings.vue:195-206`
- **Problem:** `window.setTimeout` callbacks can fire after unmount, mutating reactive state on a destroyed component.
- **Fix approach:** Clear pending timers in `onBeforeUnmount`.
- **Test:** n/a (lifecycle) — covered by the existing UISettings suite staying green; verified by inspection.
- **Status:** ✅ fixed — added `onBeforeUnmount` clearing all pending `noteTimers`.

### Finding 10 — `findByAnnotationIds` returns `_id` despite docstring excluding it
- **Severity:** Low · **Category:** Correctness (doc mismatch)
- **Files:** `server/models/propertyValues.py:131-161`
- **Problem:** Inclusion-list projection leaves Mongo's default `_id:1`.
- **Fix approach:** Use a dict projection that drops `_id`.
- **Test:** pytest — returned PV docs have no `_id`/`datasetId`, with and without `propertyPaths` (`TestFindByAnnotationIds`).
- **Status:** ✅ fixed — `findByAnnotationIds` now builds a dict projection `{"_id": 0, "annotationId": 1, ...}`.

### Finding 11 — `selectAllValue` checked on empty client-mode list
- **Severity:** Low · **Category:** Correctness (dual-mode divergence)
- **Files:** `src/components/AnnotationBrowser/AnnotationList.vue:610-616`
- **Problem:** Client branch is `0 === 0 → true` on an empty table; server branch guards `total > 0`.
- **Fix approach:** Guard `filteredItems.length > 0` in the client branch.
- **Test:** `AnnotationList.test.ts` — empty filtered list → `selectAllValue` is false (`Finding 11`).
- **Status:** ✅ fixed — client branch now requires `filteredItems.length > 0`, matching the server branch. 71/71 green.

### Finding 12 — `valueAtPath` and `collectLeafPaths` disagree on arrays-as-leaves
- **Severity:** Low · **Category:** Code Duplication / Correctness
- **Files:** `src/utils/propertyValues.ts`
- **Problem:** `valueAtPath` descends into arrays; `collectLeafPaths` treats them as leaves.
- **Fix approach:** Treat arrays as leaves in `valueAtPath`.
- **Test:** `propertyValues.test.ts` via `idsMissingPaths` — a path descending INTO an array is treated as missing; a path resolving to an array leaf is present.
- **Status:** ✅ fixed — `valueAtPath` leaf check now includes `Array.isArray(current)`, matching `collectLeafPaths`. 27/27 green.

### Finding 13 — `stubs` aggregation built/run in the API layer
- **Severity:** Low · **Category:** Layer Violation
- **Files:** `server/api/annotation.py:518-563`
- **Problem:** Pipeline constructed and `collection.aggregate` called inline in the endpoint, unlike the rest of the PR which routes through the model's `_aggregate`.
- **Fix approach:** Add `Annotation.stubs(...)` model method using `_aggregate`; endpoint passes clean inputs. Behavior-preserving refactor — keep existing tests green.
- **Test:** existing stub tests stay green (`test_stubs.py`, 19 tests).
- **Status:** ✅ fixed — added `Annotation.stubs(datasetId, shape, tags)` routing through `_aggregate` (same hint/options); endpoint now just resolves access and calls it. Removed the now-unused `AGGREGATION_MAX_TIME_MS` import from the API file.

### Finding 14 — Selection watcher spreads full selection + `ensureHydrated` every change
- **Severity:** Low · **Category:** Performance
- **Files:** `src/components/AnnotationViewer.vue` selection watcher
- **Problem:** Materializes `[...ids]` and scans on every selection mutation.
- **Fix approach:** Pass the Set to `ensureHydrated` (iteration only) and/or early-return when nothing newly needs hydration.
- **Test:** existing AnnotationViewer/AnnotationList suites green (444 tests); `tsc` clean.
- **Status:** ✅ fixed — `ensureHydrated` now takes `Iterable<string>` (drops the `[...ids]` spread); the selection watcher passes the Set directly. `idsNeedingHydration` already iterated an iterable.

### Finding 15 — Client table uses two independent sorts (Vuetify vs `dataTableItems`)
- **Severity:** Low · **Category:** Correctness (fragile)
- **Files:** `src/components/AnnotationBrowser/AnnotationList.vue:189-206,719-739`
- **Problem:** Page-jump logic re-sorts with a hand-rolled comparator that can diverge from Vuetify's internal sort → wrong page.
- **Fix approach:** Make the parallel comparator agree with the table's display order.
- **Test:** existing AnnotationList suite green; `tsc` clean. (A full display-vs-page assertion needs a mounted Vuetify table; the fix instead mirrors Vuetify's exact algorithm so they cannot diverge.)
- **Status:** ✅ fixed — rather than reconfigure the table (UX risk: arrows/sort order), `dataTableItems`' comparator (the only consumer is `getPageFromItemId`) now mirrors Vuetify 4's internal `sortItems` exactly (lowercase compare, numeric coercion, empties-first, `Intl.Collator`). The table's display is untouched, so the page-lookup order matches what it renders.

### Finding 16 — `addAnnotationImpl` clones whole stub/hydrated maps per single insert
- **Severity:** Low · **Category:** Performance
- **Files:** `src/store/annotation.ts:654-678`
- **Problem:** O(N) per single add; O(N²) if ever looped.
- **Fix approach:** Document that single-add must not be looped (route bulk through `addAnnotationsImpl`); leave singular path as-is since it's interactive. Confirm no looped caller exists.
- **Test:** n/a (no behavior change) — verified `addAnnotationImpl` has a single caller (the interactive tool-create action at `annotation.ts:644`), not looped; bulk uses `addAnnotationsImpl`.
- **Status:** ✅ fixed — added a guard comment documenting the O(stub count) cost and the no-loop requirement.

### Finding 17 — Empty inner `idConstraints` (`[[]]`) silently matches nothing
- **Severity:** Nit · **Category:** Redundant Validation / edge case
- **Files:** `server/helpers/validation.py:174-196`
- **Problem:** `[[]]` validates (vacuous `all`) then emits `{"_id": {"$in": []}}`.
- **Fix approach:** Reject empty inner constraint lists at validation (or drop them).
- **Test:** pytest — `idConstraints: [[]]` → 400 (`testEmptyInnerIdConstraintReturns400`).
- **Status:** ✅ fixed — `validateListInputs` now requires each inner constraint list to be non-empty (`len(c) > 0`); an empty OUTER list stays a no-op.

### Finding 18 — Redundant conjunct in `stubRadius`
- **Severity:** Nit · **Category:** Redundant Validation
- **Files:** `src/components/AnnotationViewer.vue:1417-1420`
- **Problem:** `isStub && !isHydratedAnnotation(annotation)` repeats the same test.
- **Fix approach:** Drop the redundant `isStub` conjunct.
- **Test:** n/a (cleanup) — `tsc` clean, AnnotationViewer suite green.
- **Status:** ✅ fixed — `stubRadius` now `!isHydratedAnnotation(annotation) ? estimatedRadius ?? 5 : 5` (the narrow is what reaches `.estimatedRadius`); added a comment that it's only read on the stub path (covers the F20 `stubRadius` nit too).

### Finding 19 — Public heavy aggregations unauthenticated, no rate limit
- **Severity:** Nit (observation) · **Category:** Security / Access Control
- **Files:** `server/api/annotation.py` public endpoints, `propertyValues.py batch`
- **Problem:** `@access.public` full-collection aggregations bounded only by `AGGREGATION_MAX_TIME_MS`.
- **Fix approach:** Author already chose high count-caps as garbage-only guards with runtime bounded by `maxTimeMS` (documented in `validation.py`). Decide: accept as-is (document) or lower `maxTimeMS` for public paths.
- **Test:** n/a.
- **Status:** ⏭️ accepted, won't-fix in the app (decided 2026-06-24). These endpoints serve public datasets and are already (a) input-validated to 400 on garbage, (b) runtime-bounded by `AGGREGATION_MAX_TIME_MS` (5 min) with index hints, and (c) capped against pathological payloads. **Decision (Arjun):** leave the public endpoints as-is; rate limiting will be handled at the **proxy (HAProxy) layer later**, not in application code. No `maxTimeMS` change for public paths. Do not re-flag this in future reviews — it is an intentional, deferred infra task owned at the proxy, not an app-code gap.

### Finding 20 — Minor naming/clarity nits
- **Severity:** Nit · **Category:** Naming
- **Items:**
  - ✅ `_pvDrivenPagePipeline` hardcoded `"from": "upenn_annotation"` → now `self.name` (backend; `tox` 284 green).
  - ✅ `stubRadius` clarified with a comment that it's only read on the stub path (done with F18).
  - ✅ `selectRandomSubset` → renamed `selectStableSubset` across `annotation.ts` + 2 test files, with a JSDoc clarifying it's deterministic, not a uniform sample.
- **Fix approach:** Apply the cleanups; rename only if low-risk (check call sites).
- **Test:** n/a (cleanup) — `tsc` clean; affected suites green.
- **Status:** ✅ fixed — all three items applied.
