# Active-constraint cues: telling the user why the counts are small

**Status:** Implemented (2026-08-15). Issue #1328.

## Problem

The render-coverage HUD (`RenderCoverageIndicator.vue`, top-center over the
canvas) reports **filtered** counts: `viewportAnnotationCount` /
`viewportRenderedCount` are computed from the id set that already survived
filters and analysis gates (`updateVisibilityAndHydration`, Steps 2 and 5b in
`src/store/annotation.ts`). Nothing in the widget said so.

A saved 16-vertex lasso gate (Area × PECAM1) restored from a configuration at
load resolved 72,925 of 708,983 annotations (10.3%), and the HUD read

> Showing 826 of 826 in view

in a viewport that visibly held thousands of objects. For an expert user that
reads as data loss, not as filtering. The `1` badge on the Analysis palette
icon was present the whole time and was not enough: it lives at the edge of the
window, far from the number the user is actually reading, and it says nothing
about the count it explains.

## Design

**One list, three surfaces.** `src/utils/activeConstraints.ts` is now the only
place that decides what counts as "something is narrowing the object set":

- `collectActiveConstraints(input)` → `IActiveConstraint[]`, pure data. Each
  entry carries its `source` (`"filters"` or `"analysis"`), its `kind`, and
  just enough detail to name it later (a property filter's path, a gate's
  axes). Filters panel first, then gates in plot order.
- `countActiveConstraints(list, source?)` → the badges' numbers when a source
  is given, the HUD's number when it is not.
- `describeConstraint` / `summarizeActiveConstraints(list, resolveName)` →
  `"1 lasso gate on Area × PECAM1; 1 tag filter"`. Naming a property path needs
  the properties store, which is why phrasing is separate from collecting: the
  collectors run inside a filters-store getter and must not pull a store
  dependency into it.

The filters store keeps its two existing getters but they now *count the one
list* — `activeFilterCount` = `countActiveConstraints(activeConstraints,
"filters")`, `activeAnalysisGateCount` = the `"analysis"` half — and gains
`activeConstraints` / `activeConstraintCount` for the HUD. The semantics are
unchanged (each badge still counts only what its own panel can show); what
changes is that they can no longer drift from each other or from the HUD.

**The HUD suffix.** `computeRenderCoverage` takes `constraintCount` and returns
`constraintLabel` — `"(1 filter applied)"` / `"(3 filters applied)"` — rendered
as a warning-tinted, dotted-underlined button on the same line as
"Showing 826 of 826 in view". "filter" covers gates too: the reader is being
told their numbers are narrowed, and the tooltip names what did it.

- **Tooltip** (native `title`, also the `aria-label`, since the visible text is
  only a count): *"Objects are narrowed by 1 lasso gate on Area × PECAM1;
  1 tag filter. Click to open Analysis and Filters."*
- **Click** opens the panels that own the active constraints — Analysis first,
  then Filters, because Filters is a *companion* palette that hosts alongside
  Analysis; the other order would close the one just opened.
- **Not gated on stub mode.** The counts are filtered in client mode too, so
  the suffix appears wherever the HUD appears. It does not change *when* the
  HUD appears: the show rule is still stub mode or active downsampling.

**Reaching the palette registry.** The HUD is mounted deep inside
`ImageViewer.vue`, with no path to App.vue's palette state, so it asks through
the store: `main.requestPaletteOpen(["analysisPanel", "filtersPanel"])` sets
`paletteOpenRequests`, App.vue watches it, opens each palette in order and
clears the list (so the same request twice in a row is still seen as a change).
This generalizes the existing `isAnnotationPanelOpen` escape hatch used by the
Timelapse panel. `TRequestablePalette` (in `model.ts`) is a subset of App.vue's
`PaletteId`, so renaming a palette id fails to compile rather than silently
never opening anything.

## Regression checklist

Change any of this and re-check these. Each item names the test that holds it.

**What counts as a constraint (`src/utils/__tests__/activeConstraints.test.ts`)**
- Every filter kind the Filters panel exposes is collected, disabled rows are
  not, and a region still being drawn (`emptyROIFilter`) is not — *"collects
  every filter kind the Filters panel exposes"*, *"does not count disabled
  filters"*
- A gate counts only when enabled **and** drawn **and** resolved: an unresolved
  gate constrains nothing, so announcing it would contradict the viewer, which
  is showing more — *"counts a gate only once it is enabled, drawn AND
  resolved"*
- Each panel's count is its own; the HUD's count is both — *"counts each
  panel's own constraints separately"*, *"counts everything narrowing the set
  when no panel is given"*
- Phrases name the gate's plane and the filtered property, collapse duplicates
  with pluralization, and degrade rather than invent: a half-configured gate
  drops the plane instead of implying a one-dimensional gate, and an
  unresolvable property path drops the name — *"names the gate's plane and the
  filters alongside it"*, *"collapses identical constraints into a pluralized
  count"*, *"omits the plane of a half-configured gate rather than implying one
  axis"*, *"falls back to no property name when the path no longer resolves"*

**Badges still count only their own panel (`src/store/__tests__/activeFilterCount.test.ts`)**
- The store getters delegating to the shared collector did not change what they
  count: gates stay off the Filters badge — *"stays 0 for a resolved, enabled
  gate"*, *"counts only the panel's own filters alongside a gate"*

**The HUD (`src/components/RenderCoverageIndicator.test.ts`)**
- No suffix when nothing is narrowing — *"says nothing about constraints when
  none is active"*
- The count sits on the same line as the numbers it explains — *"appends the
  constraint count next to the counts it explains"*
- The tooltip names the constraints and is mirrored into `aria-label` — *"names
  the active constraints in its tooltip"*
- Clicking opens the owning panel, Analysis before Filters — *"opens the panel
  that owns the constraint when clicked"*, *"opens Analysis before Filters so
  the companion stacks beside it"*
- The suffix is not gated on stub mode — *"shows the constraint suffix outside
  stub mode too"* (and `renderCoverage.test.ts`, *"announces constraints
  outside stub mode too"*)

**The label itself (`src/utils/__tests__/renderCoverage.test.ts`)**
- Null when no constraint is active; pluralized otherwise — *"says nothing
  about constraints when none is active"*, *"announces active constraints,
  pluralized"*

**Palette requests (`src/App.test.ts`)**
- A request opens every palette it names and is then cleared, so the same
  request can be made again — *"opens the palettes a store request asks for,
  then clears the request"*
- An empty request is a no-op — *"ignores an empty palette request"*
- The store mock is `reactive` for these: a plain object never fires the
  watcher, so both tests would pass vacuously against a broken wiring.

## Notes for future changes

- **Add a narrowing constraint anywhere → add it to `collectActiveConstraints`.**
  That is the single place all three surfaces read; a new filter kind that
  skips it is invisible on every one of them, not just the HUD.
- The HUD's suffix says "filter" for gates as well. If gate and filter ever
  need to be distinguished in the visible text, the split already exists in the
  data (`source`) — only the phrasing would change.
