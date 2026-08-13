# Color Annotations by Property Value

## Problem

Annotations can currently be colored manually (context menu, "Color Selected"
in the annotation list, per-tag coloring in the tag cloud). There is no way to
color them by a computed property value (possibly a nested property path such
as `propertyId.Mean.Ch1`). Two constraints shape the design:

1. **Stub mode.** Above the stub threshold the client holds neither full
   annotations nor property values, so value→color assignment cannot happen
   client-side. It must be a backend operation.
2. **Legend provenance.** A legend is only meaningful while the colors on
   screen actually came from a property mapping. We need a persistent,
   low-cruft way to know "the current colors reflect property X mapped through
   colormap Y" — and to *stop* claiming that as soon as colors are changed by
   any other means.

## Design summary

- **One new backend endpoint** — `POST /upenn_annotation/color_by_property` —
  reads property values for the whole dataset, computes a color per
  annotation server-side, and bulk-writes the existing `annotation.color`
  field. No new rendering path: the viewer already styles annotations from
  `annotation.color` (stubs carry `color` too), so stub mode works unchanged.
- **The endpoint returns legend data** (gradient stops + min/max for
  continuous, value→color swatches for categorical), which the frontend
  persists in the **configuration** under a new key `colorByProperty`, keyed
  by dataset id (a configuration is reusable across datasets while a legend
  describes one dataset's values — see below). The
  configuration is the right home: it is shared and persistent, and it already
  holds sibling view-ish state (`visibilityConfig`, `annotationBrowserConfig`).
- **Clearing semantics**: any other color assignment
  (`colorAnnotationIds`-based flows: context menu, color-selected, tag
  coloring, agent executor) clears this dataset's legend — but only when it
  actually recolored something. That single choke point is what keeps the
  legend honest without any backend bookkeeping.
- **Legend overlay** in the viewer renders from
  `main.colorByPropertyForCurrentDataset` (never the raw key):
  a full-width horizontal color ramp with min/max labels for continuous, a
  scrollable swatch panel for categorical. It has a collapse/expand toggle;
  visibility is part of the persisted legend object (shared, per the review
  decision below).

## Backend

### Endpoint

`POST /upenn_annotation/color_by_property` (annotation resource,
`server/api/annotation.py`), `@access.user(scope=TokenScope.DATA_WRITE)`,
requires WRITE on the dataset folder.

Request body:

```jsonc
{
  "datasetId": "…",
  "propertyPath": ["propertyId", "subId0", …],   // required unless clear
  "mode": "auto" | "continuous" | "categorical", // default "auto"
  "colormap": "viridis",                          // continuous only, default viridis
  "percentileLow": 1.0,                           // optional; default 1
  "percentileHigh": 99.0,                         // optional; default 99
  "rangeMin": 0.0,                                // optional; absolute override of percentileLow
  "rangeMax": 10.0,                               // optional; absolute override of percentileHigh
  "clear": false                                  // true → just reset all colors to null
}
```

**Why percentiles are the default range.** Property distributions are
long-tailed. On the 708K-cell dataset this was tested against, 99% of `Area`
values occupied 14.2% of the min..max span, so a full-extent ramp put ~7% of
all annotations into a single dark bucket and produced 131 barely-distinct
colors. Defaulting to the 1st..99th percentile yields 254 well-spread colors
with no bucket above 1.1%. Values outside the range clamp to the end colors,
and the legend carries the true extent so it can mark clipped ends `≤`/`≥`
rather than implying the ramp covers everything.

Response:

```jsonc
{
  "colored": 12345,          // annotations that received a property color
  "uncolored": 17,           // annotations in dataset without a usable value (color reset to null)
  "legend": {                // null when clear=true
    "type": "continuous",
    "propertyPath": ["…"],
    "colormap": "viridis",
    "stops": ["#440154", …], // 33 hex stops, uniformly spaced — enough to redraw the exact gradient
    "min": 0.2,              // ramp ends (percentile-derived by default)
    "max": 15.3,
    "dataMin": 0.05,         // true extent, for the "≤ / ≥" legend labels
    "dataMax": 91.4,
    "clippedLow": true,
    "clippedHigh": true
    // categorical instead has: "categories": [{ "value": "A", "color": "#4E79A7", "count": 812 }, …]
  }
}
```

### Algorithm (model layer, `Annotation.colorByProperty`)

1. Load the dataset folder with `AccessType.WRITE`, `exc=True` (API layer).
2. Stream `(annotationId, value)` pairs from `annotation_property_values`
   with a projection on `values.<path>` (model method on
   `AnnotationPropertyValues`, reusing the `findByAnnotationIds` projection
   idea but dataset-wide — one indexed `find` on `datasetId`).
3. Decide the mode when `mode="auto"`: numeric values (int/float, finite)
   → continuous; otherwise categorical. Mixed sets count non-null values;
   ≥ 90% numeric → continuous (non-numeric treated as missing), else
   categorical (values stringified).
4. Compute per-annotation colors:
   - **Continuous**: clamp to `[min, max]`, `t = (v-min)/(max-min)`,
     **quantize t to 256 levels**, sample the colormap (piecewise-linear
     interpolation over embedded anchor tables in
     `server/helpers/colormaps.py`). Quantization bounds the number of
     distinct colors, which bounds the number of Mongo writes.
   - **Categorical**: distinct values sorted by count desc; assign colors via
     `categoricalColor(index)`, which cycles the 20-color palette and shifts
     lightness on each cycle so categories past the 20th stay distinguishable
     (a real 36-cluster clustering rendered only 20 distinct colors before
     this). Reject with 400 as soon as distinct values exceed 256 — checked
     **inside** the grouping loop, because forcing categorical on a continuous
     property would otherwise build one group per value (measured: 555,479
     groups before the cap rejected the request).
5. Write:
   - a `Model.update({datasetId}, {$set: {color: None}})` clearing pass so
     annotations without a value fall back to layer color — **skipped when the
     assignment covers every annotation**, since the `$set`s overwrite them all
     anyway (see the performance section);
   - then group annotation ids by identical hex color and issue one
     `Model.update({_id: {$in: chunk}}, {$set: {color: hex}})` per color
     (≤ 256 for continuous, ≤ #categories for categorical), chunked at 50k
     ids per query like `findByAnnotationIds`.

   Uses Girder's `Model.update` (not raw pymongo). **Deliberately not
   `@recordable`**: recording would snapshot every annotation document twice
   (before/after) into one history document — at 100k+ annotations that
   overruns the 16MB BSON limit and stalls the request. Coloring is a styling
   operation; "undo" is re-running with different parameters. The existing
   per-selection color flows keep their history behavior.
6. Return counts + legend. The legend's `stops` are emitted by the server so
   the frontend renders *exactly* the gradient that was applied — no duplicate
   colormap tables in TypeScript.

### Performance (measured on a 708K-annotation dataset)

Coloring the whole dataset takes **~9.5s for 708K annotations**, down from
~17s before profiling. The phase breakdown that mattered (instrumented in the
real request path, not a standalone script — see the trap below):

| Phase | Before | After | How |
|---|---|---|---|
| Read property values into Python | 4.4s | 3.0s | Flat `$project` aggregation instead of a `find()` projection: `find()` preserves the nested `{values: {propId: {sub: v}}}` shape, so pymongo builds three dicts per document and the caller re-walks the path |
| Colormap sampling | 3.2s | 0.3s | Sample once per quantized level into a 256-entry table (`colormapTable`) instead of once per annotation; `table[i]` is exactly `sampleColormap(name, i / maxLevel)`, so colors are identical |
| Clearing pass | 4.8s (+~4.5s contention) | 0s when coverage is complete | Skipped when the assignment covers every annotation — the `$set`s overwrite them all anyway, and the clear's 708K dirty pages also slowed the writes that followed it. Falls back to clear-then-apply when coverage is partial, or when the write count contradicts the id count |
| Color writes | 3-6s spread | ~5s | One `bulk_write` of ≤256 `UpdateMany` ops instead of up to 256 round trips |

**Measurement trap — re-running the same coloring measures nothing.** WiredTiger
largely no-ops a `$set` that writes the value already stored, so repeated
identical runs made the write path look 3× faster than it is (2.6s vs the real
~5s) and pointed the optimization at the wrong phase. Force a real change
between runs (alternate colormaps) and instrument inside the request, not in a
standalone script — the standalone numbers missed the clear/write contention
entirely.

Two alternatives were measured and rejected:

- **Server-side `$merge`** (compute the color in the pipeline and merge into
  the annotation collection, so no ids cross the wire and no separate clear is
  needed): **12.6s**, nearly 3× slower than the batched writes it would
  replace. Also loses the `datasetId` scoping on each write.
- **Sorting ids within each chunk** for better index/page locality: 4.49s vs
  4.55s — no effect.

The remaining floor is one Mongo document update per annotation (~5s for
708K). Going materially below that means not persisting per-annotation colors
at all — resolving the value→color mapping at render time instead — which is a
different design, not an optimization of this one.

### The post-apply refetch: `returnAssignment`

Writing the colors was never the whole cost. The client then has to *see*
them, and `fetchAnnotations()` re-reads the dataset to do it: `GET /stubs`
recomputes every annotation's centroid and radius from its full polygon
coordinates and ships **178 MB**, measured at **12.8s** end to end — more than
the coloring itself.

Nothing about the geometry changed, though, and the endpoint already holds the
exact id→color grouping it just wrote. `returnAssignment: true` returns it as
`[{color, ids}]`, and the client patches the annotations it already has
(`applyColorAssignment`), leaving the centroid and spatial indexes untouched.

| | Before | After |
|---|---|---|
| Post-apply refresh | 12.8s, 178 MB (`GET /stubs`) | **0.54s**, no request |
| Cost of returning the assignment | — | ~1.2s (19.9 MB: str-ify ids, serialize, transfer) |
| **Whole apply, 708K annotations** | **~22s** | **~11s** |

Measured live twice with alternating colormaps so every document genuinely
changed: backend 11.0s/10.5s, patch 554ms/521ms, zero stub refetches.

Details that matter if you touch this:

- **`markRaw` the maps.** `applyColorAssignment` replaces `annotationStubs` and
  `hydratedAnnotations`; both must be `markRaw`ed like every other assignment
  to them, or Vue walks and proxies ~700K entries and that dominates the
  operation. `src/store/__tests__/rawStateMaps.test.ts` asserts this for every
  mutation that replaces one of these maps — a missing `markRaw` is invisible
  to tsc, lint, and any small-fixture test.
- **Absent means cleared.** The backend's write covers the dataset, so an
  annotation missing from every group has `color: null`. The client mirrors
  that, which is also why an **empty** assignment is exactly the `clear`
  semantics (and why `clear` needs no refetch either).
- **`assignment` is opt-in.** It is one id per annotation (~20 MB at 708K).
  Scripted callers that only want the counts should not pay for it, so the
  frontend requests it and the Python API does not.
- **The fallback is for failures, not for old backends.** If a response has no
  assignment, or the request failed after the write may have started, the
  action still falls back to `fetchAnnotations()` — there is no way to
  enumerate what a half-finished write did.

### The hydration race this closes

A recolor takes seconds, and the user can keep navigating during it. Viewport
hydration (`GET /hydrate`) issued *before* the recolor lands *after* it,
carrying the pre-recolor color for whichever annotations happened to be
hydrating — reinstating stale colors on them until something else refetched.

`mergeHydratedAnnotations` now takes `color` from the local stub when one
exists: the stub map is the client's authoritative view of color (every local
color operation patches it), while hydration exists to supply geometry. That is
also self-consistent — a stub that has drifted from the backend is already what
the other ~99% of the canvas is drawn from. Verified live: a hydration carrying
a stale color was overridden by the stub's color while keeping the fetched
geometry.

### Colormaps (`server/helpers/colormaps.py`)

Embedded anchor tables (33 anchors each, linearly interpolated): `viridis`,
`plasma`, `inferno`, `magma`, `cividis`, `turbo`, `coolwarm` (diverging),
`gray`, plus single-hue ramps `white-red`, `white-green`, `white-blue`.
Categorical palette: Tableau-20-style 20 colors. No new Python dependencies.

### Validation

All at the API boundary using `server/helpers/validation.py`:
`requireObjectBody`, `requireObjectId(datasetId)`, `validatePropertyPaths`
([path]), mode/colormap membership checks, `rangeMin/rangeMax` numeric with
`rangeMin < rangeMax`. Model raises `ValueError` for domain errors (no values
found, too many categories), mapped to 400 in the API layer.

## Frontend

### Model / configuration

`src/store/model.ts`:

```ts
// The wire legend (IColorByPropertyLegend) carries type, gradient stops +
// range for continuous, value/color/count swatches for categorical; the
// persisted state adds what the client snapshots at apply time.
export interface IColorByPropertyState extends IColorByPropertyLegend {
  propertyName: string; // display name snapshot at apply time
  showLegend: boolean;
}

// Keyed by dataset id: the legend is per-DATASET derived state, but a
// configuration is reusable across datasets (ImportConfiguration adds a
// dataset to existing collections), so a single slot would show dataset A's
// legend over dataset B's colors.
export type TColorByPropertyByDataset = {
  [datasetId: string]: IColorByPropertyState;
};
```

`IDatasetConfigurationBase` gains `colorByProperty?: TColorByPropertyByDataset`
(optional for pre-existing configurations, like `annotationBrowserConfig`).
Added to `exampleConfigurationBase()` (as `{}`) so `configurationBaseKeys`
includes it and `updateConfigurationKey`/`setBaseCollectionValues` round-trip
it. The backend collection schema needs no change (extra `meta` keys are
allowed). Read the current dataset's slot via
`main.colorByPropertyForCurrentDataset`.

Main store (`src/store/index.ts`): mutation
`setConfigurationColorByProperty`, action `saveColorByProperty(state | null)`
→ mutation + `syncConfiguration("colorByProperty")`, and action
`saveColorByPropertyFor({datasetId, configurationId, state})` — the
switch-safe write to a captured pair's slot, used by `colorAnnotationIds`
(retire), `applyColorByProperty` (persist), and `removeColorByProperty`
(retire) — see "Clearing semantics".

### API

`AnnotationsAPI.colorByProperty(params)` → POST the endpoint;
`AnnotationsAPI.clearColorByProperty(datasetId)` → same endpoint with
`clear: true`.

### Apply flow (dialog)

Three entry points, all opening the same dialog:

1. a palette icon button in the app bar, beside the Measure (ruler) button —
   reachable without opening the Object Browser;
2. a palette icon button in the Object Browser toolbar, also beside its ruler;
3. **"Color by Property…"** in that toolbar's *More Actions* menu.

`ColorByPropertyDialog` is mounted **once**, in `App.vue` along
`analyze-dialog`, and its open state lives in `main.isColorByPropertyDialogOpen`
— the same arrangement the Measure dialog already used for the same reason (two
entry points, one of them in the app bar). Mounting it per entry point would
give the app independent dialogs with independent colormap fetches.

The palette icon is reserved for this feature, so *More Actions* moved "Color
Selected" to a paint bucket (`mdi-format-color-fill`): entry points 1 and 2 are
icon-only, so their icon has to carry the meaning on its own.

New component `src/components/AnnotationBrowser/ColorByPropertyDialog.vue`:

- property path: `v-autocomplete` over `propertyStore.computedPropertyPaths`
  (works in stub mode via `discoveredPropertyPaths`), labeled with
  `getFullNameFromPath`;
- mode: Auto / Continuous / Categorical (default Auto);
- colormap select with a gradient preview per entry. The stops come from
  `GET /upenn_annotation/color_by_property/options` (fetched once, the first
  time the dialog opens), so the backend tables remain the single source of
  truth — no duplicate colormap definitions in TypeScript;
- optional min/max overrides (continuous); invalid numeric text in any range
  or percentile field is a distinct, blocking state (error message + Apply
  disabled), never silently treated as "use the default" — the operation
  replaces every color and cannot be undone;
- Apply → endpoint (with `returnAssignment`) → colors patched in place from
  the returned assignment (§ "The post-apply refetch") →
  `main.saveColorByPropertyFor({datasetId, configurationId, state: legend +
  showLegend: true})`, targeting the pair captured before the request so a
  mid-request switch cannot misdirect or drop it. A full
  `fetchAnnotations()` runs only as the fallback when the local apply could
  not happen (a non-400 failure that may have written) — and that failure
  path also RETIRES the captured pair's legend, since a partial write means
  any earlier legend describes neither the half-applied mapping nor the
  refetched colors;
- "Remove property coloring" button → `clear: true` → empty assignment
  applied locally (nulls every color) → `saveColorByPropertyFor(state:
  null)` for the captured pair, on the success and may-have-written failure
  paths alike.

### Clearing semantics (legend honesty)

`annotationStore.colorAnnotationIds` is the single choke point through which
every other color assignment flows (context menu, color-selected dialog,
tag-cloud coloring, AI-agent executor). After it applies its edit, it
retires the captured dataset+configuration pair's legend via
`main.saveColorByPropertyFor` — but only when the edit actually patched
something. An empty selection, a color every target already had, and a
not-logged-in attempt all write nothing, and retiring the legend then would
leave the canvas correctly colored by the property with nothing to explain
it. `updateAnnotationsPerId` returns its patch count for exactly this.
The legend disappears; colors keep whatever the user just set.

The retirement targets the pair captured *before* the awaited write, not
whatever is open when it completes: a large recolor takes seconds, and a
dataset or configuration switch during it must neither write the cleanup to
the newly opened configuration nor abandon it — the captured dataset's
colors were changed either way, so its legend is wrong either way. When the
captured configuration is no longer the current one,
`saveColorByPropertyFor` loads it via `girderResources` and PUTs the updated
`colorByProperty` key directly (best-effort, like `saveColorByProperty`).

The same rule holds for the property paths, in the opposite direction:
`applyColorByProperty` persists the NEW legend to the captured pair after a
mid-request switch (the backend recolored that dataset either way, and an
older coloring's legend left standing would describe colors it no longer
has), and `removeColorByProperty` retires the captured pair's legend after
clearing. Only the LOCAL color apply is skipped on a switch — it targets
whatever is loaded now.

Known, accepted staleness (documented, not tracked):

- annotations created/imported *after* an apply have no property color until
  the user re-applies;
- re-computing property values does not re-color; the legend describes the
  last apply operation;
- undo of a *recorded* action restores that annotation's whole document,
  including its pre-coloring color, while the legend still claims the property
  mapping holds — the history system replaces documents wholesale and doesn't
  know about the legend;
- a `fetchAnnotations` already in flight when a recolor finishes (a
  configuration switch on the same dataset, undo/redo, a worker completing)
  lands afterwards and reinstates the pre-recolor colors. The hydration half of
  this race IS handled (see below); the wholesale-refetch half would need a
  fetch sequence token in `fetchAnnotations`, which is the app's most
  load-bearing data path — deliberately not touched here;
- a color changed by *another user* is no longer picked up when an annotation
  hydrates, because hydration now defers to the local stub's color. Only a
  refetch surfaces it. This is the cost of closing the hydration race, and it
  matches how stubs already behave for the ~99% of the canvas that isn't
  hydrated;
- undo/redo can replay a *recorded* color change (e.g. a manual
  color-selected that preceded the apply) without clearing the legend —
  color-by-property itself is not recorded, so the history system doesn't
  know the legend exists. Clearing on every undo would erase the legend on
  unrelated undos, and the frontend can't tell which fields an undone action
  touched, so this stays documented rather than handled.

### Legend overlay

`src/components/AnnotationColorLegend.vue`, mounted in
`src/views/datasetView/Viewer.vue` (positioned overlay, bottom-right, above
the GeoJS canvas, like `tool-suggestions`).

- Rendered only when `main.colorByPropertyForCurrentDataset` is non-null.
  **Keyed by dataset id**: a configuration can be shared across datasets
  (`ImportConfiguration` adds a dataset to existing collections) while a
  legend's range and category counts describe one dataset's values, so a single
  shared slot showed dataset A's legend over dataset B's colors.
- Continuous: horizontal CSS `linear-gradient` built from `stops` (shared with
  the dialog's colormap previews via `cssLinearGradient`), min/max labels
  (formatted with existing number formatting), property display name as title.
- Categorical: swatch rows (color chip + value + count), scrollable,
  displays up to 30 rows then "+N more".
- Collapse control: a small icon button; collapsed state renders a compact
  palette chip that re-expands. Persisted as `showLegend` inside the config
  object (shared, like the rest of the configuration — confirmed as the
  intended behavior in review: one user hiding the legend hides it for
  everyone using that configuration).

## Testing

Backend (`test_color_by_property.py`, tox):
- continuous mapping: known values → expected min/max, extremes get first/last
  colormap colors, annotations without values get `color: null`;
- explicit range clamps out-of-range values to the ends;
- categorical mapping: distinct values each get a palette color; counts in
  legend; >256 distinct values → 400 (raised as ValueError in model);
- auto mode picks continuous for numeric, categorical for strings;
- nested property path resolution;
- `clear: true` nulls colors and returns `legend: null`;
- permission: user without WRITE on dataset → 403; invalid body shapes → 400.

Frontend (vitest):
- dialog: apply calls API with chosen params; the store action patches colors
  locally from the returned assignment and saves the legend to config;
- `colorAnnotationIds` clears the legend when it patched something, and keeps
  it when it didn't;
- legend component renders gradient stops / swatches / collapse from a config
  fixture.

Manual (user-supplied dataset): apply continuous + categorical coloring on a
stub-mode dataset, verify colors appear immediately (no stub refetch) and the
legend matches.

## Regression checklist

Run `pnpm test src/store/colorByProperty.test.ts src/store/applyColorAssignment.test.ts src/store/__tests__/rawStateMaps.test.ts src/store/__tests__/annotationContentRevision.test.ts src/components/AnnotationColorLegend.test.ts src/components/AnnotationBrowser/ColorByPropertyDialog.test.ts src/__tests__/mdiIconNames.test.ts` and, from
`devops/girder/plugins/AnnotationPlugin`,
`tox -- upenncontrast_annotation/test/test_color_by_property.py upenncontrast_annotation/test/test_raster.py`.

### Mapping values to colors

- [ ] **The default range is percentile-clipped, not the full extent.** Real
      distributions are long-tailed; a full-extent ramp collapsed 99% of a 708K
      dataset into one dark bucket. —
      *"testDefaultRangeClipsOutliersByPercentile"*
- [ ] **Explicit bounds override percentiles; a single explicit bound can still
      invert the range and must 400 rather than silently paint everything the
      middle color.** — *"testExplicitBoundsOverridePercentiles"*,
      *"testEmptyExplicitRangeIsA400"*
- [ ] **Every malformed bound is a clean 400, including an int too large to
      convert to float** — JSON ints are unbounded and `math.isfinite(bigint)`
      raises `OverflowError`, not `False`, so the unguarded check was a 500. —
      *"testNonFiniteBoundsAreClean400s"*,
      *"testHugeIntIsNonFiniteNotAnError"*
- [ ] **Invalid numeric text in a dialog bound field blocks Apply** instead of
      collapsing into the blank/"use default" state — the operation replaces
      every color, non-undoably, so a dropped constraint is destructive. Stale
      invalid text must not block a categorical apply (fields hidden, never
      sent). — *"an invalid bound blocks Apply instead of silently using
      defaults"*, *"a stale invalid bound does not block a categorical
      apply"*
- [ ] **Extremes reach the ends of the colormap** when the full extent is
      requested. — *"testContinuousAutoMapsExtremesAndSkipsMissing"*
- [ ] **Categories past the palette's length stay distinguishable.** A real
      36-cluster clustering rendered only 20 distinct colors before
      `categoricalColor` shifted lightness per cycle. —
      *"testCategoriesBeyondThePaletteStayDistinct"*
- [ ] **Numeric category labels don't split on representation** (int `1` and
      float `1.0` are one category). —
      *"testForcedCategoricalMergesIntAndIntegralFloat"*
- [ ] **Nested property paths resolve**, and a path through a scalar, an
      explicit null, or a missing key yields nothing rather than raising. —
      *"testNestedPropertyPath"*,
      *"testValuesForPathResolvesNestedNullAndMalformed"*,
      *"testValuesForPathReturnsScalarsAtTopLevel"*

### What gets written

- [ ] **Annotations with no value are cleared to the layer color**, including on
      re-apply with a different property — they must not keep the previous
      property's color. — *"testReapplyOverwritesPreviousColoring"*,
      *"testContinuousAutoMapsExtremesAndSkipsMissing"*
- [ ] **The clearing pass is skipped only when the assignment covers every
      annotation, and still runs when it doesn't.** Both halves matter: the skip
      is ~40% of the request, and its absence is what keeps stale colors from
      surviving. — *"testFullCoverageSkipsTheClearingPass"*,
      *"testPartialCoverageStillClears"*
- [ ] **`clear` nulls everything and returns a null legend.** —
      *"testClearResetsColorsAndReturnsNullLegend"*

### Cost (regresses silently — no visible behavior change)

- [ ] **Forcing categorical on a continuous property bails at the cap**, rather
      than first building one group per distinct value (measured: 555,479 groups
      before a 256 cap rejected the request). —
      *"testTooManyCategoriesBailsBeforeGroupingEverything"*
- [ ] **The per-annotation state maps stay non-reactive.** A missing `markRaw`
      makes Vue proxy ~700K entries and dwarfs the operation; it is invisible to
      tsc, lint, and any small-fixture test. —
      *"applyColorAssignment leaves annotationStubs raw"*,
      *"applyColorAssignment leaves hydratedAnnotations raw"*,
      *"applyStubFieldUpdates leaves both maps raw"*,
      *"mergeHydratedAnnotations leaves hydratedAnnotations raw"*
- [ ] **A successful apply does NOT refetch the dataset**; it patches from the
      returned assignment (12.8s → 0.5s at 708K). —
      *"apply posts the mapping, persists the legend, and applies colors
      locally"*, *"remove clears backend colors, retires the legend, and nulls
      colors locally"*
- [ ] **`assignment` is opt-in**, so callers that only want counts don't pay
      ~20MB. — *"testAssignmentIsOmittedUnlessRequested"*

### Not leaving the canvas stale

- [ ] **The assignment matches what was written, exactly** — same ids, same
      colors, value-less annotations absent. —
      *"testAssignmentListsExactlyWhatWasWritten"*,
      *"testAssignmentCoversEveryColouredAnnotationAtScale"*
- [ ] **An empty assignment means "clear everything"**, which is how the clear
      path repaints without a refetch. —
      *"an empty assignment clears every color (the clear path)"*,
      *"testClearReturnsAnEmptyAssignmentWhenRequested"*
- [ ] **A response without an assignment, or a failure that may have written,
      still falls back to the full refetch.** A 400 is rejected before any
      write, so it must NOT refetch. —
      *"falls back to a full refetch when no assignment comes back"*,
      *"a non-400 failure still refetches (the backend may have recolored)"*,
      *"a 400 rejection propagates unwrapped and skips the refetch"*
- [ ] **A hydration issued before a recolor cannot reinstate the old color**
      after it, while still supplying the fetched geometry. —
      *"a hydration that predates a recolor cannot reinstate the old color"*,
      *"preserves geometry from the fetch while overriding color"*
- [ ] **A dataset switch mid-request applies nothing locally, while the
      captured pair's legend is still written.** The assignment names the OLD
      dataset's ids, so applying it to the newly loaded dataset would null
      every one of its colors — but the backend recolored (or cleared) the
      captured dataset either way, so its slot in the captured configuration
      must be updated (apply) or retired (clear), never abandoned. —
      *"a dataset switch mid-request applies nothing locally but persists the
      captured dataset's legend"*,
      *"a configuration switch mid-apply writes the legend to the captured
      configuration"*,
      *"a dataset switch mid-clear nulls nothing locally but retires the
      captured dataset's legend"*
- [ ] **A may-have-written failure retires a previously persisted legend; a
      400 keeps it.** A non-400 failure can be a partial bulk write (the
      backend invalidates its raster in a `finally` for the same reason), so
      an earlier apply's legend describes neither the half-applied mapping
      nor the refetched colors — while a 400 wrote nothing and the earlier
      legend still holds. Both the apply and the clear path. —
      *"a non-400 failure retires a previously persisted legend (partial
      write)"*, *"a 400 rejection keeps a previously persisted legend
      (nothing was written)"*, *"a non-400 clear failure retires the legend
      too"*
