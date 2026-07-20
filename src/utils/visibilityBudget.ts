// Zoom-adaptive render/hydration budgets.
//
// In stub-only (lazy) mode the visibility budget caps how many annotations are
// drawn at once. A flat cap looks fine zoomed in, but zoomed out the whole
// frame's worth of annotations collapses into an unreadable mush (e.g. 50,000
// dots over a 708K-cell slide read as one solid blob) and drawing that many
// features is what briefly locks the UI after a pan.
//
// The model is a hybrid of areal density and a zoom ramp:
//   - The zoomed-out FLOOR is derived from on-screen coverage: how many dots fit
//     before they cover `coverageTarget` of the screen, given each dot's
//     on-screen footprint (radius at the min zoom + the fixed stub stroke). This
//     self-tunes to a dataset's cell size and the viewport — no magic fraction.
//   - Two zoom responses, chosen by `revealMoreOnZoom`:
//       • false (default): coverage is recomputed at the CURRENT zoom (dots grow
//         as you zoom in, so fewer fit) — density stays ~coverageTarget at every
//         zoom (uncrowded), revealing everything only in genuinely sparse
//         regions.
//       • true: from that floor the budget DOUBLES per zoom level up to the cap.
//         On-screen count shrinks ~4x per level while the budget grows 2x, so the
//         rendered fraction rises until everything in view is shown — "reveal
//         more as you zoom in" (working zooms can crowd).
//   - A SIZE GATE renders datasets that fit under the cap fully at every zoom
//     (no downsampling): only datasets that overflow the cap get the treatment.
//
// The `minimumVisible` floor is applied by the store (not here): it floors the
// VISIBLE budget only — hydration keeps the zoom-adaptive value — and the
// visible fill (selectVisibleIds) prioritizes the actual viewport so the floor
// is honored in the region the user is looking at.
//
// Kept pure for unit testing; the component supplies the live map geometry.

import { clamp } from "@/utils/math";

export interface IVisibilityBudget {
  maxVisible: number;
  maxHydrated: number;
}

export function visibilityBudgetForZoom(input: {
  zoom: number;
  zoomMin: number;
  avgRadius: number; // average annotation radius, world units
  unitsPerPixelAtZoomMin: number; // map resolution at the most zoomed-out level
  screenArea: number; // viewport area, px²
  strokePx: number; // stub stroke width (fixed px, dominates the dot when zoomed out)
  coverageTarget: number; // fraction of the screen the rendered dots may cover
  // See IVisibilityConfig.revealMoreOnZoom. true → coverage sets the zoomed-out
  // floor and the budget doubles per zoom level; false → coverage is enforced at
  // the CURRENT zoom (constant density, uncrowded).
  revealMoreOnZoom: boolean;
  maxVisible: number; // render cap (the budget when fully zoomed in)
  maxHydrated: number; // hydration cap (the budget when fully zoomed in)
  loaded: number; // total loaded stub count
}): IVisibilityBudget {
  const {
    zoom,
    zoomMin,
    avgRadius,
    unitsPerPixelAtZoomMin,
    screenArea,
    strokePx,
    coverageTarget,
    revealMoreOnZoom,
    maxVisible,
    maxHydrated,
    loaded,
  } = input;

  // Size gate: a dataset that fits under the render cap is shown in full at
  // every zoom — only over-cap datasets are downsampled.
  if (loaded <= maxVisible) {
    return { maxVisible, maxHydrated };
  }

  const levelsIn = Math.max(0, zoom - zoomMin);
  // Cells shrink with distance zoomed out; the fixed stroke dominates the dot
  // footprint when zoomed out. Compute the dot's on-screen area at the level we
  // care about: zoomMin for the reveal-more floor, the current zoom otherwise.
  const dotAreaAt = (levels: number): number => {
    const unitsPerPixel = unitsPerPixelAtZoomMin / 2 ** levels;
    const diameter = (2 * (avgRadius || 0)) / unitsPerPixel + strokePx;
    return diameter * diameter;
  };
  // Number of dots that cover coverageTarget of the screen at a given dot area.
  const coverageBudget = (dotArea: number): number =>
    dotArea > 0 ? (coverageTarget * screenArea) / dotArea : maxVisible;

  // The reveal-more ramp (coverage floor doubled per zoom level up to the cap).
  // It rises monotonically as you zoom in, so it doubles as a "how zoomed in are
  // we" signal — used for `visible` in reveal-more mode and for hydration in BOTH
  // modes.
  const revealRamp = clamp(
    Math.round(coverageBudget(dotAreaAt(0)) * 2 ** levelsIn),
    1,
    maxVisible,
  );

  const visible = revealMoreOnZoom
    ? revealRamp
    : // Enforce coverage at the CURRENT zoom: as you zoom in the dots grow, so
      // fewer fit within coverageTarget — density stays ~constant (uncrowded) and
      // everything shows only when the actual in-view count drops below this.
      clamp(Math.round(coverageBudget(dotAreaAt(levelsIn))), 1, maxVisible);

  // Hydration ramps with ZOOM (few shapes zoomed out — they read as dots — up to
  // maxHydrated zoomed in), tracked off the reveal-more ramp in BOTH modes. In
  // coverage mode the visible budget deliberately SHRINKS as you zoom in, so
  // scaling hydration off `visible` there would starve it (everything would stay
  // a dot). The store caps this at the visible budget so it never fetches coords
  // for annotations that aren't drawn.
  const hydrated = clamp(
    Math.round(maxHydrated * (revealRamp / maxVisible)),
    1,
    maxHydrated,
  );
  return { maxVisible: visible, maxHydrated: hydrated };
}

