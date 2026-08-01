# Empty-subset CSV export — review findings (PR #1299)

Codex rounds on `codex/fix-empty-csv-export`, 2026-08-01.
Round 1: head d634f5db (F1–F3). Round 2: head c1b4a05e (F4).
Round 3: head 4857c3eb (checklist below). Round 4: head 821b1e37 (F5).
Round 5: head a35b5481 (F6). Round 6: head 1492fc97 (store-level tests for
F5's deletion pruning — the dialog test mocks the store and could not catch
a pruning regression; `src/store/annotation-delete.test.ts` exercises the
real module).

## F1 (P1) — Stub-only mode loses the selected subset

`src/components/AnnotationBrowser/AnnotationCSVDialog.vue`

In stub-only mode `annotationStore.annotations` is empty by design, so the
"selected" (and "all") scopes computed from it yield `[]`, `isSubset` evaluates
`0 < 0` = false, and the download omits `annotationIds` — the backend then
exports every annotation despite the user's selection. The dialog's counts
(`allAnnotationCount`, `hasActiveFilter`) read `annotations.length` too, so the
radio labels show 0 and the filtered radio is wrongly disabled.

Fix: derive scopes from the stub-aware getters — `annotationsForIteration`
for the "selected"/"all" branches and `annotationCount` for every
`annotations.length` comparison. The preview generator already narrows stubs
via `isHydratedAnnotation`, so stubs flowing through `annotationsToExport` are
already handled downstream.

**Status:** fixed (this branch) — tests: `AnnotationCSVDialog.test.ts`
"stub-only mode" describe block.

## F2 (P2) — Empty subset still materializes all property values

`.../server/api/export.py` `_generateCsvLines`

The empty-subset guard lives in `_iterAnnotations`, but
`_getPropertyValues(datasetObjectId)` — a full property-values collection scan
into a dict — runs before it. A header-only export of a huge dataset still
pays the dataset-wide DB and memory cost. (Cost-before-guard pattern.)

Fix: return right after the header row when `parsedAnnotationIds` is an empty
list, before `_getPropertyValues`.

**Status:** fixed (this branch) — test:
`test_export.py::testEmptySubsetSkipsPropertyValueFetch`.

Noted, not done here: for small non-empty subsets `_getPropertyValues` still
loads the whole dataset's values; filtering it by the requested annotation ids
is a follow-up optimization.

## F3 (P2) — annotationIds entries can 500 on the public endpoint

`.../server/api/export.py` `exportCsv`

Codex's exact example (`{"annotationIds": false}`) is already a 400: Girder
validates the `jsonParam` schema (`jsonschema.validate` → `RestException`), so
non-list values and non-string items never reach the handler, and `requireList`
would be redundant. The real hole is malformed id *strings*: `["not-hex"]`
passes the schema and `ObjectId(aid)` raises uncaught `InvalidId` → 500.

Fix: convert with `requireObjectId` per entry and clamp with
`validateAnnotationIdCount`. Pattern sweep over the same endpoint pair found
the identical unguarded conversions:

- `exportCsv`: `ObjectId(datasetId)` (schema requires a string, not valid hex)
- `exportCsv`: `ObjectId(path[0])` in `_buildPropertyNameMap` for
  `propertyPaths`
- `exportJson` (the symmetric twin): `ObjectId(datasetId)` and
  `ObjectId(configurationId)` from query params

All converted at the API boundary via `requireObjectId` → 400.

**Status:** fixed (this branch) — tests:
`test_export.py::testExportCsvRejectsMalformedInput`,
`testExportJsonRejectsMalformedIds`.

## F4 (P2, round 2) — Selected export scanned every stub

`src/components/AnnotationBrowser/AnnotationCSVDialog.vue`

The F1 fix routed the "selected" scope through `annotationsForIteration`,
which in stub-only mode is an `Array.from` over the whole stub map — a
dataset-sized allocation and O(N) scan to pick out ids already sitting in
`selectedAnnotationIds`. (Cost-before-guard, again.)

Fix: `exportAnnotationIds` derives ids straight from the selection/filter
(never resolving objects), the download and count/preview-limit checks use
only ids/`annotationCount`, and annotation *objects* materialize solely for
the preview — which only runs within `PREVIEW_ANNOTATION_LIMIT` — resolved
per id via the new O(1) store getter
`annotationStore.getAnnotationOrStubFromId`.

**Status:** fixed (this branch) — regression test:
`AnnotationCSVDialog.test.ts` "selected-scope download never materializes the
stub iteration array" (a throwing `annotationsForIteration` accessor), plus
"selected-scope preview resolves stubs by id lookup".

## F5 (P2, round 4) — Stale selection ids could widen a subset to "all"

`AnnotationCSVDialog.vue` + `src/store/annotation.ts`

`deleteAnnotations` removed the annotation/stub but never pruned
`selectedAnnotationIds` (only the `deleteSelectedAnnotations` wrapper cleared
it), so a context-menu delete left the deleted id selected. With F4's
count-based subset check, 1 live + 1 stale selected id in a 2-annotation
dataset compared equal to `annotationCount` → `annotationIds` omitted →
whole dataset exported.

