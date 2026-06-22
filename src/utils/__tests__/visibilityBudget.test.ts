import { describe, it, expect } from "vitest";
import { visibilityBudgetForZoom } from "@/utils/visibilityBudget";

describe("visibilityBudgetForZoom", () => {
  // Clean round-number inputs: stroke-only dot (avgRadius 0) of 10px → 100px²
  // footprint; 1,000,000px² screen; coverageTarget 0.5 → floor 5,000.
  const base = {
    zoomMin: 0,
    avgRadius: 0,
    unitsPerPixelAtZoomMin: 1,
    screenArea: 1_000_000,
    strokePx: 10,
    coverageTarget: 0.5,
    maxVisible: 50_000,
    maxHydrated: 20_000,
    loaded: 1_000_000, // well over the cap → scaling active
  };

  it("renders fully (the configured caps) when the dataset fits under the render cap", () => {
    // Size gate: a 40K dataset (< 50K cap) is never downsampled, at any zoom.
    const gated = { ...base, loaded: 40_000 };
    expect(visibilityBudgetForZoom({ ...gated, zoom: 0 })).toEqual({
      maxVisible: 50_000,
      maxHydrated: 20_000,
    });
    expect(visibilityBudgetForZoom({ ...gated, zoom: 5 })).toEqual({
      maxVisible: 50_000,
      maxHydrated: 20_000,
    });
  });

  it("derives the zoomed-out floor from on-screen coverage", () => {
    // floor = coverageTarget * screenArea / dotArea
    //       = 0.5 * 1e6 / 10² = 5,000
    const b = visibilityBudgetForZoom({ ...base, zoom: 0 });
    expect(b.maxVisible).toBe(5_000);
    // maxHydrated scales by the same ratio (5,000 / 50,000 = 0.1 → 2,000)
    expect(b.maxHydrated).toBe(2_000);
  });

  it("accounts for the annotation radius in the dot footprint", () => {
    // dotDiam = 2*avgRadius/upp + stroke = 2*45/1 + 10 = 100 → area 10,000
    // floor = 0.5 * 1e6 / 10,000 = 50 → tiny floor when dots are large
    const b = visibilityBudgetForZoom({
      ...base,
      avgRadius: 45,
      zoom: 0,
    });
    expect(b.maxVisible).toBe(50);
  });

  it("doubles the budget per zoom level above the minimum", () => {
    expect(visibilityBudgetForZoom({ ...base, zoom: 1 }).maxVisible).toBe(
      10_000,
    );
    expect(visibilityBudgetForZoom({ ...base, zoom: 2 }).maxVisible).toBe(
      20_000,
    );
    expect(visibilityBudgetForZoom({ ...base, zoom: 3 }).maxVisible).toBe(
      40_000,
    );
    // maxHydrated tracks the same ratio (20,000/50,000 = 0.4 → 8,000 at zoom 2)
    expect(visibilityBudgetForZoom({ ...base, zoom: 2 }).maxHydrated).toBe(
      8_000,
    );
  });

  it("clamps to the configured caps once zoomed in far enough", () => {
    // zoom 4: 5,000 * 2^4 = 80,000 → clamped to 50,000 / 20,000
    const b = visibilityBudgetForZoom({ ...base, zoom: 4 });
    expect(b).toEqual({ maxVisible: 50_000, maxHydrated: 20_000 });
    expect(visibilityBudgetForZoom({ ...base, zoom: 9 })).toEqual({
      maxVisible: 50_000,
      maxHydrated: 20_000,
    });
  });

  it("uses zoom relative to zoomMin", () => {
    const b = visibilityBudgetForZoom({ ...base, zoomMin: 3, zoom: 3 });
    expect(b.maxVisible).toBe(5_000); // floor at the min zoom
    expect(
      visibilityBudgetForZoom({ ...base, zoomMin: 3, zoom: 4 }).maxVisible,
    ).toBe(10_000);
  });

  it("clamps the floor to the floor when zoom is below zoomMin", () => {
    expect(visibilityBudgetForZoom({ ...base, zoom: -2 }).maxVisible).toBe(
      5_000,
    );
  });

  it("never returns a zero budget when the floor rounds below 1", () => {
    // huge dots → floor < 1
    const b = visibilityBudgetForZoom({
      ...base,
      avgRadius: 5000,
      zoom: 0,
    });
    expect(b.maxVisible).toBeGreaterThanOrEqual(1);
    expect(b.maxHydrated).toBeGreaterThanOrEqual(1);
  });

  it("falls back to a stroke-only dot when avgRadius is missing", () => {
    // avgRadius undefined → dotDiam = stroke (10) → same as avgRadius 0
    const b = visibilityBudgetForZoom({
      ...base,
      avgRadius: undefined as unknown as number,
      zoom: 0,
    });
    expect(b.maxVisible).toBe(5_000);
  });
});
