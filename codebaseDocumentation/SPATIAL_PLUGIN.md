# Spatial plugin (`upenncontrast_spatial`)

**Status: Phases 1–6 of the spatial-transcriptomics platform plan, implemented on
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
else. Polygon and rectangle annotations also persist an exact `geometryHash` used only for
staleness checks. `SpatialStore` sorts the id column once per open
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
writes `values[propertyId][symbol] = count` for every row still belonging to the
dataset, zeros included. A batch membership lookup skips moved, deleted, or foreign
annotation IDs from stored tables. `written` counts saved live cells; job progress
counts examined table rows. Inline up to
`MATERIALIZE_INLINE_MAX_ROWS` (50K), otherwise a Girder local job
(`upenncontrast_spatial.server.materialize.run`) reporting progress.

Writes use `AnnotationPropertyValues.setSubValuesMany`: one bulk set of atomic Mongo update
pipelines merges `values[propertyId]` with `$mergeObjects`. Concurrent materialize, score,
and neighborhood writes therefore cannot replace unrelated property subtrees. A unique
`annotationId` key prevents racing upserts from making a second document even
after an annotation moves datasets; datasetId is mutable metadata, not identity.
Startup replaces the old nonunique annotation index and coalesces legacy duplicates
across datasets before adding the unique index. Pinned by
*"testCellValueWriterUsesAtomicNestedUpdates"* and
*"testLegacyDuplicatePropertyValuesAreCoalesced"*.

## Phase 2: any gene as a property path (value providers)

The annotation plugin gained one extension point,
`server/helpers/valueProviders.py`: `registerValueProvider(prefix, provider)`. A property
path whose first segment is a registered prefix is **virtual** — answered by the provider
instead of Mongo. This plugin registers `spatial` at load (`server/provider.py`), so
`["spatial", "CD3E"]` is the CD3E column of the dataset's store.

A provider answers three questions: `values(datasetId, path)` (dense, every row it knows),
`valuesForIds(datasetId, path, ids)` (None where the annotation has no row) and
`matchingIds(datasetId, path, propertyFilter)` (a range/values filter as an id set). It
raises `ValueError` for an unknown sub key, which every consumer maps to a 400.

Consumers that ask the provider, all in the annotation plugin:

| Consumer | How |
|---|---|
| analysis axes (`_analysisData`) | provider values nested as `{prefix: {sub: v}}` beside stored values, so gates and histograms on a gene axis need no other change |
| property filters | `Annotation.resolveProviderFilters` turns a virtual filter into an id clause (`_idSelector`, the gate rule) before the pipelines run; called from `_loadListRequest` and the spatial `aggregate`/`differential` |
| color-by-property | provider values keyed by ObjectId feed the same membership guard and writes |
| list page | `listPage` fills virtual values per page row (`_fillVirtualValues`); sorting by a virtual column is a 400 |
| batch value fetch (`findByAnnotationIds`) | merged into the returned documents, so sub-threshold datasets see the values client-side too |
| selection summary | statistics computed in numpy from the provider's dense answer over the matched ids (`analysis.describe_values`) |

Not covered, deliberately: CSV export leaves virtual columns empty (a stored copy via
*Copy into a measurement* exports), and the Objects tab cannot sort by one.

Frontend: `spatial` is a pseudo-property (`getPropertyById("spatial")` → "Spatial table",
`SPATIAL_PSEUDO_PROPERTY` in `properties.ts`); gene paths the user adds
(`addVirtualPropertyPaths`) join `computedPropertyPaths`, so every picker — analysis
axes, color-by, filters, displayed columns — offers them unchanged, and displayed virtual
columns survive a reload through the persisted displayed paths. Below the stub threshold
the wholesale value map is filled from the batch endpoint for the virtual paths. The
Measurements tab lists them under one "Spatial table" group without a Run button. The
genes dialog has three modes: **live columns** (default), **copy into a measurement**
(Phase 1 materialize), **gene-set score**.

### Score and differential expression

`differential` takes `method`: `welch` (default, t-test on means from sums) or `wilcoxon`
(Mann-Whitney U on the dense count distributions, `scipy.stats.mannwhitneyu`; the statistic
is the signed z so ranking by |statistic| works the same). Pinned by
*"testDifferentialRanksAndSchedules"*.

- `POST spatial/{datasetId}/score {features, name, method?: mean|sum, propertyName?}` —
  one sub-value `values[property][name]` per cell (default property `Gene set scores`),
  through the Phase 1 writer (`materialize.scoreColumn`, `columnsFor`).
