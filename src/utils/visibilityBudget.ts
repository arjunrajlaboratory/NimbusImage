// Zoom-adaptive render/hydration budgets.
//
// In stub-only (lazy) mode the visibility budget caps how many annotations are
// drawn at once. A flat cap looks fine zoomed in, but zoomed out the whole
// frame's worth of annotations collapses into an unreadable mush (e.g. 50,000
// dots over a 708K-cell slide read as one solid blob) and the per-frame draw of
// that many features is what briefly locks the UI after a pan.
//
// The on-screen annotation count shrinks ~4x per zoom level (each level halves
// the linear scale). We grow the budget ~2x per level from a zoomed-out floor
// (`zoomedOutFraction` of the configured cap) up to the full cap, so the rendered
// set stays readable and cheap to draw when zoomed out and reaches full detail a
// few levels in — where it rarely binds anyway because little is in view.
//
// Kept pure for unit testing; the component supplies the live map zoom.

export interface IVisibilityBudget {
  maxVisible: number;
  maxHydrated: number;
}

export function visibilityBudgetForZoom(input: {
  zoom: number;
  zoomMin: number;
  maxVisible: number;
  maxHydrated: number;
  zoomedOutFraction: number;
}): IVisibilityBudget {
  const { zoom, zoomMin, maxVisible, maxHydrated, zoomedOutFraction } = input;
  // Levels zoomed in past the most-zoomed-out level (clamped so zoom < zoomMin
  // can't shrink below the floor).
  const levelsIn = Math.max(0, zoom - zoomMin);
  const fraction = Math.min(1, zoomedOutFraction * Math.pow(2, levelsIn));
  return {
    maxVisible: Math.max(1, Math.round(maxVisible * fraction)),
    maxHydrated: Math.max(1, Math.round(maxHydrated * fraction)),
  };
}
