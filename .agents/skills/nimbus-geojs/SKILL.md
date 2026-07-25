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

## Coordinate systems

The image map has `ingcs !== gcs` (y-flipped/scaled pixel system from `geojs.util.pixelCoordinateParams`), so conversions are non-trivial and every mistake is visible.

- `annotation.coordinates()` returns **ingcs**; mouse `evt.geo` is **ingcs**; `annotation._coordinates(v)` sets **raw gcs** — asymmetric.
- `addAnnotation(a, gcs)` / `addMultipleAnnotations(list, gcs, update)` convert ingcs→gcs on every call, **mutating the feature**. The `gcs` param contract:
  - `undefined` → treat coords as ingcs, convert once (correct for freshly created features)
  - `null` → map.gcs(), conversion skipped (correct for retained/pooled features being re-added)
- The GeoJS mock in unit tests does NOT model conversion — tests can only assert the `gcs` arg contract (`toHaveBeenCalledWith([...], null, ...)`). Visual drift must be verified in-browser (see in-browser-testing skill).

## Render gating

`_update` (the WebGL feature-data rebuild) only runs when the layer's `modified()` timestamp advanced. `clearOldAnnotations` marks modified only when it *removes* something; a pure add pass with `update=false` marks nothing → invisible features. Debugging tell: run `layer.modified(); layer.draw()` in the console — if features appear instantly, it's this, not missing data. Guard the `modified()` call on "count actually grew" so pure pans keep the incremental-draw optimization.

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

## Related

- Driving GeoJS drawing tools from browser automation (synthetic drags, CDP pitfalls): in-browser-testing skill.
- Tool template/interaction structure: tool-development skill (`references/tool-interaction-patterns.md`).
