import { describe, it, expect } from "vitest";
import { computeRenderCoverage } from "@/utils/renderCoverage";

describe("computeRenderCoverage", () => {
  it("shows the indicator when not everything in the viewport is rendered", () => {
    // 12,000 of 45,000 annotations in the current view are drawn → downsampling.
    const c = computeRenderCoverage({
      stubOnlyMode: true,
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

  it("stays visible when everything in the viewport is rendered", () => {
    // Zoomed in: all 2,767 annotations in view are drawn → bar reads full.
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      viewportShown: 2767,
      viewportTotal: 2767,
      loaded: 708983,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBe(1);
  });

  it("hides when not in stub-only mode", () => {
    const c = computeRenderCoverage({
      stubOnlyMode: false,
      viewportShown: 100,
      viewportTotal: 45000,
      loaded: 45000,
    });
    expect(c.show).toBe(false);
  });

  it("stays visible but reports an empty viewport in stub-only mode", () => {
    const c = computeRenderCoverage({
      stubOnlyMode: true,
      viewportShown: 0,
      viewportTotal: 0,
      loaded: 708983,
    });
    expect(c.show).toBe(true);
    expect(c.fraction).toBe(0);
    expect(c.shownLabel).toBe("No annotations in view");
  });

  it("clamps the fraction to [0, 1]", () => {
    const over = computeRenderCoverage({
      stubOnlyMode: true,
      viewportShown: 50,
      viewportTotal: 40, // shown should never exceed total, but guard anyway
      loaded: 100,
    });
    expect(over.fraction).toBe(1);
  });
});