- `POST spatial/{datasetId}/differential {filtersA, filtersB?, maxFeatures?}` — a local
  job (`server/differential.py`) ranking every feature by Welch's t (or Mann-Whitney U) between the cells
  matching A and those matching B (omitted = every other cell): mean, fraction
  expressing, log2 fold change (pseudocount 0.01), t, p. The validated filter objects,
  not row indices, ride in the job kwargs; the table lands on the job document as
  `spatialResult`. UI: **Compare
  expression…** in the selection summary's Expression section (group A = the summarized
  scope, B = the rest or objects with picked tags), ranked table, CSV download. Python:
  `ds.spatial.score()`, `ds.spatial.differential()`, `ds.spatial.virtual_path()`.

## Phase 3: the transcript layer

The per-molecule store is the 10x `transcripts.zarr.zip`, registered **as shipped**: it is
already a level-of-detail pyramid, so nothing is rebuilt (plan §4, §12).

```
grids/{level}/{gx},{gy}   250 um * 2**level squares from the origin; each tile sorted by
                          gene in two runs (quality >= 20 first, then the rest), with
                          gene_offset[g] = [lowStart, lowEnd, highStart, highEnd]
level 0                   location (x, y, z um), quality_score, id (the transcript's own id)
levels 1..6               location, gene_identity, cluster_count (merged molecules)
density/gene              CSR over (gene, row) of a 10 um grid — a heat map per gene
```

`server/transcripts.py` — `TranscriptStore` (schema, gene search that skips control
codewords, `tilePoints` slicing the two runs per gene with the quality threshold,
microns → image pixels through `pixelSize` and the optional 3×3 `transform`,
`densityGrid`/`densityTile` on the annotation overview's pyramid), an LRU of
`MAX_OPEN_TRANSCRIPT_STORES` open stores, and `encodePoints`. Density grids are float32 and
evicted by actual bytes; the open stores divide a 512 MiB process budget. `server/api/transcripts.py`
is a mixin the `Spatial` resource inherits. The registry document gains
`{transcriptsItemId, transcriptsFileId, pixelSize, transform}`; either half (table,
transcripts) may be absent, and each is forgotten independently.

| Route | Body / params | Returns |
|---|---|---|
| `GET spatial/{datasetId}/transcripts` | — | levels, `pixelSize`, `transform`, `genes`, `totalPoints`, per-level `tiles` (`keys`, `counts`); 404 when none |
| `POST spatial/{datasetId}/transcripts/register` (WRITE) | `{itemId, pixelSize, transform?}` | the schema above |
| `DELETE spatial/{datasetId}/transcripts` (WRITE) | — | forgets the store; the item stays |
| `GET spatial/{datasetId}/transcripts/genes` | `search`, `limit` (≤ 200) | `[symbol]`, prefix matches first, no control codewords |
| `POST spatial/{datasetId}/transcripts/points` | `{genes (≤ 8), level, tiles (≤ 256 keys, non-empty), minQv?}` | **binary**: `uint32 n, uint8 hasQuality, float32[n*2] x,y (image px), uint8[n] gene slot`, then at level 0 `float32[n] quality`; 413 above `MAX_POINTS_PER_RESPONSE` (2M) |
| `GET spatial/{datasetId}/transcripts/density/{z}/{x}/{y}` | `genes`, `sizeX`, `sizeY`, `tileSize`, `maxLevel`, `color`; shared views also send `token` | PNG, alpha = sqrt of the genes' count per 10 um bin relative to the 99.5th percentile of their occupied bins (a ubiquitous gene keeps its gradient); a tile outside the pyramid is a 400, as is a transformed registration (the grid is only rendered on the transcripts' own pixel grid) |

**Molecule → cell is geometric.** The zarr's level-0 `id` is the *transcript's* id (unique
per molecule; the bundle ships no per-molecule cell reference — that lives only in
`transcripts.parquet`, which the viewer bundle omits). So the overlay answers "which cell"
by point-in-polygon against the cell outlines already drawn on the annotation layer
(`src/utils/annotationAtPoint.ts`, bbox prefilter then `geo.util.pointInPolygon`), and
"Go to cell" navigates to that annotation. No id column, no server lookup.

**Client.** `src/store/transcripts.ts` holds the selection (genes with colors, quality
threshold, rendering mode, point budget) and what the overlay last did; the molecules never
enter the store. `TranscriptOverlay.vue` (one per viewer, mounted by `ImageViewer`) plans a
pyramid level per view from the schema alone (`src/utils/transcriptTiles.ts`: the finest
level whose intersecting tiles fit `MAX_TRANSCRIPT_TILES_PER_REQUEST` and whose estimated
points fit the budget), fetches the binary body into a GeoJS point feature, steps coarser
on 413, and switches to the density heat map in "auto" mode from `AUTO_DENSITY_LEVEL`
(1 mm tiles) or when nothing fits — one OSM layer per gene in that gene's color, so a mix
stays readable. Transformed registrations stay in points mode because the density
endpoint does not support transforms; empty tile plans clear the overlay without a
request. Opacity (points and heat maps) is a palette slider and a restyle, never a
refetch. `TranscriptsPanel.vue` is a right-zone palette (`transcriptsPanel`), shown
for registered stores and while discovery is loading or has failed, so a failed
lookup remains reachable for retry.