Fix, both layers: `deleteAnnotations` now prunes deleted ids from the
selection and clears a dangling `hoveredAnnotationId` (the same
delete-leaves-paired-state-dangling shape the connection list was flagged
for), and the dialog's selected scope filters ids through
`getAnnotationOrStubFromId` before the count comparison — covering stale
sources deletion pruning can't reach (e.g. undo).

**Status:** fixed (this branch) — test: `AnnotationCSVDialog.test.ts`
"stale selected ids never widen the export to the whole dataset".

## F6 (P2, round 5) — Filtered-scope count allocated the id array

`AnnotationCSVDialog.vue`

The filtered-scope twin of F4: `exportAnnotationCount` (evaluated on every
render for the count label and preview-limit guard) reached through
`exportAnnotationIds`, whose filtered branch maps the whole filtered array —
potentially hundreds of thousands of stubs — into a second dataset-sized id
array just to read its length. `annotationsToExport` also evaluated
`exportAnnotationIds` before its own filtered early-return.

Fix: the count reads `props.annotations.length` for the filtered scope (and
`annotationCount` for "all"); `annotationsToExport` checks the filtered
scope before touching `exportAnnotationIds`. The filtered id array is now
built exactly once, at download time.

**Status:** fixed (this branch) — test: `AnnotationCSVDialog.test.ts`
"filtered-scope count/preview guard never allocates the id array".

## Regression checklist

One line per invariant, each naming the test that holds it. When changing the
CSV export dialog, the export endpoints, or the annotation store's stub
getters: re-check these. Frontend tests live in
`src/components/AnnotationBrowser/AnnotationCSVDialog.test.ts` (CSV) and
`src/store/ExportAPI.test.ts` (API); backend tests in
`upenncontrast_annotation/test/test_export.py`.

### Subset correctness (which rows end up in the file)

- [ ] "Selected" scope exports exactly the selected ids in stub-only mode —
  CSV: *"selected scope sends the selected ids, not an omitted field"*
- [ ] "Selected" scope exports the selected ids in full mode —
  CSV: *"download sends the selected subset's ids"*
- [ ] "Filtered" scope exports the filtered ids in stub-only mode —
  CSV: *"filtered scope sends the filtered ids"*
- [ ] "All" scope omits `annotationIds` (full and stub-only) —
  CSV: *"download calls exportAPI.exportCsv with correct params"*,
  *"all scope still omits annotationIds"*
- [ ] Stale ids lingering in the selection (delete/undo) are dropped before
  the subset-vs-whole-dataset comparison —
  CSV: *"stale selected ids never widen the export to the whole dataset"*
- [ ] An explicitly empty subset survives the API layer (omitted field ≠
  empty array) — ExportAPI: *"omits annotationIds when no subset is
  supplied"*, *"preserves an explicitly empty annotation subset"*
- [ ] The endpoint distinguishes omitted / subset / empty —
  backend: *"testExportCsvPreservesExactAnnotationSubset"*,
  *"testIterAnnotationsDistinguishesNoneFromEmpty"*
- [ ] Dialog counts and radio enablement come from the stub-aware
  `annotationCount` —
  CSV: *"counts come from the stub-aware annotationCount"*

### Destructive actions (deletion must not leave dangling id state)

- [ ] Deleting prunes the deleted ids from `selectedAnnotationIds` (full
  mode) — store: *"prunes deleted ids from the selection in full mode"*
- [ ] Deleting prunes selection, hover, and the stub map in stub-only mode —
  store: *"prunes selection, hover, and the stub map in stub-only mode"*
- [ ] Deleting the hovered annotation clears `hoveredAnnotationId` —
  store: *"clears the hovered id when the hovered annotation is deleted"*
- [ ] Deleting an unrelated annotation preserves selection and hover —
  store: *"keeps an unrelated hovered id and selection"*

### Cost (no visible behavior — regresses silently)

- [ ] A subset download never materializes the stub iteration array
  (`annotationsForIteration` is dataset-sized in stub-only mode) —
  CSV: *"selected-scope download never materializes the stub iteration
  array"*
- [ ] Preview resolves annotation objects per id (O(1) lookups bounded by
  `PREVIEW_ANNOTATION_LIMIT`), never by scanning —
  CSV: *"selected-scope preview resolves stubs by id lookup"*
- [ ] The filtered-scope count/preview guard reads a length, never building
  the dataset-sized id array (built exactly once, at download) —
  CSV: *"filtered-scope count/preview guard never allocates the id array"*
- [ ] An empty-subset export skips the dataset-wide property-values scan —
  backend: *"testEmptySubsetSkipsPropertyValueFetch"*

### Boundary validation (public endpoints, 400 not 500)

- [ ] Malformed `annotationIds` entries, `datasetId`, and `propertyPaths`
  property ids on `/export/csv` are a clean 400 —
  backend: *"testExportCsvRejectsMalformedInput"*
- [ ] The `/export/json` twin rejects malformed `datasetId` and
  `configurationId` the same way —
  backend: *"testExportJsonRejectsMalformedIds"*

### Process rules this feature proved

- When a rule is added to one export scope, check its twins (all/filtered/
  selected; download/preview/counts) — F1 and F4 were both one-of-N-paths
  misses.
- Put the cheap check (id counts) before the expensive work (object
  materialization); validate ids at the API boundary because the CSV body
  streams lazily and cannot 400 mid-stream.
