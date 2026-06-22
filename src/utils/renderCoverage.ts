// In stub-only (lazy) mode the canvas renders only a budgeted subset of the
// loaded annotations. The render-coverage indicator answers the question that
// actually matters to the user inspecting a region: "am I seeing everything
// that's here?" — i.e. how many of the annotations in the CURRENT VIEWPORT are
// actually drawn, with the dataset total as context.
//
// (Earlier this compared total-displayed vs the render cap, but once off-screen
// pre-load fills the budget that reads misleadingly — e.g. "50,000 / 708,983"
// while you're actually seeing everything in your view. Viewport-relative is the
// honest signal.) Kept pure for unit testing.

export interface IRenderCoverage {
  // Whether the indicator should be shown at all.
  show: boolean;
  // viewportShown / viewportTotal, clamped to [0, 1].
  fraction: number;
  // "12,000 of 45,000 in view"
  shownLabel: string;
  // "708,983 loaded"
  totalLabel: string;
}

export function computeRenderCoverage(input: {
  stubOnlyMode: boolean;
  viewportShown: number; // rendered annotations within the actual viewport
  viewportTotal: number; // all annotations within the actual viewport (current frame)
  loaded: number; // total stubs held in memory
}): IRenderCoverage {
  const { stubOnlyMode, viewportShown, viewportTotal, loaded } = input;
  // Show only while some annotations in the current view are NOT drawn (the
  // budget is downsampling what you're looking at). When everything in view is
  // rendered — a mid-size dataset, or zoomed in far enough — stay hidden.
  const show =
    stubOnlyMode && viewportTotal > 0 && viewportShown < viewportTotal;
  const fraction =
    viewportTotal > 0
      ? Math.min(1, Math.max(0, viewportShown / viewportTotal))
      : 1;
  return {
    show,
    fraction,
    shownLabel: `${viewportShown.toLocaleString()} of ${viewportTotal.toLocaleString()} in view`,
    totalLabel: `${loaded.toLocaleString()} loaded`,
  };
}