## Phase 4: recompute and table versions

Closing the loop (plan §13): edited cell polygons → a corrected count matrix, kept as a
**version** of the expression table beside the vendor one.

- **A version is an expression table.** The registry document keeps the active table in
  place and gains `versions: [{itemId, fileId, label, provenance, nObs, nVar, created}]`,
  plus `label`, `provenance`, `activated` on the active one. `register` and the recompute
  job go through `DatasetSpatial.registerVersion`, which pushes the previous active table
  (if another item) into `versions`; `activateVersion` swaps; `forgetVersion` drops a
  non-active one. Every consumer reads the active table, so a switch re-points virtual
  paths, aggregate, score and DE. The client invalidates cached virtual values,
  in-flight value requests and the property revision used by gate caches;
  gate shapes remain defined in value space and are resolved again.
- **Staleness is computed, not tracked** (`server/recompute.py`): polygon and rectangle
  annotations persist `geometryHash`, a SHA-256 digest of the ordered IEEE-754 coordinate
  pairs and vertex count. A recomputed table stores that exact identity in
  `obs.geometry_hash` beside `annotation_id`, and `GET …/staleness` compares the live polygons:
  **added** (cell without a row), **changed** (fingerprint differs), **removed** (row without
  a cell). Legacy annotations missing the field are hashed once and bulk-backfilled; normal
  reads never download or hash every coordinate. Results are cached on the dataset's
  annotation raster version, which bumps on every annotation save/delete. An imported table
  has no hashes and reports added/removed only.
- **Assignment: smallest polygon wins.** Per level-0 transcript tile the intersecting
  polygons are rasterized largest-first (`skimage.draw.polygon`) into an int32 label image
  at image resolution; molecules with quality ≥ `minQv` of a real gene look up their
  label; (cell, gene) pairs are summed via a COO → CSR build (duplicates sum). 2D, z
  ignored. Cell types transfer through **tags**: a cell's tag among the previous table's
  `cell_type` categories.
- **`scope: "dirty"`** seeds tiles from both old and new footprints of changed cells,
  old footprints of removed cells, and current footprints of added cells (every cell
  overlapping such a tile is redone, since molecules may have moved to a neighbor) and
  carries the other rows over from the active table by `annotation_id`. Previous bounds
  are stored in `obsm/nimbus_cell_bounds`. Legacy tables without bounds fall back to a
  full rebuild once, so no old footprint is silently missed. `scope: "all"`
  rasterizes every tile. Both write a complete new `spatial.zarr.zip` (zarr 2, AnnData
  layout: `X` csc, `layers/X_csr`, `obs` with `annotation_id`, `cell_index`,
  `geometry_hash`, `area`, `transcript_count`, `cell_type`, `var`, optional
  `obsm/X_umap` + `obs.kmeans`, `uns.attrs.nimbus` provenance), upload it into the dataset
  folder and register it as active.
- **Embeddings are opt-in** (`recomputeEmbeddings`): normalize → log1p → TruncatedSVD(50)
  → UMAP → k-means(10), scikit-learn and umap-learn (already in the Girder image; now
  declared in `setup.py`).
- **The job runs in Girder** as a local job (`upenncontrast_spatial.server.recompute.run`),
  since the plugin already opens both stores from the assetstore; tiles are independent,
  so a process pool is the escape hatch if a full rebuild is too slow.

| Route | Body / params | Returns |
|---|---|---|
| `GET spatial/{datasetId}/versions` | — | `{active, versions}` (itemId, label, provenance, nObs, nVar, created) |
| `POST spatial/{datasetId}/versions/{itemId}/activate` (WRITE) | — | the swapped `{active, versions}`; 404 unknown |
| `DELETE spatial/{datasetId}/versions/{itemId}` (WRITE) | — | forgets a non-active version (item stays); 404 for the active one |
| `GET spatial/{datasetId}/staleness` | — | counts + up to 10K ids each of added/changed/removed, `hasGeometryHashes`, `upToDate` |
| `POST spatial/{datasetId}/recompute` (WRITE) | `{label?, scope: all\|dirty, minQv? (20), tags?, recomputeEmbeddings?}` | `{jobId}`; the job's `spatialResult` is `{itemId, nObs, nVar, assigned, unassigned, tilesProcessed, seconds}`; 404 without a transcript store, 400 for a transformed registration or `dirty` without a table |

