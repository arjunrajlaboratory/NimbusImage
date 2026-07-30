# Navigating to annotations on the unrolled grid

Issue #1280. Clicking an Object Browser row while an axis was unrolled panned the
camera to the annotation's **raw** centroid, while the viewer had drawn that
annotation at its **unrolled** position — one or more tile-widths away. The user
landed on the equivalent spot of the *first* tile and saw nothing there.

Measured on `normmedia_8well_col2_livecellgfp` (4 timepoints, tile 1024, `unrollT`
on, grid 2×2), clicking the row for a Time-4 object:

| | before | after |
|---|---|---|
| Where GeoJS drew it | (1404, 1402) | (1404, 1402) |
| Where the camera went | (380, 380) | (1404, 1402) |
| Error | one tile diagonally | none |

## The three coordinate spaces

`ingcs` vs `gcs` is the well-known split (see the `nimbus-geojs` skill). Unrolling
adds a third: while any of `unrollXY` / `unrollZ` / `unrollT` is on, every frame
along that axis is drawn side by side and each annotation is offset by the grid
cell its frame occupies.

```
drawn.x = sizeX * (cell % unrollW) + raw.x        cell = the frame's keyOffset
drawn.y = sizeY * floor(cell / unrollW) + raw.y
```

A stored centroid (`annotationCentroids[id]`, `simpleCentroid(coordinates)`,
`stub.centroid`) is therefore **not** a position on the map. Comparing one against
anything in map space — `evt.geo`, `cameraInfo.center`, `gcsBounds`, a drawn lasso,
`map.bounds()` — is the bug.

## Structure of the fix

The offset math was inline in `AnnotationViewer.vue` and depended on `unrollW`,
which lives as a `ref` in `ImageViewer.vue` and reaches the viewer only as a prop —
so a util could not reach it, which is why the two paths drifted.

- `src/utils/unroll.ts` holds the geometry, pure and store-free: `unrollGridSize`
  (the **only** copy of the layout formula), `unrollCellIndex`, `unrollCellOffset`,
  `unrollLayoutFor`, `unrolledCoordinates`, `unrolledPoint`.
- `ImageViewer.draw()` assigns its `unrollW` / `unrollH` refs from `unrollGridSize`.
- `store.unrollGrid` mirrors it off the same `layerStackImages` entry, so navigation
  — which has no access to the component — gets the same grid by construction.
- Both callers build an `IUnrollLayout` via `unrollLayoutFor` and hand it to the
  same transform: `AnnotationViewer`'s `unrollLayout` computed for the draw path,
  `annotationNavigation`'s `currentUnrollLayout()` per navigation.

The layout is built **once per draw**, not once per annotation. `unrolledCoordinates`
runs for every annotation on every draw, so constructing a layout inside it allocates
two objects per annotation — including on the un-unrolled path, which is supposed to
allocate nothing at all. (This was caught in review after being written the wrong way
first; hence the counting test below.)

### Why `AnnotationViewer` keeps using the prop

`unrollLayoutFor` takes `unrollW` as a parameter precisely so the two callers can
differ, deliberately:

- **Navigation** passes `store.unrollGrid.unrollW`.
- **The viewer** passes `props.unrollW`, for two reasons. It keeps drawing keyed to
  the grid `ImageViewer` last laid the tiles out on, and it keeps
  `unrolledCentroidCoordinates` — a computed over *every* annotation — off
  `layerStackImages`, which rebuilds tile URLs and invalidates on every contrast
  tweak. Routing the draw path through `store.unrollGrid` would rebuild the whole
  centroid map on every contrast drag.

They are the same number because both come from `unrollGridSize` over the same
`layerStackImages.find(lsi => lsi.images[0])` entry.

### `goToConnection`: "same frame" was the wrong test

It only framed both endpoints when they shared a frame, on the grounds that two
frames can't both be displayed. That is false while unrolling — all frames are on
screen and a cross-time connection is genuinely drawn as a line between tiles. The
gate is now per-axis `unrolled || indices match`, and the framing uses the drawn
positions, so a cross-tile span comes out tile-widths wide instead of collapsing to
the distance between two raw centroids.

## Regression checklist

Run `pnpm test src/utils/unroll.test.ts src/utils/__tests__/annotationNavigation.test.ts src/components/AnnotationViewer.test.ts src/components/AnnotationBrowser/AnnotationList.test.ts`.

