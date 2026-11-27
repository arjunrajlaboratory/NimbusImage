import { describe, it, expect } from "vitest";
import {
  SLIDER_POSITIONS,
  displayValueRange,
  formatExactValue,
  formatMapValue,
  formatShare,
  isValidScalarMap,
  percentileBounds,
  scalarMapLocationKey,
  scalarMapSummary,
  scalarMapTitle,
  selectedTissueShare,
  separatedRangePositions,
  sliderPositionToValue,
  thresholdForTissueShare,
  thresholdShare,
  valueAtPercentile,
  valueToSliderPosition,
  workerThresholdForms,
} from "./scalarMap";
import { IScalarMapMeta } from "@/store/model";
import ScalarMapAPI from "@/store/ScalarMapAPI";

// 0th..100th percentiles of a uniform 0..200 distribution: p[i] = 2i.
const LINEAR = Array.from({ length: 101 }, (_, i) => 2 * i);
// 60% of the tissue sits exactly at the minimum 0, then 1..40.
const TIED = Array.from({ length: 101 }, (_, i) => (i <= 60 ? 0 : i - 60));

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
    expect(percentileBounds(LINEAR, -1)).toEqual([0, 0]);
    expect(percentileBounds(LINEAR, 500)).toEqual([100, 100]);
  });

  it("round-trips value -> share -> value without ties", () => {
    for (const value of [0.5, 3, 41, 160, 199.5]) {
      for (const side of ["above", "below"] as const) {
        const share = selectedTissueShare(LINEAR, value, side);
        expect(thresholdForTissueShare(LINEAR, share, side)).toBeCloseTo(value);
      }
    }
    expect(selectedTissueShare(LINEAR, 160, "above")).toBe(20);
    expect(selectedTissueShare(LINEAR, 40, "below")).toBe(20);
  });

  it("counts tied values with the selected side, as the inclusive cutoff does", () => {
    expect(percentileBounds(TIED, 0)).toEqual([0, 60]);
    // Bottom 50% asks for the value 0, and `<= 0` selects 60% of tissue.
    const threshold = thresholdForTissueShare(TIED, 50, "below");
    expect(threshold).toBe(0);
    expect(thresholdShare(TIED, threshold, "below", 50)).toEqual({
      requested: 50,
      selected: 60,
      tied: true,
    });
    // `>= 0` selects everything.
    expect(selectedTissueShare(TIED, 0, "above")).toBe(100);
    // Off the tie, the request is what is selected.
    expect(
      thresholdShare(
        TIED,
        thresholdForTissueShare(TIED, 20, "above"),
        "above",
        20,
      ),
    ).toEqual({
      requested: 20,
      selected: 20,
      tied: false,
    });
    // Set by value: nothing was requested, nothing is tied.
    expect(thresholdShare(TIED, 0, "below", null).tied).toBe(false);
  });
});