`POST …/register` accepts an optional `label` (default "Imported table").

**Client.** `CellTableCard.vue` (in the Transcripts palette, since recomputing needs the
transcript store): active version select (switching re-reads the registration and every
live gene column), staleness line, and `RecomputeTableDialog.vue` (label, edited-only /
full, quality threshold, tag filter, embeddings) polling the job. Python:
`ds.spatial.versions()`, `activate_version()`, `forget_version()`, `staleness()`,
`recompute(label, scope, min_qv, tags, embeddings, wait)`.

## Phase 6: neighborhood and region statistics

`server/neighborhood.py` + the `AnalysisRoutes` mixin (`api/analysis.py`). Cells are their
polygon **centroids**, computed by Mongo (`$avg` over `coordinates.x/y`, seconds for 700K
cells); a cell's **type** is its first tag not in `excludeTags` (default `["cell"]`).

| Route | Body / params | Returns |
|---|---|---|
| `POST spatial/{datasetId}/neighborhood` (WRITE) | `{radius (image px), excludeTags?, propertyName? ("Neighborhood")}` | `{jobId, propertyId}`; the local job (`neighborhood.run`) writes per-cell neighbor-type fractions + `neighbors` as sub-values of the property and stores the enrichment on the registry |
| `GET spatial/{datasetId}/neighborhood` | — | `{radius, excludeTags, types, counts, pairs, matrix, cells, typed, written, propertyId, computed}`; 404 until computed |
| `POST spatial/{datasetId}/regions/summary` | `{regionTag? \| regionIds? (≤ 50), excludeTags?, features? (≤ 64, needs a table)}` | `[{id, name, tags, cells, composition: [{type, count}], expression: [{symbol, mean, fractionExpressing, expressing}], rows}]` |

- **Neighbors**: `cKDTree.query_pairs(radius)`; each pair counts once in each direction.
  `pairs[i][j]` = observed neighbors of type j around cells of type i (symmetric);
  `matrix = log2((pairs + 1) / (expected + 1))` with `expected_ij = row_i × col_j / total`,
  i.e. the counts under a label shuffle. Untyped cells count neighbors but join no pair.
  Before either allocation, the job rejects result matrices above 512 MiB and neighborhoods
  above 5 million pairs; `count_neighbors` performs the pair preflight without retaining the
  full pair set.
- **Regions**: polygon annotations carrying the tag (or the ids); cells inside =
  `skimage.measure.points_in_poly` after a bounding-box prefilter; the region polygons are
  excluded from the cells and the region tag from the type tags. Expression per region is
  the table's `aggregate` over the region's rows.
- The chunked property writer materialize used is now `materialize.writeCellValues`,
  shared with the neighborhood job.
- **Client**: `NeighborhoodDialog.vue` (radius in µm → pixels via the configuration's
  scale, job polling, colored matrix, CSV) and `RegionSummaryDialog.vue` (regions by tag
  or the polygons currently selected in the viewer, genes, table, CSV), both from the
  Selection summary's **Spatial statistics** row.
  Python: `ds.spatial.neighborhood()`, `compute_neighborhood(radius_pixels, …)`,
  `region_summary(region_tag | region_ids, features)`.

## Client

- `nimbusimage`: `ds.spatial` — `info()`, `upload()`, `register()`, `upload_and_register()`,
  `unregister()`, `features()`, `column()`, `row()`, `aggregate()`, `materialize()`;
  transcripts: `transcripts()`, `upload_transcripts()`, `register_transcripts(item_id,
  pixel_size, transform=None)`, `unregister_transcripts()`, `transcript_genes()`,
  `transcript_points(genes, tiles, level, min_qv)` (decodes the binary body into numpy);
  versions: `versions()`, `activate_version()`, `forget_version()`, `staleness()`,
  `recompute()`.
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
`xenium_register_transcripts.py` uploads the bundle's `transcripts.zarr.zip` unchanged and
registers it with the bundle's `pixel_size` (and the inverse H&E alignment as `transform`
for the H&E dataset).

## Regression checklist

- Preserve one value document per annotation across dataset moves and both writers —
  `test_property_value_atomic.py::testMoveThenComputeKeepsOneValueDocument`;
  migrate duplicates across datasets — `testStartupCoalescesCrossDatasetDuplicates`.
- Caller-writable datasets cannot rehome foreign annotations' values through single
  or mixed bulk REST writes —
  `test_property_value_atomic.py::testCannotRehomeForeignValuesThroughWritableDataset`.
