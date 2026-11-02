# Dataset location (XY / Z / T indices)

The viewer's location is `store.xy`, `store.z` and `store.time`: slider indices
into `dataset.xy`, `dataset.z` and `dataset.time`. An index past the end makes
every `dataset.images(...)` lookup at the current location miss. Raw snapshot
export then failed with "Image not found for channel …" (issue #1388, PR #1389).

## Where the location comes from

- A `?xy=&z=&time=` query (deep links, and the breadcrumb view switcher, which
  keeps the current query when it moves to another dataset).
- The dataset view's saved `lastLocation`.
- The navigator sliders, unrolled grid cells, snapshot restore, annotation
  navigation and the AI panel, all through `setXY` / `setZ` / `setTime`.

## How it is kept valid

- **One clamp, where the dataset lands.** `clampLocationToDatasetImpl` runs in
  `setSelectedDataset` right after the dataset commits, and at the end of
  `setDatasetViewId` for a view switch that keeps the dataset. Consumers do not
  guard their own lookups.
- **Setters clamp only against a settled dataset.** While a view loads,
  `this.dataset` is still the *outgoing* dataset. The setters read
  `locationDataset`, which is null while `sync.datasetLoading` is set, so a deep
  link valid for the incoming dataset is not cut to the outgoing one's size.
- **Unrolled axes are not clamped.** Unrolling collapses an axis to one entry,
  and rendering ignores the index of a one-entry axis. The value there is the
  frame to return to: a grid cell (and snapshot restore) sets it just before
  clearing the unroll flag, and the reload that rolls the axis up clamps it
  against the real dimensions.
- **"Unrolled" means the loaded dataset's shape, not the live flags.**
  `store.unrollZ` changes on click, but `this.dataset` only follows when its
  refresh lands, and a stale refresh can land after the flag has flipped back.
  `setSelectedDataset` records the flags each dataset was fetched with in
  `datasetUnroll`, and every clamp reads that.
- **The view-switch clamp only runs against the view's own dataset.** If the
  new dataset fails to load, `this.dataset` is still the previous one.
- **Saves are debounced, checked and flushed.** `updateLastLocationInDatasetView`
  schedules a save 5 s out. `saveLastLocationInDatasetView` only writes when
  the loaded dataset matches `datasetView.datasetId` and nothing is loading, and
  it skips a write equal to the saved value. Anything that replaces the view
  (`setDatasetViewId`) or the dataset (`setSelectedDataset`) flushes the pending
  save first, while the two still match. Every clamp site schedules a save.

## Camera deep links (`?x=&y=&zoom=&width=`)

`#/datasetView/<viewId>/view?xy=0&z=3&time=0&x=1520&y=860&zoom=6` opens the
view on frame (0, 3, 0) centered on image pixel (1520, 860). External tools
(the MCP server) use it to link straight to an object.

- **`x`, `y`**: full-resolution image pixel coordinates, origin top-left, y
  down: the coordinates annotations are stored in, so an annotation centroid
  can be used as is. Both are required; fractional values are fine. On an
  unrolled view the point is taken within the cell of the current
  `xy`/`z`/`time`, as annotation navigation does.
- **`zoom`**: optional GeoJS zoom level, the same number `store.cameraInfo.zoom`
  holds. At `zoom = maxLevel` of the image's tile pyramid one image pixel is one
  screen pixel; each step up or down doubles or halves the magnification.
  Without it the viewer zooms so `width` image pixels (a positive number, for
  callers such as the MCP server that know a region but not the map's
  pyramid), else about 512 (`DEFAULT_DEEP_LINK_VIEW_WIDTH`), span the
  viewport's width. Either way the zoom is clamped to the map's zoom range.
- **Invalid values are ignored.** A missing, empty, non-numeric or non-finite
  `x` or `y` opens the view as if neither were given (fitted to the image as
  usual); an invalid `zoom` or `width` falls back to the default.

How it flows (`src/utils/cameraDeepLink.ts` parses; the store and ImageViewer
apply):

1. `setDatasetViewId` parses `routeQuery` before its first `await`, clears any
   target an earlier navigation left unapplied, and once the view is fetched
   stores `pendingCameraDeepLink` tagged with the view's `datasetId`.
2. ImageViewer applies it only when it is not loading, `store.dataset` is the
   tagged dataset (while a view loads, `store.dataset` is the outgoing one) and
   the fit-to-image for that dataset has run. On a new dataset the fit watcher
   applies it right after its fit; on an unchanged dataset a watcher applies it
   when loading ends. It zooms, centers map 0, and syncs `cameraInfo`, so
   every map in a multi-map layout follows.
3. Applying clears the target, so it runs once per navigation, and
   `DatasetView.vue` then removes the camera keys from the URL (`router.replace`),
   so a reload or a copied URL keeps where the user moved to instead of jumping
   back to the linked point.
4. Changing only the camera keys on the open view (`DatasetView.vue` watches
   them) re-targets it through `requestCameraDeepLink`.
5. The breadcrumb view switcher keeps `xy`/`z`/`time` but drops the camera
   keys, since the point belongs to the view being left.

Without these keys nothing changes: the view opens fitted to the image.

## Regression checklist

Run `pnpm test src/utils/datasetLocation.test.ts src/store/__tests__/datasetLocationClamp.test.ts src/utils/cameraDeepLink.test.ts src/store/__tests__/cameraDeepLink.test.ts src/components/ImageViewer.test.ts`.

### Clamping

- [ ] **A deep link past the dataset's size is clamped on load.** — *"clamps a deep-linked location past the dataset's dimensions on load"*
- [ ] **Setters never clamp against the outgoing dataset.** A deep link that only fits the incoming dataset survives the switch. — *"keeps a deep link that is valid for the incoming dataset but not the outgoing one"*
- [ ] **A view switch on the same dataset still clamps**, since `setSelectedDataset` is skipped there. — *"clamps a saved lastLocation when the dataset does not change"*
- [ ] **Setters clamp once the dataset is settled**, including NaN and negative input. — *"clamps setXY/setZ/setTime once the dataset is loaded"*
- [ ] **Unrolled axes keep their target through the roll-up.** Clamping them against the collapsed one-entry axis sent every grid-cell click and rolled-up snapshot restore to frame 0 (Codex round 3). — *"keeps a target set on an unrolled axis through the roll-up"*, *"leaves unrolled axes alone, since unrolling collapses them to one entry"*

- [ ] **Clamps follow the loaded dataset's shape, not the live unroll flags.** Toggling unroll on then off before the first refresh landed reset z to 0 (regression review). — *"keeps the location when a stale unrolled refresh lands after unroll is turned off"*
- [ ] **A failed load does not clamp against the previous dataset.** — *"does not clamp against the previous dataset when the new one fails to load"*

### Persistence

- [ ] **The clamped value is what gets saved**, so a view stops reopening out of range. — *"persists the clamped location, not the out-of-range one"*
- [ ] **Every clamp site schedules a save.** A refresh outside a view load (large-image change) clamped without saving (Codex round 1). — *"persists a location clamped by a dataset refresh outside a view load"*
- [ ] **Replacing the view flushes the pending save into the view being left.** — *"saves a pending location into the view being left, not the next one"*
- [ ] **Replacing the dataset flushes too.** `Dataset.vue` switches datasets with the old view still loaded, and the save was then rejected as a mismatch (Codex round 2). — *"saves a pending location before a direct dataset switch replaces the dataset"*
- [ ] **Nothing is saved mid-load**, when the location may still be an unchecked query value. — *"does not save a location while the dataset is still loading"*

### Camera deep links

- [ ] **Invalid coordinates are ignored, an invalid zoom falls back.** — *"returns null unless both x and y are finite numbers"*, *"ignores an invalid zoom but keeps the point"*
- [ ] **The target is tied to the incoming view's dataset**, never the outgoing one still loaded. — *"ties the target to the incoming dataset while the outgoing one is still loaded"*, *"does not center the outgoing dataset on a link for the incoming one"*
- [ ] **A navigation without a target clears an unapplied one.** — *"clears an unapplied target when a new navigation has none"*
- [ ] **It centers after the dataset's fit, never before** (the fit would undo it). — *"centers on the link after the dataset's fit, not before"*
- [ ] **It applies once per navigation.** — *"applies once: a later fit or frame change does not re-center"*
- [ ] **A same-dataset view switch still applies it**, when loading ends. — *"waits for loading to end when the dataset is unchanged"*
- [ ] **The view switcher drops the camera keys.** — *"goToView keeps the location but drops a camera deep link"*
- [ ] **A link can size the view by image width**; an explicit zoom wins. — *"shows a link's width, and its zoom wins over it"*
- [ ] **Applied keys leave the URL**, so a reload keeps where the user moved. — *"drops the camera keys once a target stops pending"*, *"leaves the URL alone while pending or without camera keys"*

### Known limitation

A clamp that runs inside a URL→store sync (a deep link like `?time=99` on a
10-frame dataset) is not written back to the URL: the route mapper suppresses
store→URL writes while it applies the URL. The URL keeps 99 while the store
holds 9, and a later route change re-applies 99, which clamps to 9 again. If
the dataset later gains frames (a large-image switch), that re-application
lands on frame 99. On master the store held the out-of-range 99 throughout.

### Test traps this feature proved

- A save scheduled by the view load stands in for the one under test. Drain the
  timers before the action you are checking, or the test passes against the
  unfixed code.
- The save clamps its own value, which can mask a missing guard. Use an
  in-range location when testing a guard, so only the guard can stop the save.
- `setSelectedDataset` reads the unroll flags after its first `await`. Two
  refreshes started in the same tick both see the final flags, so a test of a
  stale refresh must let the first fetch start before flipping the flag.
- lodash `debounce` captures the real `setTimeout` at import and ignores vitest
  fake timers, which is why the save delay is a plain module-level timer.

### Verified in-browser

Real clicks from a fresh page load: the repro URL (1×1 dataset at `?xy=12&z=3`)
opens at 0/0/0, raw download works, and the server's saved `lastLocation`
matches. The dataset-switch flush was also checked live with the fix
reverted, and the server value then went stale.
