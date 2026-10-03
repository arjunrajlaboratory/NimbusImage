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
  // "(1 filter applied)" — null when nothing is narrowing the object set.
  constraintLabel: string | null;
  // "(289,469 passing filters)" — how many of the total survive the active
  // constraints. Null when nothing is narrowing the set (it would just repeat
  // the total) or when the caller has no count to report.
  passingLabel: string | null;
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
  // Filters AND analysis gates currently narrowing the object set
  // (filters.activeConstraintCount). Both counts above are computed AFTER
  // these are applied, so without saying so "Showing 826 of 826 in view" in a
  // viewport that visibly holds thousands reads as data loss.
  constraintCount?: number;
  // How many annotations in the whole dataset pass the active constraints.
  // Shown next to the total so the narrowed population is readable without
  // opening a panel.
  passingCount?: number;
}): IRenderCoverage {
  const {
    stubMode,
    viewportShown,
    viewportTotal,
    loaded,
    constraintCount = 0,
    passingCount,
  } = input;
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
    // Deliberately NOT gated on stubMode: the counts are filtered in both
    // stub and client modes, so the cue has to appear wherever the HUD does.
    // "filter" covers gates too — the reader is being told their numbers are
    // narrowed, and the tooltip names which panels did the narrowing.
    constraintLabel:
      constraintCount > 0
        ? `(${constraintCount} filter${constraintCount === 1 ? "" : "s"} applied)`
        : null,
    // Gated on the same condition as constraintLabel: with nothing narrowing
    // the set the passing count equals the total and saying so is noise.
    passingLabel:
      constraintCount > 0 && passingCount != null
        ? `(${passingCount.toLocaleString()} passing filters)`
        : null,
  };
}