- Spatial jobs skip moved/deleted/foreign table IDs; written counts include only
  live dataset cells, progress counts examined rows —
  `test_spatial.py::testCellValueWriterSkipsMovedAndDeletedAnnotations`.
- Transformed transcript registrations use points in auto and explicit density modes,
  including after schema refresh — `TranscriptOverlay.test.ts` (`uses points for transformed
  registrations`, `rechecks rendering capabilities when the schema is refreshed`);
  disabled/explained heat-map choice — `TranscriptsPanel.test.ts`
  (`disables heat maps for transformed registrations and explains why`).
- Empty plans clear the overlay without requests in auto/density and coarser retry paths —
  `TranscriptOverlay.test.ts` (`clears a previously populated viewport when its tile plan is empty`,
  `does not request an empty coarser tile set after a 413`).
- Failed transcript discovery keeps controls and retry available — `App.test.ts`
  (`keeps the Transcripts control reachable after schema failure and during retry`),
  `TranscriptsPanel.test.ts` (`offers an explicit retry after schema failure`);
  cached-error retries and loading ownership — `transcripts.test.ts`
  (`retries a failed refresh even when an older schema is cached`,
  `does not let an older request clear a newer request's loading state`).

- Saved virtual columns, filters, labels, and gates survive reload without a stored
  property ID — `annotationBrowserConfig.test.ts`, `preserves virtual columns, filters, labels and gates on reload`.

### Astra review: persistence and replacement

- Startup migrates duplicate values and propagates index failures — `testStartupMigratesBeforeRetryingUniqueIndex`, `testStartupDoesNotSwallowUniqueIndexFailure`.
- Ordinary single/bulk appends cannot replace spatial updates; property deletion only unsets its own key — `testAppendDoesNotReplaceConcurrentValues`, `testDeleteOnlyUnsetsRequestedProperty`.
- Dirty rebuild includes old moved/deleted footprints and safely upgrades legacy tables — `testDirtyRecomputeIncludesPreviousFootprint`.
- Backfill cannot overwrite a concurrent edit and returns the winning hash — `testBackfillDoesNotOverwriteConcurrentEdit`.
- Rectangle summaries request the shape field — `testRectangleProjectionIncludesShape`.
- Transcript-only registrations answer missing expression values — `testTranscriptOnlyRegistryHasNoExpressionValues`.
- Table changes invalidate both lazy values and whole-dataset gate revisions; late responses cannot cross dataset reset — `virtualTableRefresh.test.ts`.
- Materialized properties register atomically across configurations — `testMaterializeRegistersConfigurationsWithoutReplacement`.

Each line names the test that holds it.

**Plugin (`upenncontrast_spatial/test/test_spatial.py`)**
- An unregistered dataset is a 404, not an empty answer — *"testUnregisteredIs404"*.
- Registration validates the layout; live rows are reported only with `verify`, and a deleted cell drops the count — *"testRegisterAndSchema"*.
- An item outside the dataset folder and a corrupt zip are 400s — *"testRegisterRejectsForeignItemAndBadStore"*.
- Registration needs WRITE, reads need READ — *"testRegisterRequiresWrite"*, *"testReadRequiresAccess"*.
- Unregistering keeps the item — *"testUnregisterForgetsButKeepsItem"*.
- Feature search orders prefix matches first and honors limit — *"testFeatureSearch"*.
- Column and row reads return non-zero entries; a cell without a row is a 404; an unknown
  feature a 400 — *"testColumnAndRow"*; a store without the CSR layer refuses row reads —
  *"testRowNeedsCsrLayer"*.
- Aggregate uses the list-filter object, counts unmatched annotations, and returns zeros
  for an empty match — *"testAggregate"*; malformed bodies are 400s — *"testAggregateRejectsBadInput"*.
- Materialize writes dense values, registers the property, and MERGES on re-run —
  *"testMaterializeWritesRegistersAndMerges"*; needs a configuration and WRITE —
  *"testMaterializeNeedsConfigurationAndWrite"*; schedules a job above the inline limit —
  *"testMaterializeSchedulesJobAboveInlineLimit"*.
- Materialize/score/neighborhood merge nested values atomically without reading a
  replaceable snapshot — *"testCellValueWriterUsesAtomicNestedUpdates"*; a scheduled
  materialize job publishes its final counts — *"testMaterializeJobPublishesItsFinalResult"*.
- `rowsForAnnotationIds` handles missing ids, empty input, and an empty store — *"testRowsForAnnotationIdsHandlesMissingAndEmpty"*.

**Value providers (annotation plugin `test/test_value_providers.py`, with a fake provider)**
- A virtual property filter resolves like a gate, combines with stored filters, and an
  unknown key is a 400 — *"testVirtualPropertyFilterResolvesLikeAGate"*.
