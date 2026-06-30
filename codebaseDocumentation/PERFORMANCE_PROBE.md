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
