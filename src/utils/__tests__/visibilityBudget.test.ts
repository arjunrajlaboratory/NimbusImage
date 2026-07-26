import { describe, it, expect } from "vitest";
import {
  visibilityBudgetForZoom,
  selectVisibleIds,
  clampVisibleBudget,
} from "@/utils/visibilityBudget";

// Deterministic, order-preserving stand-in for selectStableSubset: takes the
// first `n` ids. Keeps the tiering assertions readable (no hashing).
const takeFirst = (list: string[], n: number) => list.slice(0, Math.max(0, n));
const mkIds = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

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
    revealMoreOnZoom: true, // reveal-more ramp is the default these cases assume
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

  describe("revealMoreOnZoom = false (coverage at current zoom)", () => {
    const cov = { ...base, revealMoreOnZoom: false };

    it("matches the reveal-more floor at the most zoomed-out level", () => {
      // At zoomMin both modes use the zoomMin dot area → same budget (5,000).
      expect(visibilityBudgetForZoom({ ...cov, zoom: 0 }).maxVisible).toBe(
        5_000,
      );
    });

    it("SHRINKS (not grows) the budget as you zoom in", () => {
      // avgRadius 45, upp 1: at zoomMin dotDiam = 2*45 + 10 = 100 → area 10,000 →
      // budget 0.5*1e6/1e4 = 50. One level in, the radius doubles on screen
      // (upp halves): dotDiam = 2*90 + 10 = 190 → area 36,100 → budget ~14.
      const z0 = visibilityBudgetForZoom({ ...cov, avgRadius: 45, zoom: 0 });
      const z1 = visibilityBudgetForZoom({ ...cov, avgRadius: 45, zoom: 1 });
      expect(z0.maxVisible).toBe(50);
      expect(z1.maxVisible).toBeLessThan(z0.maxVisible);
      // Reveal-more mode would instead DOUBLE (50 → 100) over the same step.
      expect(
        visibilityBudgetForZoom({ ...base, avgRadius: 45, zoom: 1 }).maxVisible,
      ).toBe(100);
    });

    it("still honors the size gate", () => {
      const b = visibilityBudgetForZoom({ ...cov, loaded: 40_000, zoom: 3 });
      expect(b).toEqual({ maxVisible: 50_000, maxHydrated: 20_000 });
    });

    it("ramps hydration UP with zoom even as the visible budget shrinks", () => {
      // The reported bug: in coverage mode the visible budget shrinks as you
      // zoom in, so scaling hydration off it left everything a dot. Hydration
      // must instead ramp UP with zoom (shapes appear as you zoom in).
      const z0 = visibilityBudgetForZoom({ ...cov, avgRadius: 45, zoom: 0 });
      const z3 = visibilityBudgetForZoom({ ...cov, avgRadius: 45, zoom: 3 });
      expect(z3.maxVisible).toBeLessThan(z0.maxVisible); // visible shrinks
      expect(z3.maxHydrated).toBeGreaterThan(z0.maxHydrated); // hydration grows
    });
  });
});

describe("clampVisibleBudget", () => {
  it("raises the budget to the minimum floor when the zoom rule is lower", () => {
    expect(clampVisibleBudget(900, 5000, 50000)).toBe(5000);
  });

  it("keeps the zoom rule when it already exceeds the floor", () => {
    expect(clampVisibleBudget(20000, 5000, 50000)).toBe(20000);
  });

  it("never exceeds the configured cap", () => {
    expect(clampVisibleBudget(80000, 5000, 50000)).toBe(50000);
    // Floor above the cap is also capped (bounds keep min <= max anyway).
    expect(clampVisibleBudget(900, 90000, 50000)).toBe(50000);
  });

  it("defers entirely to the zoom rule when the floor is 0", () => {
    expect(clampVisibleBudget(900, 0, 50000)).toBe(900);
  });
});

describe("selectVisibleIds", () => {
  it("gives the whole budget to the viewport when it alone meets it", () => {
    // 9,000 in view, budget 5,000 (e.g. minimumVisible floor when zoomed out):
    // draw a stable 5,000 from the viewport — nothing spent off-screen. This is
    // the fix: the floor lands IN the visible area, not diluted into the margin.
    const result = selectVisibleIds({
      inViewportIds: mkIds("v", 9000),
      marginIds: mkIds("m", 5000),
      offViewportIds: mkIds("o", 5000),
      budget: 5000,
      selectSubset: takeFirst,
    });
    expect(result.length).toBe(5000);
    expect(result.every((id) => id.startsWith("v-"))).toBe(true);
  });

  it("draws the whole viewport then pre-loads margin and off-screen", () => {
    // 100 in view, budget 250 → all 100 viewport + 100 margin + 50 off.
    const inViewportIds = mkIds("v", 100);
    const marginIds = mkIds("m", 100);
    const offViewportIds = mkIds("o", 100);
    const result = selectVisibleIds({
      inViewportIds,
      marginIds,
      offViewportIds,
      budget: 250,
      selectSubset: takeFirst,
    });
    expect(result.length).toBe(250);
    expect(result.slice(0, 100)).toEqual(inViewportIds);
    expect(result.slice(100, 200)).toEqual(marginIds);
    expect(result.slice(200)).toEqual(offViewportIds.slice(0, 50));
  });

  it("shows everything in view when the viewport holds fewer than the budget", () => {
    // 680 in view, budget 5,000 → all 680 drawn (plus preload). Every viewport
    // id present.
    const inViewportIds = mkIds("v", 680);
    const result = selectVisibleIds({
      inViewportIds,
      marginIds: [],
      offViewportIds: [],
      budget: 5000,
      selectSubset: takeFirst,
    });
    expect(result.length).toBe(680);
    expect(new Set(result)).toEqual(new Set(inViewportIds));
  });
});
