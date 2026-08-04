# Property-Value Scaling: Lazy Loading and a Zarr Columnar Store

**Status:** Phases 1 and 2 implemented; Phase 3 backend foundation started
(store + build job + state, unwired from live routes).
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

### Wholesale escape hatches found in the baseline (all closed in Phase 2)

- **Property filters (lazy mode):** already server-side via
  `refreshPropertyFilterPassingIds` → `/list/ids`; the audit confirmed no filter
  path forces a wholesale load, and Phase 2 pinned that with a test.
- **`VolumeViewer.vue`** read `propertyStore.propertyValues` directly for 3D
  segmentation coloring with no lazy-mode guard — silently blanked coloring.
- **AI agent tools** (`src/agent/executors.ts`) read the in-memory map, and more
  seriously iterated the empty `annotations[]` in lazy mode, so every analysis
  tool silently reported an empty dataset.
- **Property panels / filter histograms** were already correct: the filter
  histogram deliberately derives its range from the *server* histogram rather
  than the bounded `propertyValues` map (`PropertyFilterHistogram.vue`), and
  `AnnotationList` reads values per rendered row, which the viewport fetch
  covers. `AnnotationCSVDialog` reads the resident map, but CSV export of a lazy
  dataset goes through the backend `/export` endpoints, which never touch
  frontend state.

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

## Phase 2 — remaining consumers read scoped values ✅ IMPLEMENTED

**Goal:** eliminate every remaining path that materializes the full value map,
so lazy mode is genuinely bounded regardless of dataset width. No storage change
— this leans entirely on the existing `/batch` and `/list/ids` endpoints.

### The shared primitive

`properties.fetchValuesForIds({ids, paths})` returns values for an explicit,
bounded id set as a plain map. It deliberately does **not** commit into
`propertyValues`: that cache is pruned to the visible set on every pan, so
merging a different set in would either be dropped immediately or fight the
pruning. It reuses whatever the cache already holds (via `idsMissingPaths`) and
requests only the genuinely missing ids. In wholesale mode it short-circuits to
the resident map with no request.

### 1. Property-filtered drawing — already server-side, now pinned

`filters.refreshPropertyFilterPassingIds` fetches passing ids via `/list/ids`
and `filteredAnnotations` ANDs that set in, so no wholesale load is triggered by
a filter. The audit confirmed `fetchAllPropertyValues` is reachable **only** from
the non-lazy branch of `fetchPropertyValues`, which is the single entry point
every consumer uses — so pinning that one function pins the invariant for all of
them. A stale comment claiming AnnotationViewer force-loaded values under a
filter was removed.

### 2. 3D segmentation coloring (`VolumeViewer.vue`)

`annotationsTo3D` falls back to a flat neutral color if **even one** rendered
annotation lacks a value, so the old visible-subset read did not merely degrade —
it silently blanked the whole segmentation's coloring (the property being colored
by need not even be a *displayed* column). Now, in lazy mode with property
coloring active, values are read for exactly the rendered set. That set is the
hydrated annotations, so it is bounded by the hydration cap. A failed fetch falls
back to the resident cache: incomplete color beats no geometry.

### 3. AI agent analysis tools (`executors.ts`)

The value cache turned out to be the *smaller* half of this bug. `queryAnnotations`,
`liveAnnotationIdSet`, `buildTagsMap`, `buildFirstTagMap`, and two summary tools
all iterated `annotationStore.annotations`, which is **empty** in lazy mode — so
on exactly the large datasets they matter for, every analysis tool silently
matched nothing and reported an empty dataset. All now use the stub-aware
accessors (`annotationsForIteration`, `allAnnotationIds`, `annotationCount`);
every predicate they apply (id, tags, shape, channel, location) is a field stubs
carry. `list_annotations` narrows with `isHydratedAnnotation` and falls back to
the stub's precomputed `centroid`.

On top of that, the six analysis tools now read values through
`loadAnalysisValues`, which fetches them for the analyzed set in lazy mode:

