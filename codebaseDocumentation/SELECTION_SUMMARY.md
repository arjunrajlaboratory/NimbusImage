# Selection summary

**Status: implemented on `xenium-phase0` (Phase 0 of the spatial-transcriptomics
platform plan). Backend + frontend suites green; verified live on the 708,983-cell
Xenium lymph-node dataset.**

## What it is

Import/export menu → *Selection summary*. A dialog that reports, for the whole dataset,
the filtered objects, or the current selection:

- the object count,
- composition by tag (count and percentage per tag, sorted by count), and
- per-property statistics (n, mean, sample SD, min, max) for a picked set of property
  paths, defaulting to the columns shown in the Objects tab,

with a one-click CSV download. It is the "selection summary" of the platform plan §6:
with cell types stored as tags, one call answers "what is in this gate".

## Why server-side

The Analysis panel and the Objects tab already resolve filters and gates server-side
above 50K objects (`SERVER_GATING.md`); property values for most of the population never
reach the client. A summary computed client-side would be wrong (over the loaded subset)
or impossible (values not loaded). So the summary is one endpoint over the same filter
object the list endpoints accept, and it inherits gate definitions, tag/shape/location
filters, id constraints, and property filters unchanged.

## Backend

`POST /upenn_annotation/summary` — `server/api/annotation.py` `summary`,
`server/models/annotation.py` `summarize`.

Body `{datasetId, filters, propertyPaths}`. `filters` is the list-endpoint filter object
(validated by `validateListInputs`; gates resolved by `resolveListGateConstraints`);
`propertyPaths` is a list of path arrays, capped at `MAX_SUMMARY_PROPERTY_PATHS` (200).

Response:

```json
{
  "total": 289469,
  "tags": [{"tag": "cell", "count": 289469}, {"tag": "Endothelial Cell", "count": 62098}],
  "properties": [
    {"path": ["<propId>", "CD3E"], "count": 289469, "mean": 1.23, "std": 1.69, "min": 0, "max": 26}
  ]
}
```

Semantics:

- `tags` is sorted by count descending, then tag name.
- A property `count` is the number of matching annotations holding a **numeric** value at
  the path. Strings, nested objects, missing values, and **NaN** are skipped (NaN would
  poison a mean); **Infinity is a number and is kept**. `mean/min/max` are null at count 0;
  `std` is the sample standard deviation and is null below two values.
- Without any filter the statistics run over every value document of the dataset, so a
  value document orphaned by a deleted annotation counts until the removal hook cleans it.
  Excluding them would cost a second full scan per request (measured +2.6 s for an id set
  difference, +7.4 s for a `$lookup`, against a 1.5 s query), so this is accepted.
- An empty match is `total: 0`, `tags: []`, zeroed property entries — not an error. The
  client short-circuits an empty id constraint locally (`filtersMatchNothing`), as the
  other list calls do.

Cost model: the matching id set is resolved **at most once**, and the id clause both
aggregations share is the **smaller of the matched set and its complement**
(`_idSelector`, the gate resolver's 2× rule; no clause at all when everything matches).
Property filters need the property-value join (or the PV-driven scan `listIds` uses); the
first version ran that join for the tag facet and again for the statistics and took 21.6 s
on 709K cells. Now:

| Filters | Facet (total + tags) | Statistics |
|---|---|---|
| none | annotation scan | PV scan on `datasetId` |
| annotation fields only (tags, shape, location, ids, gates) | annotation scan with the match | PV `$in` / `$nin` from the selector |
| any property filter | annotation `$in` / `$nin` from the selector | PV `$in` / `$nin` from the same selector |

A clause larger than `MAX_SUMMARY_CONSTRAINT_IDS` (1M ids on the smaller side) is a 400
asking to narrow the filters, for the same 16 MB command-limit reason as the gate budget.

Measured on the lymph node (708,983 cells, 31-gene panel): all cells 1.9 s; one tag 1.5 s;
one property range 1.5 s (was 21.6 s); tag + property range 1.7 s.

## Frontend

`src/components/AnnotationBrowser/SelectionSummaryDialog.vue`, mounted from
`DataIOMenu.vue` next to Export CSV. `AnnotationsAPI.fetchAnnotationSummary` is the client.

- Scope radio: all / filtered / selected. "filtered" sends
  `annotationListServer.currentFilters`; "selected" sends one `idConstraints` set of
  `annotationStore.resolvedSelectedAnnotationIds` (the selection minus ids that no longer
  resolve, shared with the CSV export). On open the dialog picks the narrowest non-empty
  scope.
- Property picker: a multi-select over `propertyStore.computedPropertyPaths`, seeded with
  `displayedPropertyPaths`.
- One request per change of the request's inputs (open, scope, paths, and for "filtered"
  the filter signature). A sequence counter drops late answers from superseded requests.