/**
 * Apply the `minimumVisible` floor to the zoom-adaptive visible budget, capped
 * at `maxVisible`: draw at least `minimumVisible` (so a busy view isn't stripped
 * below it) but never more than the configured cap. Shared by the store and its
 * test replica so both floor identically.
 */
export function clampVisibleBudget(
  zoomBudget: number,
  minimumVisible: number,
  maxVisible: number,
): number {
  return Math.min(Math.max(zoomBudget, minimumVisible), maxVisible);
}

/**
 * Choose which annotation ids to draw for a given total `budget`, in priority
 * tiers:
 *   1. the actual (unexpanded) viewport — what the user is looking at
 *   2. the expanded pan-preload margin
 *   3. anything else off-screen
 *
 * Prioritizing the actual viewport is what lets the caller's `minimumVisible`
 * floor (folded into `budget`) be honored IN THE VISIBLE AREA rather than
 * diluted across the larger pan-preload box: the viewport is filled first, so it
 * receives min(inViewport, budget) draws. When the viewport alone meets or
 * exceeds the budget, a stable subset of just the viewport is drawn (no budget
 * spent off-screen); otherwise the remainder pre-loads the margin, then
 * off-screen, for smooth panning.
 *
 * `selectSubset` is injected (the store passes `selectStableSubset`) to keep
 * this pure and dependency-light for unit testing.
 */
export function selectVisibleIds(input: {
  inViewportIds: string[]; // actual (unexpanded) viewport
  marginIds: string[]; // expanded margin, excluding inViewportIds
  offViewportIds: string[]; // outside the expanded box
  budget: number; // total render budget (already floored/capped by the caller)
  selectSubset: (ids: string[], maxCount: number) => string[];
}): string[] {
  const { inViewportIds, marginIds, offViewportIds, budget, selectSubset } =
    input;
  if (inViewportIds.length >= budget) {
    // Viewport alone meets/exceeds the budget: draw a stable subset of just the
    // viewport — no budget spent on off-screen pre-load.
    return selectSubset(inViewportIds, budget);
  }
  // The whole viewport fits; spend what's left on the pan-preload margin first,
  // then anything else off-screen.
  let remaining = budget - inViewportIds.length;
  const marginPick = selectSubset(marginIds, remaining);
  remaining -= marginPick.length;
  const offPick = remaining > 0 ? selectSubset(offViewportIds, remaining) : [];
  return [...inViewportIds, ...marginPick, ...offPick];
}