describe("scalarMap worker threshold forms", () => {
  it("gives a whole percentile exactly and the value at full precision", () => {
    expect(workerThresholdForms(LINEAR, 160, "above", 20)).toEqual([
      { type: "Top percent of tissue", threshold: "20", approximate: false },
      { type: "Value at least", threshold: "160", approximate: false },
    ]);
    // float32-ish cutoff: every digit needed to reproduce the preview.
    const percentiles = LINEAR.map((value) => value * 0.123456789);
    const cutoff = percentiles[80];
    expect(workerThresholdForms(percentiles, cutoff, "above", 20)).toEqual([
      { type: "Top percent of tissue", threshold: "20", approximate: false },
      { type: "Value at least", threshold: String(cutoff), approximate: false },
    ]);
  });

  it("copies the exact cutoff the tile route is sent, not a rounded one", () => {
    // float32 0.3 as a double. Nine significant digits gave "0.300000012",
    // above this plateau, so the worker's inclusive >= would exclude cells
    // the preview selected at this cutoff.
    const plateau = Math.fround(0.3);
    expect(plateau).toBe(0.30000001192092896);
    const percentiles = LINEAR.map((_, i) => (i <= 50 ? 0 : plateau));
    const [, valueForm] = workerThresholdForms(
      percentiles,
      plateau,
      "above",
      null,
    );
    expect(valueForm.threshold).toBe("0.30000001192092896");
    expect(Number(valueForm.threshold)).toBe(plateau);
    const tileUrl = new ScalarMapAPI({
      apiRoot: "http://host/api/v1",
    } as any).tileTemplateUrl({
      itemId: "item1",
      location: "xy0_z0_t0",
      sizeX: 1024,
      sizeY: 1024,
      tileSize: 256,
      maxLevel: 2,
      colormap: "viridis",
      min: 0,
      max: 1,
      threshold: plateau,
      thresholdSide: "above",
    });
    expect(new URL(tileUrl).searchParams.get("threshold")).toBe(
      valueForm.threshold,
    );
  });

  it("marks a fractional or derived percent as approximate", () => {
    const fractional = workerThresholdForms(
      LINEAR,
      thresholdForTissueShare(LINEAR, 20.5, "above"),
      "above",
      20.5,
    );
    // Shown exactly as set (the slider steps by 0.5), never rounded to a
    // different percentile.
    expect(fractional[0]).toEqual({
      type: "Top percent of tissue",
      threshold: "20.5",
      approximate: true,
    });
    const twelveAndHalf = workerThresholdForms(
      LINEAR,
      thresholdForTissueShare(LINEAR, 12.5, "below"),
      "below",
      12.5,
    );
    expect(twelveAndHalf[0].threshold).toBe("12.5");
    // Set by value, between percentiles.
    expect(workerThresholdForms(LINEAR, 9, "below", null)[0]).toEqual({
      type: "Bottom percent of tissue",
      threshold: "4.5",
      approximate: true,
    });
    // Set by value, landing on a whole percentile.
    expect(workerThresholdForms(LINEAR, 40, "below", null)[0]).toEqual({
      type: "Bottom percent of tissue",
      threshold: "20",
      approximate: false,
    });
  });
});

describe("scalarMap ranges and sliders", () => {
  it("widens a constant map's range by the server's rule", () => {
    expect(displayValueRange([3, 3])).toEqual([2.5, 3.5]);
    expect(displayValueRange([0, 0])).toEqual([-0.5, 0.5]);
    expect(displayValueRange([1, 4])).toEqual([1, 4]);
  });

  it("keeps a constant map's range open at large magnitudes", () => {
    // v ± 0.5 rounds back to v above 2^53.
    const [low, high] = displayValueRange([1e17, 1e17]);
    expect(low).toBe(1e17 - 1e11);
    expect(high).toBe(1e17 + 1e11);
    expect(low < 1e17 && 1e17 < high).toBe(true);
    expect(displayValueRange([-1e17, -1e17])).toEqual([
      -1e17 - 1e11,
      -1e17 + 1e11,
    ]);
  });

  it.each([
    [1e-7, 2e-7],
    [0, 1],
    [-5e5, 5e5],
  ])(
    "maps integer positions over [%d, %d] without losing values",
    (low, high) => {
      const range: [number, number] = [low, high];
      expect(sliderPositionToValue(0, range)).toBe(low);
      expect(sliderPositionToValue(SLIDER_POSITIONS, range)).toBe(high);
      const middle = sliderPositionToValue(500, range);
      expect(Math.abs(middle - (low + high) / 2)).toBeLessThanOrEqual(
        (high - low) * 1e-12,
      );
      expect(valueToSliderPosition(middle, range)).toBe(500);
      for (const position of [0, 1, 250, 999, 1000]) {
        const value = sliderPositionToValue(position, range);
        expect(Number.isInteger(valueToSliderPosition(value, range))).toBe(
          true,
        );
        expect(valueToSliderPosition(value, range)).toBe(position);
      }
      // Out-of-range values clamp to the ends.
      expect(valueToSliderPosition(low - (high - low), range)).toBe(0);
      expect(valueToSliderPosition(high + (high - low), range)).toBe(
        SLIDER_POSITIONS,
      );
    },
  );
});

