# Property-Value Scaling: Lazy Loading and a Zarr Columnar Store

**Status:** Phase 1 implemented; Phases 2–3 planned.
**Branch:** `claude/property-value-lazy-load`

## Motivation

NimbusImage stores computed annotation property values in MongoDB, one document
per annotation:

```
annotation_property_values: {
  _id, datasetId, annotationId,
  values: { [propertyId]: number | string | null | { [subId]: ... } }
}
```

This is fine for today's datasets but does not survive the scale we expect:
**millions of annotations × thousands of property values each**, often sparse.
Two things break:

1. **The frontend loads too much.** The mode that decides whether to load values
   wholesale or lazily keyed only on *annotation count*, so a dataset that is
   small in annotations but very wide in properties took the wholesale path and
   could OOM the tab. (Fixed in Phase 1.)
2. **MongoDB is the wrong store for a dense/sparse numeric matrix at that
   scale.** One ~100 KB document per annotation (Mongo repeats every key name in
   every document), and every column-wise operation — histogram, range filter,
   sort — is a full-collection scan because thousands of *dataset-specific,
   dynamically-named* value keys cannot be indexed. Writes are
   read-merge-write per document. (Addressed in Phase 3.)

The plan is three deployable phases, shipped and tested in order:

| Phase | What | Storage change | Risk |
|-------|------|----------------|------|
| 1 | Lazy trigger accounts for property *width* | none | low |
| 2 | Property-filtered drawing goes server-side | none | low–medium |
| 3 | Zarr columnar store behind existing endpoints | new (Zarr) | medium–high |

The guiding principle: **the frontend already speaks a storage-agnostic
contract** — "values for these annotation IDs, these property paths" (`/batch`),
"histogram for this path", "counts", "IDs passing these filters" (`/list/ids`).
Phase 3 swaps the *backing store* behind those endpoints; the frontend, and all
the viewport/pruning machinery that already works, is untouched.

---

## Current architecture (baseline)

### Two modes, keyed on annotation count

`annotation.ts` `fetchAnnotations` chooses the mode. Before Phase 1 the switch
was `count <= stubThreshold` (default 10,000, user-tunable to 200K):

- **Wholesale mode** (small datasets): `fetchPropertyValues` →
  `fetchAllPropertyValues` → `getPropertyValues(datasetId)` pages through *every*
  value document and builds the full `{annotationId: {propertyId: value}}` map in
  the `properties` store. Displayed or not, everything is resident.
- **Lazy / stub-only mode** (large datasets): nothing loads wholesale.
  - A 512-doc **sample** discovers the set of property paths for the column
    picker (`getPropertyValuesSample` → `collectLeafPaths`) — structure is
    homogeneous across a dataset.
  - Values load **only for the currently visible annotations × currently
    displayed columns** via `POST annotation_property_values/batch`, which
    projects only the requested paths server-side (`findByAnnotationIds`). The
    client cache is pruned to the visible set on every pan
    (`ensureVisiblePropertyValues` + `scopedMergePropertyValues`), so it stays
    bounded.
  - "How many annotations still need computing" is a **server-computed count**
    (`POST upenn_annotation/uncomputed_counts`) — never values.
  - Histograms for the filter UI are server-side (`$bucketAuto`).

### Backend endpoints (the storage-agnostic contract)

| Endpoint | Purpose | Model method |
|----------|---------|--------------|
| `POST annotation_property_values/batch` | values for N annotation IDs, projected to paths | `findByAnnotationIds` |
| `GET annotation_property_values` | paginated scan (sample / wholesale) | `find` + `.hint` |
| `GET annotation_property_values/histogram` | per-path histogram | `histogram` (`$bucketAuto`) |
| `POST upenn_annotation/uncomputed_counts` | per-property uncomputed counts | `uncomputedCounts` (`$facet`) |
| `POST upenn_annotation/list/ids` | annotation IDs passing filters | `listIds` |
| `POST upenn_annotation/list` | a page of annotation rows + values | `listPage` |

The `list*` endpoints already translate property filters into Mongo queries
(`_propertyFilterStages`: `values.<propId>.<subId>` `$gte/$lte/$in` matches),
driven either from the annotation collection via a `$lookup` into
`annotation_property_values`, or directly from the PV collection when only
property filters are active (`_canDrivePvPage`).

### Remaining wholesale escape hatches (baseline)

- **Property filters (lazy mode):** `filters.refreshPropertyFilterPassingIds`
  already fetches passing IDs server-side via `/list/ids` and stores
  `propertyFilterPassingIds`; `filteredAnnotations` ANDs that set in. So the
  earlier "load all values while a filter is on" path is already gone on this
  branch. Phase 2 hardens and extends this.
