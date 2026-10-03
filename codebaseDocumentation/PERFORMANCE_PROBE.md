# In-Browser Render-Performance Probe

A deterministic, repeatable probe that quantifies NimbusImage's client-side render
performance (frame times, main-thread blocking, heap) during scripted pan / zoom /
time-scrub / z-scrub interactions.

Script: [`scripts/nimbus-perf-probe.js`](../scripts/nimbus-perf-probe.js).

## Why this exists

It is the **"evaluator floor"** for a performance feedback loop. The idea (loop
engineering): you can only automate *"make this faster and prove it"* if you have a
stable, non-gameable number to gate on. A perf metric either regressed or it didn't —
unlike "does this code look faster?", it can't be talked into a false pass... **as long
as it's measured correctly.** The three lessons below are exactly the ways it lies if
you measure it wrong.

## How to run

1. Open a dataset in NimbusImage in a **foreground / visible** tab (Lesson 1).
2. Paste `scripts/nimbus-perf-probe.js` into the devtools console (or inject it via a
   browser-automation `evaluate` call). It installs `window.__nimbusPerf`.
3. Run:
   ```js
   await __nimbusPerf.run()                                   // timeScrub + pan + zoom
   await __nimbusPerf.run({ scenarios: ['pan','zoom'], reps: 5 })
   await __nimbusPerf.run({ scenarios: [['zScrub', { zs:[3,4], cycles:4 }]] })
   ```
4. Compare `result.summary` against a committed baseline.

`result.summary[scenario]` gives the **median over warm runs** of: `maxBlockMs`,
`totalBlockingMs`, `frameMaxMs`, `frameP95Ms`, `fps`. `maxBlockMs` (longest single
main-thread stall) is the most decision-relevant gate — it's what users feel as a freeze.

## The three lessons (baked into the script)

1. **Visibility is mandatory.** A hidden/background tab pauses `requestAnimationFrame`,
   throttles `setTimeout` to ~1 Hz, and never composites. Measured while hidden, the
   probe reports **0 long tasks / "all green"** even when rendering is broken — the most
   dangerous false-pass. `run()` aborts unless `document.visibilityState === 'visible'`.
   An automated evaluator **must** drive a foreground tab (or a tool that records a real
   trace, e.g. Chrome DevTools `performance_start_trace`).

2. **Fire store actions, don't await them.** `setTime` / `setZ` / `setXY`
   (`src/store/index.ts`) await a network PUT to `/dataset_view`
   (`updateLastLocationInDatasetView`, ~line 1862) that is decoupled from the visible
   render. Awaiting per step folds backend latency into "render cost" and blows past
   automation eval timeouts. Scenarios dispatch-and-fire, then sample rAF + long tasks.
   *(Side finding: every scrub step fires a `dataset_view` PUT — a debounce candidate.)*

3. **Warm up, then take the median.** Single runs are noise — the first run after idle
   is ~2× slower (cold caches + GC). A one-shot A/B comparison gave a **false 4×**
   (896 ms vs 230 ms) that was purely cold-vs-warm, not a real difference. The probe
   discards `warmups` runs and reports the median of `reps` warm runs + the spread.

## Baselines (captured 2026-06-30; ~120 Hz display, so 8.3 ms ≈ one refresh)

| Dataset | Scenario | fps | worst frame | **max block** | verdict |
|---------|----------|----:|------------:|--------------:|---------|
| Timelapse `38_km gdnf 2_3` (2,619 anns, full-load) | timeScrub | 75 | 33 ms | **0** | healthy |
| ″ | pan / zoom | 120 | 9 ms | **0** | locked to refresh |
| Xenium (708,983 centroids, stubOnly) | pan @ zoom 3 | 65 | 75 ms | **339 ms** | jank |
| ″ | zoom 3→5 | 37 | 192 ms | **320 ms** | jank |
| HCR z-scrub 26K↔26K (warm) | z 3↔4 | 80 | 75 ms | **87 ms** (spread 82–89) | optimization target |

Healthy reference: 0 ms blocking, frames locked to refresh. Stress cases: 300+ ms
main-thread freezes (Xenium pan/zoom) and ~87 ms per z-switch between two heavy slices
(HCR) — both believed to be the same viewport visible-set-rebuild machinery.

> The HCR z-scrub baseline requires two heavily-populated adjacent z-slices. The HCR
> dataset's z=4 was bulk-populated (≈26K annotations copied from z=3) to create this
> fixture; see `scripts/generate_test_annotations.py` for generating similar fixtures.

## Fix applied (HCR z-scrub) — retained-feature reuse