- Download: client-side CSV with `Section,Name,Count,Fraction,Mean,SD,Min,Max` rows for
  `total`, each `tag`, and each `property`.

## Regression checklist

Each line names the test that holds it.

**Backend (`test/test_summary.py`)**
- Total and tag composition, sorted by count then name — *"testTotalAndTagComposition"*.
- Non-numeric and missing values are excluded from every statistic and from `count`; single
  values have null std — *"testPropertyStatsSkipNonNumericAndMissing"*.
- Annotation-field filters narrow both the facet and the statistics —
  *"testStatsFollowAnnotationFieldFilters"*.
- Property-only filters take the PV-driven path and still narrow both —
  *"testStatsFollowPropertyFilters"*.
- Mixed tag + property filters take the join path —
  *"testStatsFollowMixedFieldAndPropertyFilters"*.
- NaN is missing, Infinity is a value — *"testNaNIsMissingButInfinityIsAValue"*.
- A majority match is expressed as `$nin` of the complement and answers identically; a
  full match needs no clause — *"testMajorityMatchUsesComplementAndStaysCorrect"*.
- An over-budget id clause is a 400, not a BSON error — *"testOverBudgetIdClauseIs400"*.
- An empty match is zeros, not a 400/500 — *"testEmptyMatchIsZeroNotError"*.
- READ access on the dataset folder is required — *"testRequiresReadAccess"*.
- Malformed filters, unsafe path keys, and more than 200 paths are 400s —
  *"testRejectsMalformedInput"*.

**Client (`AnnotationsAPI.test.ts`, `SelectionSummaryDialog.test.ts`)**
- Request body shape — *"posts datasetId, filters and propertyPaths and returns the body"*.
- An empty id constraint is answered locally with zeros —
  *"answers an empty id constraint locally with zeroed statistics"*.
- Opening fires exactly one request, seeded with the displayed columns —
  *"opens on the whole dataset with the displayed columns when nothing is selected or filtered"*.
- Selection scope drops stale ids — *"prefers the selection, dropping ids that no longer resolve"*.
- Filtered scope sends the server filters and refetches on a signature change —
  *"uses the server list filters for the filtered scope and refetches when they change"*.
- Picker changes refetch — *"refetches when the property picker changes"*.
- A late answer from a superseded request is ignored —
  *"keeps the latest request's answer when an earlier one resolves late"*.
- A bail-out retires the request in flight — *"retires an in-flight request when a bail-out clears the summary"*.
- Server error messages surface in the dialog — *"shows the server's message when the request fails"*.
- CSV sections and the download call — *"downloads a CSV with total, tag and property sections"*.

**Process**
- Verify from a fresh page load on a dataset that actually has tags and property values
  (the lymph node: 28 cell-type tags, three nested properties). A dataset with one tag
  cannot show a sorting or percentage regression.
- After backend edits, `docker compose build girder && docker compose up -d girder` — a
  restart does not load new routes.