- Provider ids are intersected with live annotations before match-all or complement logic —
  *"testVirtualFilterIntersectsProviderIdsWithLiveAnnotations"*.
- The list page carries virtual values for rows with and without a value document, and
  refuses to sort by one — *"testListPageCarriesVirtualValues"*.
- Gates take a virtual axis — *"testAnalysisGateOnVirtualAxis"*; color-by takes a virtual
  path — *"testColorByVirtualPath"*; summary statistics too —
  *"testSummaryStatisticsOnVirtualPath"*; the batch fetch merges them —
  *"testBatchValuesIncludeVirtualPath"*; with no provider every path is stored —
  *"testStoredPathsUntouchedWithoutProviders"*.

**Spatial provider, score, differential (`test/test_phase2.py`)**
- `["spatial", gene]` filters, gates, list values and summary statistics through the real
  store; unknown gene 400 — *"testVirtualPathFilterAndGate"*, *"testVirtualPathInListPageAndSummary"*.
- A dataset without a store answers nothing — *"testProviderWithoutStoreAnswersNothing"*.
- Score writes one sub-value (dense, mean by default) and rejects bad names/methods —
  *"testScoreWritesOneSubValue"*.
- Differential ranks correctly, refuses tiny groups, schedules a job that stores the table
  and carries filters not rows — *"testDifferentialRanksAndSchedules"*.

**Python (`nimbusimage/tests/test_spatial.py`)**
- 404 → None, other errors propagate — *"test_info_returns_none_when_unregistered"*, *"test_info_reraises_other_errors"*.
- Upload + register, route shapes, filters default, job wait only when scheduled —
  *"test_upload_and_register"*, *"test_reads_hit_the_expected_routes"*,
  *"test_aggregate_sends_filters_or_empty_object"*, *"test_materialize_waits_for_job_only_when_scheduled"*.
- Every awaited spatial operation raises on a failed job —
  *"test_spatial_jobs_raise_when_the_job_fails"*.

**Frontend, Phase 2**
- The store answers for the pseudo-property and names virtual paths — *"answers for the spatial pseudo-property and names its paths"*.
- Adding live columns shows them, lists them, and fetches values below the stub threshold —
  *"adds live columns: shown, listed among computed paths, and fetched below the stub threshold"*; not wholesale in stub mode —
  *"does not fetch wholesale in stub-only mode (the visible fetch handles it)"*; a displayed
  virtual column survives reload and can be removed — *"keeps a displayed virtual column across a reload and can remove it"*.
- Partial virtual-column responses recursively retain previously fetched siblings —
  *"keeps earlier live columns when a sibling column is fetched later"* and
  *"retains nested sibling paths fetched in separate requests"*.
- Measurements groups virtual columns without a Run button — *"lists virtual spatial columns under one group without a Run button"*.
- Genes dialog: live mode writes nothing server-side — *"adds live columns by default, with no server write"*; score mode —
  *"scores a gene set into its own measurement"*.
- Compare dialog: polls the job for the table — *"compares A against everything else and polls the job for the table"*;
  group B tags and the cap — *"sends the picked tags as group B and refuses to run without any"*; failures and close —
  *"reports a failed job and a rejected request, and stops polling on close"*; CSV —
  *"downloads the ranked table as CSV"*.
- API routes — *"score, differential and fetchJob use the documented routes"*.

**Frontend**
- 404 → null, other errors rethrown; request bodies — *"fetchInfo returns null for 404 and rethrows anything else"*, *"searchFeatures passes search and limit as query params"*, *"aggregate and materialize post the documented bodies"*.
- Measurements tab asks for the registration only when shown, and offers Add genes only
  with a table — *"asks for the table registration when shown, not when hidden"*, *"offers Add genes only when the dataset has a spatial table"*.
- Materialize dialog: inline write reloads properties; job polling until success; failed
  job and rejected request reported; polling stops on close — *"writes inline results and reloads the property list"*, *"polls a scheduled job until it succeeds"*, *"reports a failed job and a rejected request"*, *"stops polling when the dialog closes"*.
- Picker debounces typing, keeps picked symbols listed, caps at max — *"lists picked symbols alongside search results and debounces typing"*, *"caps the selection at max"*.
- Summary expression: only with a table and picked genes, same scope, in the CSV —
  *"aggregates expression over the same scope only when a table exists and genes are picked"*.
- Selection counts, labels, and default scope ignore stale selected ids, matching the
  request constraint — *"counts only selected ids that still resolve"*.

