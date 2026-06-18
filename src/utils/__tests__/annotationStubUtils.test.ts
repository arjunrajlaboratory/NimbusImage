import { describe, it, expect, vi } from "vitest";
import {
  hashString,
  selectRandomSubset,
  estimateAnnotationRadius,
  getStubStyleFromBaseStyle,
  annotationTestPoints,
} from "../annotation";

vi.mock("geojs", () => ({
  default: {
    util: {
      convertColor: vi.fn((color: string) => {
        if (color === "red") return { r: 1, g: 0, b: 0 };
        return { r: 0.5, g: 0.5, b: 0.5 };
      }),
    },
  },
}));

describe("hashString", () => {
  it("returns a number", () => {
    expect(typeof hashString("test")).toBe("number");
  });

  it("is deterministic", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
  });

  it("returns unsigned 32-bit integer", () => {
    const hash = hashString("test");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("produces different hashes for different strings", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
  });
});

describe("selectRandomSubset", () => {
  it("returns all if under limit", () => {
    const ids = ["a", "b", "c"];
    expect(selectRandomSubset(ids, 5)).toEqual(ids);
  });

  it("returns exactly maxCount if over limit", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    expect(selectRandomSubset(ids, 10)).toHaveLength(10);
  });

  it("is deterministic", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    expect(selectRandomSubset(ids, 10)).toEqual(selectRandomSubset(ids, 10));
  });
});

describe("estimateAnnotationRadius", () => {
  it("returns default for single point", () => {
    expect(estimateAnnotationRadius([{ x: 10, y: 20 }])).toBe(5);
  });

  it("computes max bbox half-extent for polygon", () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // max(width, height) / 2 = max(10, 10) / 2 = 5
    expect(estimateAnnotationRadius(coords)).toBe(5);
  });

  it("uses the larger dimension for non-square bbox", () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ];
    // max(20, 10) / 2 = 10
    expect(estimateAnnotationRadius(coords)).toBe(10);
  });
});

describe("getStubStyleFromBaseStyle", () => {
  it("returns a style with thinner stroke than full annotations", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.strokeWidth).toBe(2);
  });

  it("uses lower fill opacity", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.fillOpacity).toBe(0.4);
  });

  it("uses default radius of 5 when no estimatedRadius provided", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.radius).toBe(5);
  });

  it("uses estimatedRadius when provided", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, false, 20);
    expect(style.radius).toBe(20);
  });

  it("uses estimatedRadius as-is without minimum", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, false, 1);
    expect(style.radius).toBe(1);
  });

  it("applies annotation color when provided", () => {
    const style = getStubStyleFromBaseStyle("red");
    expect(style.fillColor).toBe("red");
  });
});

describe("annotationTestPoints", () => {
  it("returns the annotation coordinates when present", () => {
    const coords = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    expect(annotationTestPoints({ coordinates: coords }, undefined)).toBe(
      coords,
    );
  });

  it("falls back to the centroid when coordinates are absent (stub)", () => {
    const centroid = { x: 5, y: 6 };
    expect(annotationTestPoints({}, centroid)).toEqual([centroid]);
  });

  it("falls back to the centroid when coordinates is an empty array", () => {
    const centroid = { x: 7, y: 8 };
    expect(annotationTestPoints({ coordinates: [] }, centroid)).toEqual([
      centroid,
    ]);
  });

  it("returns an empty array when neither coordinates nor centroid exist", () => {
    expect(annotationTestPoints({}, undefined)).toEqual([]);
  });
});