describe("scalarMap validation", () => {
  const good = { itemId: "a", updated: "u", revision: "r", meta: meta() };

  it("accepts a well-formed map", () => {
    expect(isValidScalarMap(good)).toBe(true);
  });

  it.each([
    ["no meta", { itemId: "a" }],
    ["short percentiles", { ...good, meta: meta({ percentiles: [1, 2] }) }],
    [
      "decreasing percentiles",
      { ...good, meta: meta({ percentiles: [...LINEAR].reverse() }) },
    ],
    [
      "non-finite percentile",
      {
        ...good,
        meta: meta({ percentiles: LINEAR.map((v, i) => (i === 5 ? NaN : v)) }),
      },
    ],
    [
      "bad value range",
      { ...good, meta: meta({ valueRange: [2, 1] as [number, number] }) },
    ],
    ["no locations", { ...good, meta: meta({ locations: undefined as any }) }],
    ["not an object", "nope"],
  ])("rejects %s", (_label, map) => {
    expect(isValidScalarMap(map)).toBe(false);
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
    // Full precision: exactly the double, never rounded.
    expect(formatExactValue(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(formatExactValue(1.23456789e-7)).toBe("1.23456789e-7");
    expect(formatShare(4.56)).toBe("4.6");
    expect(formatShare(42.4)).toBe("42");
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

  it("falls back for a map missing its descriptive fields", () => {
    const bare = meta({
      name: undefined as any,
      statistic: undefined as any,
      property: undefined as any,
      radius: undefined as any,
      radiusUnit: undefined as any,
    });
    expect(scalarMapTitle(bare)).toBe("Untitled map");
    expect(scalarMapSummary(bare)).toBe("");
    expect(scalarMapSummary({ ...bare, radius: 30 })).toBe("radius 30");
    expect(scalarMapTitle(meta({ name: "  " }))).toBe("Untitled map");
    expect(scalarMapTitle(meta())).toBe("Blob metrics/Area mean, 50 µm");
  });
});

describe("scalarMap whole percentiles", () => {
  // Uneven, strictly increasing, with no float-friendly spacing.
  const UNEVEN = Array.from({ length: 101 }, (_, i) => i * 1.37 + i * i * 0.01);

  it("maps every whole percent to exactly its stored percentile, reported exact", () => {
    for (let percent = 0; percent <= 100; percent++) {
      expect(thresholdForTissueShare(UNEVEN, percent, "below")).toBe(
        UNEVEN[percent],
      );
      expect(thresholdForTissueShare(UNEVEN, percent, "above")).toBe(
        UNEVEN[100 - percent],
      );
      for (const side of ["above", "below"] as const) {
        const cutoff = thresholdForTissueShare(UNEVEN, percent, side);
        expect(workerThresholdForms(UNEVEN, cutoff, side, percent)[0]).toEqual({
          type:
            side === "above"
              ? "Top percent of tissue"
              : "Bottom percent of tissue",
          threshold: percent.toString(),
          approximate: false,
        });
        expect(selectedTissueShare(UNEVEN, cutoff, side)).toBe(percent);
      }
    }
  });

  it("includes a tie run that starts at a whole percentile", () => {
    // percentiles[29..40] are equal: bottom 29% must select the whole run.
    // (29 is one of the percents `(p / 100) * 100` put a hair BELOW p.)
    const run = LINEAR.map((value, i) => (i >= 29 && i <= 40 ? 58 : value));
    const cutoff = thresholdForTissueShare(run, 29, "below");
    expect(cutoff).toBe(58);
    expect(selectedTissueShare(run, cutoff, "below")).toBe(40);
  });
});

describe("scalarMap share estimates", () => {
  it("calls a difference a tie only when the cutoff sits on a run of equal percentiles", () => {
    // Two cells valued 0 and 1: the pooled percentiles interpolate between
    // them, so top 20% is the cutoff 0.8 with no tie, even though it selects
    // one of the two cells.
    const twoCells = Array.from({ length: 101 }, (_, i) => i / 100);
    const cutoff = thresholdForTissueShare(twoCells, 20, "above");
    expect(cutoff).toBeCloseTo(0.8);
    expect(thresholdShare(twoCells, cutoff, "above", 20).tied).toBe(false);
    // On a real tie run it is a tie.
    expect(thresholdShare(TIED, 0, "below", 50).tied).toBe(true);
  });
});

describe("scalarMap range positions", () => {
  it("keeps the range thumbs at least one position apart instead of dropping the update", () => {
    expect(separatedRangePositions([100, 900], [0, 1000])).toEqual([100, 900]);
    // The low thumb moved onto the high one.
    expect(separatedRangePositions([500, 500], [499, 500])).toEqual([499, 500]);
    expect(separatedRangePositions([1000, 1000], [10, 1000])).toEqual([
      999, 1000,
    ]);
    // The high thumb moved onto the low one.
    expect(separatedRangePositions([300, 300], [300, 600])).toEqual([300, 301]);
    expect(separatedRangePositions([0, 0], [0, 50])).toEqual([0, 1]);
  });
});
