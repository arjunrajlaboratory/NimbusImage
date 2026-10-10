import { describe, it, expect } from "vitest";
import {
  clampLocationIndex,
  clampLocationToDataset,
} from "@/utils/datasetLocation";

describe("clampLocationIndex", () => {
  it("keeps an index that is in range", () => {
    expect(clampLocationIndex(3, 5)).toBe(3);
    expect(clampLocationIndex(0, 1)).toBe(0);
    expect(clampLocationIndex(4, 5)).toBe(4);
  });

  it("clamps an index past the end to the last index", () => {
    expect(clampLocationIndex(12, 1)).toBe(0);
    expect(clampLocationIndex(5, 5)).toBe(4);
  });

  it("clamps a negative index to 0", () => {
    expect(clampLocationIndex(-1, 5)).toBe(0);
  });

  it("maps non-finite values to 0", () => {
    expect(clampLocationIndex(NaN, 5)).toBe(0);
    expect(clampLocationIndex(Infinity, 5)).toBe(0);
    expect(clampLocationIndex(-Infinity, 5)).toBe(0);
  });

  it("truncates a fractional index", () => {
    expect(clampLocationIndex(2.7, 5)).toBe(2);
  });

  it("returns 0 for an empty axis", () => {
    expect(clampLocationIndex(3, 0)).toBe(0);
  });
});

describe("clampLocationToDataset", () => {
  const dataset = {
    xy: [0],
    z: [0],
    time: Array.from({ length: 42 }, (_, i) => i),
  };

  it("clamps every axis to the dataset's dimensions", () => {
    expect(clampLocationToDataset({ xy: 12, z: 3, time: 50 }, dataset)).toEqual(
      { xy: 0, z: 0, time: 41 },
    );
  });

  it("leaves a valid location unchanged", () => {
    expect(clampLocationToDataset({ xy: 0, z: 0, time: 17 }, dataset)).toEqual({
      xy: 0,
      z: 0,
      time: 17,
    });
  });
});
