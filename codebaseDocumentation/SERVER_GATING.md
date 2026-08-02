# Server-side analysis gating (spec)

**Status: Phases 1–3 implemented on `analysis-server-gating` (branched off
`analysis-panel-scatter-gating`, PR #1298). Backend + frontend suites green;
see the regression checklist at the bottom.**

This document is the contract to build against and iterate on. It extends
`ANALYSIS_PANEL.md` (the client-side design record); nothing here relaxes an
invariant recorded there. Read that document first.

## Why

The Analysis panel refuses to work above `MAX_ANALYSIS_PLOT_POINTS = 50,000`
filtered objects (`src/store/constants.ts:30`): plotting is refused, gate
resolution stops, and the panel shows a "narrow the filters" notice. That was
the correct call for a client-side design — a gate resolves to an id set, and
resolving it against a sample or a viewport subset silently excludes every
object the client never saw (see "The point cap, and why there is no
sampling", ANALYSIS_PANEL.md).

But the datasets this feature exists for are exactly the ones above the cap
(the Xenium lymph-node dataset has 708,983 objects). The property values live
server-side; the polygon test is trivial; so resolution belongs server-side
where the full population is.

Three phases, each independently shippable:

| Phase | Deliverable | What it unlocks |
|---|---|---|
| 1 | `POST /upenn_annotation/analysis/gate_ids` — resolve gate polygons to id lists server-side; client uses it above the cap | Gates *filter* correctly at any dataset size |
| 2 | `POST /upenn_annotation/analysis/histogram2d` — server-binned 2D counts; heatmap rendering + shape-drawn gates above the cap | Users can *see and draw* gates at any size |
| 3 | Gate definitions as first-class terms in the `/list` and `/list/ids` filter objects | The Objects tab and export stop round-tripping gate id lists on every page fetch |

## The core semantic decision: a gate is a pure predicate

### Statement

A gate's membership predicate is a **pure function of the gate definition and
one annotation** — never of the population the gate is evaluated against:

```
inGate(annotation, gate, xAxis, yAxis) =
    x := axisCoordinate(annotation, xAxis, gate.xCategories)
    y := axisCoordinate(annotation, yAxis, gate.yCategories)
    x ≠ null ∧ y ≠ null ∧ pointInPolygon((x, y), gate.vertices)
```

where `axisCoordinate` is:

- **Property axis** (`{type: "property", path}`): the value at
  `values.<path>` for this annotation. Must be a finite number; anything else
  (missing document, missing key, string, NaN, Infinity, null) → `null` →
  **outside the gate** (matches `rawAxisValue`, `src/utils/analysisGating.ts:146`).
- **Categorical axis** (`{type: "categorical", key}`): let `k` be the encoded
  category key of the annotation's raw identity (see *Category keys* below).
  If `k` is at index `i` in the gate's pinned order (`gate.xCategories` /
  `gate.yCategories`), the coordinate is `i + jitter(annotationId, salt)`.
  **If `k` is not in the pinned order, the coordinate is `null` → outside the
  gate.**
- Fewer than 3 vertices → matches nothing (parity with `resolveGateIds`).
- Point-in-polygon is **even-odd ray casting**, exactly the algorithm in
  `analysisGating.ts:284` (strict inequalities and all).

### Why purity is sound (the chain-redundancy argument)

Today the client resolves gate *i* against the population reaching plot *i*
(base filters ∧ gates 0..i−1, via `chainPlotInputs`). For **filtering**, that
restriction is redundant: `filteredAnnotations` is
`base ∩ ⋂ᵢ gateSetᵢ`, with `gateSetᵢ = polygonᵢ ∩ upstreamᵢ` and
`upstreamᵢ = base ∩ polygon₀ ∩ … ∩ polygonᵢ₋₁`; the whole intersection
telescopes to exactly `base ∩ ⋂ᵢ polygonᵢ`. The chain matters only for **display** — which points
appear on plot *i*, and the per-plot "gate: N" badge — and display can compose
the chain client-side from the pure sets.

Purity is what makes server-side resolution *stateless*: the request carries
the gate definition, the answer depends only on the dataset's current
contents, and none of the client's filter state (selection sets, ROI
polygons, hidden-layer rules) has to be serialized, mirrored, or invalidated.
The entire class of invalidation findings from review rounds 3–12 (upstream
edits, base-population changes, palette toggles) does not exist for the
server path, because the answer never depended on those inputs.

### The one deliberate behavior change: unknown categories are outside the gate

