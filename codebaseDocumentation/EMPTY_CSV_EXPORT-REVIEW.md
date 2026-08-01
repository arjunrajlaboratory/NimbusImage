# Empty-subset CSV export — review findings (PR #1299)

Codex rounds on `codex/fix-empty-csv-export`, 2026-08-01.
Round 1: head d634f5db (F1–F3). Round 2: head c1b4a05e (F4).

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