- **`VolumeViewer.vue`** reads `propertyStore.propertyValues` directly for 3D
  segmentation coloring (`:761`, `:935`) with **no lazy-mode guard** — in lazy
  mode it silently sees only the visible-subset cache. Needs a fix (Phase 2).
- **AI agent tools** (`src/agent/executors.ts`) `await fetchPropertyValues()`
  then read the in-memory map; in lazy mode they see only the visible subset.
  Needs a scoped fetch (Phase 2 / Phase 3 API).
- **Plots / property panels** still assume the resident map in places.

---

## Phase 1 — lazy trigger accounts for property width ✅ IMPLEMENTED

**Problem.** The mode switch keyed on annotation count alone. A dataset with
5,000 annotations × 5,000 values per annotation (25M values) sails under
`stubThreshold` and takes the wholesale path.

**Change.** The decision now also considers the estimated resident value count
(annotations × per-annotation leaf paths):

- New pure helper `shouldUseStubOnlyMode(count, width, stubThreshold)` in
  `src/utils/propertyValues.ts` — lazy if `count > stubThreshold` **or**
  `count × width > PROPERTY_VALUE_BUDGET` (default 1,000,000 leaves,
  ~100 MB as a nested JS map).
- `fetchAnnotations` estimates `width` from a bounded sample
  (`PROPERTY_WIDTH_SAMPLE_SIZE = 16` docs) via the existing
  `getPropertyValuesSample`, fetched **in parallel** with the annotation count.
- Failure of *either* the count or the width fetch routes to the safe (lazy)
  path (`Infinity`), matching the existing count-failure behavior.
- `0 × Infinity = NaN` is handled: an empty dataset with unknown width stays
  wholesale.

**Files:** `src/utils/propertyValues.ts` (helper + constants),
`src/store/annotation.ts` (`fetchAnnotations`), doc comments in
`src/store/model.ts` and `src/components/VisibilitySettings.vue`, stale-comment
fix in `src/store/properties.ts`.

**Tests:** `src/utils/__tests__/propertyValues.test.ts` — `shouldUseStubOnlyMode`
covers narrow/wide, count-threshold boundary, value-budget boundary, and the
Infinity/NaN edges.

**Cost:** one extra small sample request per dataset open, run in parallel with
the count — negligible, and the sample is the same call lazy mode already makes.

---

## Phase 2 — property-filtered drawing and other consumers go server-side

**Goal:** eliminate every remaining path that materializes the full value map,
so lazy mode is genuinely bounded regardless of dataset width. No storage change
— this leans entirely on the existing `/list/ids` and `/batch` endpoints.

1. **Confirm/complete property-filtered drawing.** `filteredAnnotations` must
   narrow drawing to `propertyFilterPassingIds` (fetched via `/list/ids`) in
   lazy mode, and `updateVisibility` loads values only for the visible subset.
   Audit that no code path still calls `fetchAllPropertyValues` while a filter
   is active. Add a regression test asserting `fetchAllPropertyValues` is *not*
   called on filter changes in lazy mode.

2. **`VolumeViewer.vue` lazy guard.** In lazy mode the 3D segmentation coloring
   must fetch values for the annotations it renders (a scoped `/batch` fetch),
   not read the visible-subset cache and silently mis-color. Either reuse
   `ensureVisiblePropertyValues` scoped to the volume's annotation set, or add a
   dedicated scoped fetch.

3. **AI agent tools** (`executors.ts`): replace `await fetchPropertyValues()` +
   in-memory read with an explicit scoped fetch for the queried ID set
   (`getPropertyValuesForIds`), so a sampling/analysis tool over a large dataset
   pulls only what it samples. `MAX_SAMPLE_ROWS` already bounds this.

4. **Plots / property panels:** inventory remaining `propertyStore.propertyValues`
   readers (`grep` list in the Regression checklist) and route each through a
   scoped fetch or a server aggregation (histograms already exist server-side).

**Risk:** medium — touches drawing and the agent. Each sub-item is independently
shippable and testable.

---

## Phase 3 — Zarr columnar property-value store

### Why Zarr (and scanpy compatibility)

The scenario — annotations × properties, mostly numeric, often sparse — is
exactly the single-cell / **AnnData** shape: annotations = `obs`, properties =
`var`, values = `X`. Storing the value matrix as Zarr in the AnnData layout
means:

- The matrix doubles as a **scientist-facing artifact** readable directly by
  `scanpy` / `anndata` (`ad.read_zarr(...)`) — a real selling point for this
  user base, and the basis for an exportable/queryable API surface.
