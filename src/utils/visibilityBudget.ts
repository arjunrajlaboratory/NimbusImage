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
//   - From that floor the budget DOUBLES per zoom level up to the configured cap.
//     On-screen count shrinks ~4x per level while the budget grows 2x, so the
//     rendered fraction of what's in view rises until everything in view is
//     shown — the "reveal more as you zoom in" behavior.
//   - A SIZE GATE renders datasets that fit under the cap fully at every zoom
//     (no downsampling): only datasets that overflow the cap get the treatment.
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
  coverageTarget: number; // fraction of the screen the rendered dots may cover when zoomed out
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
    maxVisible,
    maxHydrated,
    loaded,
  } = input;

  // Size gate: a dataset that fits under the render cap is shown in full at
  // every zoom — only over-cap datasets are downsampled.
  if (loaded <= maxVisible) {
    return { maxVisible, maxHydrated };
  }

  // On-screen dot footprint at the most zoomed-out level. The radius term is
  // tiny when zoomed out (cells are sub-pixel), so the fixed stroke dominates.
  const radiusPx = (avgRadius || 0) / unitsPerPixelAtZoomMin;
  const dotDiameter = 2 * radiusPx + strokePx;
  const dotArea = dotDiameter * dotDiameter;
  const floor =
    dotArea > 0 ? (coverageTarget * screenArea) / dotArea : maxVisible;

  const levelsIn = Math.max(0, zoom - zoomMin);
  const visible = clamp(Math.round(floor * 2 ** levelsIn), 1, maxVisible);
  // Hydration cap tracks the same fraction so fewer shapes are hydrated/drawn
  // when zoomed out (where they look like dots anyway).
  const hydrated = clamp(
    Math.round(maxHydrated * (visible / maxVisible)),
    1,
    maxHydrated,
  );
  return { maxVisible: visible, maxHydrated: hydrated };
}