**Transcripts (`test/test_transcripts.py`, synthetic two-level pyramid)**
- Registration describes the pyramid, skips control codewords in the gene count, and
  leaves the table routes a 404 — *"testRegisterDescribesPyramid"*; bad pixel size,
  transform, or a foreign/non-store item are 400s — *"testRegisterValidatesInput"*.
- Registration needs WRITE; table and transcripts are forgotten independently —
  *"testRegisterRequiresWriteAndKeepsTable"*.
- Gene search skips controls, orders prefix matches first, rejects limit 0 —
  *"testGeneSearchSkipsControls"*.
- Level-0 points arrive in image pixels with quality — *"testPointsAtLevelZeroCarryQuality"*;
  the quality threshold selects the runs and filters within them, unknown tiles are empty —
  *"testPointsHonorQualityAndUnknownTiles"*; coarser levels carry no quality —
  *"testPointsAtCoarserLevelsHaveNoQuality"*.
- Malformed bodies (an empty tile list included) are 400s and too many points a 413 —
  *"testPointsRejectBadInputAndTooMany"*;
  private datasets refuse reads, including density tiles without an accepted credential —
  *"testPointsRequireReadAccess"*.
- Density tiles light exactly the bins holding molecules, in the requested color, on the
  overview pyramid — *"testDensityTileMatchesBins"*; parameters and the tile range validated —
  *"testDensityTileValidatesParams"*; a transformed registration transforms points and
  refuses density — *"testDensityRefusesTransformedRegistrations"*.
- Store units: tile bounds, unknown keys, density grid, transform parsing, empty encoding —
  *"testStoreUnits"*; the same test pins float32 density grids and byte-budget eviction.

**Transcripts, Python (`nimbusimage/tests/test_spatial.py`)**
- 404 → None — *"test_transcripts_none_when_unregistered"*; registration body —
  *"test_register_sends_pixel_size_and_transform"*; binary decode —
  *"test_points_decode_the_binary_body"*; routes — *"test_gene_search_route"*.

**Transcripts, frontend**
- Binary decode round-trips, coarser levels null, truncation refused —
  *"round-trips level-0 points with quality"*, *"leaves quality null at coarser levels"*,
  *"decodes an empty body and rejects a truncated one"*.
- Which cell a molecule is in: the containing polygon, bbox first —
  *"returns the polygon containing the point and skips the rest"*, *"uses the bounding box before the polygon test"*.
- View → microns clamps, scales, and undoes the transform — *"clamps to the image and scales by the pixel size"*,
  *"returns null when the image is off screen"*, *"undoes the registration transform before scaling"*;
  tiles only where the pyramid has them — *"lists only tiles the pyramid has"*; the plan takes
  the finest fitting level and honors the tile cap — *"takes the finest level that fits the budget"*,
  *"respects the tile cap even under budget"*.
- Store: registration is per dataset and stale answers are discarded — *"knows the store only for the dataset it was fetched for"*,
  *"discards a stale answer after a dataset switch"*; "could not ask" ≠ "no store" —
  *"keeps 'could not ask' distinct from 'no store'"*; colors assigned and kept, selection
  reset with the dataset — *"assigns and keeps gene colors, and resets with the dataset"*; the
  readout follows its gene — *"drops the readout when its gene is removed or the overlay is turned off"*;
  colors do not refetch — *"changes the request signature for refetch inputs only"*; cell
  navigation — *"navigates to a molecule's cell by annotation id"*.
- Overlay: fetches the view's tiles at the planned level — *"fetches the view's tiles at the finest fitting level and draws them"*;
  413 replans the keys at the coarser level — *"steps one level coarser when the server answers 413"*; density in auto
  when zoomed out and on demand — *"shows the density heat map when zoomed far out in auto mode, and when asked"*;
  clears when off — *"clears everything when disabled, turned off, or without genes"*; stale
  fetch ignored — *"ignores a fetch that finishes after a newer one started"*; click readout
  and teardown — *"reports the clicked molecule and tears down on unmount"*; unrolled views —
  *"does nothing while unrolled"*.
- Panel: registration looked up only when shown — *"looks the registration up only when shown"*;
  status text — *"describes what the overlay is doing"*; cell text and navigation —
  *"explains the clicked molecule's cell and navigates to it"*; symbols and debounced search —
  *"hands picked symbols to the store and debounces the search"*.
- API: 404 → null — *"fetchTranscriptsSchema returns null for 404 and rethrows other errors"*;
  binary request — *"decodes the binary points body and passes the request as JSON"*; routes —
  *"gene search uses the documented route"*; density template —
  *"builds a density template on the overview pyramid"*.

**Recompute and versions (`test/test_recompute.py`, synthetic pyramid + rectangular cells)**
- A full rebuild counts each molecule in the smallest polygon containing it, applies the
  quality threshold, skips control codewords, transfers cell types from tags, and keeps the
  previous table as a version — *"testRecomputeAllAssignsAndVersions"*.
