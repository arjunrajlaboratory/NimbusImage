# Branch Review — `feature/stub-annotations`

**Base:** `master` · **Reviewed:** 2026-06-23 · **Scope:** ~9K lines of source across 4 backend files and ~36 frontend files.

This is the actionable fix list from the branch review. Findings are globally numbered and ordered by severity (Medium → Low → Nit). Each has a location, the problem, and concrete fix guidance. Two open questions were resolved by the author — their answers are baked into Findings 1 and 5 below.

> **Status (2026-06-23): all 26 findings addressed (TDD).** Each finding below carries a **✅ Resolved** note with the change + the test that covers it. Verified green: `pnpm tsc` (clean), `pnpm lint:ci` (0 warnings), `pnpm test` (2377/2377), backend `tox` + `flake8` (full plugin clean — note `tox` runs pytest only, so `flake8` is run separately).
>
> **Finding 1 was re-scoped per the author**: the per-IP rate limiter is dropped (rate limiting belongs at the edge proxy / HAProxy at this traffic level); the app keeps only the input-size sanity ceilings (10M) + a 5-minute `maxTimeMS` query bound. See Finding 1 below.
>
> New tests: backend added cases in `test_uncomputed_counts.py`, `test_property_values_batch.py`, `test_stubs.py`; frontend `math.test.ts`, `sequenceGuard.test.ts`, `stubPerf.test.ts`, `properties.test.ts`, `annotationsAPI.test.ts`, plus added cases in `annotationListFilters`, `annotationStubUtils`, `annotationUpdate`, `propertyValues`, `loadingLabels`, `annotationStubs`, `AnnotationViewer`, `AnnotationList`.
>
> **Still needs a human in-browser check** (display-only, not assertable in jsdom): Finding 16 — change a filter while on server-list page 3 and confirm the footer snaps to page 1.

## Author clarifications (resolved questions)

- **Count-endpoint failure (Finding 5):** *Recoverable.* A failed annotation count must NOT route a large dataset into the full-fetch branch. Treat a count failure as "over threshold" → stub-only mode (the safe path), rather than `0` → full fetch (the OOM path). Optionally retry, but the fallback must be stub-mode, not full-fetch.
- **Anonymous access (Finding 1):** *Real.* Datasets can be made public, so the new aggregation endpoints are reachable unauthenticated. Rate limiting / abuse mitigation must be handled, not just documented.

## Fix checklist

Medium (do before merge):
- [x] 1 — Rate-limit new public aggregation endpoints
- [x] 2 — Validate `uncomputedCounts` input
- [x] 3 — Validate `batch` `propertyPaths` input
- [x] 4 — Cancel debounced/throttled fns on AnnotationViewer unmount
- [x] 5 — `getAnnotationCount` failure → stub-mode, not full-fetch (OOM fix)
- [x] 6 — Add stale-response guard to property-value fetch
- [x] 7 — Reset `discoveredPropertyPaths` on dataset switch
- [x] 8 — Dev-gate `stubPerf` + bound `hydrateLatencyMs`

