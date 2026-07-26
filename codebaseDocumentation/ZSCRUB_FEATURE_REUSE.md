# Z-scrub feature reuse — change writeup (current state)

Branch: `feature/stub-annotations`. This is the reviewer's guide and the
current-state record for the annotation-render performance work: what changed, why,
the correctness reasoning, the two bugs found and fixed while reviewing/testing it,
the measured effect, what it deliberately does NOT solve, and the one open decision.

**Changed files (all uncommitted on the branch):**

- `src/components/AnnotationViewer.vue` — the optimization + both bug fixes.
- `src/utils/annotation.ts` — the extracted `shouldRetainFeature` skip predicate.
- `src/components/AnnotationViewer.test.ts` — round-trip reuse tests, the
  frame-index redraw integration test, the `gcs` re-add assertions, and the
  "marks layer modified" render regression test.
- `src/utils/__tests__/annotationStubUtils.test.ts` — `shouldRetainFeature` units.
- `codebaseDocumentation/PERFORMANCE_PROBE.md` — perf-loop record.
- `codebaseDocumentation/FRONTEND_COMPONENT_TESTING.md` — the test-harness mechanics
  these tests rely on.

## TL;DR

Scrubbing Z on large stub-mode datasets (HCR fixture: ~26k annotations on z=3 and
z=4) froze the main thread ~87 ms per z-change. The cost was **reconstructing
every visible GeoJS feature** on each frame change. This change **reuses
torn-down feature objects** instead of rebuilding them, and **removes a wasted
extra draw** per frame change.