Today, a category absent from a gate's pinned order is appended to the end of
the axis in *population encounter order* (`buildPlotSeries`'s `buildAxis`),
so an annotation in a brand-new category can fall inside an old polygon that
happens to reach that index. That membership depends on which other unknown
categories exist and the iteration order of the population — it is arbitrary,
unreproducible server-side, and inexpressible as a per-annotation predicate.

**New rule, applied in BOTH implementations: an annotation whose category key
is not in the gate's pinned order is outside that gate.** Unknown categories
still *plot* (appended after the pinned ones, sorted by label then key, so
users see them); to gate them, redraw the lasso — redrawing re-pins the order
including the new categories. This is the flow-cytometry meaning of a gate: a
region in the coordinate space that existed when it was drawn.

Client change required: `resolveGateIds` must exclude points whose categorical
index is ≥ the gate's pinned-category count (`Math.round(coord) >=
gate.xCategories.length`; jitter is bounded by ±0.28 so rounding recovers the
index exactly). Sorting appended categories (instead of encounter order) is a
display-determinism fix that rides along.

Cross-the-cap consistency is the hard requirement behind this: a dataset that
grows past the cap **must not change gate membership** by switching resolvers.
One predicate, two implementations, one shared test fixture (below).

### Category keys in Python

`encodeAnalysisCategoryKey` is `"v1:" + JSON.stringify(raw)` where raw is a
sorted string array (tags), a string (shape), or an int (channel, xy, z,
time). Python parity:

```python
def encode_category_key(raw) -> str:
    return "v1:" + json.dumps(raw, separators=(",", ":"))
```

`json.dumps` with `separators=(",", ":")` matches `JSON.stringify` for
strings, string arrays, and integers (the only raw types; floats never occur
— locations and channel are ints). One divergence to handle: tags are sorted
before encoding, and JS `Array.prototype.sort` compares **UTF-16 code
units** while Python's `str` comparison uses code points. These differ only
when a string contains astral-plane characters (JS compares their surrogate
pairs). `helpers/analysis.py` therefore sorts tags with a UTF-16 code-unit
sort key (encode each string to its sequence of UTF-16 code units and
compare those), and the parity fixture includes an astral-plane tag to pin
this exact case.

### Jitter in Python (bit-exact)

`jitterFromId` (`analysisGating.ts:84`) is 32-bit integer arithmetic plus one
IEEE-754 double expression — both exactly reproducible:

```python
def jitter_from_id(annotation_id: str, salt: int) -> float:
    h = salt
    for ch in annotation_id:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF   # JS (h*31+c)|0 then >>>0
    return ((h % 1000) / 1000 - 0.5) * 0.56
```

JS computes `(h * 31 + c) | 0` in signed 32-bit and finally `h >>> 0`;
keeping the value reduced mod 2³² unsigned is the same bits. `(h % 1000) /
1000 - 0.5) * 0.56` is double math in both languages → identical to the last
bit. Salts: X = 17, Y = 31. Annotation ids are 24-char hex (ASCII), but the
implementation must handle arbitrary BMP strings the way `charCodeAt` does
(UTF-16 code units) — the numpy version operates on code-unit arrays.
Vectorized form: ids as a `(N, L)` uint32 array of code units, 24 fused
multiply-adds under `np.uint32` wrap-around.

**The cross-language contract tests are the most important tests in this
feature.** A vitest test writes JSON fixtures
(`test/fixtures/analysis_gating_parity.json`, committed) containing:
(a) ~20 ids × both salts → expected jitter doubles;
(b) a small synthetic population (mixed property/categorical axes, missing
values, an astral-plane tag, duplicate labels) + several gates (lasso, box,
<3 vertices, polygon crossing a jittered strip boundary) → expected id sets.
The Python suite loads the same fixture and asserts equality **to the bit**
for jitter and exactly for id sets. If either implementation changes, the
fixture regenerates from TS (the reference implementation) and the Python
test fails until parity is restored.

## Phase 1 — `POST /upenn_annotation/analysis/gate_ids`

### Request

```jsonc
{
  "datasetId": "<hex id>",
  "plots": [                       // plots with DRAWN gates, in plot order
    {
      "id": "<plot uuid>",         // opaque; echoed back as the result key
      "xAxis": {"type": "property", "path": ["<propId>", "Area"]},
      "yAxis": {"type": "categorical", "key": "tags"},
      "gate": {
        "categoryKeyVersion": 1,
        "vertices": [{"x": 1.5, "y": 2.5}, ...],
        "xCategories": null,               // pinned order, per axis type
        "yCategories": ["v1:[\"A\"]", ...]
      }
    }
  ]
}
```

### Response

```jsonc
{ "gateIds": { "<plot uuid>": ["<annotation hex id>", ...], ... } }
```

Each list is that gate's **pure-predicate membership over the whole dataset**
— independent of every other plot in the request (no chaining server-side;
see the redundancy argument). An empty list is a real answer ("this lasso
contains nothing"), distinct from the plot being absent from the request.

### Validation (all 400s, `server/helpers/validation.py` style)

- Body must be an object; `datasetId` via `requireObjectId`.
- `plots` via `requireList`; length ≤ `MAX_ANALYSIS_PLOTS = 100`.
- Each plot: object with string `id`; `xAxis`/`yAxis` each
  `{type: "property", path}` (path via `isValidPropertyPath` — non-empty
  string list, no `.`/`$`) or `{type: "categorical", key}` with key in the
  six known keys.
- `gate`: object; `vertices` a list of `{x, y}` finite numbers, length ≤
  `MAX_GATE_VERTICES = 10_000` (< 3 is **not** an error — it resolves to `[]`,
  parity with the client); `categoryKeyVersion` must equal 1; per-axis
  categories: `null` for property axes, list of strings (≤
  `MAX_GATE_CATEGORIES = 10_000`) for categorical axes. A categorical axis
  with `null` categories is a 400 (the client always pins on draw).
- Booleans rejected where numbers are expected (mirror `validateListInputs`).

### Access & abuse bounds

- `@access.public(scope=TokenScope.DATA_READ)` + `Folder().load(datasetId,
  user=..., level=AccessType.READ, exc=True)` — the `/list/ids` pattern
  exactly.
- All Mongo reads through model methods / `_aggregate` (maxTimeMS 300s,
  `allowDiskUse`, hint `{datasetId: 1, _id: 1}` where applicable) — never raw
  unbounded `collection.find`.
- Work is bounded by the validation caps above plus dataset size; no
  response-size cap, same rationale as `/list/ids` (validation.py:15–19).

### Implementation sketch (backend)

New module `server/helpers/analysis.py` — pure functions, no HTTP concerns,
shared by Phases 1–3:

```python
def resolve_gate_ids(annotations, values_by_id, plot) -> list[str]
def axis_coordinates(annotations, values_by_id, axis, categories) -> np.ndarray  # NaN = no value
def points_in_polygon(xs, ys, vertices) -> np.ndarray[bool]   # even-odd, vectorized
def jitter_from_ids(ids, salt) -> np.ndarray[float64]
def encode_category_key(raw) -> str
```

Endpoint flow (in `api/annotation.py`, model logic in
`models/annotation.py` per the API/model layering rule):

1. Validate + access-check (API layer).
2. One projected query per collection, not per plot:
   - annotation collection: `{datasetId}` → `_id, tags, shape, channel,
     location` (only the fields any requested categorical axis needs; skip
     entirely if all axes are property axes).
   - PV collection: `{datasetId}` → `annotationId` + `values.<path>` for the
     union of requested property paths (the `findByAnnotationIds` projection
     shape, but matched on `datasetId` alone — no id list).
3. numpy: per plot, build x/y coordinate arrays, run `points_in_polygon`,
   collect ids. Missing value on either axis → excluded (NaN never passes).
4. Return `{gateIds}`.

**Measured cost** on the 708,983-object Xenium dataset (local Docker, warm):
gate resolution **~4.5 s**, histogram **~7.3 s**, a gate-carrying list page
**~4.8 s**. The polygon test itself is ~0 — the time is the projected Mongo
scan plus building coordinates for 700K rows.

Two optimizations were required to get there from a first-cut ~16.7 s / 33.4 s
(both preserve results exactly; the parity fixture proves it):

- **Memoize the category-key encoding per axis.** A dataset has a handful of
  distinct categories and hundreds of thousands of annotations, so encoding
  per annotation ran `json.dumps` 700K times per axis (~1 s each) to produce
  a few distinct strings.
- **Batch-decode id code units.** When every id is the same length and pure
  BMP — 24-char hex ObjectIds, i.e. always — the whole batch decodes in one
  `frombuffer` instead of a Python loop per id (1.9 s → 0.05 s).
- The histogram additionally reuses the coordinates it just built for the
  badge count instead of re-resolving the gate from the docs.

That is fine for a gate-edit-triggered call and acceptable per list-page
fetch; see Phase 3's cost note for the escape hatches if it ever isn't.

### Client integration (Phase 1)

The dividing line is `analysisPopulation.length > MAX_ANALYSIS_PLOT_POINTS`
— the same cap, now routing to the server instead of clearing state. Below
the cap **nothing changes**.

- **`analysisInputSignature`** (filters.ts): the over-cap branch stops
  returning the constant `"over-cap"` and returns the server-mode identity:
  `["server", datasetId, JSON.stringify(gate-relevant fields of
  resolutionPlots), propertyValuesRevision, annotation.contentRevision]`.
  Note what it deliberately does NOT include: the population signature,
  categorical content hash, or any filter state — the pure predicate does
  not depend on them. This is the payoff of purity: the over-cap signature is
  O(plots), not O(population).
- **`annotation.contentRevision`** (new, annotation store): a monotonic
  counter bumped by every mutation that changes annotation content or
  membership (`setAnnotations`, `setAnnotation`, `setAnnotationsAtIndices`,
  stub updates, create/delete paths). It is the server-mode stand-in for
  `categoricalContentSignature` + `populationSignature` (an annotation edit
  must re-resolve gates, and the client cannot hash 700K stubs per reactive
  touch). Coarse over-triggering is tempered by the refresh debounce below.
- **`refreshAnalysis`**: claims `analysisGateGuard` token first (unchanged
  invariant), then branches: over-cap + any `resolutionPlots` with drawn
  gates → `fetchServerGateIds(datasetId, plots)` (new method in
  `AnnotationsAPI.ts`; POSTs the request above). Commit via the existing
  `setAnalysisGateIds` + `setAnalysisGateDataSignature` machinery, with the
  server-mode signature in place of `gateDataSignature`. Failure handling is
  the existing contract: `null` on request failure (never `{}`); same-input
  retry may keep prior ids; changed-input ids are dropped before awaiting.
  Scope reuses `analysisRefreshScope` verbatim: hidden → enabled drawn gates
  only; panel open → all drawn gates (badges in Phase 2 need them).
- **What lands in `analysisGateIds` above the cap: the PURE id lists**, not
  chain-intersected ones. `filteredAnnotations` (`base ∩ ⋂ gateSets`) is
  unchanged and provably equal to today's semantics. Composition with the
  server list (`activeAnalysisGateIdLists` → `idConstraints`) and CSV export
  work unchanged. Empty pure lists flow into the existing
  `filtersMatchNothing` guard — the match-none path is already correct.
- **Debounce**: the Viewer watcher on `analysisInputSignature` gains a 300 ms
  debounce for the server-mode signature only (contentRevision can burst
  during bulk edits); below-cap behavior is untouched. The sequence guard
  makes overlapping requests safe regardless.
- **The panel above the cap still shows the over-cap banner in Phase 1** —
  amended to say gates still apply and will become drawable in Phase 2.
  Gates are surfaced by their own badge on the **Analysis** button
  (`activeAnalysisGateCount`), which counts gates rather than ids and so
  works unchanged above the cap. Note that badge is on Analysis, not
  Filters: `activeFilterCount` deliberately excludes gates, because each
  badge counts only what its own panel can display.

### What Phase 1 explicitly does not do

- No histogram/heatmap (Phase 2). Users cannot *draw* a new gate above the
  cap yet; persisted/below-cap-drawn gates now *apply* above it.
- No change to below-cap resolution, or to how gates reach the server list.
- No frontend fallback for a backend without the endpoint (per repo policy:
  the frontend does not compensate for outdated backends). Deploy backend
  first.

## Phase 2 — `POST /upenn_annotation/analysis/histogram2d`

### Purpose

Above the cap the panel renders each plot as a server-binned 2D histogram
(Plotly `heatmap`) instead of a scatter, and gates are drawn as shapes
(`drawclosedpath` / `drawrect`) instead of lasso selections. Resolution is
Phase 1's endpoint; this endpoint is **display only**.

### Request

```jsonc
{
  "datasetId": "<hex id>",
  "xAxis": {...}, "yAxis": {...},          // TAnalysisAxis, as Phase 1
  "xCategories": [...] | null,             // pinned order if this plot has a gate
  "yCategories": [...] | null,
  "bins": {"x": 128, "y": 128},            // clamped to [1, MAX_HISTOGRAM_BINS=512]
  "upstreamGates": [ {xAxis, yAxis, gate}, ... ],   // ENABLED gates of plots before this one
  "filters": { ...IAnnotationListFilters... }        // the serializable base filters
}
```

- `upstreamGates` reproduce the chain for display: the histogram shows the
  population *reaching* this plot. Server applies them as pure predicates.
- `filters` reuses the existing list-filter schema and `validateListInputs`
  (tags, location, propertyFilters, idConstraints, idSubstring) so the
  histogram reflects the same narrowing the server list already understands.

### Response

```jsonc
{
  "counts": [[...], ...],            // len(yBins) rows × len(xBins) columns
  "xEdges": [..] | null,             // numeric axis: bin edges (len = bins+1)
  "yEdges": [..] | null,
  "xCategories": [..] | null,        // categorical axis: keys in index order
  "yCategories": [..] | null,        //   (pinned order extended w/ sorted unknowns)
  "inputCount": 123456,              // population after filters + upstream gates
  "plottedCount": 120000,            // rows with values on both axes
  "gateCount": 4521 | null           // |this plot's own gate ∩ input|, when the
                                     // plot's gate is sent (badge parity)
}
```

For a categorical axis, each category is one bin at its integer index
(jitter is irrelevant for binning; it only matters for polygon membership).
Numeric edges come from the population min/max after filters; degenerate
(min == max) → one bin.

### Client integration

- `AnalysisScatterPlot.vue` gains an over-cap mode: heatmap trace (log-scaled
  color option deferred), axis layout from edges/categories, and
  `layout.dragmode: "drawclosedpath"` with `modebar` adding `drawrect` +
  `eraseshape`. `plotly_relayout` events carrying `shapes` are parsed
  (`M/L/Z` path → vertices; rect → 4 corners) by a new pure util
  `shapeToGate` in `analysisGating.ts`, then stored via the existing
  `setAnalysisPlotGate` — downstream identical to a lasso. One drawn shape
  per plot: drawing a new one replaces the gate (and the rendered shape).
- The existing gate polygon is re-rendered as a layout shape so a persisted
  gate is visible on the heatmap.
- Fetching is display work and must obey the palette-visibility invariant
  (ANALYSIS_PANEL.md "The panel component is always mounted; its display
  work is not"): histogram requests fire only while the panel is open, keyed
  by a per-plot signature (axes + bins + upstream-gate definitions +
  serializable-filters JSON + contentRevision + propertyValuesRevision),
  with a sequence guard per plot.
- **Honesty banner**: filters the client applies that the request cannot
  express (ROI polygons, hidden-layer rules, id-list filters above
  `MAX_HISTOGRAM_ID_CONSTRAINT = 50_000` ids) render a per-plot notice:
  "distribution ignores: <names>" — the histogram may show a superset. The
  *gate resolution* (Phase 1) is unaffected — it is filter-independent — so
  filtering correctness never degrades; only the picture can over-include.
  This mirrors the server list's existing documented ROI limitation.
- The per-plot badge above the cap reads `gateCount` from the histogram
  response (chained semantics preserved) rather than `gateIds.length` (pure
  count, which would over-state).

## Phase 3 — gate definitions as first-class list-query terms

### Problem

Above the cap a resolved gate can hold hundreds of thousands of ids, and
`buildListFilters` currently ships every gate's full id list as an
`idConstraints` entry **on every page fetch, count, and select-all**. That is
megabytes of upload per pagination click.

### Change

`IAnnotationListFilters` gains:

```ts
analysisGates?: {
  xAxis: TAnalysisAxis;
  yAxis: TAnalysisAxis;
  gate: IAnalysisGate;       // vertices + pinned categories + version
}[];
```

- `buildListFilters` sends **definitions** for the analysis gates (all modes,
  above and below the cap — one code path) and stops pushing gate id lists
  into `idConstraints`. Selection and annotation-id filters keep using
  `idConstraints` unchanged.
- The client-side match-none short-circuit moves off `filtersMatchNothing`'s
  `idConstraints` scan for gates: a new getter (`hasEmptyResolvedGate`) — any
  *resolved* gate whose id list is empty — feeds the same short-circuit in
  `AnnotationsAPI` (answer `{total: 0}` without asking). The server also
  answers correctly if asked (a gate matching nothing yields zero rows);
  the short-circuit is an optimization, not load-bearing correctness.
- Backend: `validateListInputs` validates `analysisGates` with Phase 1's
  validators; `models/annotation.py` resolves each gate to an ObjectId set
  via `helpers/analysis.py` **once per request**, then appends
  `{"_id": {"$in": ids}}` to the match stages (same AND shape as
  `idConstraints`). 300K ObjectIds ≈ 3.6 MB in-pipeline — inside BSON limits.
- `currentFiltersSignature` must hash gate definitions (small: vertices) —
  they replace id lists in the filters object, so the existing
  "never-serialize-id-lists" rule is *easier* to keep, but the signature and
  the `AnnotationList.vue` refetch watcher must be re-pointed from
  `analysisGateSignature`'s id hashes to the definition JSON + a resolution
  epoch (gate results can change under a fixed definition when values are
  recomputed — include `propertyValuesRevision` and `contentRevision`).

### Size bound (this is a real limit, not just a cost)

A resolved gate reaches the list query as ObjectIds, and each id costs ~20
bytes in a BSON array, so a gate matching most of a large dataset can push
the pipeline toward MongoDB's **16 MB command limit**. Two mitigations, both
implemented:

- **A majority gate is expressed as `$nin` of its complement**, not `$in` of
  its matches. Inside a pipeline already scoped to the dataset these are
  equivalent, and the complement is strictly smaller — a gate keeping 95% of
  a dataset now costs 5% of the ids instead of 95%. This halves the worst
  case (which is a gate matching exactly half).
- **`MAX_GATE_CONSTRAINT_IDS = 400_000`** across all gates in one request
  (~8 MB, half the command limit). Past it the request fails with a
  comprehensible 400 rather than an opaque BSON error.

So "exact at any dataset size" holds for gate *resolution*
(`analysis/gate_ids` streams ids and has no such bound) but **not** for the
list/page path, which tops out near a gate matching ~400K objects — around
800K on a dataset where the complement trick applies. The proper fix is to
stop materializing ids for the list at all: push the gate's own predicate
into the query (a property axis' polygon bounding box is a `$gte`/`$lte`
range on the PV collection; a categorical axis is an `$in` on tags/channel
plus a jitter sub-range), and use exact point-in-polygon only to refine.
That is a larger change and is not done here.

**Trap this created, worth remembering.** Gate clauses live under
`filters["gateMatchClauses"]` rather than `filters["idConstraints"]`,
because a `$nin` cannot be expressed as an id list. Anything that *inspects*
id constraints must consider both — `_hasAnnotationFieldFilters` decides
between the PV-driven and annotation-driven pipelines, and omitting the new
key sent gate + property-filter queries down the PV path where an `_id`
clause is never applied, so the gate silently stopped filtering. Held by
*"testGateComposesWithPropertyFilter"*.

### Measured query behavior

Checked against the live stack rather than reasoned about (Mongo `explain`
plus timed aggregations; 708,983-object dataset unless noted).

**Index usage.** The projected scan behind `_analysisData` plans as
`IXSCAN` on `datasetId_1__id_1` → `FETCH` → `PROJECTION_SIMPLE`, i.e. the
dataset partition is index-selected rather than collection-scanned.

**`$in` vs `$nin`** for the gate constraint — the numbers behind the 2×
threshold in `resolveListGateConstraints`. `$nin` costs ~1.4× per element,
so it only pays when its array is *materially* smaller:

| gate keeps | `$in` | `$nin` | array ratio | winner |
|---|---|---|---|---|
| 51% | 566 ms | 746 ms | 0.96 | `$in` |
| 60% | 648 ms | 617 ms | 0.67 | `$nin` |
| 75% | 794 ms | 411 ms | 0.33 | `$nin` |
| 95% | 1,228 ms | 172 ms | 0.05 | `$nin` (7×, 13.5 MB → 0.7 MB) |

A naive "whichever array is shorter" rule would have *lost* time near the
crossover; the implemented rule switches only at a 2× payload saving.

**Filter-combination cost** (52,282-object HCR dataset, which has property
values; median of 3 warm runs):

| query | pipeline | median |
|---|---|---|
| property filter only | PV-driven | 0.07 s |
| gate only | annotation-driven | 0.40 s |
| gate + property filter | annotation-driven + `$lookup` | 0.94 s |

Combining a gate with a property filter is **~13× the property-only path**,
because a gate is an `_id` constraint on the annotation collection and so
forces the annotation-driven pipeline with its join. This is correct but
not necessary: gate clauses could be rewritten from `_id` to `annotationId`
and applied on the PV-driven path directly, keeping the fast path. Not done
here — it touches `listIds`, `listCount`, `listPage` and `listPosition`, and
the last change of exactly that kind (moving clauses out of `idConstraints`)
silently disabled gating on one of those paths until a test caught it. Worth
doing deliberately, with its own review.

End-to-end timings after the review fixes are unchanged from before them
(gate resolution 4.4 s, histogram 7.5 s, gate-carrying list page 4.9 s at
708K), so none of the hardening cost measurable latency.

### Cost note (decided: no server cache in v1)

Sending definitions makes every list page fetch re-resolve the gates
server-side (measured ~4.8 s at 700K). That is measurable and acceptable for
v1;
a server-side resolution cache would need invalidation keyed to annotation
and PV mutations, which is precisely the class of complexity this feature
just spent twelve review rounds paying down. If profiling shows the
re-resolution dominating, the recorded escape hatches are (in order):
per-request memo across the page+count pair; client-side hint
`knownGateIds` for small results (< 10K ids — semantics identical, pure
optimization); a proper cache with mutation-hooked invalidation. Do not
build any of them speculatively.

## Invariants carried forward (unchanged, and load-bearing here)

1. **Sequence-guard tokens are claimed as the first statement** of every
   refresh action, before any bail-out (`analysisGateGuard`, per-plot
   histogram guards, `propertyFilterRequestGuard` precedent).
2. **Failure ≠ empty.** Request failures return `null` and leave same-input
   state alone; `{}`/`[]` are real answers. The server endpoints must never
   convert an internal failure into an empty result (a Mongo timeout raises;
   it does not return zero rows).
3. **A gate that matches nothing is a real constraint.** Empty resolved
   lists flow to the match-none short-circuit; the backend continues to
   reject `[[]]` id constraints; Phase 3's definition path answers zero rows.
4. **Never serialize id lists for identity.** Server-mode signatures are
   built from definitions, revisions, and counters — never from hashing the
   population (that is what the revision counters are for).
5. **No display work while the palette is hidden.** Histogram fetches are
   panel-open-only; gate *resolution* is not display work and continues
   hidden (it powers filtering).
6. **Scope comes from `analysisRefreshScope`** — the server path consumes
   `resolutionPlots`/`gatedPlots` from the same function as the client path.
   No new plot-subset predicates anywhere else.
7. **API/model layering** (backend): validation and RestException at the API
   boundary; models and `helpers/analysis.py` raise ValueError/domain errors
   only; all reads through model methods or `_aggregate` (never raw
   unbounded pymongo); `exc=True` loads; no `except Exception`.
8. **Frontend does not compensate for outdated backends.** No
   endpoint-missing fallbacks; deploy order is backend → frontend.

## Limits (all new constants in `server/helpers/validation.py`)

| Constant | Value | Guards |
|---|---|---|
| `MAX_ANALYSIS_PLOTS` | 100 | plots per gate_ids request |
| `MAX_GATE_VERTICES` | 10,000 | vertices per gate |
| `MAX_GATE_CATEGORIES` | 10,000 | pinned categories per axis |
| `MAX_HISTOGRAM_BINS` | 512 | bins per numeric axis |
| `MAX_HISTOGRAM_CELLS` | 512² | total histogram cells — a **categorical** axis gets one bin per category, so it bypasses the per-axis bin clamp entirely. Checked at the boundary AND after deriving categories, because the count can come from the data (a dataset where every annotation carries a distinct tag yields one column per annotation), not only from a hostile request |
| `MAX_GATE_CONSTRAINT_IDS` | 400,000 | ids all gates may push into one list query (see the size bound above) |
| `MAX_HISTOGRAM_ID_CONSTRAINT` | 50,000 | ids the client will inline into a histogram request |

`numpy` gets declared in `setup.py` `install_requires` (already a de facto
dependency via `helpers/connections.py`; today it arrives transitively).

## Test strategy

**Cross-language parity (the keystone):** committed JSON fixture generated by
a vitest test from the TS reference implementation; Python asserts bit-exact
jitter and exact gate id sets. Regenerating the fixture is the only sanctioned
way to change gating semantics, and it fails the other language's suite until
both match. Fixture cases: property×property, property×categorical,
categorical×categorical, missing values on each axis, astral-plane tag,
duplicate display labels, box gate, <3-vertex gate, polygon slicing through a
jittered categorical strip, unknown-category exclusion.

**Backend (tox, `test_analysis_gating.py`):** validation 400s for every
malformed input (mirroring `TestServerListValidation`'s coverage style);
403/404 access tests (private folder, bad dataset id); empty dataset; empty
gate; per-plot independence (two plots, results don't chain); property path
depth (nested `Centroid.x`); orphan PV docs excluded (values doc whose
annotation is gone must not produce an id — join against the annotation
collection, unlike `listIds`'s documented asymmetry); histogram bin edges,
categorical bins, upstream-gate narrowing, `gateCount`, filters application,
bins clamping. Phase 3: definition-carrying list/count/ids requests, AND
composition with other constraints, zero-match gates.

**Frontend (vitest):** signature branch (over-cap signature contains
revisions and definitions, not population hashes; changes when a vertex
moves, not when an unrelated filter toggles); guard ordering (late response
after newer token discarded — the stale-guard-before-early-return shape);
failure retention (same-input failure keeps ids, changed-input failure
drops); debounce; `contentRevision` bumps on each mutating path;
unknown-category exclusion in `resolveGateIds`; `shapeToGate` parsing;
heatmap-mode rendering + badge from `gateCount`; Phase 3 `buildListFilters`
emits definitions and no gate id lists, `hasEmptyResolvedGate`
short-circuit, refetch watcher fires on definition change.

**Live verification (in-browser, per repo process):** on the 708,983-object
Xenium dataset — persisted gate applies on fresh load above cap; draw on
heatmap; page the Objects tab; export CSV of gated subset; kill the network
mid-refresh and confirm no empty-gate wipeout. Do this from a fresh page
load on a dataset that actually exceeds the cap.

## Regression checklist

Every invariant names the test that holds it (format enforced by
`regressionChecklist.test.ts`). Grouped by concern.

**Cross-language parity (`analysisGatingParity.test.ts` /
`test_analysis_gating.py`, sharing `fixtures/analysis_gating_parity.json`)**
- Jitter is bit-identical in both implementations — *"jitter($id, $salt) is
  bit-exact"*, *"testScalarJitterMatchesFixtureBitExactly"*,
  *"testVectorizedJitterMatchesScalar"*
- Every fixture gate resolves to identical id sets —
  *"matches the current inputs (fixture is not stale)"*,
  *"testEveryFixtureCaseResolvesIdentically"*
- Category keys encode identically, unescaped non-ASCII included —
  *"testMatchesJavascriptJsonStringify"*, *"testDoesNotEscapeNonAscii"*,
  *"testTagSortUsesUtf16CodeUnits"*

**Pure-predicate semantics**
- Unknown-to-gate categories are outside the gate, per axis — *"excludes
  categories the gate's pinned order does not know"*, *"applies the
  unknown-category rule per axis"*, *"testUnknownCategoryIsMissing"*
- Appended categories plot deterministically — *"appends categories unknown
  to a pinned order sorted by label, not encounter order"*
- Plots resolve independently, never chained server-side —
  *"testPlotsResolveIndependentlyNotChained"*
- Missing/non-finite/boolean values are outside every gate —
  *"testNonNumericPropertyValuesAreMissing"*, *"testNanCoordinatesNeverMatch"*
- An orphaned property-value doc never produces an id —
  *"testOrphanValueDocNeverProducesAnId"*

**Over-cap resolution (`src/store/__tests__/filters.test.ts`)**
- The over-cap signature reads definitions and revisions, never population
  or filter state — *"keeps the signature free of population and filter
  state"*, *"stops collecting an over-cap population before hashing its
  tail"*
- Pure server ids commit and compose with client filters — *"resolves via
  the server above the point cap, without fetching values"*
- Same-input failure keeps ids; changed-input failure drops them before the
  await — *"keeps same-input ids on a failed retry"*
- A stale response never overwrites a newer one — *"discards a stale
  response that resolves after a newer request"*
- Hidden refreshes skip disabled gates — *"skips disabled gates while the
  panel is closed"*
- Unchanged inputs never refetch (palette toggles) — *"does not re-request
  when already resolved under the same inputs"*
- An empty server answer is a real match-none constraint — *"treats an
  empty server answer as a real match-none constraint"*,
  *"testEmptyGateIsARealAnswer"*
- Crossing the cap frees the retained value cache — *"clears the retained
  value cache when crossing above the cap"*
- Server-mode refreshes debounce; below-cap stays immediate and cancels a
  pending server call — *"debounces server-mode signature changes into one
  refresh"*, *"cancels a pending server refresh when dropping below the
  cap"*

**contentRevision (`annotationContentRevision.test.ts`)**
- Every content-changing mutation bumps it — *"every content-changing
  mutation bumps (source scan)"*
- View-only mutations never bump it — *"does NOT bump on view-only
  mutations"*

**Heatmap display (`AnalysisPanel.test.ts` / `AnalysisScatterPlot.test.ts`)**
- Above the cap the panel renders heatmaps and builds no client series —
  *"switches to server-binned heatmaps above the point cap"*
- Histogram fetches run panel-open only — *"does not fetch histograms while
  hidden or below the cap"*
- Reopening with unchanged inputs refetches nothing; failures retry on the
  next open — *"does not refetch an unchanged histogram on reopen"*,
  *"retries a failed histogram fetch on the next open"*
- A drawn shape becomes a gate pinning the server-derived category order —
  *"turns a drawn closed path into a gate"*, *"pins the server-derived
  category order into a drawn gate"*
- Non-shape relayouts and the persisted gate's own shape are ignored —
  *"ignores non-shape relayouts and the persisted gate's own shape"*
- The badge shows the chained count, not pure membership — *"shows the
  chained badge count from the histogram, not pure ids"*
- The honesty banner names inexpressible filters — *"names the filters the
  distributions cannot express"*; the request spec errs one-sidedly toward
  over-inclusion — *"inlines bounded id lists and skips oversized ones with
  labels"*, *"reports region filters and the hidden-layer rule as skipped"*

**Server list (`annotationListServer.test.ts` / `test_server_list.py`)**
- Page fetches carry gate definitions, never id lists — *"sends gate
  DEFINITIONS, never gate id lists (SERVER_GATING.md P3)"*
- A match-nothing gate short-circuits at the API boundary — *"expresses a
  match-nothing gate as an empty id constraint"*, *"returns an empty page
  without issuing a request"*
- Definitions narrow ids, pages, and counts consistently —
  *"testGateNarrowsListIds"*, *"testGateAppliesToPageAndCount"*,
  *"testTwoGatesAnd"*, *"testGateComposesWithPropertyFilter"*
- A zero-match gate is zero rows, not an error —
  *"testZeroMatchGateIsZeroRowsNot400"*

**Resource bounds (added after the round-1 review of PR #1302)**
- A categorical grid cannot exhaust the process, whether the category count
  comes from the request or from the data — *"testHugeCategoricalGridIsRejected"*,
  *"testDataDerivedCategoriesAreAlsoBounded"*
- A majority gate ships as `$nin` of its complement, a minority as `$in`,
  and both give the same answer — *"testMajorityGateUsesComplementNotAGiantIn"*,
  *"testMinorityGateStillUsesIn"*, *"testComplementAndInAgreeThroughTheEndpoint"*
- Past the id budget the request 400s instead of failing inside MongoDB —
  *"testOversizedGateConstraintIs400NotAMongoFailure"*
- A barely-smaller complement keeps `$in`, since `$nin` costs ~1.4x per
  element and only pays at a real size reduction —
  *"testMarginalMajorityStaysWithIn"*
- Gate clauses are honored on the property-filter path too (they are `_id`
  constraints in a different representation, so the PV/annotation pipeline
  choice must see them) — *"testGateComposesWithPropertyFilter"*
- The histogram badge applies the same unknown-category exclusion the
  resolver does — *"testGateCountExcludesAppendedCategories"*

**Boundary hardening (`test_analysis_gating.py` / `test_server_list.py`)**
- Malformed input is a 400, never a 500, on every endpoint —
  *"testMalformedPlotIs400Not500"*, *"testMalformedRequestIs400Not500"*,
  *"testMalformedGateIs400"*, *"testNonListAnalysisGatesIs400"*
- Private datasets 403 for non-readers — *"testRequiresReadAccess"*
- Degenerate inputs answer instead of erroring —
  *"testDegenerateGateMatchesNothingWithoutError"*,
  *"testDegenerateNumericRangeIsASingleBin"*,
  *"testEmptyPopulationIsARealAnswer"*

**Process rules this feature re-proved**
- Verify from a fresh page load on a dataset that actually exceeds the cap
  (the 708,983-object Xenium dataset).
- The parity fixture regenerates only from the TS reference implementation;
  a hand-edited fixture is a spec violation.

## What is verified, and what is not

**Verified live against the 708,983-object Xenium dataset** (through the real
REST API, `scratchpad/verify_gating.py`): a whole-dataset categorical gate
resolves to exactly 708,983 ids; a narrow slice through the jittered strip
resolves to 227,901 and is byte-stable across repeated requests; the
histogram's `gateCount` badge equals the `gate_ids` answer exactly; property
axes on a dataset with no computed values resolve to empty rather than
erroring; and `list/ids` and a filtered `list` page carrying the same gate
DEFINITION return the identical 227,901 objects. Timings above.

**Verified in a live browser** on the 52,282-object HCR dataset (above the
cap, with real `Area`/`Perimeter` values), driving the real UI:

- Opening Analysis shows the over-cap banner and renders a **heatmap**, not
  the old "narrow the filters" refusal. Footer read `34,154 of 52,282
  objects binned (18,128 without values)` — matching the property-value doc
  count in Mongo exactly.
- A shape drawn with synthetic mouse events on the Plotly drag layer
  (`dragmode: drawclosedpath`) became a real gate: 19 vertices → resolved
  server-side → chip, viewer, and footer all updated.
- Drawing over the data peak resolved to **22,478** objects; the badge read
  `gate: 22,478`, the footer `22,478 of 52,282 filtered objects pass all
  gates`, and the viewer visibly thinned. A first gate drawn over an empty
  region correctly resolved to **0** — this dataset is degenerate (2
  non-zero bins in 16,384; 22,508 objects piled at `(100, 40)`), so both
  answers were checked against the actual distribution rather than assumed.
- **Phase 3 on the wire:** `currentFilters` carried `analysisGates: [1
  definition]` with `idConstraints: []` — the whole filter payload was
  **485 bytes** instead of ~560 KB of ids — and the server list
  independently returned the same 22,478.

**Also verified in the browser on the 708,983-object Xenium dataset**, which
is a different regime — stub-only mode, 14× the objects, and no computed
properties, so both axes are categorical and membership depends entirely on
the per-id jitter:

- Heatmap binned all 708,983; a box drawn over the left half of the jitter
  strip resolved to **352,994**, and the header went from "Showing 17,022 of
  708,983 in view" to "…of 352,994".
- **Bit-exact TS↔Python jitter parity at full scale.** The JS reference
  jitter was recomputed in the browser over all 708,983 stubs and compared
  against the server's resolved set: **zero mismatches**. This is the case a
  single floating-point ULP would break — points sit at
  `index ± jitter(id)`, so any divergence flips membership near the gate
  edge. The committed parity fixture pins the same property in CI; this
  confirms it against a real dataset.
- Wire format held: `analysisGates` 1 definition, `idConstraints` empty,
  **427-byte** filter payload, server list total 352,994 matching the
  client, list page fetch ~4.9 s.

**Chaining verified live** (two plots on the 708,983-object dataset), which
is where the pure/chained split is observable:

- Plot 2's *display* is chained: its footer read `352,994 of 352,994 objects
  binned` while plot 1's read `708,983 of 708,983` — `upstreamGates` at work.
- Plot 2's *resolved ids are pure*: 353,283, i.e. the predicate over the
  whole dataset, not narrowed by plot 1.
- Its *badge shows the chained count* (198,354 = |gate₂ ∩ input₂|), not the
  pure count — the deliberate distinction in `AnalysisScatterPlot`.
- Filtering telescopes: `filteredAnnotations` = 198,354 = |pure₁ ∩ pure₂|,
  and the server list independently returned 198,354 from a **557-byte**
  two-definition payload with no id constraints. This is the redundancy
  argument from "a gate is a pure predicate" confirmed on real data.
- Editing plot 1's gate dropped **both** plots' ids synchronously (checked
  before any await), then both re-resolved: plot 1 → 187,919, plot 2 still
  353,283 (pure, correctly unchanged), plot 2's displayed input → 187,919,
  intersection → 38,901. A JS recomputation over all 708,983 stubs matched
  every one of those with zero mismatches.

Not exercised live: the disabled-gate display path, and the honesty banner
(no ROI filter was active).

## Found while chaining: the two jitter salts are not independent

`jitterFromId` (client, pre-dating this work) is `h = salt; for each char:
h = h*31 + code`. That hash is **affine in the seed**:
`h(salt, id) = salt·31ᴸ + f(id) (mod 2³²)`. For fixed-length ids — 24-char
hex ObjectIds, i.e. always — the X and Y hashes therefore differ by a
*constant*: measured `h(31,·) − h(17,·) = 983,840,270` across every id
sampled, exactly matching the predicted `(31−17)·31²⁴`.

So the Y jitter is the X jitter shifted by a constant, not an independent
draw. After `% 1000` the pairs land on a lattice: over 708,983 objects, a
10×10 grid of one categorical cell had **60 empty cells** and a peak of
5.6× the expected density (global Pearson r is only 0.037, which is why a
correlation check alone misses it).

**This is not a gating-correctness bug** — drawing and resolution use the
same jitter, so a gate selects exactly the points shown, and every parity
check above passed with zero mismatches. It is a *display* defect specific
to categorical × categorical plots, where points form stripes instead of
filling the cell, leaving much of the cell ungateable.

**Deliberately not fixed here.** Gate polygons are stored in jittered
coordinate space, so changing the jitter function silently changes the
membership of every persisted gate. That needs the same treatment
`categoryKeyVersion` got: a version bump plus a hydration rule, not a
drive-by change. The cheap correct fix when someone does it is to give each
axis a genuinely different mixer (e.g. a distinct multiplier per salt, or a
final avalanche step) rather than only a different seed.

**Two environment notes for the next person.** The viewer route is
`#/datasetView/<datasetViewId>/view` — the `/view` suffix is required and
the id is the **datasetView** id, not the dataset folder id; without both
you get a blank body with no error. And `localStorage['nimbus.girderToken']`
holds the live session: do not write to it.
