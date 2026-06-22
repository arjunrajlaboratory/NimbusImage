import { describe, it, expect } from "vitest";
import { computeRenderCoverage } from "@/utils/renderCoverage";

describe("computeRenderCoverage", () => {
  it("shows the indicator when the render budget is saturated (downsampling)", () => {
    // 708K dataset: 50,000 of 708,983 rendered (visible capped at the budget).
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      displayed: 50000,
      loaded: 708983,
      maxVisible: 50000,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBeCloseTo(50000 / 708983, 6);
    expect(c.label).toBe(
      `${(50000).toLocaleString()} / ${(708983).toLocaleString()}`,
    );
  });

  it("hides when the current view is fully rendered even if a few are loaded on other frames", () => {
    // 26K dataset: 26,041 of 26,146 loaded are displayed — the gap is
    // cross-frame annotations, NOT budget downsampling (visible is well under
    // the budget), so the current view shows everything it can → hide.
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      displayed: 26041,
      loaded: 26146,
      maxVisible: 50000,
    });
    expect(c.show).toBe(false);
  });

  it("hides when everything loaded is displayed", () => {
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      displayed: 26146,
      loaded: 26146,
      maxVisible: 50000,
    });
    expect(c.show).toBe(false);
  });

  it("hides when the budget exceeds the dataset (all rendered)", () => {
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      displayed: 708983,
      loaded: 708983,
      maxVisible: 1000000,
    });
    expect(c.show).toBe(false);
  });

  it("never shows outside stub-only mode, even when the budget is saturated", () => {
    const c = computeRenderCoverage({
      stubOnlyMode: false,
      displayed: 50000,
      loaded: 708983,
      maxVisible: 50000,
    });
    expect(c.show).toBe(false);
  });

  it("hides (no divide-by-zero) when nothing is loaded yet", () => {
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      displayed: 0,
      loaded: 0,
      maxVisible: 50000,
    });
    expect(c.show).toBe(false);
    expect(c.fraction).toBe(0);
  });
});
