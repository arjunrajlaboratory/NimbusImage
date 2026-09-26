# Selection summary — review findings

Tracker for the `/branch-review` round on `xenium-phase0` (2026-09-02). Feature record:
`SELECTION_SUMMARY.md`.

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| 1 | Medium | `SelectionSummaryDialog.vue` `refresh` | Sequence-guard token claimed after the no-dataset early return | fixed — token claimed first; test *"retires an in-flight request when a bail-out clears the summary"* |
| 2 | Medium | `models/annotation.py` `summarize` | Near-total property matches shipped two dataset-sized `$in` arrays | fixed — `_idSelector` picks `$in`/`$nin`-of-complement with the gate resolver's 2× rule, `None` when everything matches, `MAX_SUMMARY_CONSTRAINT_IDS` → 400; tests *"testMajorityMatchUsesComplementAndStaysCorrect"*, *"testOverBudgetIdClauseIs400"* |
| 3 | Medium | `xenium_common.py` `ensure_property` | `except Exception` around `register()` | fixed — removed; `register()` is idempotent so nothing legitimate raises |
| 4 | Low | `models/annotation.py` `_propertyStats` | Unconstrained statistics include orphaned value docs | deferred — excluding them costs a second full scan (measured: id set difference +2.6 s, `$lookup` +7.4 s, against a 1.5 s query); orphans are removed by the annotation-removal hook. Documented in the `summarize` docstring and `SELECTION_SUMMARY.md` |
| 5 | Low | `xenium_upload_polygons.py` | Skipped degenerate polygons left `None` ids that downstream scripts sent to the server | fixed — `cell_indices_with_annotations` skips them in the properties and cell-type scripts |
| 6 | Low | `api/annotation.py` | Filter-endpoint prologue copied three times | fixed — `_loadListRequest` used by `list`, `list/ids`, `summary` |
| 7 | Low | `SelectionSummaryDialog.vue` / `AnnotationCSVDialog.vue` | Stale-selection filtering duplicated | fixed — `annotationStore.resolvedSelectedAnnotationIds` |
| 8 | Nit | `SelectionSummaryDialog.vue` | Hand-rolled `join(".")` path key | fixed — `serializePropertyPath` / `deserializePropertyPath` exported from `src/utils/paths.ts`, `properties.ts` uses the shared one |
| 9 | Nit | `SelectionSummaryDialog.vue` | `as any` error extraction | fixed — `extractErrorMessage` from `src/utils/errors.ts` |
| 10 | Nit | `api/annotation.py` `summary` | Cap checked after O(n) path validation | fixed — `requireCountWithin` before `validatePropertyPaths` |
| Q | — | `_propertyStats` | NaN / Infinity handling | decided by the user: NaN is missing, Infinity is a value; test *"testNaNIsMissingButInfinityIsAValue"* |

Blast-radius notes for this round:
- *"The facet's total came from `$count`; now it still does, but the id clause may be `$nin`."* `_buildListMatchStages` already accepts ready-made `gateMatchClauses`, so the `$nin` form reuses the gate path; `_propertyStats` takes the same clause object, so both aggregations cannot disagree on membership.
- *"`validateListInputs` ran after offset/limit parsing in `listAnnotations`; now before."* Both produce 400s; no caller depended on the order.
- *"`serializePropertyPath` was private to `properties.ts`."* Same NUL separator; the Set/Map keys in `properties.ts` are unchanged.
