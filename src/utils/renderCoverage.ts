// In stub-only (lazy) mode the canvas renders only a budgeted subset of the
// loaded annotations, so the user can't tell how much of the dataset is
// actually on screen. computeRenderCoverage turns the displayed/loaded counts
// into the state for a small top-center indicator. Kept pure for unit testing.

export interface IRenderCoverage {
  // Whether the indicator should be shown at all.
  show: boolean;
  displayed: number;
  loaded: number;
  // displayed / loaded, clamped to [0, 1].
  fraction: number;
  // "50,000 / 708,983" (locale-grouped). The component adds any descriptor word.
  label: string;
}

export function computeRenderCoverage(input: {
  stubOnlyMode: boolean;
  displayed: number;
  loaded: number;
  maxVisible: number;
}): IRenderCoverage {
  const { stubOnlyMode, displayed, loaded, maxVisible } = input;
  // Show only when the render budget is actively limiting the display. The
  // visible set saturates at `maxVisible` precisely when the current view has
  // more annotations than the budget allows, so `displayed >= maxVisible` is the
  // "downsampling" signal. When fewer than the budget are displayed, the current
  // view already shows everything it can (a mid-size dataset, or all-but-a-few
  // cross-frame annotations), so hide it — that is the "fully loaded" case. The
  // `displayed < loaded` guard covers the boundary where the dataset is exactly
  // the budget size and entirely rendered.
  const show =
    stubOnlyMode &&
    maxVisible > 0 &&
    displayed >= maxVisible &&
    displayed < loaded;
  const fraction =
    loaded > 0 ? Math.min(1, Math.max(0, displayed / loaded)) : 0;
  return {
    show,
    displayed,
    loaded,
    fraction,
    label: `${displayed.toLocaleString()} / ${loaded.toLocaleString()}`,
  };
}