- Staleness reports added/removed for an imported table and added/changed/removed for a
  recomputed one; `dirty` scope touches only the affected tile and carries the other rows
  over; versions keep their order — *"testStalenessAndDirtyScope"*.
- Versions activate (WRITE) and can be forgotten once; the active one cannot —
  *"testActivateAndForgetVersions"*.
- Bad scope/label/minQv/tags, `dirty` without a table, a transformed registration and a
  missing transcript store are 400/404 — *"testRecomputeValidation"*.
- Units: exact ordered-coordinate geometry hashes distinguish equal-moment polygons,
  largest-first label image, COO → CSR duplicate summing, and the written zarr layout —
  *"testUnits"*; embeddings shapes — *"testEmbeddingsShapes"*.

**Recompute, Python (`nimbusimage/tests/test_spatial.py`)**
- Routes — *"test_version_routes"*; recompute waits for the job and raises on failure —
  *"test_recompute_waits_for_the_job_result"*.

**Recompute, frontend**
- Card reads versions/staleness only when shown and describes them —
  *"reads versions and staleness only when shown"*, *"explains that an imported table cannot report edits, and up to date"*;
  switching re-reads the table and live gene columns —
  *"switching the version re-reads the table and the live gene columns"*; errors surface —
  *"shows the error when the registry cannot be read"*.
- Dialog offers edited-only only when something changed and a table exists —
  *"offers edited-only when something changed, full rebuild otherwise"*; posts, polls, re-reads —
  *"posts the request and polls the job, then re-reads the table"*; failures and close —
  *"reports a failed job and a rejected request, and stops polling on close"*.
- API routes — *"uses the documented routes"*.

**Neighborhood and regions (`test/test_analysis.py`)**
- Neighbor counts, pair matrix, enrichment sign and untyped handling by hand —
  *"testNeighborhoodUnits"*; the same test pins the matrix-byte and pair-count ceilings.
- The job writes per-cell fractions and `neighbors`, stores and serves the matrix —
  *"testNeighborhoodJobWritesFractionsAndMatrix"*; radius/tags/property validation, 404
  before computing, WRITE required — *"testNeighborhoodValidation"*.
- Region composition and per-gene means for cells inside tagged polygons, by tag and by id
  — *"testRegionSummary"*; bad bodies, features without a table, unknown tag → empty —
  *"testRegionSummaryValidation"*.

**Neighborhood and regions, Python** — *"test_neighborhood_none_until_computed"*,
*"test_compute_neighborhood_posts_and_waits"*, *"test_region_summary_bodies"*.

**Neighborhood and regions, frontend**
- Microns → pixels via the scale, refused without one —
  *"converts microns to pixels with the dataset scale and refuses without one"*; stored
  result loaded on open — *"loads the stored enrichment when opened"*; job in pixels,
  polling, property reload — *"schedules the job in pixels, polls it, and reloads the properties"*;
  failures and CSV — *"reports failures and exports the matrix as CSV"*.
- Regions: tags offered, genes sent only with a table, CSV —
  *"offers the dataset's tags and summarizes the chosen one with genes"*,
  *"asks for no genes without a table and surfaces errors"*.
- API — *"uses the documented routes and maps 404 to null"*.

**Shared-view tile authentication**
- `/share_link/me` does not replace either an empty or ambient login cookie —
  *"testBearerReadsOnlyTheSharedDataset"*.
- Image, annotation-raster, and density templates add the isolated link bearer while
  preserving tile placeholders — *"adds an explicit share-link token without changing
  tile placeholders"*, *"preserves z/x/y placeholders and serializes render inputs"*, and
  *"builds a density template on the overview pyramid"*; viewer/overlay tests pin that the
  store token reaches those builders.

**Process**
- Backend edits need `docker compose build girder && docker compose up -d girder`.
- Verify live on the lymph node: register, `GET spatial/{id}` shows 708,983 live rows,
  aggregate under a tag matches the Phase 0 `Gene Expression` property's mean for the same
  gene, materialize a small panel and compare a few cells' values.
- Transcripts live: register the 4.7 GB store, `GET .../transcripts` reports 232,650,139
  molecules over 7 levels; a level-0 request for one gene in the visible tiles returns in
  well under a second; clicking a molecule inside a drawn cell offers "Go to cell".
- Recompute live: a full rebuild of the lymph node from the vendor polygons should agree
  closely with the vendor matrix (10x assigns in 3D with its own QV handling, so not
  exactly); then edit one cell and rebuild in `dirty` scope — one tile, seconds.
