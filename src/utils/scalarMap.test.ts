import { describe, it, expect } from "vitest";
import {
  SCALAR_MAP_COLORMAPS,
  SCALAR_MAP_COLORMAP_STOPS,
  colormapGradientCss,
  formatMapValue,
  formatShare,
  percentileOfValue,
  scalarMapLocationKey,
  scalarMapSummary,
  thresholdForTissueShare,
  tissueShareOfThreshold,
  valueAtPercentile,
  workerThresholdForms,
} from "./scalarMap";
import { IScalarMapMeta } from "@/store/model";

// 0th..100th percentiles of a uniform 0..200 distribution: p[i] = 2i.
const LINEAR = Array.from({ length: 101 }, (_, i) => 2 * i);

function meta(overrides: Partial<IScalarMapMeta> = {}): IScalarMapMeta {
  return {
    version: 1,
    toolId: "t",
    name: "Blob metrics/Area mean, 50 µm",
    property: "Blob metrics/Area",
    statistic: "Mean",
    cutoff: null,
    cellTags: ["cell"],
    radius: 50,
    radiusUnit: "µm",
    gridSpacingPx: 12.5,
    originPx: [0, 0],
    shape: [10, 10],
    locations: [
      { XY: 0, Z: 0, Time: 0, key: "xy0_z0_t0" },
      { XY: 1, Z: 2, Time: 3, key: "xy1_z2_t3" },
    ],
    valueRange: [0, 200],
    percentiles: LINEAR,
    units: "µm²",
    ...overrides,
  };
}

describe("scalarMap percent <-> value", () => {
  it("reads whole percentiles exactly, as the worker does", () => {
    // `Top percent of tissue` 20 thresholds at percentiles[80].
    expect(valueAtPercentile(LINEAR, 80)).toBe(160);
    expect(thresholdForTissueShare(LINEAR, 20, "above")).toBe(160);
    expect(thresholdForTissueShare(LINEAR, 20, "below")).toBe(40);
  });

  it("interpolates between percentiles and clamps out of range", () => {
    expect(valueAtPercentile(LINEAR, 80.5)).toBeCloseTo(161);
    expect(valueAtPercentile(LINEAR, -5)).toBe(0);
    expect(valueAtPercentile(LINEAR, 150)).toBe(200);
    expect(percentileOfValue(LINEAR, -1)).toBe(0);
    expect(percentileOfValue(LINEAR, 500)).toBe(100);
  });

  it("round-trips value -> percent -> value", () => {
    for (const value of [0, 3, 41, 160, 199.5, 200]) {
      const share = tissueShareOfThreshold(LINEAR, value, "above");
      expect(thresholdForTissueShare(LINEAR, share, "above")).toBeCloseTo(
        value,
      );
      const below = tissueShareOfThreshold(LINEAR, value, "below");
      expect(thresholdForTissueShare(LINEAR, below, "below")).toBeCloseTo(
        value,
      );
    }
    expect(tissueShareOfThreshold(LINEAR, 160, "above")).toBe(20);
    expect(tissueShareOfThreshold(LINEAR, 40, "below")).toBe(20);
  });

  it("puts a value shared by many percentiles in the middle of its run", () => {
    // Half the tissue is exactly 0 (e.g. a density map with empty areas).
    const plateau = Array.from({ length: 101 }, (_, i) =>
      i <= 50 ? 0 : i - 50,
    );
    expect(percentileOfValue(plateau, 0)).toBe(25);
    expect(percentileOfValue(plateau, 10)).toBe(60);
  });

  it("states the threshold in both forms the worker takes", () => {
    expect(workerThresholdForms(LINEAR, 160, "above")).toEqual([
      { type: "Top percent of tissue", threshold: "20" },
      { type: "Value at least", threshold: "160" },
    ]);
    expect(workerThresholdForms(LINEAR, 9, "below")).toEqual([
      { type: "Bottom percent of tissue", threshold: "4.5" },
      { type: "Value at most", threshold: "9" },
    ]);
  });
});

describe("scalarMap display helpers", () => {
  it("finds the location key for a viewer position, or null", () => {
    expect(scalarMapLocationKey(meta(), 1, 2, 3)).toBe("xy1_z2_t3");
    expect(scalarMapLocationKey(meta(), 1, 0, 0)).toBeNull();
  });

  it("formats values and shares", () => {
    expect(formatMapValue(1234.567)).toBe("1230");
    expect(formatMapValue(0.04567)).toBe("0.0457");
    expect(formatMapValue(0)).toBe("0");
    expect(formatMapValue(NaN)).toBe("–");
    expect(formatMapValue(2.5e6)).toBe("2.50e+6");
    expect(formatShare(4.56)).toBe("4.6");
    expect(formatShare(42.4)).toBe("42");
  });

  it("has a legend gradient for every colormap offered", () => {
    for (const { value } of SCALAR_MAP_COLORMAPS) {
      expect(SCALAR_MAP_COLORMAP_STOPS[value].length).toBeGreaterThan(1);
      expect(colormapGradientCss(value)).toContain(
        SCALAR_MAP_COLORMAP_STOPS[value][0],
      );
    }
  });

  it("summarizes statistic, property and radius", () => {
    expect(scalarMapSummary(meta())).toBe(
      "Mean · Blob metrics/Area · radius 50 µm",
    );
    expect(scalarMapSummary(meta({ statistic: "Density" }))).toBe(
      "Density · radius 50 µm",
    );
    expect(
      scalarMapSummary(meta({ statistic: "Fraction above cutoff", cutoff: 2 })),
    ).toBe("Fraction above cutoff 2 · Blob metrics/Area · radius 50 µm");
  });
});