The z-scrub freeze was the **CPU-side reconstruction** of every visible GeoJS
feature on each frame change: `drawNewAnnotations` called `createGeoJSAnnotation`
for ~8k features (zoom 0; far more zoomed in). Decomposed live, that was ~51 ms of
construction + ~26 ms add/GL-draw at zoom 0 (≈194 ms + 108 ms for ~26k at zoom 2).

Two changes in `AnnotationViewer.vue` (`feature/stub-annotations`):

1. **Retained-feature LRU** — torn-down GeoJS feature objects are kept in an LRU
   keyed by `(layerId, annotationId)` and re-added when an annotation reappears,
   skipping reconstruction. Keyed per-annotation (not per-frame) so reuse is robust
   to the two-phase frame update and throttle coalescing. Each reuse is revalidated
   via `drawnFeatureUnchanged` (layer/color/stub-ness/geometry) + an opacity style
   token, and restyled for hover/selection, so the rendered set is identical to a
   full rebuild (verified: layer feature count == displayed-id count at each Z).
2. **No wasted leading draw on frame change** — frame indices (`xy`/`z`/`time`) were
   removed from the `onPrimaryChange` watcher; the redraw now flows once through
   `updateVisibility → displayedAnnotations`, with the correct visible set, instead of
   a first draw against the stale (pre-update) set followed by the real one.

**Measured (clean back-to-back A/B, same machine state):** warm-median `maxBlock`
**87 → ~68 ms**; once the cache is warm a frame's draw is ~33 ms (vs ~77 ms cold),
i.e. reconstruction is eliminated. Timelapse pan/zoom stay **0 ms** (no regression).

**Residual (does not yet meet a strict ≤40 ms gate):** with reconstruction gone, the
remaining per-Z cost is `updateVisibilityAndHydration` (~17 ms) + `layerAnnotations`
recompute (~4 ms) + the add/GL-draw of ~8k features (~28 ms), which bundle into one
~50–68 ms task (the GeoJS GL buffer is rebuilt because features leave and re-enter the
layer). The `maxBlock` probe metric is longtask-quantized (0 below 50 ms, then ≥50),
so this sits right at the threshold and reads bimodally. Getting reliably under 50 ms
would require either avoiding the GL rebuild (keep both frames resident across two
layers and toggle layer visibility) or splitting the task across macrotasks (lowers
`maxBlock` but worsens worst-frame time + heap — rejected as metric-gaming).

**Review follow-ups (applied):** the LRU cap is now derived from
`visibilityConfig.maxVisible` (not a fixed 60k); the skip predicate was extracted to
the unit-tested `shouldRetainFeature` in `src/utils/annotation.ts`; two round-trip
reuse tests plus a frame-index (`xy`/`z`/`time`) redraw integration test were added to
`AnnotationViewer.test.ts`; and the `_exit`/re-add reliance is documented and pinned
to `geojs ^1.19.1`.

**Two rendering bugs found while testing, both fixed (verified live):**

1. *Zoom in → out drift:* reused features were re-added with the default (ingcs) gcs,
   so `addAnnotation`'s per-add `_convertCoordinates(ingcs → gcs)` ran a **second**
   time on already-gcs coordinates and drifted them off the image (dots in bands
   above/below, worsening each zoom-out). Fixed by re-adding reused features with
   `gcs = null` (no conversion) while fresh features keep `undefined` (convert once).
   This bug was the cache.
2. *Vanish after scrubbing empty Z frames:* a draw that only *adds* features (return
   to an annotation frame while the layer is already empty) never marked the layer
   `modified()`, so GeoJS's `_update` skipped the render — features in the list,
   nothing painted, until reload. Fixed in `drawAnnotationsNoThrottle` by marking the
   layer modified when the feature count grows. **Independent of the cache** (shared
   draw path). Full write-up: `codebaseDocumentation/ZSCRUB_FEATURE_REUSE.md`.

## Wiring it into a loop (sketch)

```
/loop  on each commit touching the render path:
  1. (re)inject scripts/nimbus-perf-probe.js into a FOREGROUND tab on a fixed dataset
  2. await __nimbusPerf.run({ scenarios: ['zScrub','pan'] })   ← the "say no" number
  3. diff result.summary.*.maxBlockMs vs perf-baseline.json
/goal  zScrub.maxBlockMs <= 90 AND xenium-pan.maxBlockMs within 10% of baseline
```

The evaluator is a warm-median'd number from a *visible* tab — so the gate is real, not
a coin flip. Parallel variant experiments belong in per-variant git worktrees.
