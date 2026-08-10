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
  // Whether the dataset is being treated as a large ("stub mode") dataset:
  // either it was loaded stub-only, OR its count now exceeds the stub-mode
  // threshold. The caller derives this reactively so lowering the threshold
  // below the count surfaces the indicator without a reload (it is NOT the
  // load-time stubOnlyMode data flag, which stays load-time only).
  stubMode: boolean;
  viewportShown: number; // rendered annotations within the actual viewport
  viewportTotal: number; // all annotations within the actual viewport (current frame)
  loaded: number; // total stubs held in memory
}): IRenderCoverage {
  const { stubMode, viewportShown, viewportTotal, loaded } = input;
  const hasAnnotations = viewportTotal > 0;
  // Show whenever the dataset is in stub mode, OR the render is actively
  // downsampling (not everything in the current view is drawn):
  //   - Stub mode: a stable, persistent readout (and the home for the settings
  //     gear) so the user knows a large dataset is being handled specially —
  //     even when fully zoomed in and the bar reads full ("Showing X of X").
  //   - Downsampling outside stub mode (e.g. maxVisible tightened below the
  //     dataset size so the budget clips the view): surfaces it rather than
  //     letting it happen silently.
  // An empty region (no annotations in view) reads "No annotations in view".
  const show = stubMode || viewportShown < viewportTotal;
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
