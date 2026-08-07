---
name: nimbus-geojs
description: "Use when working with GeoJS in AnnotationViewer.vue or ImageViewer.vue — adding/removing/reusing annotation features, the draw path, coordinate handling, drawing-tool interaction events, or writing/debugging AnnotationViewer.test.ts. Symptoms this skill explains: annotations invisible though layer.annotations() has them, features drifting off-image or mirrored after re-add, dots in bands above/below the image, live drag positions not updating, annotations vanishing after z-scrubbing."
---

# GeoJS in NimbusImage — traps and testing

GeoJS's annotation layer has several asymmetric, mutating APIs. Each trap below caused a real shipped bug or a multi-hour debug in this repo. Read the row for your symptom first.

## Symptom → cause quick reference

| Symptom | Cause | Fix |
|---|---|---|
| Features in `layer.annotations()` (count correct) but nothing paints | Adds with `update=false` don't bump `modified()`; `layer.draw()` alone doesn't force `_update` | Call `layer.modified()` when the add pass grew the feature count, then `draw()` |
| Re-added feature drifts off-image; dots in bands above/below image, worse each zoom in→out | `addAnnotation` runs ingcs→gcs conversion on EVERY add, mutating coords in place — a re-add double-converts | Re-add already-added features with `gcs = null`; fresh features with `gcs = undefined` |
| Annotation renders mirrored above the image / invisible after coordinate update | `annotation._coordinates(v)` sets raw **gcs** (y-up) with NO conversion, but `coordinates()` and `evt.geo` return **ingcs** (image px, y-down) | Never mutate an added annotation's coords — remove and recreate via factory + `addAnnotation` so conversion happens exactly once |
| No position updates during a drag | GeoJS suppresses `mousemove` during an active drag action; it fires `actionmove` instead | Bind both `geo_event.mousemove` and `geo_event.actionmove` if you need live drag positions |
| `currentAnnotation` non-null but user isn't drawing | Completing an annotation resets layer mode to null; `refreshAnnotationMode` re-arms with a fresh EMPTY in-create annotation | Non-null ≠ drawing — check `currentAnnotation.coordinates().length` |
| Connection lines mostly missing on a big (stub-only) dataset; more appear as you zoom in | Draw/retention gated on `getAnnotationFromId`, which returns `undefined` for unhydrated non-point annotations | Gate on what you actually draw from (the centroid map), never on hydration — see "Hydration-coupled draw paths" |
| A specially styled feature reverts to the default style after a pan/zoom | The retained-feature restyle loop in `drawNewAnnotations` treats every `girderId`-bearing feature as an object annotation | `continue` on `isConnection` (or your own marker) in that loop |
| A drawn feature can't be selected even though its record exists | One feature drawn per *pair/group* while several records map to it; the feature carries only the first record's id | Choose the selected record as the drawn representative |
| Feature is in `layer.annotations()`, on-screen, right colour — and paints nothing | `options("style", {...})` **replaces** the style, dropping GeoJS's default `stroke: true` / `fill: true` | Include `stroke: true` explicitly, and merge: `options("style", {...a.options("style"), ...next})` |
| Clicking a list row shows no connection at high zoom | A connection draws only when BOTH endpoints are displayed; recentering on one leaves the other outside the viewport | Frame both endpoints (`frameCameraInfo`) instead of recentering on one |
| With an axis unrolled, the camera/hit-test lands exactly one tile-width (or a multiple) away from the object | The draw path offsets each annotation by its grid cell; the other path used the raw frame-local centroid | Put both through `@/utils/unroll` — see "Unrolled coordinates are a third space" |
| Hover/selection highlight works on one layer and does nothing on another | The second layer rebuilds its features from scratch on every draw and bakes the highlight in at build time, so only the state wired to a rebuild is ever reflected | Give the features a base-style option and restyle them in place — see "Layers that bake style at draw time" |

## Layers that bake style at draw time

A layer that is torn down and rebuilt on every draw (the timelapse track layer:
`removeAllAnnotations` then one fresh line feature per connection) reflects a state
change only if something triggers a rebuild. That makes it tempting to skip cheap-looking
state — rebuilding ~2,500 features per hover genuinely is sluggish — but **skipping the
repaint is only safe if that state is not a user-facing gesture.** It was: a connection-list
row click *highlights* (sets hover) rather than selects, so the highlight silently did nothing
in timelapse mode while working everywhere else.

Restyle in place instead, and give the features what that needs at build time:

