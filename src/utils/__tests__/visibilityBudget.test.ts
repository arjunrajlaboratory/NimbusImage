import { describe, it, expect } from "vitest";
import { visibilityBudgetForZoom } from "@/utils/visibilityBudget";

describe("visibilityBudgetForZoom", () => {
  // 708K Xenium dataset config: cap 50K visible / 20K hydrated, zoomRange.min 0.
  const base = {
    maxVisible: 50000,
    maxHydrated: 20000,
    zoomedOutFraction: 0.1,
  };

  it("renders the zoomed-out floor (fraction of the cap) at the minimum zoom", () => {
    const b = visibilityBudgetForZoom({ zoom: 0, zoomMin: 0, ...base });
    // 10% of each cap when fully zoomed out — the readable-overview budget.
    expect(b.maxVisible).toBe(5000);
    expect(b.maxHydrated).toBe(2000);
  });

  it("doubles the budget per zoom level above the minimum", () => {
    expect(
      visibilityBudgetForZoom({ zoom: 1, zoomMin: 0, ...base }).maxVisible,
    ).toBe(10000);
    expect(
      visibilityBudgetForZoom({ zoom: 2, zoomMin: 0, ...base }).maxVisible,
    ).toBe(20000);
    expect(
      visibilityBudgetForZoom({ zoom: 3, zoomMin: 0, ...base }).maxVisible,
    ).toBe(40000);
    // maxHydrated scales by the same factor.
    expect(
      visibilityBudgetForZoom({ zoom: 2, zoomMin: 0, ...base }).maxHydrated,
    ).toBe(8000);
  });

  it("clamps to the full configured cap once zoomed in far enough", () => {
    // 0.1 * 2^4 = 1.6 → clamped to 1.0.
    const b = visibilityBudgetForZoom({ zoom: 4, zoomMin: 0, ...base });
    expect(b.maxVisible).toBe(50000);
    expect(b.maxHydrated).toBe(20000);
    // Still clamped at very high zoom.
    const deep = visibilityBudgetForZoom({ zoom: 10, zoomMin: 0, ...base });
    expect(deep.maxVisible).toBe(50000);
    expect(deep.maxHydrated).toBe(20000);
  });

  it("uses zoom relative to zoomMin, not absolute zoom", () => {
    // zoomMin 3, zoom 3 → fully zoomed out → floor.
    const b = visibilityBudgetForZoom({ zoom: 3, zoomMin: 3, ...base });
    expect(b.maxVisible).toBe(5000);
    // one level in from min 3
    expect(
      visibilityBudgetForZoom({ zoom: 4, zoomMin: 3, ...base }).maxVisible,
    ).toBe(10000);
  });

  it("interpolates continuously for fractional zoom", () => {
    // 0.1 * 2^0.5 ≈ 0.1414 → 7071
    const b = visibilityBudgetForZoom({ zoom: 0.5, zoomMin: 0, ...base });
    expect(b.maxVisible).toBe(Math.round(50000 * 0.1 * Math.SQRT2));
  });

  it("clamps to the floor when zoom is below zoomMin (no runaway shrink)", () => {
    const b = visibilityBudgetForZoom({ zoom: -2, zoomMin: 0, ...base });
    expect(b.maxVisible).toBe(5000);
    expect(b.maxHydrated).toBe(2000);
  });

  it("disables scaling when zoomedOutFraction is 1 (kill switch)", () => {
    const b = visibilityBudgetForZoom({
      zoom: 0,
      zoomMin: 0,
      maxVisible: 50000,
      maxHydrated: 20000,
      zoomedOutFraction: 1,
    });
    expect(b.maxVisible).toBe(50000);
    expect(b.maxHydrated).toBe(20000);
  });

  it("never returns a zero budget even with a tiny fraction or cap", () => {
    const b = visibilityBudgetForZoom({
      zoom: 0,
      zoomMin: 0,
      maxVisible: 5,
      maxHydrated: 1,
      zoomedOutFraction: 0.01,
    });
    expect(b.maxVisible).toBeGreaterThanOrEqual(1);
    expect(b.maxHydrated).toBeGreaterThanOrEqual(1);
  });
});
