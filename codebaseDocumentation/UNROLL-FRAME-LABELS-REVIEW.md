# Unroll frame labels (#151 / PR #1276) — review findings

Round 1: Codex review of `claude/issue-151-unroll-frame-labels`, plus one
follow-up request from Arjun.

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| 1 | Medium | `ImageViewer.vue:489`, `utils/unroll.ts:85` | Axis indices ranked over one layer's frames, and that one layer's cells reused for every map — a sparse layer navigates to the wrong frame | fixed |
| 2 | Low | `ImageViewer.vue:934` | Clickable label is a `<div>`: no keyboard access, no button semantics | fixed |
| 3 | — (request) | `utils/unroll.ts` | Also show the dataset's dimension label — `XY 1 (19263, -6626)` | fixed |
| 4 | Low | `ImageViewer.vue:499` | Round 2: toggling "Show XY/Z/Time labels" while unrolled left the existing widgets stale until the next `draw()` | fixed |

## Finding 1 — verified real

`getUnrollCells` ranked each axis value among the distinct values of the images
it was handed, and it was handed one layer's images (`layerStackImages.find(lsi
=> lsi.images[0])`). But `store.xy` / `.z` / `.time` index into `dataset.xy` /
`.z` / `.time`, which `parseTiles` builds from **every** frame of the dataset.
So for a channel present only at XY 0 and 5 in a dataset whose frames cover
XY 0, 2, 5:

- rank within the layer: `5 → 1` → navigates to `dataset.xy[1]` = XY **2**
- correct: `5 → 2`

The label was wrong the same way (`XY 2` on the cell showing XY 5). Complete
Cartesian datasets — the normal case — hide it, because rank within one layer
equals rank within the dataset.

Second half of the finding: `updateUnrollLabels` computed one cells array and
applied it to every map, but in `layerMode: "unroll"` each map draws its own
layer group, so a group with different frame coverage got another group's
labels.

**Fix.** `getUnrollCells` takes a single options object: `cellImages` (grid
order, per map) and `axisImages` (the frames the ranks come from —
`dataset.allImages`). `ImageViewer` computes cells per map from that map's own
`mapLayerList` group.

Not done, deliberately: extracting the axis-array construction out of
`parseTiles` to share it literally. `parseTiles` builds `z`/`time` through the
`zs`/`ts` map machinery that also does the unroll `-1` collapsing; pulling that
apart is a bigger, riskier change than this fix needs. `sortedAxisValues` in
`unroll.ts` mirrors it instead, with a comment saying so.

## Finding 2 — verified real

The widget element was a `div` with an `onclick`, so keyboard users could not
reach it and screen readers saw no control. GeoJS's `domWidget` honours
`arg.el`, so the element is now a real `<button type="button">` with an
`aria-label`, and the mousedown-stopPropagation behaviour that keeps clicks away
from the drawing tools is unchanged (it is bound on the widget canvas whatever
the tag is).

## Finding 3 — follow-up request

Labels now read `XY 1 (19263, -6626)` when the dataset has
`meta.dimensionLabels` for that axis, and plain `XY 1` when it doesn't. Gated
per axis on the existing viewer settings (`showXYLabels` / `showZLabels` /
`showTimeLabels`), which is what the navigator sliders already use to decide
whether to show a dimension label — so one switch controls both.

## Finding 4 — verified real (round 2)

Nothing consumed the cells until the next `draw()`, and the label settings never
cause one, so flipping "Show XY position labels" while unrolled left the old
text on screen. Fixed with `watch(unrollCellsByMap, () => updateUnrollLabels())`
— watching the cells rather than the settings covers every input that only
changes label text, now and later. `updateUnrollLabels` lost its `someImage`
parameter (it derives it from the same layer the cells come from) so it can be
called from the watcher, and it still no-ops on an unchanged signature, so the
extra calls from the draw path cost a string compare.

Verified live, not just in vitest: `commit('setShowXYLabels', false)` on the
unrolled `normmedia` dataset rewrote the six labels from
`XY 1 (19263, -6626)` to `XY 1` with no redraw, and back again.

### Test-harness fixes this round exposed

Both were pre-existing and made the new test fail for reasons unrelated to the
code under test:

- `afterEach` had an empty `if (wrapper) {}` block, so every mounted
  `ImageViewer` stayed alive and kept reacting to the shared `reactive()` store
  mock. A store change in a later test therefore ran ~90 earlier components'
  watchers, all writing widgets onto the same `mockedStore.maps` entry (183
  labels where 2 were expected). Now it unmounts.
- The label assertions read `createWidget.mock.results`, i.e. the creation log,
  which also counts labels a later rebuild deleted — and `draw()` replaces a map
  entry every time in the harness, because `needReset` keys off
  `!mapElement.firstChild` and the mocked map never appends a child. Assertions
  now read created-minus-deleted widgets from the *current* map entry.

## Pattern sweep

- **Ranks/indices derived from a subset of frames**: the only other place that
  maps a frame to a store index is `AnnotationViewer.unrollIndex` →
  `unrollIndexFromImages`, which resolves a *cell position* (`keyOffset`) from
  `dataset.images(...)`, not an axis index — different quantity, correct as is.
- **Per-map state computed once from the first layer**: `unrollW` / `unrollH`
  and the map bounds in `draw()` are also derived from the first layer with
  images and shared across maps. That is pre-existing and deliberate (every map
  shows the same grid geometry); labels now describe each map's own frames
  within that shared geometry.
- **Click-only affordances on GeoJS-created DOM**: the scale widgets
  (`updateScaleWidget` / `updateScalePixelWidget`) have the same issue as
  finding 2 — an `onclick` on an SVG element. Out of scope for this branch;
  noted here rather than fixed silently.