- **A base-style option** (`timelapseBaseStyle`) holding the appearance minus the highlight,
  so the unhighlighted look can be recomputed without knowing which track built it.
- **Every id that maps to the feature** (`connectionIds`), not just the representative one.
  One feature per endpoint *pair* but several records per pair means matching on the single
  baked-in id misses the duplicates — the same trap as the representative row above, one
  layer over.
- **Skip features whose style is unchanged.** Setting a style calls `annotation.modified()`
  → `layer.modified()`, so touching all N features forces a full `_update`; touching only the
  two that changed (and skipping `draw()` entirely when none did) keeps it cheap.
- Keep the rebuild for state that changes *which* feature is built (which duplicate
  represents a pair), and restyle for state that only changes paint.

Measured on 2,364 segments: 0.8 ms to scan them all, 6.6 ms median for the redraw
(GeoJS aggregates every line annotation into ONE webgl `lineFeature`, so any style change
rebuilds that feature's data).

Verifying it repainted, not just that the options bag changed: read the resolved
render-time style off the aggregated feature, which is what the GPU will draw.

```js
const lineFeature = layer.features().find(f => f.featureType === 'line');
const acc = lineFeature.style.get('strokeWidth');
const counts = {};
lineFeature.data().forEach((line, i) => {
  const w = acc(lineFeature.line()(line, i)[0], 0, line, i);
  counts[w] = (counts[w] || 0) + 1;
});
// {"3":1312,"5":1,"6":1175} — exactly one segment widened by the hover.
```

This beats a screenshot diff: `map.screenshot()` hangs in a background tab, and the
`computer` tool cannot hold the tab foreground across calls.

## Coordinate systems

The image map has `ingcs !== gcs` (y-flipped/scaled pixel system from `geojs.util.pixelCoordinateParams`), so conversions are non-trivial and every mistake is visible.

- `annotation.coordinates()` returns **ingcs**; mouse `evt.geo` is **ingcs**; `annotation._coordinates(v)` sets **raw gcs** — asymmetric.
- `addAnnotation(a, gcs)` / `addMultipleAnnotations(list, gcs, update)` convert ingcs→gcs on every call, **mutating the feature**. The `gcs` param contract:
  - `undefined` → treat coords as ingcs, convert once (correct for freshly created features)
  - `null` → map.gcs(), conversion skipped (correct for retained/pooled features being re-added)
- The GeoJS mock in unit tests does NOT model conversion — tests can only assert the `gcs` arg contract (`toHaveBeenCalledWith([...], null, ...)`). Visual drift must be verified in-browser (see in-browser-testing skill).

## Unrolled coordinates are a third space

`ingcs` vs `gcs` is not the only split. When any of `store.unrollXY / unrollZ / unrollT`
is on, every frame along that axis is drawn side by side on one map, and the draw path
offsets each annotation by the grid cell its frame occupies:

```
drawn.x = sizeX * (cell % unrollW) + raw.x        // cell = the frame's keyOffset
drawn.y = sizeY * floor(cell / unrollW) + raw.y
```

So an annotation's **stored** coordinates and its **on-screen** position differ by up to
the whole grid. Two consequences, and the first one is the trap:

- **A stored centroid is not a position on the map.** `annotationCentroids[id]`,
  `simpleCentroid(annotation.coordinates)` and `stub.centroid` are all frame-local. The
  moment you compare one against anything in map space — `evt.geo`, `cameraInfo.center`,
  `gcsBounds`, a drawn lasso, a `map.bounds()` — you need the unrolled position instead.
  Use `unrolledPoint` / `unrolledCoordinates` from `@/utils/unroll`, built from a layout
  from `unrollLayoutFor`.
- **Everything is on screen at once, so "same frame" is the wrong displayed-ness test.**
  A connection between two timepoints is genuinely drawn as a line between two tiles.
  Gate on "displayed", which for each axis is `unrolled || indices match` — not on frame
  equality (issue #1280).

The grid itself lives in `ImageViewer`'s `unrollW` / `unrollH` refs, which is why this
drifted in the first place: navigation code cannot reach a component ref. `unrollGridSize`
is the single copy of the layout formula, `ImageViewer` assigns its refs from it, and
`store.unrollGrid` mirrors it for everyone else. Never re-derive it.

**The failure is quiet and looks like a rounding error until you check the magnitude** —
the offset is an exact multiple of the tile size, so "off by 1024" is the tell. Diagnose
by comparing the store value against what GeoJS actually holds:

```js
// per annotation, in the console
layer.annotations().find(a => a.options('girderId') === id).coordinates()[0]  // drawn
store.state.annotation.annotationCentroids[id]                               // raw
```

Known still-raw paths (pre-existing, not yet fixed): the annotation spatial index and
everything querying it — click/shift-click selection, hover highlight, right-click menu,
alt-drag ghost, and the viewport hydration partition. Clicking an object while unrolled
selects nothing; clicking the same spot on the first tile selects it. Verified live on
`normmedia_8well_col2_livecellgfp`.

## Render gating

`_update` (the WebGL feature-data rebuild) only runs when the layer's `modified()` timestamp advanced. `clearOldAnnotations` marks modified only when it *removes* something; a pure add pass with `update=false` marks nothing → invisible features. Debugging tell: run `layer.modified(); layer.draw()` in the console — if features appear instantly, it's this, not missing data. Guard the `modified()` call on "count actually grew" so pure pans keep the incremental-draw optimization.

## Hydration-coupled draw paths (stub-only datasets)

`getAnnotationFromId` returns `undefined` for every unhydrated non-point annotation once
a dataset is in stub-only mode. Any draw path that calls it merely to null-check an
endpoint silently drops most of its output on large datasets, and the loss looks like a
*zoom* bug because zooming in hydrates more annotations and the features appear.

Measured on the 709K-object Xenium dataset: 4 of 12 connection endpoints resolved, so
1 of 11 connection lines was drawn — with every centroid present the whole time.

Rules:

- **Gate on the data you actually consume.** Connection lines need only the two
  centroids, so `drawNewConnections` checks `unrolledCentroidCoordinates`, and
  `drawGeoJSAnnotationFromConnection` takes two `IGeoJSPosition`s rather than two
  `IAnnotation`s. If you need the annotation, fall back to the stub
  (`getAnnotationFromId(id) ?? getStub(id)`), which is what the selection and navigation
  paths do.
- **Draw and retention are a pair.** `clearOldAnnotations` has its own predicate per
  feature kind; if it disagrees with the draw path, every pass deletes what the previous
  one created and rebuilds it next frame — invisible except as churn. Fixing only the
  draw path left retention removing 10 of 11 lines per pass.
- **Verify from a fresh page load.** Interacting hydrates things; a probe run after a
  few pans and zooms will pass on a dataset where a fresh load fails.

## Per-feature style survives only if the redraw loop skips it

`drawNewAnnotations` builds `drawnGeoJSAnnotations` from **every** feature carrying a
`girderId` — including ones that aren't object annotations. Its retained-feature loop
then compares `isHovered`/`isSelected` against ground truth and restyles on mismatch.
A feature that never sets those options has them `undefined`, and `undefined != false`
is **true**, so the branch fires on every redraw and overwrites the feature's style with
`getAnnotationStyle(...)`.

So a feature styled at construction needs both: style it when you build it (a rebuilt
feature must come back correct without waiting for a selection change), and skip it in
that loop. Doing only one of the two produces a highlight that survives until the next
pan.

**`options("style", …)` replaces, it does not merge.** GeoJS supplies `stroke: true`,
`fill: true` and friends through its annotation defaults; assigning a style object that
omits them silently turns rendering off for that feature. This shipped: adding
construction-time styling with `{strokeColor, strokeWidth, strokeOpacity}` made every
connection line invisible at every zoom — present in `layer.annotations()`, correctly
positioned, correct colour in `options().style`, and never painted. The tell is
`annotation.style().stroke === undefined` where a working feature reads `true`.

Always spread the existing style, and assert renderability in tests, not just colour:

```ts
line.options("style", { ...line.options("style"), ...getConnectionStyle(sel, hov) });
// test: expect(line.options().style.stroke).toBe(true)  // not only strokeColor
```

When a feature is invisible, check in this order — each step rules out a whole class:
`layer.annotations()` contains it → its display coords are on screen →
`annotation.style().stroke` is true → the layer was `modified()` before `draw()`.
A screenshot alone cannot distinguish these.

## One feature per group ⇒ pick the representative deliberately

When several records map to one drawn feature (segments deduped by endpoint pair, glyphs
merged by position), the feature can carry only one record's `girderId`. That id is the
only one selection-highlighting and click-resolution can ever reach. If duplicates are
possible in the schema — they are for connections, and real datasets here contain them —
prefer the *selected* record as the representative, otherwise selecting the second
duplicate can never highlight anything.

## Clickable overlays anchored to image coordinates (ui-layer dom widgets)

For UI that must sit at a fixed *image* position and be clickable (frame labels on the
unrolled grid, `ImageViewer.vue`), a `dom` widget on a `ui` layer beats a text feature or a
Vue overlay — GeoJS does the coordinate tracking and you get a real element to style and bind:

```ts
const widget = uiLayer.createWidget("dom", { position: { x, y } });  // map coords
const element = widget.canvas();   // a real <div>
element.onclick = ...;
```

- Passing `position: {x, y}` **to the constructor** binds the `geo_event.pan` reposition handler
  (last lines of `geojs/src/ui/widget.js`). `map.zoom()` ends in a `pan()` and `map.size()` ends in a
  `center()`, so one binding covers pan, zoom and container resize — no watcher needed.
  A position of `{top, left, …}` instead pins the widget to the viewport (that's the scalebar).
- `domWidget._init` calls `stopPropagation` on `mousedown`, so a click on the widget never reaches
  the GeoJS interactor — **this is what keeps an armed drawing tool from creating an annotation
  when the user clicks the overlay.** Verify it with a tool selected, not just with no tool.
- Widget elements are direct children of an active `.geojs-layer`, which is `pointer-events: none`
  with `&.active > * { pointer-events: auto }` — so the widget is clickable and the rest of the
  layer stays transparent to map interaction. Layers are `active` by default.
- Style widget elements from an **unscoped** `<style>` block; scoped CSS can't reach GeoJS-created
  DOM (no `data-v-` attribute). Same reason `.scale-widget` lives in ImageViewer's unscoped block.
- One element per cell is repositioned on every pan, so cap the count for big grids
  (`MAX_UNROLL_LABEL_CELLS`) and rebuild only on a signature change, not on every `draw()`.
- Teardown: `uiLayer.deleteWidget(w)` → `widget._exit()` unbinds the pan handler and removes the
  element; `map.exit()` cascades to child widgets. Key per-map widget bookkeeping off the map
  object (a `WeakMap`), so a map reset naturally drops the stale entry.

## Testing AnnotationViewer (unit)

Full guide: `codebaseDocumentation/FRONTEND_COMPONENT_TESTING.md`. Non-obvious conventions in `src/components/AnnotationViewer.test.ts`:

- **Store mocks are `reactive()`** — drive watchers/computeds after mount by mutating `mockedStore.z` / `mockedAnnotationStore.annotations`, then `await wrapper.vm.$nextTick()`.
- **Fake timers are active**; the draw path is `throttle(drawAnnotationsNoThrottle, 100)` — flush trailing draws with `vi.advanceTimersByTime(101)`.
- **You cannot spy on `<script setup>` closures** — assert via side effects: `annotationLayer.draw` (a `vi.fn`) or exposed computeds like `wrapper.vm.displayedAnnotations`.
- **`geojsAnnotationFactory` mock ignores its args** — to read drawn features by id, `mockImplementation((shape, coords, options) => { const f = mockGeoJSAnnotation(shape); if (options) f.options(options); return f; })`.
- **`@/utils/annotation` is mocked with hand-copied pure helpers** (importing the real module OOMs the file). If the component starts using a new exported helper, add it to the mock or you get "No export defined on the mock".
- `layerSliceIndexes` is a constant `vi.fn` by default; `mockImplementation(() => ({ zIndex: mockedStore.z, ... }))` to make the displayed set turn over per frame.
- **`geojs.util` geometry is stubbed with fixed return values, so a hit test never hits by default.** `distance2dToLineSquared` returns **100** and `pointInPolygon` returns **false**. A line hit test compares against a squared tolerance (connections use `6 px`, i.e. 36), so 100 never matches and the test fails with a symptom that looks like a product bug — the code under test appears to find nothing. Set it per test:

  ```ts
  (geojs.util.distance2dToLineSquared as any).mockReturnValue(1);   // "on the line"
  (geojs.util.distance2dToLineSquared as any).mockReturnValue(100); // "nowhere near"
  ```

  Reset it in the same test when you assert both a hit and a miss. Cost three failed debugging attempts chasing hit-test math that was already correct.
- **`mockGeoJSAnnotation` does not derive `coordinates()` from the `vertices` option.** A feature built by the draw path has the right `options()` but returns nothing useful from `coordinates()`, so anything geometric (hit tests, on-screen checks) sees an empty segment. Override it: `feature.coordinates = () => [{x:0,y:0},{x:1000,y:1000}]`.

## Related

- Driving GeoJS drawing tools from browser automation (synthetic drags, CDP pitfalls): in-browser-testing skill.
- Tool template/interaction structure: tool-development skill (`references/tool-interaction-patterns.md`).
