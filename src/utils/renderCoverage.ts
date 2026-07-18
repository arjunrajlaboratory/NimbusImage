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

import { clamp } from "@/utils/math";

export interface IRenderCoverage {
  // Whether the indicator should be shown at all.
  show: boolean;
  // viewportShown / viewportTotal, clamped to [0, 1].
  fraction: number;
  // "Showing 12,000 of 45,000 in view" (or "No annotations in view")
  shownLabel: string;
  // "708,983 total annotations"
  totalLabel: string;
}

export function computeRenderCoverage(input: {
  stubOnlyMode: boolean;
  viewportShown: number; // rendered annotations within the actual viewport
  viewportTotal: number; // all annotations within the actual viewport (current frame)
  loaded: number; // total stubs held in memory
}): IRenderCoverage {
  const { stubOnlyMode, viewportShown, viewportTotal, loaded } = input;
  // Always visible in stub-only mode — it stays a stable, useful readout (and a
  // home for the settings gear) whether the budget is downsampling the view or
  // showing everything in it. When fully zoomed in, fraction is 1 and the bar
  // reads full ("everything here is drawn"); an empty region reads "No
  // annotations in view".
  const show = stubOnlyMode;
  const hasAnnotations = viewportTotal > 0;
  const fraction = hasAnnotations
    ? clamp(viewportShown / viewportTotal, 0, 1)
    : 0;
  return {
    show,
    fraction,
    // Self-contained phrase (the verb lives here, not in the template) so the
    // empty case reads as a clean sentence rather than "Showing No annotations".
    shownLabel: hasAnnotations
      ? `Showing ${viewportShown.toLocaleString()} of ${viewportTotal.toLocaleString()} in view`
      : "No annotations in view",
    totalLabel: `${loaded.toLocaleString()} total annotations`,
  };
}
