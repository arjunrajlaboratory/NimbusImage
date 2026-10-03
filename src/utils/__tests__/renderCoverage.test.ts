import { describe, it, expect } from "vitest";
import { computeRenderCoverage } from "@/utils/renderCoverage";

describe("computeRenderCoverage", () => {
  it("shows the indicator when not everything in the viewport is rendered", () => {
    // 12,000 of 45,000 annotations in the current view are drawn → downsampling.
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 12000,
      viewportTotal: 45000,
      loaded: 708983,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBeCloseTo(12000 / 45000, 6);
    expect(c.shownLabel).toBe(
      `Showing ${(12000).toLocaleString()} of ${(45000).toLocaleString()} in view`,
    );
    expect(c.totalLabel).toBe(`${(708983).toLocaleString()} total annotations`);
  });

  it("stays visible in stub mode when everything in the viewport is rendered", () => {
    // Zoomed in: all 2,767 annotations in view are drawn → bar reads full, but
    // the indicator persists so the user knows they are in stub mode.
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 2767,
      viewportTotal: 2767,
      loaded: 708983,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBe(1);
  });

  it("shows persistently in stub mode even at X of X in view", () => {
    // A mid-size dataset the user opted into stub mode (by lowering the
    // threshold below its count). Everything in view is drawn (X of X), but the
    // indicator must stay visible so the user knows stub mode is active.
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 3940,
      viewportTotal: 3940,
      loaded: 52186,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBe(1);
  });

  it("shows when the render budget clips the view even outside stub mode", () => {
    // A dataset not (yet) in stub mode whose maxVisible was lowered below the
    // in-view count: the budget downsamples the view, so surface it rather than
    // let downsampling happen silently.
    const c = computeRenderCoverage({
      stubMode: false,
      viewportShown: 100,
      viewportTotal: 45000,
      loaded: 45000,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBeCloseTo(100 / 45000, 6);
  });

  it("hides when not in stub mode and everything in view is drawn", () => {
    // No downsampling (viewportShown === viewportTotal) and not stub mode — a
    // normal small dataset should never show the indicator.
    const c = computeRenderCoverage({
      stubMode: false,
      viewportShown: 500,
      viewportTotal: 500,
      loaded: 500,
    });
    expect(c.show).toBe(false);
  });

  it("stays visible but reports an empty viewport in stub mode", () => {
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 0,
      viewportTotal: 0,
      loaded: 708983,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBe(0);
    expect(c.shownLabel).toBe("No annotations in view");
  });

  it("says nothing about constraints when none is active", () => {
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 826,
      viewportTotal: 826,
      loaded: 708983,
    });
    expect(c.constraintLabel).toBeNull();
  });

  it("reports how many objects pass the active constraints", () => {
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 826,
      viewportTotal: 826,
      loaded: 708983,
      constraintCount: 1,
      passingCount: 289469,
    });
    expect(c.passingLabel).toBe(
      `(${(289469).toLocaleString()} passing filters)`,
    );
  });

  it("omits the passing count when nothing is narrowing the set", () => {
    // With no constraint active the passing count equals the total, so saying
    // it would just repeat the number on the same line.
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 826,
      viewportTotal: 826,
      loaded: 708983,
      passingCount: 708983,
    });
    expect(c.passingLabel).toBeNull();
  });

  it("omits the passing count when the caller has none to report", () => {
    const c = computeRenderCoverage({
      stubMode: true,
      viewportShown: 826,
      viewportTotal: 826,
      loaded: 708983,
      constraintCount: 1,
    });
    expect(c.constraintLabel).toBe("(1 filter applied)");
    expect(c.passingLabel).toBeNull();
  });

  it("announces active constraints, pluralized", () => {
    // The reported case: a restored lasso gate cut 708,983 to 72,925, so a
    // viewport that visibly held thousands read "826 of 826" — data loss.
    const one = computeRenderCoverage({
      stubMode: true,
      viewportShown: 826,
      viewportTotal: 826,
      loaded: 708983,
      constraintCount: 1,
    });
    expect(one.constraintLabel).toBe("(1 filter applied)");
    expect(one.shownLabel).toBe(
      `Showing ${(826).toLocaleString()} of ${(826).toLocaleString()} in view`,
    );
    expect(
      computeRenderCoverage({
        stubMode: true,
        viewportShown: 826,
        viewportTotal: 826,
        loaded: 708983,
        constraintCount: 3,
      }).constraintLabel,
    ).toBe("(3 filters applied)");
  });

  it("announces constraints outside stub mode too", () => {
    // The counts are filtered in client mode as well, so the cue cannot be
    // gated on stub mode.
    const c = computeRenderCoverage({
      stubMode: false,
      viewportShown: 100,
      viewportTotal: 45000,
      loaded: 45000,
      constraintCount: 2,
    });
    expect(c.show).toBe(true);
    expect(c.constraintLabel).toBe("(2 filters applied)");
  });

  it("clamps the fraction to [0, 1]", () => {
    const over = computeRenderCoverage({
      stubMode: true,
      viewportShown: 50,
      viewportTotal: 40, // shown should never exceed total, but guard anyway
      loaded: 100,
    });
    expect(over.fraction).toBe(1);
  });
});
