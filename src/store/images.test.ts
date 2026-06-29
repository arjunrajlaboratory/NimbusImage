import { describe, expect, it } from "vitest";
import { mergeHistograms, ITileHistogram } from "@/store/images";

function makeHistogram(
  overrides: Partial<ITileHistogram> = {},
): ITileHistogram {
  return {
    hist: [1, 2, 3, 4],
    bin_edges: [0, 25, 50, 75, 100],
    min: 0,
    max: 100,
    samples: 10,
    ...overrides,
  };
}

describe("mergeHistograms", () => {
  it("returns a placeholder with renderable bins for no histograms", () => {
    const merged = mergeHistograms([]);
    expect(merged.hist.length).toBeGreaterThan(0);
    expect(merged.samples).toBe(0);
  });

  it("returns the single histogram unchanged", () => {
    const only = makeHistogram();
    expect(mergeHistograms([only])).toBe(only);
  });

  it("preserves renderable bins when merging multiple histograms", () => {
    // Regression: a max-merge (multi-frame) layer must still hand the contrast
    // UI a non-empty `hist`, otherwise ContrastHistogram renders nothing.
    const merged = mergeHistograms([
      makeHistogram({ hist: [5, 6, 7], min: 10, max: 80, samples: 4 }),
      makeHistogram({ hist: [1, 2, 3], min: 0, max: 120, samples: 6 }),
    ]);
    expect(merged.hist.length).toBeGreaterThan(0);
    expect(merged.hist).toEqual([5, 6, 7]);
  });

  it("widens min/max and sums samples across frames", () => {
    const merged = mergeHistograms([
      makeHistogram({ min: 10, max: 80, samples: 4 }),
      makeHistogram({ min: 0, max: 120, samples: 6 }),
    ]);
    expect(merged.min).toBe(0);
    expect(merged.max).toBe(120);
    expect(merged.samples).toBe(10);
  });
});