- Warm-median `maxBlock` (HCR z3↔z4 probe): **~87 ms → ~68 ms** (clean A/B).
- Warm per-frame draw: **~77 ms → ~33 ms** — the reconstruction is eliminated.
- Timelapse pan/zoom: **0 ms** (unchanged); time-scrub maxBlock **0**.
- **Two rendering bugs found while testing this and since fixed** (both verified
  live in-browser): the zoom-in→out coordinate drift and the scrub-through-empty-
  frames disappearance — see [Bugs found and fixed](#bugs-found-and-fixed-during-review--testing).
- `pnpm tsc`, `pnpm lint:ci`, `pnpm test` (2446, incl. 12 new): pass.
- Did **not** reach a strict ≤40 ms target — see [Limitations](#limitations).

## Status and open decisions

**Done and verified:** the optimization (Parts 1–2), all review follow-ups, and
both bug fixes are in the working tree; tsc/lint/tests are green and both bugs were
confirmed fixed live on the HCR dataset.

**Open decision — keep or drop the retained-feature cache (Part 1).** The cache is
the higher-risk half: it delivered the reconstruction win (~77 → ~33 ms warm draw)
but it is also what caused the coordinate-drift bug, it relies on a private GeoJS
re-add contract, and it holds up to ~60k extra feature objects. Weigh that against a
*partial* win (`maxBlock` still ~68 ms, over the 50 ms longtask line) and the fact
that the proper fix (per-frame layers, see [Future work](#future-work-to-reach-40-ms))
would supersede it. **Note:** the scrub-disappearance bug is NOT a reason to drop the
cache — it lives in the shared draw path and reproduces with or without the cache.
Part 2 (removing the wasted leading draw) is low-risk and worth keeping regardless.

**Open question — memory bound on 700k-annotation datasets** (heap already ~480 MB
there); the cap is now `ceil(maxVisible * 1.2)` ≈ 60k — lower
`RETAINED_FEATURE_MULTIPLE` if memory is tighter than reuse value.

## The problem

On a frame change (Z/Time/XY), the visible annotation set turns over completely.
The draw lifecycle (`drawAnnotationsNoThrottle`) then:

1. `clearOldAnnotations(false)` — diffs current features vs the new
   `layerAnnotations`; on a frame change nearly all are stale, so it takes the
   **bulk-clear** branch (`removeAllAnnotations`).
2. `drawNewAnnotations` — calls `createGeoJSAnnotation` for **every** visible
   annotation, rebuilding the GeoJS annotation object + geometry.

Measured live (zoom 0, ~8k visible): `createGeoJSAnnotation` ≈ **51 ms**,
add + GL draw ≈ 26 ms. At zoom 2 (~26k visible): ≈ 194 ms + 108 ms. The
construction is the dominant, eliminable cost.

## The change

### Part 1 — retained-feature LRU (skip reconstruction)

New module-scope state in the component:

- `retainedFeatures: Map<"layerId|girderId", IGeoJSAnnotation>` — torn-down GeoJS
  feature objects, keyed **per (layer, annotation)**. Map insertion order is the
  LRU order. The cap is `retainedFeatureLimit()` =
  `ceil(visibilityConfig.maxVisible * 1.2)` — derived from the live visible-set
  cap rather than a fixed literal, so the bound stays consistent if that cap is
  reconfigured (≈ 60k at the default 50k cap, preserving the previously-tuned
  value).
- `retainedStyleToken` — `` `${getStubScaled()}|${store.annotationOpacity}` ``,
  the global style inputs that `drawnFeatureUnchanged` does **not** check. Note
  `getStubScaled()` reads `unitsPerPixel(0)` at the **fixed** zoom level 0, so it
  is constant across zoom — GeoJS rescales dots with zoom via the `scaled` style
  at render time, so reuse across zoom levels needs no re-bake and the token does
  **not** change on zoom (it moves only on a map/dataset re-init). Opacity is the
  only component that varies in practice, and it is **also** covered by
  `onRestyleNeeded` (the `baseStyle` watch); the token is defense-in-depth, not
  the sole invalidation path for it.

Lifecycle hooks:

- **`clearOldAnnotations`** now calls `retainRemovedFeatures(...)` before removing
  features (both the bulk and incremental branches), stashing the removed
  features into the LRU. The skip list — connections and special/in-progress
  features — lives in the pure, unit-tested `shouldRetainFeature(options)` helper
  in `src/utils/annotation.ts`; the current edit annotation is excluded
  separately by object identity (not expressible from options alone).
- **`drawNewAnnotations`** now calls `takeRetainedFeature(...)` before falling
  back to `createGeoJSAnnotation`. A cached feature is reused only if it passes
  `drawnFeatureUnchanged` (layer exists, same color, same stub-ness, same
  geometry key) for the *current* render data. Reused features are pushed into
  `drawnGeoJSAnnotations` so the existing hover/selection restyle pass updates
  them.
- **Style-token gate**: `syncRetainedStyleToken()` runs at the top of
  `drawNewAnnotations` and inside `retainRemovedFeatures`. If the token changed
  (in practice: an opacity change — `getStubScaled()` is zoom-independent, see
  above), the whole cache is dropped, so a reused feature can never carry a stale
  baked opacity. This is a redundant safety net for opacity (already cleared by
  `onRestyleNeeded`); it costs nothing and removes any dependence on watcher
  ordering.

Why **per-annotation**, not per-frame: a frame change fires the draw lifecycle
**twice** (a leading draw against the stale visible set, then the heavy draw once
`visibleAnnotationIds` lands), and fast scrubs coalesce draws via the 100 ms
throttle. A per-frame cache only achieved partial reuse under that timing. Keying
by annotation id makes reuse independent of frame/draw timing: whatever was
removed is reused whenever its id is drawn again.

### Part 2 — remove the wasted leading draw

The "Primary change" watcher previously fired on `[annotationConnections, xy, z,
time, shouldDrawAnnotations, shouldDrawConnections]`. `xy/z/time` were removed.

A frame change already updates `visibleAnnotationIds` (via the `updateVisibility`
watcher), which flows `layerAnnotations → displayedAnnotations →
onDisplayedAnnotationsChange → draw`. Drawing *also* from `onPrimaryChange`
produced a **leading draw against the stale (pre-update) visible set** — it
rendered an empty/incorrect frame for a beat and forced `layerAnnotations` to
recompute twice per frame change. Removing the frame indices makes a frame change
draw **once**, with the correct set.

### Cache invalidation (correctness)

`clearRetainedFeatureCache()` (clears `retainedFeatures`) is called from:

- `onRestyleNeeded` — baseStyle / layer color / tool-highlight changes alter baked
  appearance in ways the per-feature check doesn't cover.
- `onUnrollChanged` — unroll changes which frames a draw spans.
- the `props.annotationLayer` watcher — a rebuilt layer (dataset reset) must not
  receive dead feature objects from the old layer.
- `onBeforeUnmount`.

The cache is also **disabled entirely** (`isFrameCacheEnabled() === false`) when
unrolling or any visible layer uses `max-merge` on any axis. Unroll genuinely
breaks it: the unroll grid offset makes a feature's rendered coordinates
frame-dependent. Max-merge is more conservative than strictly necessary — because
keying is **per (layer, annotation)** and every reuse is revalidated by
`drawnFeatureUnchanged`, per-annotation reuse would likely be sound there too; but
in max-merge the visible set no longer turns over per frame, so retention buys
little, and we disable it rather than reason about the merged-set bookkeeping.

## Correctness invariants

- **Identical rendered set at any Z.** A cached feature is reused only when it is
  in the current `layerAnnotations` for its layer (the `drawNewAnnotations` loop
  only considers ids in that map) AND passes `drawnFeatureUnchanged` + the style
  token. Otherwise it is reconstructed. Verified live: GeoJS layer feature count
  `==` displayed-id count at each Z, on z3 / z4 / z3-again.
- **No stale geometry.** `drawnFeatureUnchanged` compares `geometryKeyForRender`
  of the live data against the cached feature's baked `geometryKey`, so an
  in-place edit (drag/polygon-slice) rejects the cached feature. The stub↔hydrated
  transition is caught by the `isStub` check.
- **Hover/selection not stale.** Reused features go through the existing restyle
  pass (`drawNewAnnotations`), which re-applies hover/selection style when it
  differs from the baked state.
- **No cross-frame leak.** Reused features come only from
  `layerAnnotations.get(layerId)` for the current frame; features for other
  frames stay in the cache (not added to the layer) until reused or evicted.
- **Reuse is safe in GeoJS.** `removeAnnotation` calls `annotation._exit()`, which
  for the base annotation only detaches a cursor mousemove handler (no subtype
  overrides it destructively) — so a removed annotation object retains its
  coordinates/options/state and can be re-added.
  **This is a private GeoJS contract pinned to `geojs ^1.19.1`** (see the comment
  on `retainRemovedFeatures`). If a future upgrade makes `_exit` (or a subtype
  override) free renderer state, reused features could render/hit-test wrong with
  no failing unit test — re-verify the scrub-back path on any GeoJS bump. The
  cache **logic** (retain-on-remove, reuse-or-reject-on-redraw) is guarded by the
  round-trip tests in `AnnotationViewer.test.ts`, but those run against the
  GeoJS mock and so do not exercise the real `_exit` behavior.
- **Coordinates must not be re-converted on re-add** (bug fixed after first review).
  `annotationLayer.addAnnotation` runs `annotation._convertCoordinates(ingcs, gcs)`
  on **every** add (the NimbusImage image map has `ingcs !== gcs` — a y-flipped/
  scaled pixel system from `geojs.util.pixelCoordinateParams`). A freshly-created
  feature holds ingcs coordinates and must be converted once; a **reused** feature
  was already converted to gcs on its first add, so re-adding it with the default
  ingcs gcs converts it a **second** time and drifts it off the image — worsening on
  every zoom-out that re-adds it (symptom: annotation dots rendering in bands above/
  below the image after zoom in → out). Fix: `drawNewAnnotations` adds fresh
  features with `addMultipleAnnotations(fresh, undefined, …)` (ingcs → convert) and
  reused features with `addMultipleAnnotations(reused, null, …)` (map gcs → **no**
  convert). Guarded by the `toHaveBeenCalledWith([...], null, …)` assertions in the
  round-trip tests (the visual drift itself can't be reproduced against the mock,
  which doesn't model coordinate conversion — verify in-browser on a GeoJS bump).

## Memory

The cache holds roughly the off-screen frames' worth of features on top of the
live layer — i.e. it ~doubles peak feature-object count during a scrub. Bounded by
`retainedFeatureLimit()` = `ceil(visibilityConfig.maxVisible * 1.2)` (≈ 60k at the
default 50k cap), LRU-evicting oldest first. Deriving from `maxVisible` (rather
than a fixed literal) keeps the bound proportional to the live visible-set cap if
that cap is ever reconfigured. The trim is `O(overflow)`, not `O(size)`: it evicts
only the surplus via `keys().next()` rather than materializing the full key set on
the hot path. On the 52k HCR dataset the app heap moved ~165 → ~190 MB.
**Still open for the reviewer:** confirm the bound on the 700k-annotation datasets
(heap already ~480 MB there); lower `RETAINED_FEATURE_MULTIPLE` if memory is
tighter than reuse value.

## Measured results (clean back-to-back A/B, same machine)

| Scenario | Baseline | This change |
|---|---|---|
| HCR z3↔z4 warm-median `maxBlock` | ~87 ms (tight 82–91) | **~68 ms** |
| HCR warm per-frame draw | ~77 ms | **~33 ms** |
| Timelapse pan / zoom `maxBlock` | 0 ms (120 fps) | **0 ms** (120 fps) |
| Timelapse timeScrub `maxBlock` | 0 ms | **0 ms** |

Evaluator: `__nimbusPerf.run({scenarios:[['zScrub',{zs:[3,4],cycles:4}]]})` in a
**foreground** tab (see `PERFORMANCE_PROBE.md`). Numbers are warm medians; the
session's heavy browser load (100+ tabs → GC) inflated absolute readings, so trust
the A/B delta over absolutes.

## Limitations

`maxBlock` did not reach a strict ≤40 ms. With reconstruction eliminated, the
residual per-Z work is `updateVisibilityAndHydration` (~17 ms) + `layerAnnotations`
recompute (~4 ms) + the add/GL-rebuild of ~8k features (~28 ms), which bundle into
one ~50–68 ms task. The GeoJS GL buffer is rebuilt because features leave and
re-enter the layer; **`annotationLayer._update` rebuilds all feature data on any
layer modification — there is no cheap per-feature visibility flag**, so the
goal's literal "toggle visibility to skip the rebuild" cannot be done within a
single annotation layer.

`maxBlock` from the probe is longtask-quantized (0 below 50 ms, then ≥50), so the
residual sits right at the threshold and reads bimodally.

Rejected alternative: deferring the redraw to a macrotask (rAF/`setTimeout`) does
push `maxBlock` median to ~0 by splitting the long task, but it worsened
worst-frame time (~80–100 ms) and grew heap — net worse real-world behavior, so it
was not taken.

## Future work to reach ≤40 ms

Keep each recently-visited frame's features in its **own** annotation layer and
toggle `layer.visible()` on frame change. GeoJS gates `_update` on a timestamp, so
a hidden→shown layer with unchanged data is **not** rebuilt — this genuinely skips
the GL rebuild. It's a core-rendering refactor: hit-testing, hover, selection,
editing, and connection drawing all currently assume the single
`props.annotationLayer` and would need to route through a per-frame active layer.

## Review checklist

- [x] Reuse correctness: any input that changes a feature's baked appearance but
  isn't covered by `drawnFeatureUnchanged` (color/stub/geometry) + the style token
  (opacity; `getStubScaled()` is constant) + the full-cache-clear triggers
  (`onRestyleNeeded` for `baseStyle`/layer-color/tool-highlight, layer-swap,
  unroll)? Traced: per-annotation color → `drawnFeatureUnchanged`; layer color →
  `store.layers` returns a fresh array → `layers` watch → `onRestyleNeeded`;
  radius/scaleWithZoom/opacity → `baseStyle` watch. No uncovered input found.
- [x] `retainRemovedFeatures` skip list complete? Extracted to the unit-tested
  `shouldRetainFeature` (connections, special, missing identity) + the
  caller's current-edit-annotation identity check.
- [ ] Memory bound acceptable on 700k datasets — **still open** (now
  `ceil(maxVisible * 1.2)`; tune `RETAINED_FEATURE_MULTIPLE` down if needed).
- [x] Removing `xy/z/time` from the primary watcher: any frame-change-driven draw
  that *only* `onPrimaryChange` used to trigger and that `displayedAnnotations`
  doesn't cover? Frame changes drive `updateVisibility`
  (`watch([filteredAnnotations, xy, z, time], updateVisibility)`) →
  `displayedAnnotations` → `onDisplayedAnnotationsChange`, which now draws once
  because `handlingPrimaryChange` is no longer set on a frame change. Timelapse
  time-scrub verified fine. Now also covered by an integration test in
  `AnnotationViewer.test.ts` ("frame-index change (xy/z/time) redraw path") that
  drives a real `xy`/`z`/`time` change end-to-end and asserts the displayed set
  turns over and a redraw is issued without routing through `onPrimaryChange`.
- [x] `isFrameCacheEnabled()` covers all "one draw spans multiple frames" modes
  (unroll + max-merge per axis). Max-merge disable is conservative-not-required
  (see Cache invalidation §).

## Bugs found and fixed during review + testing

Two rendering bugs surfaced while reviewing/stress-testing this work. Both are
GeoJS-render-sync issues (features present but mis-positioned or unpainted), both
were confirmed fixed live on the HCR dataset, and each has a regression test.

### 1. Coordinate drift on feature re-add (zoom in → out)

Reused features drifted off the image — dots rendering in bands above/below —
worsening on each zoom-out that re-added them. Cause: `addAnnotation` runs
`_convertCoordinates(ingcs, gcs)` on **every** add, and a reused feature was already
in gcs from its first add, so re-adding it converted a second time. **This bug WAS
the cache** (only reused features are re-added). Fixed by adding fresh features with
`gcs=undefined` (convert once) and reused features with `gcs=null` (skip
conversion). Full mechanism + the guarding test assertions are in the
[Correctness invariants](#correctness-invariants) → "Coordinates must not be
re-converted on re-add" bullet.

### 2. Annotations vanish after scrubbing through empty Z frames

Tapping up/down the stack several times eventually left annotation frames blank
until a reload. **Root cause is independent of the retained cache** — it lives in
the shared frame-draw path and reproduces whether a frame's features are reused
(cache) or freshly created, so removing the cache would not have fixed it.

`geojs` gates the annotation layer's `_update` (the WebGL feature-data rebuild) on a
`modified()` timestamp. `addAnnotation` / `addMultipleAnnotations` called with
`update=false` (as the draw path does) do **not** bump it, and `clearOldAnnotations`
marks the layer modified **only when it removes features**. So on the "return to an
annotation frame while the layer is already empty" path — common when scrubbing
through blank Z slices — a draw *adds* features to an unmodified layer and
`draw()` renders nothing: the features sit in `layer.annotations()` (count is
correct — verified live at 8604) but never paint, until some later modification or a
reload. Confirmed live by calling `layer.modified(); layer.draw()` in the console,
which made the missing annotations reappear instantly.

**Fix** (`drawAnnotationsNoThrottle`): count features before vs after the add pass and
call `props.annotationLayer.modified()` when the count grew, so the added features
paint. Guarded on growth so a pure pan with no add/remove still skips `_update`
(preserving the incremental-draw optimization). Regression test in
`AnnotationViewer.test.ts` ("marks the layer modified when a draw adds features")
asserts `modified()` is called when features are added to an empty layer — it fails
against the pre-fix code and passes now (verified live in-browser on the HCR dataset).

## Review follow-ups (polish)

A code review of the diff produced the following follow-ups, all applied:

1. **Memory bound** (Medium): replaced the hardcoded `RETAINED_FEATURE_LIMIT =
   60000` with `retainedFeatureLimit()` derived from `visibilityConfig.maxVisible`.
2. **GeoJS contract** (Low): documented the `_exit`/re-add reliance and pinned it
   to `geojs ^1.19.1` in a comment on `retainRemovedFeatures`.
3. **Testability** (Low): extracted the skip predicate to
   `shouldRetainFeature` in `src/utils/annotation.ts` (unit-tested), added two
   round-trip reuse tests, and added a frame-index (`xy`/`z`/`time`) redraw
   integration test — all in `AnnotationViewer.test.ts`. The harness mechanics
   these lean on (reactive store mocks, fake-timer draw flushing, the can't-spy
   closures constraint, the arg-ignoring `geojsAnnotationFactory` mock) are
   documented in [FRONTEND_COMPONENT_TESTING.md](FRONTEND_COMPONENT_TESTING.md).
4. **max-merge rationale** (Nit): clarified that the disable is conservative.
5. **`getStubScaled()` accuracy** (Nit): corrected the comments/writeup — it is
   zoom-independent; GeoJS handles dot rescaling via the `scaled` style.
6. **Opacity invalidation** (Nit): noted the token is a redundant safety net over
   `onRestyleNeeded`.

## Test coverage (12 new)

- `src/utils/__tests__/annotationStubUtils.test.ts` — **6**: `shouldRetainFeature`
  skip-predicate edges (missing girderId/layerId, connections, special, defaults).
- `src/components/AnnotationViewer.test.ts` — **6**:
  - retained-feature reuse round-trip (**2**): reuse-on-scrub-back (asserts no
    reconstruction + `gcs=null` re-add) and reject-stale-and-reconstruct (asserts
    `gcs=undefined` fresh add).
  - frame-index redraw integration (**3**, `it.each` over `xy`/`z`/`time`): a real
    frame change turns over `displayedAnnotations` and issues a redraw without
    routing through `onPrimaryChange`.
  - render regression (**1**): a draw that adds features to an empty layer calls
    `modified()` (guards bug #2 above; fails against pre-fix code).

The component tests run against the GeoJS mock, so they guard the cache/draw
**logic** and the `gcs`/`modified()` call contracts — not the real GeoJS render
behavior. The two visual bugs were verified live in-browser (see the fixes above);
re-verify the scrub-back and scrub-through-empty paths in-browser on any `geojs`
bump. Harness mechanics: [FRONTEND_COMPONENT_TESTING.md](FRONTEND_COMPONENT_TESTING.md).
