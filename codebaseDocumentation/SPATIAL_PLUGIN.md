# Spatial plugin (`upenncontrast_spatial`)

**Status: Phase 1 of the spatial-transcriptomics platform plan, implemented on
`xenium-phase0` (2026-09-02). Plugin, Python accessor and frontend suites green; verified
live on the 708,983-cell × 4,624-gene Xenium lymph-node store.**

The plan this implements: `~/code/nimbusimage_xenium_eval/reference_material/
xenium-platform-architecture-plan.md` §2 and §10.

## What it is

A dataset folder may hold one `spatial.zarr.zip` item: the per-cell expression table of a
spatial-transcriptomics dataset as an AnnData-layout zarr store, zipped. This plugin
registers that item per dataset and serves it, so the full matrix (3.28 billion values for
the lymph node — 80 GB if it were Mongo property values) lives as one file while the
interactive machinery keeps working on Mongo.

Why its own plugin: the store, its registry, the endpoints, the open-handle cache, and
later the transcript tiles and recompute workers are their own nouns with their own
dependency (`zarr`); keeping them out of `upenncontrast_annotation` keeps that package
from growing further. It is installed alongside the annotation plugin and
`girder-claude-chat` in `devops/girder/Dockerfile`.

## Row identity: `obs.annotation_id` only

Rows join to cell annotations through the store's `obs.annotation_id` column and nothing
else — the annotation schema is untouched. `SpatialStore` sorts that column once per open
store and answers annotation → row with `searchsorted` (one vectorized call per gate);
row → annotation is an array read. `GET spatial/{datasetId}?verify=true` reports `liveAnnotations`,
the rows that still resolve, so an orphaned table (polygons deleted and re-uploaded) is
visible and the remedy is "rebuild with the import script".

## Store layout

Written by `anndata` (zarr v2) from `xenium_build_spatial_store.py` in the `xenium-ingest`
skill; read by plain `zarr` 2 on the server (already in the Girder image via large_image).

| Path | Content |
|---|---|
| `X` | counts, cells × genes, `csc_matrix` — one contiguous slice per gene |
| `layers/X_csr` | the same counts as `csr_matrix` — one slice per cell (optional; `row` needs it) |
| `obs` | `annotation_id` (24-hex string), `cell_index`, `cell_type` (categorical), one int column per clustering |
| `var` | index = symbol (`_index` attr names the column), `gene_id`, `feature_type` |
| `obsm/X_umap` | optional embedding |
| `uns/nimbus` | `schemaVersion`, `datasetId`, `source`, `created` |

`readStringColumn` handles the three encodings anndata uses for strings (`string-array`,
`nullable-string-array`, `categorical`), which is why the test fixture writes those
encodings by hand rather than depending on anndata.

## Server

`devops/girder/plugins/SpatialPlugin/upenncontrast_spatial/`:

- `server/store.py` — `SpatialStore` (validation, feature index, sorted ids, column/row/
  aggregate reads), an LRU of `MAX_OPEN_STORES` open stores keyed by file id.
- `server/models/registry.py` — `dataset_spatial`: `{datasetId, itemId, fileId,
  schemaVersion, nObs, nVar, obsColumns, created, updated}`.
- `server/api/spatial.py` — the resource. Every read requires READ on the dataset folder,
  every write WRITE; inputs go through the annotation plugin's `validation.py`.
- `server/materialize.py` — the dense writer and the local-job entry point.

