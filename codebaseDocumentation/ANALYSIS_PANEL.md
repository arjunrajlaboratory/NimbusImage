# Analysis Panel (scatter gating)

The Analysis palette plots any two computed property values — or a numeric
property against a categorical annotation field — as a scatter, and lets the
user lasso points to keep. A lasso becomes a **gate** that is ANDed into
`filteredAnnotations`, so it narrows the viewer, the Object Browser, the
Connections list and the filtered CSV export exactly like a property-range
filter does. The zero-result CSV contract is fixed separately in prerequisite
PR [#1299](https://github.com/arjunrajlaboratory/NimbusImage/pull/1299).

Multiple plots **chain**: plot *n* shows the population passing the gates of
plots *0..n-1*, so a sequence of plots reads as a flow-cytometry-style gating
strategy. A plot never applies its own gate to its own scatter — otherwise the
points just selected would disappear out from under the lasso.

## A gate is a polygon, not a list of ids

This is the load-bearing decision; most of the rest follows from it.

`IAnalysisGate` stores the lasso as **vertices in plot coordinate space**, plus
the category ordering in effect when it was drawn. The ids inside it are derived
at runtime into `filters.analysisGateIds` and never persisted.

Two reasons:

1. **A configuration is shared by every dataset that uses it**, while annotation
   ids belong to one dataset. Persisting ids would apply one dataset's objects
   to another — silently, since ids from the wrong dataset simply match nothing.
2. It is what makes a gating strategy *portable*, which is the point of one:
   draw it once, apply it to each replicate.

It also keeps the configuration small. An id list runs to tens of thousands of
24-character strings; a lasso is a few dozen points.

For a categorical axis a coordinate is a **category index**, so the ordering is
part of the gate's meaning and travels with it (`xCategories`/`yCategories`).
Re-deriving the order from whatever categories happen to be present in the next
dataset would move the gate onto different categories. Categories the stored
ordering has never seen are appended, so a new tag still plots instead of
vanishing.

## Where things live

| Concern | File |
|---|---|
| `IAnalysisPlot`, `IAnalysisGate`, `TAnalysisAxis` | `src/store/model.ts` |
| Coordinates, point-in-polygon, chain walk (all pure) | `src/utils/analysisGating.ts` |
| Axis encode/decode + categorical axis list | `src/utils/analysisAxes.ts` |
| Gate state, composition, `refreshAnalysisGateIds` | `src/store/filters.ts` |
| Persist / validate in the configuration | `src/utils/annotationBrowserConfig.ts` |
| Save + hydrate wiring | `src/store/index.ts` |
| Gate-refresh trigger | `src/views/datasetView/Viewer.vue` |
| Panel (population, fetch, cap, series) | `src/components/AnalysisPanel.vue` |
| One plot (Plotly render + lasso) | `src/components/AnalysisScatterPlot.vue` |
| Palette wiring | `src/App.vue` |

## Filter composition

`filters.ts` splits the old `filteredAnnotations` in two:

- **`annotationsPassingNonGateFilters`** — every filter *except* the analysis
  gates. This is the panel's input population and what each scatter is drawn
  from.
- **`filteredAnnotations`** — the above, further narrowed by
  `activeAnalysisGateSets`.

Splitting it this way makes "a plot doesn't filter itself" fall out structurally
rather than needing a special case at each call site.

Gates compose with **AND**, one constraint set per gate — deliberately unlike
the annotation-id filters, which are *unioned* into a single set. In server mode
each gate is pushed as its own entry in `idConstraints`.

A plot contributes a constraint only once its gate is **drawn, enabled, and
resolved**. The window between drawing a gate and the values needed to resolve
it arriving therefore shows everything rather than flashing empty.

## Gate resolution is owned by the store, not the panel

`refreshAnalysisGateIds` fetches the axes' values and turns each polygon into
ids. It lives in the filters store, triggered from `AnnotationViewer.vue`,
because **a gate is a filter**: it has to apply whether or not the Analysis
palette is open, and a gate restored from the configuration has to resolve on
load. It no-ops when no plot has a gate, so a dataset with no analysis pays
nothing.

`resolveAnalysisGateIds` re-walks `chainPlotInputs` per plot rather than
threading a running population. That is deliberate: it guarantees the gate is
resolved against the *same* chain the panel displays. One implementation of the
chain is what stops a gate from selecting points other than the ones drawn under
it. `n` is the number of plots, so the repeated walk is free.

## Property values: one fetch, owned by the store

`refreshAnalysis` performs the **only** round trip, via
`propertiesAPI.getPropertyValuesForIds(datasetId, ids, paths)`, and publishes
the result as `filters.analysisValues` for the panel to draw from. The panel
briefly had its own copy; that meant two fetches over the same population — up
to `MAX_ANALYSIS_PLOT_POINTS` ids — on exactly the path the feature exists for.

It fetches when a plot has a gate to resolve, **or** when the panel is open and
needs values to draw an ungated plot. Neither means no fetch, so a configuration
carrying plots costs nothing until someone looks at them; the panel reports its
visibility through `setAnalysisPanelOpen`.

Do not "optimize" this into reading `propertyStore.propertyValues`:

- That map is **projected to the Annotation Browser's displayed columns**. A
  dataset whose value docs hold nine metrics can have only `{Area}` resident, so
  arbitrary axes silently resolve to nothing. This shipped once and presented as
  "0 of 26,142 objects plotted" with no error.
- In lazy (stub-only) mode it additionally holds only the viewport subset and is
  pruned on every pan.

Projecting to the chosen axes is what makes the fetch affordable: an unprojected
whole-dataset fetch of the Xenium dataset is ~230 MB, while two paths over
20,000 objects measured **1.99 s** end-to-end in the live app. No new backend
endpoint was needed — `annotation_property_values/batch` already projects by
`propertyPaths` and chunks the id list at 50k.

## The point cap, and why there is no sampling

`MAX_ANALYSIS_PLOT_POINTS = 50000` (`src/store/constants.ts`, matching
`DEFAULT_VISIBILITY_CONFIG.maxVisible`). Above it the panel shows a "narrow the
filters" notice and plots nothing, and gate resolution stops too.

Plotting a sample instead would be easy and wrong: a gate resolves to a set of
ids, so a lasso over a sample would exclude every *unsampled* object while all
the counts still looked right. Refusing keeps every gate exact, and the remedy
is the intended workflow anyway. This matters at real scale: the Xenium
lymph-node dataset has 708,983 objects.

Because the panel tells the user to narrow with the **Filters** palette, Filters
is registered as a companion of *both* the Object Browser and the Analysis panel
(`paletteRoles` in `App.vue`) — otherwise opening it would close the panel that
just asked for it.

## Never serialize a filter object that can contain id lists

`src/utils/signatures.ts` is the single home for this. Several watchers key off
"has the query changed?" by serializing filter state, and that state can hold
tens of thousands of ids — a select-all selection filter, an annotation-id
filter, a resolved analysis gate. The getters they read rebuild on every
reactive touch (`currentFilters` reads `xy/z/time` unconditionally to assemble
`currentFrame`), so serializing wholesale builds and discards megabytes of JSON
on every Z-scrub.

Built on it: `currentFiltersSignature`, `membershipFilterSignature`,
`analysisGateSignature`, `populationSignature` — **all four**.

The identity must be **exact, not sampled**. A first/middle/last sample was
tried and is wrong: two same-length sets differing only at an unsampled position
collide, and the watchers then skip the server-list refetch and — worse — skip
clearing the annotation selection, leaving hidden rows for a later bulk action.
`signatures.ts` hashes every id instead (cyrb53, no allocation, memoized by
array identity for the id constraints, which are replaced wholesale). Length
scrubbing a frame under "current frame only" routinely swaps a set for a
different one of the same size, so the population signature hashes every id too. A
length-only population key once left fetched values keyed to the previous
frame's ids — which reads as "every object is missing values" rather than as an
error.

Streaming hashes must preserve **structure**, not only values. `feedString`
separates adjacent values and `countItem()` separates records; incrementing a
record count without hashing where each boundary occurs made tag rows
`[a] / [b]` collide exactly with `[a,b] / []`.

**Any new watcher over filter state must use these, not `JSON.stringify`.** The
first fix here corrected one instance and left its sibling watcher in
`AnnotationList.vue` untouched, which is how the server-mode list ended up
never refetching on a gate change.

## "Empty" is not a signal

Two bugs on this feature came from reading an empty collection as "nothing to
do":

- `refreshAnalysis` bailed when `analysisPropertyPaths()` was empty. But a gate
  on **two categorical axes** needs no property values at all, so such a gate
  drew, lassoed and persisted normally and then filtered nothing. Skip the
  *fetch*, never the *resolve*.
- `fetchAnalysisValues` returned `{}` on failure, which is indistinguishable
  from a successful response for a property nothing has been computed for. Every
  property gate then resolved to zero matches and the whole dataset vanished
  after a transient network error. It returns `null` on failure now, and the
  caller leaves the existing gate ids alone.

## Invalidate stale requests before every early return

`refreshAnalysis` and `refreshPropertyFilterPassingIds` both claim their
sequence-guard token as the **first statement**, before any bail-out. Advancing
it only on the path that actually fetches leaves a running request "current", so
a bail-out can clear the derived state and then have the older request commit
results for inputs that no longer apply — reinstating a filter that is off.
`properties.ts`'s `ensureVisiblePropertyValues` documents the same rule.

## The refresh trigger must survive a view-mode switch

`Viewer.vue` renders `<image-viewer v-if="2d">` / `<volume-viewer v-else>`, so
3D mode **unmounts `ImageViewer` and with it `AnnotationViewer`**. The gate
refresh therefore hangs off `Viewer.vue`, which is mounted for the whole dataset
view in both modes. Hosted in `AnnotationViewer` (its first home, chosen for
parity with `refreshPropertyFilterPassingIds`), a dataset opened directly in 3D
never resolved its persisted gate and the saved filter silently did not apply —
while `VolumeViewer` happily read the un-narrowed `filteredAnnotations`.

Note the pre-existing `refreshPropertyFilterPassingIds` watcher still lives in
`AnnotationViewer` and has the same exposure.

## Anything that changes the query must also refetch the server list

Above `ANNOTATION_LIST_SERVER_THRESHOLD` the Objects tab is backend-paginated,
so a filter that reaches `buildListFilters` but not the refetch watcher in
`AnnotationList.vue` produces a table showing rows that no longer match. Gates
shipped in exactly that state: the viewer and the count badge updated, the table
did not, and the selection-clearing watcher *did* fire — so it read as a
selection bug rather than a stale list.

## A gate that matches nothing is not a gate that is absent

A gate resolved to zero annotations — an empty lasso — is a real constraint
meaning "nothing", and reaches the list API as an empty inner `idConstraints`
entry. The API deliberately rejects `[[]]` with a 400
(`server/helpers/validation.py` wants match-none explicit rather than an
accidental `$in: []`), so sending it failed the request and left the previous
rows on screen.

The client knows the answer without asking, so it answers: `filtersMatchNothing`
in `@/utils/annotationListFilters`, applied **inside `AnnotationsAPI`** rather
than in each store action. That placement is the point — the first attempt
guarded `fetchPage` and `fetchPageContaining` and missed `fetchMatchingIds`, the
action behind "Select all" and "Delete Unselected". At the request boundary
there is nothing left to miss.

The same distinction exists in the **CSV export** path, where the failure was
worse than a 400. `annotationIds` carries three meanings: omitted = every
annotation, a non-empty list = those, and present-but-empty = none.
`export.py` used `if annotationIds:` while `ExportAPI.ts` used `|| []`, so
exporting a filtered set that resolved to zero downloaded the **whole dataset** —
silently the opposite of the request. This is a general export-endpoint contract
bug rather than Analysis feature code. Its fix and regression coverage were
split into prerequisite PR
[#1299](https://github.com/arjunrajlaboratory/NimbusImage/pull/1299), keeping
this PR frontend-only; merge #1299 before #1298.

## Derived state must not outlive the input that defines it

`analysisGateIds` is derived from a plot's polygon and from the population
reaching that plot. Whenever either changes, the ids must be dropped, not
merely scheduled for recomputation:

- **Its own gate or axes changed.** `setAnalysisPlotGate` drops on *every*
  change, not just on clear. Keeping them across a re-lasso meant the plot
  highlighted the new selection while the viewer and list filtered by the old
  one — and because `refreshAnalysis` deliberately leaves ids untouched when its
  fetch fails, a failure right after re-lassoing stranded the stale constraint
  permanently.
- **An UPSTREAM plot changed.** Every later plot's ids were resolved against the
  population passing its predecessors, so editing plot 1 invalidates plots
  2..n — including on an enable-state toggle, which changes what reaches
  downstream even though plot 1's own ids stay valid. The four plot mutators
  all invalidate the affected suffix before scheduling the configuration save.

Unresolved contributes no constraint, so the interim state shows **more** than
the final answer rather than something wrong. That is the safe direction and
the reason dropping is preferred to leaving stale ids in place.

## The panel component is always mounted; its display work is not

`FloatingPalette` keeps its content mounted and hides it with `display: none`.
So **no display-only work may run while it is hidden** — otherwise every user
pays to build series and mount Plotly on every dataset open, and each plot pins
up to 50,000 annotation references after the palette closes. `App.vue` passes
`:visible="analysisPanel"`, the prop is **required** (so a second mount site
cannot reintroduce the bug by omission), the hidden template contains no plot
children, and the input/series derivations return before reading the population.
The store remains mounted and continues resolving an active gate while hidden,
because that work powers filtering rather than display.

## Categorical axes

`tags`, `shape`, `channel`, `xy`, `z`, `time` — all read from fields present on
an `IAnnotationStub`, so categorical axes work identically in stub-only mode and
need no fetch at all. Points get a **deterministic** per-id jitter
(`jitterFromId`) so columns spread into readable strips without reshuffling on
re-render — and, more importantly, so a gate drawn over a jittered column still
contains the same points when re-resolved in a later session.

## Regression checklist

Change any of this and re-check these. Each item names the test that holds it.

**View-mode survival (`src/views/datasetView/Viewer.test.ts`)**
- The refresh runs on mount, so a gate hydrated before this view resolves — *"refreshes on mount, so a gate hydrated before this view resolves"*
- It still runs when the dataset opens in 3D, where AnnotationViewer is unmounted — *"still refreshes when the dataset opens in 3D volume mode"*

**Refresh ownership (`src/store/index.test.ts`)**
- Configuration hydration seeds plots but never dispatches its own duplicate request; the Viewer signature watcher is the only refresh owner — *"hydrates plots without directly dispatching a duplicate analysis refresh"*

**Fetch scope — owned by the store (`src/store/__tests__/filters.test.ts`)**
- An ungated plot costs nothing while the panel is closed — *"does not fetch for an ungated plot while the panel is closed"*
- A gated plot resolves with the panel closed, because a gate is a filter — *"fetches for a gated plot even with the panel closed"*
- Opening the panel fetches for ungated plots so they can be drawn — *"fetches for an ungated plot once the panel opens"*
- Only the axes' paths are requested, projected — *"requests only the axes' property paths, projected"*
- A categorical-only gate resolves with no fetch at all — *"resolves a categorical-only gate without fetching anything"*
- A failed value fetch leaves gate ids alone rather than resolving every gate to zero matches — *"leaves gate ids untouched when the value fetch fails"*
- A bail-out invalidates any in-flight request, so a stale one cannot reinstate a gate — *"invalidates an in-flight request before bailing out"*
- Above the cap: no fetch and no gate — *"refuses to fetch or gate above the point cap"*
- The polygon resolves to ids and the values are published for the panel to reuse — *"resolves the polygon into ids and publishes the values it fetched"*
- Derived state is cleared when the last gate goes — *"clears derived state when the last gate goes away"*
- Re-lassoing drops the previous gate's ids, so a failed follow-up cannot strand them — *"drops the previous gate's ids when a new lasso replaces it"*
- The gate signature samples ids rather than counting them, so a same-size gate edit registers — *"samples gate ids in the signature, not just their count"*
- Loading is tracked explicitly, so an empty result is not mistaken for pending — *"tracks loading explicitly so an empty result is not mistaken for pending"*, *"clears the loading flag when it bails out early"*

**Gate composition (`src/store/filters.test.ts`)**
- No drawn gate passes everything through and adds 0 to `activeFilterCount` — *"passes everything through while no gate is drawn"*
- A drawn but unresolved gate constrains nothing, so drawing never flashes empty — *"does not constrain a drawn gate until its ids have been resolved"*
- Multiple enabled gates AND (not union); disabling one drops its constraint but keeps its polygon; clearing restores — *"ANDs the enabled resolved gates into filteredAnnotations"*
- An empty resolved gate filters everything out, and is not treated as "no gate" — *"treats an empty resolved gate as filtering everything out"*
- Changing an axis nulls both the gate and its resolved ids — *"invalidates the gate and its ids when an axis changes"*
- Removing an attached property nulls every affected axis and gate, invalidates the earliest dependent suffix, and saves once — *"drops missing property axes and invalidates their dependent plot suffix"*
- Removing a plot removes its gate and its ids — *"removing a plot removes its gate from the composition"*
- Editing, removing, or toggling an upstream plot drops every downstream gate's ids; a toggle keeps only the toggled plot's still-valid ids — *"drops stale downstream ids after $edit"*
- Active gates are exposed as raw id lists, so forwarding them to the backend never builds a Set — *"exposes active gates as raw id lists, not Sets"*
- The analysis signature short-circuits when nothing needs resolving, so an idle dataset never touches the population — *"short-circuits the analysis signature when nothing needs resolving"*
- Opening the panel wakes it even with no gate — *"wakes the analysis signature when the panel opens with no gate"*
- The id-membership filters are signed, never serialized — *"signs the id-membership filters without serializing their ids"*
- Gates are cleared on dataset switch — *"clears analysis plots on reset"*

**Gating maths (`src/utils/__tests__/analysisGating.test.ts`)**
- Annotations missing either axis value are dropped and counted — *"drops annotations missing a value on either axis, and counts them"*
- NaN/Infinity count as missing, never as a plottable coordinate — *"treats a non-finite property value as missing"*
- Categories map to sorted indices, jittered deterministically across rebuilds — *"maps categories to sorted indices with deterministic jitter"*
- A gate's stored category ordering wins over the current data's — *"pins category indices to a gate's stored ordering"*
- An unseen category is appended rather than dropped — *"appends a category the stored ordering has never seen"*
- Every categorical axis kind labels from stub-available fields — *"labels each categorical axis kind from stub-available fields"*
- Point-in-polygon is real containment, including concave lassos — *"resolves a concave polygon by containment, not by bounding box"*
- A degenerate (<3 vertex) polygon selects nothing — *"selects nothing for a degenerate polygon"*
- Lasso and box selections both become polygons; a payload with neither leaves the gate alone — *"converts a lasso path, carrying the category ordering along"*, *"converts a box-select range into a four-corner polygon"*, *"returns null for a payload with neither lasso nor range"*
- The chain gives plot *n* only gates *0..n-1*, and skips disabled/unresolved/gate-less plots — *"gives each plot the population passing the PRECEDING gates only"*, *"skips a disabled gate"*, *"skips a gate whose ids are not resolved yet"*, *"skips a plot with no gate even if stale ids linger"*
- Population signature distinguishes same-length populations — *"distinguishes same-length populations"*
- Categorical signatures preserve annotation boundaries, so redistributing the same tag values across rows still refreshes — *"preserves annotation boundaries when tag values are redistributed"*

**Persistence (`src/store/annotationBrowserConfig.test.ts`)**
- A plot round-trips through the configuration — *"persists the gate polygon and survives a round trip"*
- Resolved ids never reach the configuration — *"never persists resolved annotation ids"*
- An axis whose property left the configuration is dropped, taking its gate — *"drops a plot's axis when its property left the configuration"*
- An unknown categorical key is rejected rather than trusted — *"drops an unknown categorical key rather than trusting it"*
- Malformed gates/plots are dropped — *"drops malformed gates and plots"*
- Older configurations without the key still load — *"tolerates a configuration saved before analysis plots existed"*

**Live property changes (`src/store/properties.createProperty.test.ts`)**
- Deleting an attached property reconciles analysis plots immediately rather than waiting for reload — *"reconciles plots immediately after deleting an attached property"*
- A failed property-ID sync preserves its backend error across both deletion actions — *"surfaces the backend's message when deleting a propertyIds sync fails"*

**Panel (`src/components/AnalysisPanel.test.ts`)**
- Visibility is reported to the store, including on unmount — *"reports its open state to the store, including on unmount"*
- While hidden, no scatter child mounts, no series builds, and no memoised input population remains; reopening restores them — *"does no display work and retains no plot populations while hidden"*
- Above the cap the panel refuses to plot — *"refuses to plot above the point cap"*; boundary held by *"plots at exactly the cap"*
- Plot *n* receives gates *0..n-1* only — *"feeds each plot the population passing the PRECEDING gates only"*
- Input arrays stay identity-stable when nothing changed, so a Z-scrub doesn't re-render every plot — *"keeps plot input arrays identity-stable when nothing changed"*
- Memoised inputs for removed plots are dropped — *"drops memoised inputs for removed plots"*
- A series is built per plot with both axes chosen — *"builds a series per plot with both axes chosen, and none without"*

**Selection safety (`src/components/AnnotationBrowser/AnnotationList.test.ts`)**
- Every query change clears the global object selection in client and server modes, so an analysis gate cannot hide a selected object that a later bulk action deletes — *"clears the global selection when an analysis gate changes in client mode"*

**Plotly wiring (`src/components/AnalysisScatterPlot.test.ts`)**
- A lasso reaches the store as a polygon, not as ids — *"sends a lasso to the store as a polygon, not as ids"*
- Handlers attach exactly once even when two renders overlap, so one lasso fires once — *"attaches selection handlers exactly once when two renders overlap"*, *"attaches selection handlers exactly once across repeated renders"*
- A bare selection event leaves the gate alone — *"ignores a selection event carrying no lasso or range"*
- Deselect clears the gate — *"clears the gate on deselect"*
- Gated points are marked selected; unresolved gates leave it null — *"marks the gated points as selected in the trace"*, *"leaves selectedpoints null when no gate has been resolved"*

**Server-mode list (`src/store/__tests__/annotationListServer.test.ts`)**
- One `idConstraints` entry per gate, never a union — *"adds one AND constraint per analysis gate, not a union"*
- An empty gate is recognised as match-none — *"is true when a gate resolved to no annotations"*, *"is false again once the gate matches something"*

**Match-none at the request boundary (`src/store/__tests__/annotationsAPI.test.ts`)**
- No page request is issued for an impossible query — *"returns an empty page without issuing a request"*
- No id request is issued either (this is the sibling the first fix missed) — *"returns no ids without issuing a request"*
- A fully-populated constraint still sends the request — *"still sends the request when every constraint is non-empty"*

**Verified live, not covered by a test**
- The GeoJS viewer draws exactly the gated set (709k-object Xenium dataset: gate of 305 → header read "Showing 305 of 305 in view", layer held 305 features).
- Plotly's own lasso hit-testing. Tests drive `plotly_selected` with a known
  payload, which exercises our polygon capture and re-resolution but not
  Plotly's own drag maths.

## Process notes

- Verify from a **fresh page load** on a dataset that actually has the property
  under test, and prefer one with *varying* values: the first dataset tried here
  was a grid of identical squares, so Circularity was constant (0.785 for every
  object) and a broken axis would have looked the same as a working one.
- A backgrounded or occluded Chrome window pauses `requestAnimationFrame`, which
  stalls every Vuetify overlay transition at `visibility: hidden`. Select
  dropdowns then look "open but unclickable" app-wide, including pre-existing
  ones. Check `document.visibilityState` and count rAF frames before
  investigating a layering bug. See the `in-browser-testing` skill, trap #2.

## Status, and what a fresh reader should know

Delivered on branch `analysis-panel-scatter-gating`, PR
[#1298](https://github.com/arjunrajlaboratory/NimbusImage/pull/1298), through
`aef8d2eb` (the feature, four Codex-fix rounds, documentation, and the export
split). The round-5 follow-up fixes below are in the working tree and are not
committed yet. **Not merged.**

Current working-tree gates: `pnpm tsc`, `pnpm lint:ci`, and all 3,400 frontend
tests.
There are no backend changes in #1298. The general CSV endpoint correction and
its backend tests live in prerequisite #1299.

### Round 4 review resolution

Codex has reviewed four times. Rounds 1–3 (eleven findings) are committed;
**round 4 is fixed and committed at `3e206adb`**:

> **P1 — Invalidate downstream gate IDs after upstream edits.** Editing a plot
> that precedes other gated plots drops only the edited plot's ids, but
> `resolveAnalysisGateIds` derived every later gate from the population passing
> its predecessors. Downstream ids therefore keep the old upstream constraint,
> and if the property fetch fails they filter the viewer, list and exports by
> the stale chain permanently. Must invalidate the edited plot **and every
> following plot**, including on upstream axis changes, removal, and
> enable-state toggles.

This was real, and it contradicted a claim made in the round-3 reply on the PR
("`toggleAnalysisPlotGateEnabled` deliberately keeps them — the ids stay
valid"). That is true of the toggled plot itself and false of everything
downstream of it. `dropAnalysisGateIdsFromPlot` now invalidates the affected
suffix from `setAnalysisPlotGate`, `setAnalysisPlotAxes`,
`removeAnalysisPlot`, and `toggleAnalysisPlotGateEnabled`. The toggle path
starts at the following plot, preserving its own still-valid ids. The
table-driven *"drops stale downstream ids after $edit"* regression chains three
plots and covers all four mutations.

### Round 5 follow-up review tracker

The next cold branch review found six additional issues. They are tracked here
before implementation so the finding, regression, and final verification stay
together across context clears.

1. **High — stale client-mode selection after a gate change**
   (`src/components/AnnotationBrowser/AnnotationList.vue`). A selected object
   can become hidden by an analysis gate while remaining in the global
   selection that powers delete/tag/color actions. **Status: fixed in the
   working tree (uncommitted).** The canonical query-signature watcher now
   clears selection in both client and server modes, covering analysis gates
   and every sibling filter path; *"clears the global selection when an
   analysis gate changes in client mode"* pins the destructive-action source of
   truth.
2. **High — categorical signatures omit annotation boundaries**
   (`src/utils/analysisGating.ts`, `src/utils/signatures.ts`). Different tag
   distributions with the same flattened values can collide exactly, so a gate
   refresh can be skipped. **Status: fixed in the working tree
   (uncommitted).** `countItem()` now mixes a record separator into both hash
   lanes, so boundaries affect the digest rather than only the final count;
   *"preserves annotation boundaries when tag values are redistributed"*
   reproduces the former exact collision.
3. **Medium — a closed Analysis palette still builds plot inputs and mounts
   Plotly** (`src/components/AnalysisPanel.vue`). `v-show` keeps the panel
   mounted, so display-only work and retained populations survive while hidden.
   **Status: fixed in the working tree (uncommitted).** The hidden panel now
   renders no plot subtree, the input-chain watcher unsubscribes from plot data
   and clears its memoised populations, and the series computed returns before
   touching plot inputs. *"does no display work and retains no plot populations
   while hidden"* covers close, reopen, and close-again transitions.
4. **Medium — configuration hydration requests analysis twice**
   (`src/store/index.ts`, `src/views/datasetView/Viewer.vue`). Hydration
   dispatches a refresh directly and also changes the signature watched by the
   Viewer. **Status: fixed in the working tree (uncommitted).** Hydration now
   only seeds plot state; the Viewer remains the single refresh owner in both
   2D and 3D. *"hydrates plots without directly dispatching a duplicate
   analysis refresh"* observes the real Vuex action stream, alongside the
   existing Viewer watcher regressions.
5. **Medium — deleting a property leaves plots that reference it active**
   (`src/store/properties.ts`, `src/store/filters.ts`). Unknown axes are pruned
   on reload but not reconciled immediately, leaving invisible or match-none
   gates during the current session. **Status: fixed in the working tree
   (uncommitted).** After a successful property-ID sync, one plural filters
   action clears every missing axis and its gate, invalidates from the earliest
   changed plot through the dependent suffix, and schedules one config save.
   *"drops missing property axes and invalidates their dependent plot suffix"*
   and *"reconciles plots immediately after deleting an attached property"*
   cover the store and cross-module paths. The sibling delete actions now also
   preserve backend errors through both Vuex decorator boundaries.
6. **Nit — obsolete `neededPaths` panel exposure**
   (`src/components/AnalysisPanel.vue`). The store owns property fetching and
   no caller reads this computed anymore. **Status: fixed in the working tree
   (uncommitted).** The computed, import, and exposed property are removed.

### What is verified live vs by test only

Verified in a running browser: the full gating flow including a real lasso drag
through Plotly, the persistence round trip (reload → gate re-resolves without
opening the panel), server-mode list refetch, 3D-mode survival, the over-cap
notice on the 709k-object Xenium dataset, categorical gating, empty-gate
match-none, and palette stacking.

Verified by tests and revert-and-watch-it-fail only: the two round-3 fixes that
remain in this branch. The third finding, the general empty-subset CSV contract,
is tested separately in prerequisite #1299.
The round-4 suffix-invalidation fix is also verified live: on HCR squares, a
three-plot chain used a property axis downstream to keep refresh asynchronous;
disabling plot 1 preserved its `gate: 26,142` while plots 2 and 3 immediately
became unresolved (`gate: …`). The temporary plots were removed, and a hard
reload confirmed the shared configuration was back to its original no-plot
state.
The browser session was reauthenticated and used for that round-4 check. The
separate #1299 export fix still needs `docker compose build girder && docker
compose up -d girder` for an end-to-end browser exercise — the plugin is baked
into the image, so a restart will not pick it up.

The round-5 follow-up was verified from a hard-reloaded, visible browser on HCR
squares. A temporary Tags × Shape plot rendered all 26,142 objects in Plotly;
closing Analysis removed the panel, plot component, and `.js-plotly-plot` from
the DOM, while reopening rebuilt them. An object selected before a full-range
box gate became unchecked as soon as the gate resolved (`gate: 26,142`), which
exercises the live query/selection watcher; the client-mode branch is pinned by
the focused regression because this dataset uses the server list. The temporary
plot and gate were removed, and a fresh reload confirmed the shared
configuration was back to zero plots. No browser warnings or errors were
recorded. Property-deletion reconciliation, the exact categorical hash
collision, and single-owner hydration are verified by their store/unit
regressions rather than by destructive live probes.

### Review history, and what it suggests

Seventeen of the eighteen findings across four Codex rounds plus the cold
follow-up review were real. Notably, most of the later ones were consequences of
*earlier fixes* rather than of the original feature — the gate-replacement bug
only became permanent because of the failed-fetch fix; the `fetchMatchingIds`
miss came from guarding call sites instead of the request boundary; the palette
overlap came from fixing eviction without fixing layout. The feature core has
been stable since round 1, but the seams now have regression coverage for the
failure shapes that kept recurring.

## Possible follow-ups

Above the cap, the scalable design is server-side: a 2D density histogram for
display plus polygon-to-ids resolution on the backend (the same shape as
`refreshPropertyFilterPassingIds`). Now that a gate *is* a polygon, that is a
backend endpoint rather than a data-model change. A cheaper intermediate step:
**rectangular** gates, which are exactly two numeric range filters and therefore
already expressible through the existing property-filter path — exact at any
dataset size, with no new endpoint.