There are **three** navigation entry points and they must stay consistent:
`goToAnnotationLocation`, `goToConnection`, and `goToTrack`. The third arrived from
#1288 *after* this fix was written and carried the identical defect — which is the
argument for the shared `@/utils/unroll` helpers rather than three local fixes.
Anything added here later needs the same treatment.

### Navigation aims at drawn positions

- [ ] **Recentring uses the cell-offset centroid, not the raw one.** The whole
      defect. — *"centres on the tile-offset centroid, not the raw one"*
- [ ] **Row wrapping is right, not just column wrapping.** A cell past the last
      column offsets in *both* axes; an x-only fix passes a 1×N grid and fails a
      2×2 one. — *"wraps onto the next grid row past the last column"*
- [ ] **Cell 0 and the un-unrolled case are untouched.** The raw centroid *is* the
      drawn position there, and this must not regress the pre-existing Objects-tab
      behaviour. — *"leaves the centroid alone for a frame on the first cell"*,
      *"does not offset when unrolling is off"*
- [ ] **The offset is computed after the frame is set**, so the grid is the one
      being navigated to rather than the one being left.

### Connection framing

- [ ] **Cross-frame endpoints are framed when the differing axis is unrolled.** —
      *"frames cross-time endpoints while time is unrolled"*
- [ ] **A difference on a *rolled* axis still declines to frame.** Unrolling T does
      not put two Z slices on screen. Testing only the unrolled-axis case would let
      a blanket "always frame" pass. — *"still declines to frame when the endpoints
      differ on a rolled axis"*
- [ ] **The span is signed and measured between drawn positions**, not raw ones. —
      *"passes the SIGNED endpoint delta to frameCameraInfo"*

### Track framing (`goToTrack`, merged in from #1288)

`goToTrack` has **three** separate predicates that all encode "which members are
drawn" — the slice filter, the bounding box, and the time window — and all three
assumed a single frame is on screen. Two are relaxed by one rule: *an unrolled axis
never disqualifies a member, and positions are the drawn ones.*

The third is the trap: the time window is **not** relaxed, because the timelapse
overlay keeps windowing even when every frame is displayed. "Unrolled ⇒ everything
is displayed" holds for the base annotation layer and *not* for the timelapse layer,
so the rule to apply is "match what the draw path actually does", not "unrolled means
everything". Every item below has a paired control, because a blanket relaxation
would pass the unrolled assertion alone.

- [ ] **The box spans cells for a cross-time track while T is unrolled.** —
      *"frames the drawn box, spanning cells for a cross-time track"*, with
      *"does not collapse the box to the raw centroids"* pinning the pre-fix value
- [ ] **The time window is NOT relaxed for `unrollT`** — the one rule unrolling
      leaves alone. The timelapse overlay
      (`drawTimelapseConnectionsAndCentroids`) filters segments and dots to
      `currentTime ± modeWindow` whatever the unroll state, so exempting the flag
      here frames a track with no track drawn on it. Caught in review after being
      written the wrong way round. — *"still snaps Time when unrolled, because the
      overlay still windows"*, with *"leaves Time alone when a member is inside the
      window, unrolled"* proving it is "match the overlay" and not "always snap"
- [ ] **Rolled time snaps identically**, so the rule is not conditioned on the flag
      at all. — *"snaps Time the same way when time is NOT unrolled"*
- [ ] **Other-Z members are included when Z is unrolled**, at their drawn positions. —
      *"includes other-Z members when Z is unrolled"*
- [ ] **…but a cross-slice track is still framed to the anchor slice when Z is
      rolled**, because the other slices genuinely aren't drawn. —
      *"still frames only the anchor slice when Z is NOT unrolled"*

### Grid layout

- [ ] **`unrollGridSize` stays the only copy of the formula.** `ImageViewer` and
      `store.unrollGrid` must both go through it; a second copy is how navigation
      and rendering drift again. — *"lays %i square frames out %ix%i"* (the
      historical values of the inline formula it replaced)
- [ ] **Non-square frames get fewer columns.** A wide frame stacks into rows sooner;
      only testing square tiles hides an aspect-ratio mistake. — *"gives a wide
      frame fewer columns"*