- **`get_sample_values` is bounded by construction** — it downsamples the
  candidate ids *first*, then reads values only for the ≤`n` sampled rows, so it
  works at any dataset size. Its result key changed from `totalMatching` to
  `totalCandidates`, because it can no longer honestly report how many of the
  whole matching set have a value document without reading all of them.
- **Aggregate tools** (stats, histogram, scatter, box) need whole columns, so
  they are capped at `MAX_ANALYSIS_IDS` (50,000) and otherwise return a clear
  error asking the model to narrow with `query`. That is deliberately an honest
  refusal rather than a silent empty result; the real fix is a server-side
  aggregation endpoint (Phase 3).

### 4. CSV export dialog (`AnnotationCSVDialog.vue`)

Found by sweeping the branch for the generalized shape rather than by a report —
`annotationStore.annotations` is empty in lazy mode, so:

- `annotationsToExport` was empty, and `isSubset` (which compares it against the
  dataset count) was therefore false, so **"export selected" silently exported
  the entire dataset**. Both now use the stub-aware accessors.
- The ≤1000-row *preview* read the resident map and so showed blank/NA values.
  It now reads values for exactly the previewed rows. Note this became reachable
  *because of Phase 1*: lazy mode can now trigger on property width at a low
  annotation count, well under the preview limit.

The actual download was and remains server-side (`/export/csv`), so exported
values were never wrong — only the preview and the selection scope.

### The generalized shape (for future sweeps)

Every bug in Phase 2 reduces to one of two shapes:

1. **A consumer reads `annotationStore.annotations`**, which is empty in lazy
   mode. Fix: `annotationsForIteration` / `allAnnotationIds` /
   `annotationCount`, narrowing with `isHydratedAnnotation` where coordinates or
   `name` are needed.
2. **A consumer reads `propertyStore.propertyValues`**, which in lazy mode holds
   only the visible annotations and only the displayed columns. Fix:
   `fetchValuesForIds` for the bounded set actually being used.

Remaining readers of (1), deliberately left: `properties.ts`
`uncomputedAnnotationsPerProperty` (correct by design — `uncomputedCountByProperty`
switches to server counts in lazy mode), `AnnotationList.vue:1000` (a
count-change refresh trigger), `proposalDedupe.ts` (auto-tool-suggestion overlap
dedupe — a separate feature), `main.ts` (memory diagnostics), and the agent's
fit-view (below).

### Deliberately not fixed

Fit-view-to-annotations needs coordinates that stubs lack, and already fails with
an explicit error in lazy mode rather than silently — see *Known gaps* in the
Regression checklist.

---

## Phase 3 — Zarr columnar property-value store

### What is implemented so far

The backend **foundation** is committed but **not wired into any live route**
(routing dispatch stays behind the per-dataset flag, which is never set until a
build runs), so it cannot affect current behavior. numpy/scipy/zarr/anndata are
not installed in the dev/CI sandbox, so the numeric layer is written +
flake8-clean + covered by a skipped-until-extras test — **validate with `tox`
inside a rebuilt girder container.**

| File | Role | Validated here? |
|------|------|-----------------|
| `server/helpers/valueMatrix.py` | pure flatten/unflatten/bucket/filter logic | yes (no deps) |
| `server/helpers/valueStoreState.py` | per-dataset flag + generation on folder meta | inspection |
| `server/helpers/zarrValueStore.py` | AnnData/Zarr build + batch/histogram/filter reads | inspection; skipped test |
| `server/helpers/zarr_value_job.py` | local build job (Zenodo-job pattern) | inspection |
| `test/test_value_matrix.py` | pure-logic unit tests | runs in any tox env |
| `test/test_zarr_value_store.py` | build↔read roundtrip parity | skips without extras |
| `setup.py` | `columnar` extra (numpy/scipy/zarr/anndata) | — |

