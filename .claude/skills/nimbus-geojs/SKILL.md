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
