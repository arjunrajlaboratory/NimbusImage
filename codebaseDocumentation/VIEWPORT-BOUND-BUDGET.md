# Problem: the render/hydration budget fills with off-screen annotations when zoomed in

**Status:** Open problem, not yet scheduled. Tracked separately from the
point-annotation work (see the "RESOLVED (2026-06-24): point annotations bypass
the stub/hydrated machinery" section in `ANNOTATION-STUBS.md`). This is the
shape-agnostic, higher-blast-radius lever and deserves its own design +
verification pass.

**Branch context:** `feature/stub-annotations`. This is the same item the
`ANNOTATION-STUBS.md` overview calls out as the highest-leverage remaining perf
lever ("viewport-bound the visibility/hydration budget when zoomed in").

## Summary

In stub-only / lazy mode the visibility budget (`maxVisible`, default 50,000)
caps how many annotations are turned into GeoJS features. The budget is filled
**two-tier**: in-viewport ids first, then off-viewport ids fill the remainder
(`updateVisibilityAndHydration`, Steps 2–4 in `src/store/annotation.ts`). When
zoomed in, the actual viewport holds only a few thousand annotations, so the
remaining budget — tens of thousands of slots — is filled with **off-screen**
annotations that are created, styled, drawn, and maintained for nothing.

The same applies to the hydration budget (`maxHydrated`, default 20,000).

## Evidence (measured on a 1,000,000-point dataset, single Z plane, high zoom)

Dataset: 1M random points on one Z plane of a 1024×1024 image. Driven in-browser
in stub-only mode, zoomed in so the scale bar read ~3 µm.

Read directly from the live store (`window.__annStore`):

| Quantity | Value |
|---|---|
| Annotations actually in the viewport (`viewportAnnotationCount`) | **4,260** |
| Features drawn (`visibleAnnotationIds.size`) | **50,000** |
| **Off-screen features drawn** | **45,740 (91.5%)** |
| Points hydrated and held (`hydratedAnnotations.size`) | 23,454 |
| Per-pan main-thread block (longtask) | **~0.95–1.06 s** |
| Heap during interaction | ~620–686 MB |

So at this zoom **91.5% of the drawn features were off-screen.** The dominant
per-pan cost is (1) the Step-3 visibility selection scanning the full on-frame
id set (~857K here) and (2) drawing/maintaining 50,000 features when only ~4,260
are visible.

## Why it matters

- The per-refresh selection (`selectStableSubset`) and the per-draw feature
  creation are both ~O(features drawn). Filling the budget with off-screen
  content multiplies both by ~10× at high zoom for no visible benefit.
- It is the larger of the two co-dominant costs in the high-zoom pan profile
  (the other being the per-feature draw cost, already attacked by the
  incremental draw path and, for points, by the point-collapse work).

## Direction (not yet committed — needs its own design)

- Bound the **drawn** (and hydrated) count to roughly what is in the viewport
  plus a small pan-preload margin, instead of always filling the global
  `maxVisible`. This is the practical form of "decouple hydrated-in-memory from
  drawn-as-shape."
- Open design questions: what exactly counts as "near the viewport" (the
  existing 2× expanded box? a fixed margin? a multiple of the in-view count?);
  how it interacts with the pan-preload pre-loading goal; whether a separate,
  smaller shape-draw cap should bound polygon draw cost independently of how
  much is hydrated for selection/measurement.

## Scope / blast radius

- **Shape-agnostic.** Affects the already-verified polygon datasets, not just
  points — so it must be re-verified on **HCR 26K** and **Xenium 708K** (the
  reference datasets) in addition to the 1M-point stress case.

## Files

- `src/store/annotation.ts` — `updateVisibilityAndHydration`, Steps 2–4
  (viewport split, visibility budget fill, hydration budget fill).
- `src/utils/visibilityBudget.ts` — `visibilityBudgetForZoom` (the zoom-adaptive
  cap; today it caps at the global `maxVisible` when zoomed in).
- `src/components/AnnotationViewer.vue` — where the budget is computed from the
  live map and passed into the action.