- [ ] **Degenerate inputs fall back to 1×1.** Mid-load, no frame has a size yet; a
      zero width makes the cell offset `NaN` and puts the camera nowhere. —
      *"falls back to 1x1 for (%i, %i, %i)"*

### Cost

Nothing in this group has a visible symptom, which is exactly why each one needs a
test: every item here regressed or nearly regressed while the feature was being
written, and no assertion about *positions* can see any of them.

- [ ] **The un-unrolled path allocates nothing.** It runs per annotation per draw;
      `unrolledCoordinates` must return the *same array* it was given. — *"returns
      the very same array when nothing is unrolled"*
- [ ] **One layout per draw, not one per annotation.** Building an `IUnrollLayout`
      inside the transform costs two objects per annotation, on the un-unrolled
      path too. Asserted as "does not scale with annotation count", because the
      layout is a computed and the absolute number of evaluations per mount is
      incidental. — *"builds a layout per draw, not per annotation"*
- [ ] **`unrolledCentroidCoordinates` does not depend on `layerStackImages`.** It
      would silently turn every contrast drag into a full rebuild of the centroid
      map. Guarded by the viewer taking `unrollW` from its prop. — *"takes its grid
      from the unrollW prop"*

### Test-fixture traps this feature proved

- [ ] **`mockedStore.unroll` must be DERIVED from the three flags.** It used to be
      an independent field in `AnnotationViewer.test.ts`, so setting `unrollXY`
      alone left `unroll` false — the component's filtering saw an unrolled axis
      while its coordinate transform did not, a state the real store cannot be in.
      Two tests passed only because of it.
- [ ] **Do not stub `unrollIndexFromImages` when testing unroll geometry.**
      `annotationNavigation.test.ts` mocks `@/utils/annotation` for
      `simpleCentroid`; a fixed-value stub of `unrollIndexFromImages` in the same
      mock makes every cell-offset assertion pass for the wrong reason. It is
      spread in from `importOriginal` on purpose.
- [ ] **Any store mock reaching `goToAnnotationLocation` needs `unrollGrid` and the
      unroll flags**, or navigation throws on `store.unrollGrid.unrollW`
      (`AnnotationList.test.ts`).
- [ ] **`@/utils/unroll` is mocked in `AnnotationViewer.test.ts` with
      `importOriginal` spread**, wrapping only `unrollLayoutFor` so the counting
      test can see it. Keep the real geometry: stubbing more of that module would
      make the offset assertions meaningless. Note the file uses
      `vi.clearAllMocks()`, which preserves the spy's implementation —
      `resetAllMocks` would strip it and silently return `undefined` layouts.

### Verified in-browser, not just in unit tests

The unit tests mock the store, so they cannot prove `store.unrollGrid` equals the
grid `ImageViewer` actually laid out. Confirm live (see the `in-browser-testing`
skill): unroll an axis, click a row for an object on a later tile, and check the
camera against what GeoJS holds —

```js
layer.annotations().find(a => a.options('girderId') === id).coordinates()[0]
store.state.main.cameraInfo.center     // must match
```

## Still raw: the hit-testing family (not fixed here)

The same shape survives elsewhere, pre-existing and out of scope for #1280. The
annotation spatial index (`annotationSpatialIndex`, `buildAnnotationBBox`) is built
from raw centroids while its queries come from map space, so while unrolled:

- click / shift-click selection, hover highlight and the right-click menu hit-test
  raw coordinates (`AnnotationViewer.vue` `shouldSelectAnnotation`,
  `setHoveredAnnotationFromCoordinates`);
- the alt-drag ghost is drawn at raw coordinates (the *save* is fine — it applies
  only a delta);
- the viewport hydration partition (`partitionByViewports`) compares raw centroids
  against `gcsBounds`, so on a stub-mode dataset every current-frame annotation can
  classify as `outside` and the drawn set collapses to a sample;
- the agent's `set_camera` with `fit: "annotations" | "selection"` frames cell 0.

Confirmed live on `normmedia_8well_col2_livecellgfp`: clicking an object drawn in
cell 1 hovers nothing, and clicking the empty equivalent spot in cell 0 hovers that
object. The drawing tools are not affected — `setNewAnnotationMode` sets the
interaction layer's mode to `null` while unrolled, so nothing can be drawn.