- Column-wise ops (histogram, range filter, sort) read a **column chunk**
  instead of scanning a collection.
- Sparsity is native (CSR/CSC per the AnnData convention) — sparse rows/cols
  are simply not stored.

**Why server-side, not browser Zarr streaming.** The access patterns conflict:
the viewport wants arbitrary **rows** (annotations), while histograms/filters
want whole **columns** (properties). No single chunking serves both from the
client. A server with the array mapped can serve either in milliseconds and
keeps the existing endpoint contract, so the frontend is untouched.

**Alternatives considered.** Parquet + DuckDB (less code — predicates/sorts/
aggregations free from the query engine — but not ecosystem-native for
single-cell; a good fallback if Zarr read latency disappoints). TileDB (native
sparse, heavier dependency). Zarr chosen for scanpy compatibility.

### Storage layout

Per dataset, an AnnData-style Zarr group under the assetstore (see below):

```
<store>/<datasetId>.zarr/
  X/                      # values matrix (CSC primary; CSR mirror optional)
  obs/  index            # annotation IDs (row order), as strings
  var/  index            # property leaf paths (column order): "propId" or "propId/subId"
  uns/  nimbus_meta       # {generation, builtFrom, dtypes, schema version}
```

- **CSC** (compressed sparse column) is the primary orientation: fast per-column
  reads for histogram/filter/sort. **CSR** mirror (fast per-row reads for the
  viewport `/batch`) is optional — store both if `/batch` latency from CSC is
  too high; the cost is ~2× the (sparse) matrix, cheap relative to dense.
- `var/index` is the canonical column ordering; the frontend's existing
  `string[]` path representation maps 1:1 to it (`propId` or `propId/subId`).
- String-valued properties are rare and stay a side table (or a categorical
  encoding in a separate array); `X` is numeric.

### Routing: a per-dataset flag

Mongo remains the store for property **definitions** (`annotation_property`) and
for ordinary datasets. A dataset gains a **columnar store flag + generation**
(new field on the dataset folder metadata, e.g. `nimbusValueStore:
{backend: "zarr", generation: N}` — there is no existing version/dirty mechanism
to extend, so this is new machinery):

- Set when a build/consolidation job completes.
- The read endpoints (`/batch`, `/histogram`, `/list/ids` property-filter path,
  `uncomputed_counts`) check the flag and dispatch to the Zarr reader instead of
  Mongo. **Behavior and response shapes are identical** — only the source
  changes.
- Small datasets never get the flag; they keep the current zero-extra-
  infrastructure Mongo path.

### Build / consolidation job

Follow the existing local-job template (`api/zenodo.py` +
`helpers/zenodo_job.py` → `JobModel().createLocalJob(...)`, `run(job)` reporting
progress via SSE):

- New module `helpers/zarr_job.py` with `run(job)`: read all value docs for the
  dataset from Mongo (paged), assemble `obs`/`var`/`X` (CSC), write the Zarr
  group, then flip the dataset flag + bump `generation`.
- Triggered: (a) explicitly via a new endpoint; (b) automatically when a
  property-compute job's output for a dataset crosses a size threshold; (c) on
  server-side import of a large matrix (see below).
- **Dirty tracking.** After the store exists, further writes (new compute,
  edits, annotation deletion) must either update the Zarr incrementally or mark
  the dataset dirty for rebuild. The event bus already has the hook:
  `model.upenn_annotation.removeStringIds` (used today to orphan-clean PV docs)
  is the natural place to mark a Zarr dataset dirty. Simplest first cut: mark
  dirty + rebuild; incremental column-append is a later optimization.

### Write path at scale

`appendMultipleValues` → `saveMany` (delete-then-insert per doc) does not scale
to millions of rows. For datasets destined for the columnar store, large writes
should go **straight to Zarr** (a compute worker emits a column, appended to
`X`), bypassing the Mongo read-merge-write. The Mongo PV collection is then only
for small/legacy datasets. This is the deepest change and should come last
within Phase 3.

### Assetstore / storage location

The plugin writes **no files today** — everything streams to the HTTP response.
The only writable host-backed path in the girder container is `/assetstore`
(bind-mounted, gitignored; a single filesystem assetstore is created at
`provision.py` startup). Options:

- Write the Zarr group under `/assetstore/<...>/nimbus-values/` — reuses the
  existing volume, no compose change, but sits outside Girder's file model.
- Register each Zarr group as Girder `File`/`Item` resources — integrates with
  access control and the existing FUSE mount (`/mnt/fuse`), more plumbing.
- A dedicated new compose volume — cleanest separation, requires an ops change.

