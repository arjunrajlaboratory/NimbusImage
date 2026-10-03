# Unroll frame labels with click-to-navigate (issue #151)

## Goal

When a dimension is unrolled (XY / Z / Time), label each cell of the unrolled
grid in its upper-left corner, and make the label a control: clicking it turns
unroll off and jumps the viewer to that frame.

## Behavior

- Labels appear only while `store.unroll` is true (any of `unrollXY`,
  `unrollZ`, `unrollT`). No new setting; they disappear with unroll.
- Text mirrors the Navigator sliders' 1-based display (`:offset="1"`):
  `XY 3`, `Z 2`, `T 7`. When several axes are unrolled at once the label joins
  them: `XY 3 · Z 2`.
- Clicking a label:
  1. sets `store.xy` / `store.z` / `store.time` to that cell's indices for the
     unrolled axes (non-unrolled axes keep their current value), then
  2. clears the unroll flags that are on.
  The dataset reload that turns the grid back into a single frame is the
  existing `NavigatorPanel` watcher on the three flags — the same mechanism
  snapshot restore (`Snapshots.vue`) and the AI panel (`agent/executors.ts`)
  rely on. Nothing here calls `refreshDataset` itself, which would double the
  reload.
- Only the label is clickable. The rest of each cell keeps today's behavior so
  annotation tools still work in unroll mode.

## Grid → frame mapping

`ImageViewer.draw()` lays the grid out with `unrollW`/`unrollH`, and cell _i_ is
`someImages.images[i]` (`keyOffset === i`). Cell _i_'s top-left in map gcs is
`(sizeX * (i % unrollW), sizeY * floor(i / unrollW))` — the same convention
`AnnotationViewer.unrolledCoordinates` uses.

The index to navigate to is **not** the raw frame value. `store.xy` / `z` /
`time` are indices into `dataset.xy` / `.z` / `.time`, which `parseTiles` builds
as the sorted distinct axis values (and `z` falls back to `PositionZ`, which can
be a non-index float). So for each unrolled axis we rank the cell's frame value
among the sorted distinct values of that axis across the grid's images. That
reproduces `parseTiles`' array without needing the post-reload dataset, and it
keeps the label (`rank + 1`) consistent with where the slider lands.

## Components

- **`src/utils/unroll.ts`** (new, pure, unit-tested): `getUnrollCells(images,
  flags)` → `{ index, label, location: { xy?, z?, time? } }[]`. Holds the
  ranking and label-formatting rules; no GeoJS, no store.
- **`src/components/ImageViewer.vue`**: renders the labels as GeoJS
  `dom` widgets on a ui layer, one per cell, positioned with a gcs
  `{x, y}` position so GeoJS repositions them on pan and zoom (its `zoom()`
  ends in a `pan()`, so the `geo_event.pan` handler widgets bind covers both).
  A `domWidget` stops `mousedown` propagation, so a label click cannot reach
  the GeoJS interactor and start an annotation. Labels are rebuilt only when a
  signature (labels + grid width + cell size) changes, and are created on every
  map so the multi-map `layerMode: "unroll"` view labels each grid.
- Navigation handler lives in `ImageViewer.vue` next to the widget code and
  calls the existing store actions (`setXY`/`setZ`/`setTime`,
  `setUnrollXY`/`setUnrollZ`/`setUnrollT`).

## Bounds

Grids larger than 400 cells get no labels: one DOM node per cell repositioned
on every pan stops being reasonable, and at that density the text is unreadable
anyway.

## Testing

- Unit (`src/utils/unroll.test.ts`): ranking with dense and sparse axis values,
  `PositionZ` fallback, single- and multi-axis labels, empty input.
- Browser: unroll XY on the `normmedia…` dataset, confirm corner labels on each
  cell, click one and confirm the view returns to the rolled single frame at
  that XY (slider value, URL query) with no annotation created.