- [ ] **The annotation-overview raster repaints in the new colors.** The
      overview is a server-rendered image of `annotation.color`, so a recolor
      has to invalidate it on both sides: the client bumps `mutationCounter`
      (the tile URLs' cache buster) and the backend bumps the dataset's raster
      version (the geometry cache's key and the tile ETag). Neither happens for
      free here — the write paths use `bulk_write`/`update`, not
      `save()`/`saveMany()`, and skipping the refetch means nothing else bumps
      the client counter. Both halves, and the no-op case that must not bump. —
      *"bumps mutationCounter so the overview raster refetches its tiles"*,
      *"bumps mutationCounter on the clear path too"*,
      *"does not bump when no color actually moved"*,
      *"testColorByPropertyInvalidatesEtagAndRepaints"*
- [ ] **The raster version bumps even when the color writes fail partway.**
      Unordered bulk writes can raise after applying some operations —
      exactly when the cached raster is most wrong. The frontend treats a
      non-400 failure as "may have written" and refetches; the server cache
      must reach the same conclusion. —
      *"testFailedColorWritesStillInvalidateRaster"*
- [ ] **A dataset or configuration switch during a manual recolor still
      retires the CAPTURED pair's legend** — the recolor changed that
      dataset's colors regardless of what is open when it completes, and
      bailing left the stale legend to reappear on the next load. The
      newly opened configuration must stay untouched. —
      *"a dataset+configuration switch mid-recolor still retires the captured
      configuration's legend"*, *"a dataset switch under the SAME
      configuration retires the captured dataset's legend only"*
- [ ] **A color-only change does NOT bump `contentRevision`.** That counter
      feeds the analysis gate and histogram signatures, none of which depend on
      color; bumping it would re-resolve every gate over the whole dataset for
      an identical answer. —
      *"does NOT bump on a color-only assignment (applyColorAssignment)"*

### The legend tells the truth

- [ ] **Any other color assignment retires the legend.**
      `colorAnnotationIds` is the choke point for every manual recolor. —
      *"colorAnnotationIds clears an active legend"*,
      *"colorAnnotationIds does not write the configuration when no legend is
      active"*
- [ ] **Clipped ends are marked `≤`/`≥` with the true extent available**, so the
      legend never implies the ramp covers all the data. —
      *"marks clipped ends with ≥/≤ and shows the data extent on hover"*,
      *"leaves unclipped ends unmarked"*
- [ ] **Apply is unavailable until the selected property resolves for the
      current dataset** — the dialog outlives dataset switches. —
      *"canApply requires the selected path to exist for the current dataset"*
- [ ] **The destructive warning stays in the dialog.** Applying overwrites every
      annotation's color, non-undoably. —
      *"warns that applying replaces all colors and cannot be undone"*
- [ ] **Every `mdi-*` name resolves in the pinned `@mdi/font`.** This shipped
      with `mdi-gradient-horizontal`, which does not exist in 5.9.55, so the
      *More Actions* entry rendered with a blank icon slot — invisible to tsc,
      lint and every component test. Two entry points are icon-only, so a blank
      glyph leaves an unlabeled button. —
      *"references only icons the installed font defines"*

### Process rules this feature proved

- Verify from a **fresh page load** on a dataset that actually has the property
  under test, and confirm colors against MongoDB rather than only against the
  API response — transitive agreement hid nothing here, but the direct check is
  what makes it evidence.
- **Re-running the same coloring measures nothing**: WiredTiger largely no-ops a
  `$set` writing the value already stored, which made the write path look 3×
  faster than it is and pointed optimization at the wrong phase. Alternate
  colormaps between timed runs, and instrument inside the request rather than in
  a standalone script.

## Non-goals (v1)

- Live recolor on property recompute (would need invalidation bookkeeping —
  the cruft this design avoids).
- Scoping to filtered/selected subsets (whole dataset only).
- Log-scale ranges (percentile clipping, now the default, covers the
  long-tail case that motivated this; the property histogram endpoint exists
  if we later want an interactive range picker in the dialog).
- Undo/redo for the bulk color write (see recordable note above).