| Route | Body / params | Returns |
|---|---|---|
| `GET spatial/{datasetId}` | `verify` (opt-in) | registry + `features`, `obsColumns`; with `verify`, `liveAnnotations` (a scan of the dataset's ids, ~1.5 s at 700K); 404 when none |
| `POST spatial/{datasetId}/register` (WRITE) | `{itemId}` — item in the dataset folder, one file | the registry document |
| `DELETE spatial/{datasetId}` (WRITE) | — | forgets the registration; the item stays |
| `GET spatial/{datasetId}/features` | `search`, `limit` (≤ 200) | `[{symbol, featureType}]`, prefix matches first |
| `GET spatial/{datasetId}/column` | `feature` | `{symbol, annotationIds, values}` non-zero entries, serialized straight from the numpy arrays with orjson (a dense gene is hundreds of thousands of pairs) |
| `GET spatial/{datasetId}/row` | `annotationId` | `{annotationId, values: {symbol: value}}`; 404 when the cell has no row |
| `POST spatial/{datasetId}/aggregate` | `{filters, features}` | `{total, unmatched, features: [{symbol, mean, fractionExpressing, expressing}]}` |
| `POST spatial/{datasetId}/materialize` (WRITE) | `{features, propertyName?}` | `{propertyId, written, jobId}` |

`filters` is the list-filter object every list endpoint and the selection summary accept,
analysis gate definitions included: ids resolve through `Annotation.listIds`, so a gate
means the same thing in "what is in this gate" and "what does this gate express". Means
include zeros; `unmatched` counts matching annotations with no row.

Caps: `MAX_FEATURES_PER_REQUEST` 64 (aggregate and materialize), `MAX_FEATURE_SEARCH_RESULTS`
200.

### Materialize

Finds or creates a polygon property named `propertyName` (default `Gene Expression`,
image `properties/none:latest`) among the dataset's configurations, registers it into all
of them (the configuration's `meta.propertyIds` is what makes a property visible), and
writes `values[propertyId][symbol] = count` for every row, zeros included. Inline up to
`MATERIALIZE_INLINE_MAX_ROWS` (50K), otherwise a Girder local job
(`upenncontrast_spatial.server.materialize.run`) reporting progress.

Merging trap: `AnnotationPropertyValues.validateMultiple` lets the STORED
`values[propertyId]` win when a document already exists — that is why plain resubmission
is a no-op. Adding genes to a property that already has values therefore updates the
stored documents in place and saves them with `validate=False`; new documents validate as
usual. Pinned by *"testMaterializeWritesRegistersAndMerges"*.

## Client

- `nimbusimage`: `ds.spatial` — `info()`, `upload()`, `register()`, `upload_and_register()`,
  `unregister()`, `features()`, `column()`, `row()`, `aggregate()`, `materialize()`.
- Frontend: `src/store/SpatialAPI.ts`, `src/store/spatial.ts` (registration per dataset;
  `hasTable` is false for a stale answer from another dataset; "no table" and "could not
  ask" are distinct), `SpatialFeaturePicker.vue` (server-side search, debounced),
  `MaterializeGenesDialog.vue` (Measurements tab → **Add genes**, only when a table is
  registered; polls the job), and an **Expression** section in the selection summary
  (mean count and % expressing for picked genes over the same scope, in the CSV too).

## Import

`plugins/nimbusimage/skills/xenium-ingest/scripts/xenium_build_spatial_store.py` builds the
store from a Xenium bundle and the verified annotation-id map, uploads it, registers it.
The 10x matrix is gene-major CSR, which read as `(data, indices, indptr)` with shape
`(cells, genes)` **is** the cells × genes CSC — no transpose is materialized. The Girder
worker form of the import wraps this script once the format has settled.

## Regression checklist

Each line names the test that holds it.

**Plugin (`upenncontrast_spatial/test/test_spatial.py`)**
- An unregistered dataset is a 404, not an empty answer — *"testUnregisteredIs404"*.
- Registration validates the layout; live rows are reported only with `verify`, and a deleted cell drops the count — *"testRegisterAndSchema"*.
- An item outside the dataset folder and a corrupt zip are 400s — *"testRegisterRejectsForeignItemAndBadStore"*.
- Registration needs WRITE, reads need READ — *"testRegisterRequiresWrite"*, *"testReadRequiresAccess"*.
- Unregistering keeps the item — *"testUnregisterForgetsButKeepsItem"*.
- Feature search orders prefix matches first and honours limit — *"testFeatureSearch"*.
- Column and row reads return non-zero entries; a cell without a row is a 404; an unknown
  feature a 400 — *"testColumnAndRow"*; a store without the CSR layer refuses row reads —
  *"testRowNeedsCsrLayer"*.
- Aggregate uses the list-filter object, counts unmatched annotations, and returns zeros
  for an empty match — *"testAggregate"*; malformed bodies are 400s — *"testAggregateRejectsBadInput"*.
- Materialize writes dense values, registers the property, and MERGES on re-run —
  *"testMaterializeWritesRegistersAndMerges"*; needs a configuration and WRITE —
  *"testMaterializeNeedsConfigurationAndWrite"*; schedules a job above the inline limit —
  *"testMaterializeSchedulesJobAboveInlineLimit"*.
- `rowsForAnnotationIds` handles missing ids, empty input, and an empty store — *"testRowsForAnnotationIdsHandlesMissingAndEmpty"*.

**Python (`nimbusimage/tests/test_spatial.py`)**
- 404 → None, other errors propagate — *"test_info_returns_none_when_unregistered"*, *"test_info_reraises_other_errors"*.
- Upload + register, route shapes, filters default, job wait only when scheduled —
  *"test_upload_and_register"*, *"test_reads_hit_the_expected_routes"*,
  *"test_aggregate_sends_filters_or_empty_object"*, *"test_materialize_waits_for_job_only_when_scheduled"*.

**Frontend**
- 404 → null, other errors rethrown; request bodies — *"fetchInfo returns null for 404 and rethrows anything else"*, *"searchFeatures passes search and limit as query params"*, *"aggregate and materialize post the documented bodies"*.
- Measurements tab asks for the registration only when shown, and offers Add genes only
  with a table — *"asks for the table registration when shown, not when hidden"*, *"offers Add genes only when the dataset has a spatial table"*.
- Materialize dialog: inline write reloads properties; job polling until success; failed
  job and rejected request reported; polling stops on close — *"writes inline results and reloads the property list"*, *"polls a scheduled job until it succeeds"*, *"reports a failed job and a rejected request"*, *"stops polling when the dialog closes"*.
- Picker debounces typing, keeps picked symbols listed, caps at max — *"lists picked symbols alongside search results and debounces typing"*, *"caps the selection at max"*.
- Summary expression: only with a table and picked genes, same scope, in the CSV —
  *"aggregates expression over the same scope only when a table exists and genes are picked"*.

**Process**
- Backend edits need `docker compose build girder && docker compose up -d girder`.
- Verify live on the lymph node: register, `GET spatial/{id}` shows 708,983 live rows,
  aggregate under a tag matches the Phase 0 `Gene Expression` property's mean for the same
  gene, materialize a small panel and compare a few cells' values.