Low:
- [x] 9 — `findByAnnotationIds` consistent doc shape
- [x] 10 — Move `hydrate` dataset-discovery aggregation to a model helper
- [x] 11 — Share `_isValidPropertyPath` / `_validateListInputs` helpers
- [x] 12 — Extract `stubFromAnnotation(...)` helper (4 dup sites)
- [x] 13 — Extract `createSequenceGuard()` (2 dup sites)
- [x] 14 — Avoid double stub-map / spatial-index build under threshold
- [x] 15 — Avoid full-dataset id array allocation per frame
- [x] 16 — Bind server page index to the table footer
- [x] 17 — Let checkbox read selection reactively (don't bake `isSelected`)
- [x] 18 — Extract `<PropertyColumnHeader>` (dup header markup)
- [x] 19 — `stubPerf.reset()` should reset `cacheCap`
- [x] 20 — Extract shared `clamp(value, lo, hi)`
- [x] 21 — Replace `as unknown as IAnnotation` double-cast with `Partial<IAnnotation>`

Nit:
- [x] 22 — Replace `JSON.stringify` sort compare with `sortsEqual`
- [x] 23 — Type/validate `getUncomputedCounts` response
- [x] 24 — Tighten `idsNeedingHydration` map param types
- [x] 25 — Move orphaned docblock in `camera.ts`
- [x] 26 — Add NaN-intent comment to `!(viewportExtent > 0)`

---

## Findings

### Finding 1 — Public aggregation endpoints have no rate limiting · Medium · Security/Access Control

**Files:** `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py:527` (`uncomputedCounts`), plus `stubs` / `hydrate` / `listAnnotations` / `listAnnotationIds`; `server/api/propertyValues.py:143` (`batch`).

All `@access.public`; each runs an `allowDiskUse=True` aggregation (full-collection `$lookup` / `$facet` / `$objectToArray`+`$unwind`). **Author confirmed datasets can be public**, so an unauthenticated client can trigger multi-second aggregations over a 700K-annotation collection.

**Fix:** Add rate limiting / abuse mitigation to the new public aggregation endpoints. Options to weigh during the fix:
- Per-IP / per-token rate limit on the heavy endpoints.
- Cap aggregation cost (e.g. reject `uncomputedCounts` when `properties` list is huge; cap `batch` id count; cap page size — `listPage` already caps at 200).
- Confirm `allowDiskUse` is necessary; consider a `maxTimeMS` guard so a single query can't run unbounded.

Not a regression (`find`/`count` were already public), but these materially raise cost-per-request — handle them.

**✅ Resolved (scoped per author, 2026-06-23).** Request-*rate* limiting is deferred to the edge proxy (HAProxy stick-tables), which is the right layer for it and avoids a weak per-process in-app limiter at this traffic level. What remains in the app are the two mitigations the proxy *cannot* do, kept as cheap correctness/hygiene regardless of abuse:
1. **Input-size sanity ceilings** — `MAX_UNCOMPUTED_PROPERTIES` and `MAX_ANNOTATION_IDS`, both `10_000_000`, on `uncomputedCounts` / `batch` / `hydrate`. These are garbage guards (real usage is orders of magnitude below: hydration budget ~40K ids, datasets < 1K properties), not tuning knobs; oversized → `400`. (`listPage` already caps page size at 200.)
2. **`maxTimeMS` guard** — every heavy aggregation routes through `Annotation._aggregate(...)` (or carries `maxTimeMS` explicitly for the API-layer `stubs` pipeline), bounding any single query at `AGGREGATION_MAX_TIME_MS` = **300000 (5 min)** with `allowDiskUse` retained — comfortably above the slowest legitimate query, a hard ceiling against a runaway one pinning a Mongo connection.

The per-IP rate limiter (`server/helpers/rate_limit.py` + `enforceAnonymousRateLimit` calls + `test_rate_limit.py`) was **removed**. The cap tests moved to their endpoints' suites: `test_uncomputed_counts.py` (properties cap), `test_property_values_batch.py` (id cap), `test_stubs.py` (hydrate id cap) — each shrinks the cap via `monkeypatch` and asserts `400`.

---

### Finding 2 — `uncomputedCounts` does no input validation → uncaught 500s · Medium · Redundant Validation / Error Handling

**File:** `server/api/annotation.py:527-536`; model loop does `counts[pf["id"]]`.

```python
def uncomputedCounts(self, body):
    datasetId = ObjectId(body["datasetId"])   # KeyError if missing; InvalidId → 500 not 400
    Folder().load(datasetId, user=..., level=AccessType.READ, exc=True)
    properties = body.get("properties") or []
    return self._annotationModel.uncomputedCounts(datasetId, properties)
```

The model later does `pf["id"]` unconditionally and `pf.get("tags")` (expects a dict). `{"properties": [{}]}`, `{"properties": [{"id": 5}]}`, or a malformed `datasetId` → uncaught `KeyError` / `TypeError` / `bson.errors.InvalidId` → 500 on a public endpoint.

**Fix:** Validate at the API boundary, mirroring `_validateListInputs`:
- `datasetId` present + valid ObjectId; map `bson.errors.InvalidId` → `RestException(code=400)` (remember: `InvalidId` is a `BSONError`, **not** a `ValueError`).
- `properties` is a list of dicts, each with a non-empty string `id` (optional `shape` str / `tags` dict).

**✅ Resolved.** `uncomputedCounts` now uses `requireObjectId(body.get("datasetId"), "datasetId")` (missing/malformed → 400, `InvalidId` caught explicitly) and `validateUncomputedCountsProperties(properties)` (each entry a dict with a non-empty string `id`; optional `shape` str / `tags` dict) — both in the new `server/helpers/validation.py`. Validation runs before the `Folder().load` and the aggregation. Tests: `test_uncomputed_counts.py` (malformed/missing datasetId, missing/non-dict/non-string id, properties-not-a-list, tags-not-a-dict → all 400).

---

### Finding 3 — `batch` property-values endpoint doesn't validate `propertyPaths` → 500 / projection injection · Medium · Redundant Validation / Error Handling

**File:** `server/api/propertyValues.py:143-156`; model `server/models/propertyValues.py:140-144`.

`propertyPaths` flows into `findByAnnotationIds`, which builds `"values." + ".".join(path)`. A non-list-of-lists-of-strings (e.g. `[["a", 5]]`) raises `TypeError`; a component containing `.` / `$` silently builds a wrong/injected projection key.

**Fix:** Validate `propertyPaths` with `_isValidPropertyPath` (the same helper `listAnnotations` uses). Pairs with Finding 11 — move that helper somewhere both API files can import it.

**✅ Resolved.** `batch` now calls `validatePropertyPaths(propertyPaths)` (shared helper — same `isValidPropertyPath` the list endpoint uses; rejects non-list-of-lists, non-string components, and `.`/`$` injection). `datasetId` and each `annotationId` go through `requireObjectId` (malformed → 400 instead of 500). Tests: `test_property_values_batch.py` (propertyPaths not-a-list / element-not-a-list / non-string component / `.`/`$` injection / malformed datasetId → 400; empty propertyPaths list still OK).

---

### Finding 4 — Debounced/throttled fns in AnnotationViewer aren't cancelled on unmount · Medium · Error Handling

**File:** `src/components/AnnotationViewer.vue:3564` (`onBeforeUnmount`); fns: `updateVisibilityDebounced` (:3392), `restyleAnnotationsThrottled` (:1502). `onMounted` invokes `updateVisibilityDebounced()`.

Current `onBeforeUnmount` unbinds events and cancels the idle callback, but does **not** cancel the debounce/throttle. A trailing fire after teardown (navigate away right after a pan) calls `props.annotationLayer.map()` on a dead layer and dispatches store actions against a torn-down view. The prior OOM bug here was a missing unmount; sibling `AnnotationList.vue:614` already cancels its `debouncedServerRefetch`.

**Fix:**
```ts
onBeforeUnmount(() => {
  updateVisibilityDebounced.cancel();
  restyleAnnotationsThrottled.cancel();
  drawAnnotations.cancel?.();      // pre-existing, cancel while here
  drawTooltips.cancel?.();         // pre-existing
  handleValueOnMouseMoveDebounce.cancel?.(); // pre-existing, if present
  // ...existing unbinds
});
```
Confirm each is a lodash debounce/throttle exposing `.cancel()`.

**✅ Resolved.** `onBeforeUnmount` now cancels all five (`updateVisibilityDebounced`, `restyleAnnotationsThrottled`, `drawAnnotations`, `drawTooltips`, `handleValueOnMouseMoveDebounce`) — all real lodash `debounce`/`throttle` (`import { throttle, debounce } from "lodash"`), so `.cancel()` exists. Exposed `updateVisibilityDebounced`/`restyleAnnotationsThrottled` (the other three already were) for the test. Test: `AnnotationViewer.test.ts` "cancels all pending debounced/throttled callbacks so none fire after teardown" (spies each `.cancel`, unmounts, asserts all called).

---

### Finding 5 — `getAnnotationCount` failure routes large datasets to full-fetch (OOM) · Medium · Error Handling

**File:** `src/store/AnnotationsAPI.ts:370-375`; consumed at `src/store/annotation.ts:1666-1669`.

```ts
async getAnnotationCount(datasetId: string): Promise<number> {
  return this.client.get("upenn_annotation/count", { params: { datasetId } })
    .then((res) => res.data.count)
    .catch(() => 0);   // 0 <= stubThreshold → FULL fetch (OOM path)
}
```

**Author confirmed failure is recoverable, but must NOT trigger a full fetch.** A transient count failure on a huge dataset returns `0`, takes the full-fetch branch, and tries to load every annotation — the exact OOM scenario stub-mode exists to prevent.

**Fix:** On count failure, fall back to **stub-only mode**, not full-fetch. Practical approaches:
- Let `getAnnotationCount` reject (drop the `.catch`), and in `fetchAnnotations` catch a count failure specifically and route to the stub-only branch (treat as "over threshold").
- Or return a sentinel that `fetchAnnotations` reads as "over threshold" (e.g. `Infinity`) instead of `0`.
- Either way `logError` the failure. Optional: one retry before falling back.

Make sure the chosen approach keeps the floating `connectionsPromise` (`annotation.ts:1663`) safe (no unhandled rejection).

**✅ Resolved.** `getAnnotationCount` no longer swallows errors to `0` — it rejects (the doc comment spells out why a silent 0 is the OOM trigger). `fetchAnnotations` wraps the count in try/catch: on failure it `logError`s and sets `count = Number.POSITIVE_INFINITY`, which is `> stubThreshold` → the stub-only branch (the safe path). `annotationLoadingTitle` now returns a count-less "Loading annotations…" for a non-finite count so the bar doesn't read "Infinity". `connectionsPromise` stays awaited (the stub-only branch awaits it in its `Promise.all`), so no unhandled rejection. The other consumer, `DatasetInfo.vue`, now `.catch(() => null)`s the count so a failure shows "unknown" rather than crashing. Tests: `annotationsAPI.test.ts` (resolves count / rejects on failure), `loadingLabels.test.ts` (Infinity → count-less title); `DatasetInfo.test.ts` (17) still green.

---

### Finding 6 — Property-value fetch has no stale-response guard (race) · Medium · Error Handling

**File:** `src/store/properties.ts:804` (`ensureVisiblePropertyValues`), `_fetchVisiblePropertyValues` at `:983`.

The hydration path (abortable) and the two id-fetch paths (`requestSeq`-guarded) protect against out-of-order responses; this one calls `mergeVisiblePropertyValues({ newEntries, keepIds })` with no guard. On rapid pans, a slow earlier fetch resolving last prunes freshly-fetched entries scoped to a stale `keepIds`.

**Fix:** Route through a `requestSeq` token or a `createDebouncedAbortableTask` like the hydration fetch (see `src/utils/debouncedAbortable.ts`). If Finding 13's `createSequenceGuard()` is built, reuse it here.

**✅ Resolved.** Reuses Finding 13's `createSequenceGuard()`. `ensureVisiblePropertyValues` claims a token up front (superseding any in-flight fetch, and making the synchronous prune reflect the latest set); `_fetchVisiblePropertyValues` carries the token and only merges if `guard.isCurrent(token)` after the await. Test: `properties.test.ts` "does not let a slow earlier fetch overwrite a newer fetch scoped to a different visible set" (+ "applies the latest fetch result").

---

### Finding 7 — `discoveredPropertyPaths` not cleared on dataset reset · Medium · Pattern Consistency

**File:** `src/store/properties.ts:194` (`resetPropertyStateImpl`).

`displayedPropertyPaths` and `uncomputedCounts` are reset; the sibling lazy-mode field `discoveredPropertyPaths` is not. On dataset switch, the previous dataset's paths persist until the next `fetchPropertyPathsSample`; `computedPropertyPaths` reads them in the interim (largely masked by the `getPropertyById` filter, but inconsistent).

**Fix:** `this.discoveredPropertyPaths = markRaw([]);` in `resetPropertyStateImpl`.

**✅ Resolved.** Added `this.discoveredPropertyPaths = markRaw([]);` to `resetPropertyStateImpl` (next to the `displayedPropertyPaths`/`uncomputedCounts` resets). Test: `properties.test.ts` "clears discoveredPropertyPaths along with the other per-dataset paths".

---

### Finding 8 — `stubPerf` instrumentation runs always-on in production · Medium · Performance / Dead code

**File:** `src/utils/stubPerf.ts:167-172`; hot-path callsites `src/store/annotation.ts:2342-2396`, `src/components/AnnotationViewer.vue:3405`.

```ts
export const stubPerf = new StubPerf();
if (typeof window !== "undefined") {
  (window as unknown as { __stubPerf: StubPerf }).__stubPerf = stubPerf;
}
```

Header says "Dev-only," but it's not gated — counters increment on per-pan/per-hydrate hot paths, and `hydrateLatencyMs` (`push` at :93, cleared only by `reset()`) grows unbounded for the tab's lifetime — a slow leak on a branch whose purpose is memory hygiene.

**Fix:**
- Gate behind `import.meta.env.DEV` so the module tree-shakes from prod builds (and/or make the track* methods no-ops in prod).
- Cap `hydrateLatencyMs` to a ring buffer of the last N samples.
- Replace `as unknown as { __stubPerf: StubPerf }` with a declared global type (e.g. `declare global { interface Window { __stubPerf?: StubPerf } }`).
- This also moots the `console.log` usage at `:86` and `:144-162` (was Finding U3) and the `cacheCap` reset gap (Finding 19) for prod.

**✅ Resolved.** Added `enabled = import.meta.env.DEV`; every `track*` method early-returns when disabled, so the per-pan/per-hydrate hot paths are no-ops (and the verbose `console.log` never runs) in prod. `trackLatency` now keeps a ring buffer of the last `MAX_LATENCY_SAMPLES` (200) — no unbounded growth. `Window.__stubPerf?` is a proper `declare global` augmentation (no `as unknown` cast). `StubPerf` is exported for unit testing. Tests: `stubPerf.test.ts` (ring-buffer cap, disabled no-op, enabled counters, cacheCap reset).

---

### Finding 9 — `findByAnnotationIds` returns different doc shapes depending on projection · Low · Pattern Consistency

**File:** `server/models/propertyValues.py:140-154`.

With `propertyPaths`: docs include `annotationId` + projected values, drop `_id`/`datasetId`. Without it: full docs. Confirm the frontend keys only on `annotationId` and doesn't rely on `_id`/`datasetId` when projecting; if it might, include a consistent minimal field set in both branches.

**✅ Resolved.** Confirmed the only consumer (`PropertiesAPI.getPropertyValuesForIds`) maps each doc to `{annotationId, values}` and keys on nothing else. Also made the shape consistent regardless of projection: the no-projection branch now projects `["annotationId", "values"]` (instead of returning full docs), so both branches return the same minimal field set and neither leaks `datasetId`. Test: `test_property_values_batch.py` "testConsistentDocShapeWithAndWithoutPaths".

---

### Finding 10 — `hydrate` dataset-discovery aggregation built in API layer · Low · Raw PyMongo / Layer smell

**File:** `server/api/annotation.py` (`hydrate`).

`collection.aggregate()` is the allowed pipeline exception, but constructing the `$group` dataset-discovery pipeline in the API method reads better as a model helper, e.g. `self._annotationModel.distinctDatasetIds(objectIds)`, keeping the API method free of pipeline construction.

**Fix:** Move the aggregation into a small model method; call it from `hydrate`.

**✅ Resolved.** Added `Annotation.distinctDatasetIds(objectIds)` to the model; both `hydrate` and `deleteMultiple` (which had the identical inline `$match`/`$group` block) now call it, so neither API method constructs the pipeline. Test: `test_stubs.py::TestDistinctDatasetIds` (distinct datasets, empty input, nonexistent ids); existing hydrate + deleteMultiple endpoint tests still green.

---

### Finding 11 — `_isValidPropertyPath` / `_validateListInputs` should be shared helpers · Low · Code Duplication

**File:** `server/api/annotation.py:23-138` vs `server/api/propertyValues.py`.

`propertyValues.py:batch` needs the same path validation (Finding 3). Per CLAUDE.md, extract these validators to `server/helpers/` (alongside `serialization.py`'s `orJsonDefaults`, e.g. a `validation.py`) rather than importing across API modules. `_streamJsonArray` is also a candidate for sharing if `batch` ever streams large value sets.

**✅ Resolved.** Created `server/helpers/validation.py` with `requireObjectId`, `isValidPropertyPath`, `validatePropertyPaths`, `validateListInputs`, and `validateUncomputedCountsProperties`. `annotation.py` and `propertyValues.py` both import from it; the local `_isValidPropertyPath`/`_validateListInputs` copies in `annotation.py` are removed. `_streamJsonArray` left in `annotation.py` (batch doesn't stream yet — defer until needed). Existing `test_server_list.py` (34) still green against the moved validators.

---

### Finding 12 — Duplicated stub-construction object literal (4 copies) · Low · Code Duplication

**File:** `src/store/annotation.ts:662, 697, 743, 807`.

Identical 8-field stub literal (`{ id, centroid, location, shape, channel, tags, color, estimatedRadius }`) hand-written in four mutations; one already diverges (`value.coordinates` vs `annotation.coordinates`).

**Fix:** Extract `stubFromAnnotation(annotation, centroid): IAnnotationStub` into `src/utils/annotation.ts` (next to `estimateAnnotationRadius`); call from all four sites. Re-verify the `coordinates` source is correct after consolidating.

**✅ Resolved.** `stubFromAnnotation(annotation, centroid)` added to `src/utils/annotation.ts`; all four mutations (`addAnnotationImpl`, `addAnnotationsImpl`, `setAnnotation`, `setAnnotations`) now call it. The `value`/`annotation` naming difference was cosmetic (same object); coordinates source confirmed correct. Tests: `annotationStubUtils.test.ts` "stubFromAnnotation"; existing `annotationStubs.test.ts` (45) still green.

---

### Finding 13 — Duplicated monotonic `requestSeq` stale-guard pattern · Low · Code Duplication / Missing Abstractions

**File:** `src/store/annotationListServer.ts:87-92,145-162` and `src/store/filters.ts:225-254`.

Both implement "increment seq, capture, only apply if `seq === this.seq`."

**Fix:** Extract a `createSequenceGuard()` util. Reuse it in Finding 6 (which currently lacks any guard).

**✅ Resolved.** `createSequenceGuard()` added to `src/utils/sequenceGuard.ts` (`next()` / `isCurrent(token)`). `annotationListServer.ts` and `filters.ts` now use module-level guards instead of Vuex `requestSeq` state + increment mutations (the counters were never read by the UI). Tests: `sequenceGuard.test.ts`; existing server/filter store tests still green. (Finding 6 reuses it — see below.)

---

### Finding 14 — Redundant stub-map + spatial-index rebuild under threshold · Low · Performance

**File:** `src/store/annotation.ts:1669-1680` (`fetchAnnotations`, `count <= stubThreshold`).

`setAnnotations(...)` builds the full stub map/centroids and `bulkLoad`s the spatial index; `setStubsFromServer(stubs)` then overwrites those and `bulkLoad`s again over the same ids. For ≤10K datasets the O(N) build runs twice.

**Fix:** Have `setAnnotations` skip stub/index construction when a `setStubsFromServer` follows, or fold the server-stub override into one mutation.

**✅ Resolved.** `setAnnotations` now accepts an array (unchanged for all existing callers) or `{ values, serverStubsFollow }`. With `serverStubsFollow: true` it builds only `annotations[]` + `annotationIdToIdx` and skips the centroid/stub-map/spatial-index build (which the immediately-following `setStubsFromServer` does from server data). The under-threshold `fetchAnnotations` branch passes the flag only when server stubs are actually present (else it falls back to the full client build). Verified by `pnpm tsc` + the full suite (the under-threshold path's output is unchanged — `setStubsFromServer` produces the same final state).

---

### Finding 15 — `updateVisibility` allocates a full-dataset id array per frame · Low · Performance

**File:** `src/components/AnnotationViewer.vue:3346-3350`; watch at `:3408`.

`.map((a) => a.id)` materializes a fresh 700K-string array on every XY/Z/Time change. Not per-animation-frame, but consider passing the source array/Set and deriving ids once in the store (or having the store maintain the Set).

**✅ Resolved.** `updateVisibilityAndHydration`'s `filteredIds` is now optional: when a client filter is active the component still passes the (smaller) filtered id array, but with no filter it omits it and the action walks its own `annotationStubs` map directly — no full-dataset id array materialized per frame. Behavior-preserving (same current-frame set either way). Test: `annotationStubs.test.ts` "derives ids from the stub map when filteredIds is omitted".

---

### Finding 16 — Server page reset not reflected in the data-table footer · Low · Pattern Consistency

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:608` (filter watch sets `page:1`) vs `v-data-table-server` at `:195` (no `v-model:page`).

Changing a filter while on page 3 resets the store to page 1 and refetches page-1 rows, but Vuetify's footer may still show "Page 3" (display desync; correct rows render).

**Fix:** Bind `v-model:page` / `:page="serverPage"`. Verify in-browser before/after.

**✅ Resolved.** `<v-data-table-server>` now binds `:page="annotationListServer.page"` and `:items-per-page="annotationListServer.pageSize"`, so a store-driven page reset (the filter watch's `setOptions({ page: 1 })`) is reflected in the footer. The existing `onServerOptions` no-op guard (now using `sortsEqual`) prevents a redundant refetch when the bound page round-trips back. ⚠️ Footer display is a Vuetify-internal concern not asserted in jsdom — verify in-browser (change a filter while on page 3 → footer should snap to page 1).

---

### Finding 17 — `serverRowItems` rebuilds the whole page array on selection change · Low · Performance

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:321-329`.

Baking `isSelected` into each row item makes the computed depend on `selectedAnnotationIds`, so every selection toggle re-maps and re-spreads up to 200 rows.

**Fix:** Let the row checkbox read selection reactively (e.g. `annotationStore.isAnnotationSelected(row.id)` in the row component) instead of precomputing `isSelected` in the array. Bounded by the 200-row cap, so low priority.

**✅ Resolved.** `isSelected` removed from both row-item builders (`serverRowItems` and the client `annotationToItem`) and from the `IAnnotationListItem`/`IAnnotationListRowItem` types. `AnnotationListRow.vue`'s checkbox now binds `:model-value="annotationStore.isAnnotationSelected(item.annotation.id)"` (reactive read), so toggling a selection no longer re-maps/re-spreads the page array — only the touched checkbox bindings re-evaluate. `selectedItems` updated to filter via `isAnnotationSelected`. Test: `AnnotationList.test.ts` "reads selection reactively from the store rather than baking it into items".

---

### Finding 18 — Duplicated property-header slot markup across the two tables · Low · Code Duplication

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:218-245` (server table) vs the client `v-data-table` equivalent.

The custom property-header template (label + `getSortIcon` + remove `v-btn`) is byte-for-byte identical in both tables. The row body was already extracted to `AnnotationListRow.vue`; the header block is the remaining copy-paste.

**Fix:** Extract a `<PropertyColumnHeader>` component (or a shared `#header` render helper).

**✅ Resolved.** Extracted `src/components/AnnotationBrowser/PropertyColumnHeader.vue` (label + sort icon + remove button, with the `.property-header-*` scoped styles moved into it). Both tables use it via `<property-column-header :title :sortable :sort-icon @remove>`. It takes plain props (the parent computes the icon with the slot's `getSortIcon`) rather than the column object + function, so it stays decoupled from Vuetify's internal `InternalDataTableHeader` type. `pnpm tsc` clean; `AnnotationList` tests (283) green.

---

### Finding 19 — `stubPerf.reset()` does not reset `cacheCap` · Low · Error Handling / Correctness

**File:** `src/utils/stubPerf.ts:64-76`.

`reset()` zeroes every counter except `cacheCap`, so a `report()` after `setDataset()` but before the first `trackCache` reports the previous dataset's cap.

**Fix:** Add `this.cacheCap = 0;` to `reset()`. (Subsumed if Finding 8 dev-gates the module, but cheap to do regardless.)

**✅ Resolved.** `reset()` now zeroes `cacheCap`. Test: `stubPerf.test.ts` "reset() also clears cacheCap".

---

### Finding 20 — `clamp` reimplemented in three sibling util files · Low · Code Duplication / Missing Abstractions

**File:** `src/utils/visibilityBudget.ts:28-30`, `src/utils/visibilityConfigBounds.ts:45` (inline in `clampField`), `src/utils/renderCoverage.ts:37` (`Math.min(1, Math.max(0, x))`).

**Fix:** Extract a single `clamp(value, lo, hi)` into a shared `src/utils/math.ts`; import in all three. (Check whether a `clamp` util already exists before adding one.)

**✅ Resolved.** No pre-existing `clamp` util; added `src/utils/math.ts` `clamp(value, lo, hi)` and imported it in `visibilityBudget.ts`, `visibilityConfigBounds.ts` (`clampField`), and `renderCoverage.ts`. Tests: `math.test.ts`; the three consumers' existing tests still green.

---

### Finding 21 — `buildStubUpdates` uses `as unknown as IAnnotation` double-casts · Low · Type Safety

**File:** `src/utils/annotationUpdate.ts:67-68`.

```ts
const before = { ...stub, tags: [...stub.tags] } as unknown as IAnnotation;
const after  = { ...stub, tags: [...stub.tags] } as unknown as IAnnotation;
```

A stub lacks `coordinates`/`name`, so it's force-cast through `unknown`. Safe today (`getAnnotationUpdatePatch` only diffs stub-carried fields), but silently passes `undefined` if `editFunction` ever touches `coordinates`.

**Fix:** Type the `editFunction` boundary as `(annotation: Partial<IAnnotation>) => void`, or document the precondition prominently.

**✅ Resolved.** `getAnnotationUpdatePatch` now accepts `Partial<IAnnotation>` (with an early `after.id === undefined → null` guard), so `buildStubUpdates` builds `before`/`after` as `Partial<IAnnotation>` with no `as unknown` cast. The single remaining `after as IAnnotation` at the `editFunction` call carries a prominent comment documenting the precondition (editFunction must only touch stub-carried fields in this path). Widening the whole `editFunction`/`updateAnnotationsPerId` contract to `Partial` was rejected — function-param contravariance (strictFunctionTypes) would break the three `(ann: IAnnotation) => void` callers in `AnnotationViewer.vue`. Tests: `annotationUpdate.test.ts` ("diffs partial (stub-shaped) annotations", "returns null when the partial annotation has no id").

---

### Finding 22 — `onServerOptions` compares sort objects via `JSON.stringify` · Nit · Pattern Consistency

**File:** `src/components/AnnotationBrowser/AnnotationList.vue:383-385`.

`JSON.stringify` equality is key-order-sensitive. Works today (both sides built by `mapSort`).

**Fix:** Small `sortsEqual(a, b)` helper comparing `type`/`key`/`order`.

**✅ Resolved.** `sortsEqual(a, b)` added to `src/utils/annotationListFilters.ts` (handles null, compares `type`/`order` and the `key` element-wise — string field vs `string[]` path). `onServerOptions` uses it instead of `JSON.stringify`. Tests: `annotationListFilters.test.ts` "sortsEqual".

---

### Finding 23 — `getUncomputedCounts` returns `response.data` unchecked · Nit · Type Safety

**File:** `src/store/PropertiesAPI.ts:85` (and the `as any[]` mappers in `AnnotationsAPI.ts:124-151`).

`return response.data;` coerced to declared `{[id]: number}` with no cast/validation.

**Fix:** Optional — add a light runtime/structural check or explicit typing at the boundary. Consistent-enough with the file's existing convention, so lowest priority.

**✅ Resolved.** Added `coerceUncomputedCounts(data: unknown)` to `src/utils/propertyValues.ts` (non-object → `{}`; drops non-finite-number values) and `getUncomputedCounts` returns it instead of raw `response.data`. The `as any[]` mappers in `AnnotationsAPI.ts` were left as-is (consistent with the file's `toStub`/`toAnnotation` convention, as the finding allows). Tests: `propertyValues.test.ts` "coerceUncomputedCounts".

---

### Finding 24 — `idsNeedingHydration` over-generic map params · Nit · Type Safety / Naming

**File:** `src/utils/annotation.ts:425-428`.

Params typed `ReadonlyMap<string, unknown>` but only `.has()` is used.

**Fix:** Use `ReadonlyMap<string, never>` or a `{ has(id: string): boolean }` interface to communicate "keys only, values unused."

**✅ Resolved.** `hydrated`/`stubs` params now typed `IHasKey` (`{ has(id: string): boolean }`) — communicates keys-only and also lets a `Set` be passed. Test: `annotationStubUtils.test.ts` "accepts any has-only collection (e.g. a Set)".

---

### Finding 25 — Orphaned docblock above `cameraRefreshNeeded` · Nit · Naming / Documentation

**File:** `src/utils/camera.ts:3-35`.

Two consecutive doc blocks precede `cameraRefreshNeeded`; the first (lines 3-18) actually describes `recenterCameraInfo` (defined below at `:65`).

**Fix:** Move the `recenterCameraInfo` docblock down to sit immediately above `recenterCameraInfo`.

**✅ Resolved.** The `recenterCameraInfo` docblock now sits immediately above `recenterCameraInfo`; only the hysteresis docblock precedes `cameraRefreshNeeded`. `camera.test.ts` (15) still green.

---

### Finding 26 — `!(viewportExtent > 0)` needs a NaN-intent comment · Nit · Simplification

**File:** `src/utils/camera.ts:50`.

The double-negative is deliberate — it also catches `NaN` (a `<= 0` rewrite would not).

**Fix:** Keep the form; add an inline `// also catches NaN` so a future "simplification" doesn't break it.

**✅ Resolved.** Added a comment above `if (!(viewportExtent > 0))` explaining the double-negative catches NaN (NaN comparisons are always false) → refresh-on-any-pan safe default.

---

## What's already done well (no action)

- No N+1 / looped DB or API calls anywhere — `$in` / `$facet` / aggregation / batch endpoints throughout.
- Access control intact on every new endpoint; `hydrate` checks access against the datasets the requested annotations actually belong to (no id-smuggling escalation); `exc=True` used consistently.
- Layer separation respected (models raise `ValueError`; API maps to `RestException(400)`); `bson.errors.InvalidId` caught explicitly; no broad `except Exception`.
- Genuine bug fix in `propertyValues.py` `annotationsRemovedEvent` (ObjectId normalization fixes property-value orphaning on bulk deletes).
- API calls correctly placed in `AnnotationsAPI.ts` / `PropertiesAPI.ts`; no raw `girderRest` in stores/components; no `console.*` in committed component code; no `as any`/`@ts-ignore` introduced; `pnpm tsc` clean.
- No frontend-compensating-for-backend dual-API fallbacks; new store state correctly isolated in `annotationListServer.ts`.
- `selectLargestBySize` / `selectRandomSubset` hot-path optimizations correct and documented; `debouncedAbortable.ts` has no abort/debounce race; `spatialIndex.ts` RBush wrapper handles reference-based removal correctly.

## Pre-existing (not introduced by this branch, no action required here)

- `getDatasetIdFromAnnotationListInBody` uses `load(annId, force=True)` without a justifying comment (`server/api/annotation.py:161`) — the real write check happens in `@recordable`'s dataset gate.