**Numeric-only first cut:** `X` holds numeric leaves; string/null/bool leaves
are skipped (count recorded in `uns.nimbus_meta`) and stay served from Mongo.
A real stored `0.0` is preserved via a `present` mask layer (so write-time
zero-elimination can't turn it into an absent value).

**Not yet done (next Phase 3 steps):** the read-routing dispatch in the
endpoints (`/batch`, `/histogram`, `/list/ids`, `uncomputed_counts`) behind
`valueStoreState.is_zarr_ready`; a build-trigger + status endpoint; the
dirty-on-write hook (`model.upenn_annotation.removeStringIds` is the natural
bind point); the scanpy-facing matrix download; and the direct-to-Zarr write
path. Column reads currently read whole CSC column slices; a CSR mirror for the
row-oriented `/batch` is deferred until measured.

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
2. **Phase 2** (done) — deploy, then verify on a real large dataset: 3D property
   coloring still colors (not neutral), and the AI panel's analysis tools report
   real numbers instead of an empty dataset. Pure frontend, reversible.
3. **Phase 3** — behind the per-dataset flag, so it's opt-in per dataset and
   ordinary datasets are unaffected. Deploy the read path first (build job +
   routing + flag), validate against Mongo output for a real large dataset, then
   the direct-to-Zarr write path last.

---

## Regression checklist

Grouped by concern; each item names the test that holds it. Add an item whenever
a review finds something this list missed.

### Mode decision (Phase 1) — `src/utils/__tests__/propertyValues.test.ts`
- A narrow dataset under `stubThreshold` still loads wholesale —
  *"stays wholesale for a small, narrow dataset"*.
- A wide dataset under `stubThreshold` goes lazy on the value budget —
  *"goes lazy when count × width exceeds the value budget under the count
  threshold"*.
- Count above the threshold goes lazy regardless of width —
  *"goes lazy above the annotation-count threshold regardless of width"*.
- Both boundaries are exact, not off by one —
  *"stays wholesale exactly at the count threshold with a narrow width"* and
  *"stays wholesale exactly at the value budget"*.
- A failed count or width fetch routes to the safe (lazy) path —
  *"goes lazy on an unknown (Infinity) count — the safe path"* and
  *"goes lazy on an unknown (Infinity) width when annotations exist"*.
- `0 × Infinity` (empty dataset, unknown width) must not read as over-budget —
  *"stays wholesale for an empty dataset even with unknown width"*.
- A dataset with no property values is never forced lazy by width —
  *"ignores width when there are no property values"*.

### Lazy-mode boundedness (Phase 2) — `src/store/__tests__/properties.test.ts`
- The wholesale loader is reachable only from the non-lazy branch —
  *"samples paths instead of loading every value in lazy mode"* and
  *"still loads every value in wholesale mode"*. This is the invariant every
  other consumer inherits, since `fetchPropertyValues` is the single entry
  point.
- Viewport loading stays scoped to the visible ids and displayed columns —
  *"fetches only the visible ids' values in lazy mode"*.
- A scoped read returns the requested ids —
  *"fetches the requested ids and returns them as a map"*.
- A scoped read must not disturb the pruned visible cache (it would be dropped
  on the next pan, or fight the pruning) —
  *"does not write the fetched values into the visible-set cache"*.
- A scoped read reuses what the cache already holds —
  *"reuses cached values and requests only the missing ids"*.
- Wholesale mode answers scoped reads from memory, with no request —
  *"returns the resident map without a request in wholesale mode"*, and
  *"makes no request for an empty id or path set"*.

### 3D property coloring (Phase 2) — `src/components/VolumeViewer.test.ts`
- Coloring reads values for the rendered (hydrated) set, not the visible-subset
  cache — *"fetches values for the rendered set and passes them to
  annotationsTo3D"*. Without this, one missing value silently flattens the whole
  segmentation to a neutral color.
- The fetch is conditional, not unconditional —
  *"does not fetch when coloring by tag"* and
  *"does not fetch in wholesale mode (the resident map is complete)"*.
- A failed value fetch degrades color, never geometry —
  *"still renders geometry when the value fetch fails"*.

### Agent analysis in lazy mode (Phase 2) — `src/agent/executors.test.ts`
- Summaries count stubs rather than reporting an empty dataset —
  *"get_annotation_summary counts stubs instead of reporting an empty dataset"*.
- Listing works from stubs, which carry a centroid but no coordinates or name —
  *"list_annotations returns stub rows with the stub centroid"*.
- Aggregate tools fetch values for the analyzed set —
  *"get_property_histogram fetches values for the analyzed set"* and
  *"get_property_values reports stats from fetched values"*.
- Sampling is bounded by construction: downsample first, then read only the
  sampled rows — *"get_sample_values reads only the sampled rows, not the whole
  set"*.
- An unbounded aggregate asks the model to narrow instead of pulling a whole
  dataset — *"aggregate tools refuse an unbounded set and ask the model to
  narrow it"*.

### Columnar store (Phase 3) — plugin `test/`
- Flatten/unflatten round-trips, including a null leaf and an empty-dict leaf —
  *"testRoundTrip"*, *"testNullLeafIsPreserved"*, *"testEmptyDictIsALeaf"*.
- The stored column index is deterministic across builds —
  *"testSortedUnionAcrossSparseDocs"*.
- Histogram bucketing matches the Mongo endpoint's shape, including ties and
  empty input — *"testContiguousBucketsSpanRange"*, *"testEmptyInput"*,
  *"testAllEqualCollapsesToOneBucket"*.
- An absent value never passes a range filter (matching Mongo) —
  *"testMissingValueNeverPassesARange"* and *"testAbsentValueDoesNotPass"*.
- Reads match the Mongo result shapes, projected and unprojected —
  *"testReadBatchAllColumns"*, *"testReadBatchProjectsPaths"*.
- A real stored `0.0` is not read as an absent value (the presence-mask
  invariant) — *"testStoredZeroSurvives"*.
- Filters AND across columns — *"testMultipleFiltersAreAnded"*.
- *To add with the routing dispatch:* flag off → Mongo, flag on → Zarr (routing
  test); the build job flips the flag / bumps generation only on success (job
  test); a write after build marks the dataset dirty (event-hook test); Zarr vs
  Mongo parity on a real fixture dataset end to end.

### CSV export dialog (Phase 2) — `AnnotationCSVDialog.test.ts`
- Scope counts come from stubs, so the export set is not empty in lazy mode —
  *"counts stubs so the export scope is not an empty set"*.
- "Export selected" sends the selected ids rather than falling through to a
  whole-dataset export — *"exports only the selected stubs, not the whole
  dataset"*.
- The bounded preview reads values for the previewed rows —
  *"reads preview values for the previewed rows rather than the visible cache"*.
- The too-large-for-preview branch is actually exercised (it previously passed
  because a full synchronous generation left progress at 1) —
  *"updateText clears text and sets progress when too large for preview"*.

### Known gaps (deliberately not fixed here)
- **Fit-view-to-annotations** (`set_view` / `fit: "full" | "selection"` in the
  agent) needs coordinates, which stubs lack, so it fails with an explicit "no
  annotations to fit" error in lazy mode. It fails *loudly*, unlike the silent
  wrongness fixed above; fixing it means bounding from stub centroids or the
  spatial index.
- **Whole-dataset aggregates above `MAX_ANALYSIS_IDS`** are refused rather than
  computed. The real fix is a server-side aggregation endpoint (Phase 3), not a
  bigger client-side ceiling.

### Process rules proved here
- Verify from a fresh page load on a dataset that actually has many property
  values (the width estimate is only meaningful with real value docs).
- Rebuild the girder container (not restart) after changing plugin
  dependencies — `pip install -e` runs at image build time.
- Confirm a new test fails without its fix via `git stash push <file>` (used for
  the VolumeViewer and agent fixes here); a test that passes before the fix is
  worse than no test.
