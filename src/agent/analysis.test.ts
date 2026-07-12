import { describe, it, expect } from "vitest";
import {
  roundSignificant,
  downsample,
  resolvePathValue,
  computeStats,
  uniformHistogram,
  SIGNIFICANT_DIGITS,
} from "./analysis";

describe("roundSignificant", () => {
  it("rounds to 6 significant digits", () => {
    expect(SIGNIFICANT_DIGITS).toBe(6);
    expect(roundSignificant(1.23456789)).toBe(1.23457);
    expect(roundSignificant(123456789)).toBe(123457000);
  });

  it("passes through 0, null, and negatives", () => {
    expect(roundSignificant(0)).toBe(0);
    expect(roundSignificant(null)).toBeNull();
    expect(roundSignificant(-1.23456789)).toBe(-1.23457);
  });

  it("handles very small and very large magnitudes", () => {
    expect(roundSignificant(0.000123456789)).toBe(0.000123457);
    expect(roundSignificant(1.23456789e21)).toBe(1.23457e21);
  });

  it("passes non-finite values through unchanged", () => {
    expect(roundSignificant(Infinity)).toBe(Infinity);
    expect(roundSignificant(-Infinity)).toBe(-Infinity);
    expect(roundSignificant(NaN)).toBeNaN();
  });
});

describe("downsample", () => {
  it("returns the same array and false when n <= limit", () => {
    const items = [1, 2, 3];
    const [sampled, wasDownsampled] = downsample(items, 3);
    expect(sampled).toBe(items);
    expect(wasDownsampled).toBe(false);
  });

  it("takes every k-th item, preserving the first, when n > limit", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const [sampled, wasDownsampled] = downsample(items, 4);
    // step = ceil(10 / 4) = 3 → indices 0, 3, 6, 9
    expect(sampled).toEqual([0, 3, 6, 9]);
    expect(sampled.length).toBeLessThanOrEqual(4);
    expect(sampled[0]).toBe(0);
    expect(wasDownsampled).toBe(true);
  });

  it("is deterministic and never exceeds the limit", () => {
    const items = Array.from({ length: 101 }, (_, i) => i);
    const [a] = downsample(items, 50);
    const [b] = downsample(items, 50);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(50);
  });
});

describe("resolvePathValue", () => {
  const values = {
    propA: { sub1: 5, sub2: "text" },
    propB: 42,
    propC: { sub1: NaN },
  };

  it("resolves a nested numeric leaf", () => {
    expect(resolvePathValue(values, ["propA", "sub1"])).toBe(5);
    expect(resolvePathValue(values, ["propB"])).toBe(42);
  });

  it("returns null for a missing segment", () => {
    expect(resolvePathValue(values, ["propA", "missing"])).toBeNull();
    expect(resolvePathValue(values, ["missing", "sub"])).toBeNull();
  });

  it("returns null for a non-numeric leaf", () => {
    expect(resolvePathValue(values, ["propA", "sub2"])).toBeNull();
    // Descending into a number is not an object → null
    expect(resolvePathValue(values, ["propB", "sub"])).toBeNull();
  });

  it("returns null for a NaN leaf", () => {
    expect(resolvePathValue(values, ["propC", "sub1"])).toBeNull();
  });
});

describe("computeStats", () => {
  it("matches hand-computed values for [1,2,3,4]", () => {
    const stats = computeStats([1, 2, 3, 4]);
    expect(stats.count).toBe(4);
    expect(stats.mean).toBe(2.5);
    expect(stats.std).toBeCloseTo(1.29099, 5);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
    expect(stats.median).toBe(2.5);
    expect(stats.p25).toBe(1.75);
    expect(stats.p75).toBe(3.25);
  });

  it("sorts unordered input before computing percentiles", () => {
    const stats = computeStats([4, 1, 3, 2]);
    expect(stats.median).toBe(2.5);
    expect(stats.p25).toBe(1.75);
    expect(stats.p75).toBe(3.25);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
  });

  it("handles count === 1 (std 0, all percentiles equal the value)", () => {
    const stats = computeStats([7]);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBe(7);
    expect(stats.std).toBe(0);
    expect(stats.min).toBe(7);
    expect(stats.max).toBe(7);
    expect(stats.median).toBe(7);
    expect(stats.p25).toBe(7);
    expect(stats.p75).toBe(7);
  });
});

describe("uniformHistogram", () => {
  it("keeps counts summing to input length with the max in the last bucket", () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const buckets = uniformHistogram(values, 5);
    expect(buckets).toHaveLength(5);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(values.length);
    // 10 is the max value and belongs to the last bucket
    expect(buckets[buckets.length - 1].count).toBeGreaterThan(0);
  });

  it("has contiguous bucket bounds and keeps zero-count buckets", () => {
    // A gap at the middle leaves interior buckets empty but present.
    const buckets = uniformHistogram([0, 0, 10, 10], 5);
    expect(buckets).toHaveLength(5);
    for (let i = 0; i < buckets.length - 1; i++) {
      expect(buckets[i + 1].min).toBe(buckets[i].max);
    }
    expect(buckets.some((b) => b.count === 0)).toBe(true);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(4);
  });

  it("collapses constant data to a single bucket", () => {
    const buckets = uniformHistogram([3, 3, 3], 10);
    expect(buckets).toEqual([{ min: 3, max: 3, count: 3 }]);
  });

  it("collapses to a single bucket when buckets <= 1", () => {
    const buckets = uniformHistogram([1, 2, 3, 4], 1);
    expect(buckets).toEqual([{ min: 1, max: 4, count: 4 }]);
  });
});