**Recommendation:** start under `/assetstore` with an explicit subdirectory and
a small path helper; promote to Girder-managed files if access-control
integration is needed. Access checks stay at the endpoint layer (Folder READ on
the dataset), exactly as today — the Zarr reader is invoked only after the
existing permission check passes.

### Dependencies

- `zarr`, `numcodecs`, and an explicit `numpy` pin added to the plugin's
  `install_requires` (`setup.py`). `numpy` is already present transitively (used
  in `models/connections.py`), so this is additive. Python is 3.11 in the
  girder image.
- **The plugin is `pip install -e`'d at image build time**, so a dependency
  change requires a **container rebuild** (`docker compose build`), not just a
  restart. Note this in the deploy runbook.
- Server-side reads use `zarr` + `numpy` (and `scipy.sparse` for CSR/CSC), all
  pure-Python/wheels.

### API surface (scanpy-facing)

Expose the columnar store for programmatic access via the `nimbusimage` Python
package and REST:

- `GET annotation_property_values/matrix?datasetId=...` — stream the Zarr group
  (or a signed path) for direct `anndata.read_zarr`.
- `nimbusimage` high-level: `dataset.property_matrix()` → returns an `AnnData`
  (obs = annotation IDs, var = property paths, X = values), so a scientist can
  `sc.pp.*` / `sc.tl.*` on NimbusImage properties directly.
- Column/row slice endpoints for partial pulls (a property across all
  annotations; an annotation across all properties) — these are just the
  `/histogram` and `/batch` reads, already columnar-friendly.

### Risks & open questions

- **Read latency** for the viewport `/batch` from CSC — measure before deciding
  whether the CSR mirror is mandatory.
- **Consistency** between Mongo (source of truth during transition) and Zarr —
  the generation counter + dirty flag must be authoritative; reads must never
  serve a stale Zarr silently. Consider serving Mongo until the first build
  completes, then Zarr.
- **Incremental updates** vs full rebuild — start with rebuild-on-dirty; profile
  before building incremental append.
- **String properties** — keep in Mongo or a Zarr side table; `X` stays numeric.

---

## Deployment order

1. **Phase 1** (done) — deploy, confirm wide datasets activate lazy mode and no
   longer OOM. Pure frontend, reversible.
2. **Phase 2** — deploy, confirm no wholesale value loads remain in lazy mode
   (filters, VolumeViewer, agent, plots). Pure frontend, reversible.
3. **Phase 3** — behind the per-dataset flag, so it's opt-in per dataset and
   ordinary datasets are unaffected. Deploy the read path first (build job +
   routing + flag), validate against Mongo output for a real large dataset, then
   the direct-to-Zarr write path last.

---

## Regression checklist

Grouped by concern; each item names the test that holds it. Add an item whenever
a review finds something this list missed.

### Mode decision (Phase 1)
- Narrow dataset under `stubThreshold` stays wholesale —
  `propertyValues.test.ts` `shouldUseStubOnlyMode` "small, narrow".
- Wide dataset under `stubThreshold` (count × width > budget) goes lazy —
  same suite, "count × width exceeds the value budget".
- Count-fetch failure → lazy; width-fetch failure → lazy — same suite, Infinity
  cases. *(Store-level wiring test in `annotation.ts` TODO — the helper is
  covered; add a `fetchAnnotations` test that mocks a failing width sample.)*
- Empty dataset with unknown width stays wholesale (no `0 × Infinity` NaN
  regression) — same suite, "empty dataset".

### Lazy-mode boundedness (Phase 2 — to add)
- Toggling a property filter in lazy mode does **not** call
  `fetchAllPropertyValues` — new test in `AnnotationViewer.test.ts` /
  `filters.test.ts`.
- `VolumeViewer` in lazy mode fetches values for its rendered set rather than
  reading the visible-subset cache — new test.
- Agent sampling tool pulls only the queried ID set in lazy mode — new test in
  the agent suite.

### Columnar store (Phase 3 — to add)
- Zarr reader returns byte-identical `/batch`, `/histogram`, `/list/ids`, and
  `uncomputed_counts` results to the Mongo path for a fixture dataset — backend
  parity test (tox).
- Flag off → Mongo path; flag on → Zarr path — routing test.
- Build job flips the flag and bumps generation only on success — job test.
- A write after build marks the dataset dirty (or updates Zarr) — event-hook
  test.

### Process rules proved here
- Verify from a fresh page load on a dataset that actually has many property
  values (the width estimate is only meaningful with real value docs).
- Rebuild the girder container (not restart) after changing plugin
  dependencies — `pip install -e` runs at image build time.
