import { describe, it, expect, vi } from "vitest";
import {
  hashString,
  selectRandomSubset,
  estimateAnnotationRadius,
  getStubStyleFromBaseStyle,
  annotationTestPoints,
  idsNeedingHydration,
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
  it("matches the full-annotation edge stroke (width and opacity)", () => {
    // The stub circle should read like the real annotation's outline, not a
    // thinner/lighter variant — only its shape (circle) and fill distinguish it.
    const style = getStubStyleFromBaseStyle();
    expect(style.strokeWidth).toBe(4);
    expect(style.strokeOpacity).toBe(1);
  });

  it("thickens the stroke when selected, matching full annotations", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, true);
    expect(style.strokeWidth).toBe(6);
  });

  it("thickens the stroke when hovered, matching full annotations", () => {
    const style = getStubStyleFromBaseStyle(undefined, true, false);
    expect(style.strokeWidth).toBe(5);
  });

  it("matches the full-annotation fill opacity (defaults to 0.5, honors the passed value)", () => {
    // The stub fill should equal the real annotation's (store.annotationOpacity,
    // threaded in by the caller); the default mirrors the full-annotation default.
    expect(getStubStyleFromBaseStyle().fillOpacity).toBe(0.5);
    expect(
      getStubStyleFromBaseStyle(undefined, false, false, 5, 1, 0.3).fillOpacity,
    ).toBe(0.3);
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

  it("defaults scaled to 1 when not provided", () => {
    expect(getStubStyleFromBaseStyle().scaled).toBe(1);
  });

  it("applies the provided scaled value so stubs track world size", () => {
    // estimatedRadius is in world units; a GeoJS point with scaled=N renders
    // radius * 2^(zoom - N), which matches the annotation's true footprint only
    // when N = log2(unitsPerPixel(0)) (e.g. 5 for a unitsPerPixel(0)=32 pyramid).
    const style = getStubStyleFromBaseStyle(undefined, false, false, 20, 5);
    expect(style.scaled).toBe(5);
    expect(style.radius).toBe(20);
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

describe("idsNeedingHydration", () => {
  const stubs = new Map([
    ["a", {}],
    ["b", {}],
    ["c", {}],
  ]);

  it("returns known stubs that are not already hydrated", () => {
    const hydrated = new Map([["a", {}]]);
    expect(idsNeedingHydration(["a", "b", "c"], hydrated, stubs)).toEqual([
      "b",
      "c",
    ]);
  });

  it("skips ids already in the hydration cache", () => {
    const hydrated = new Map([
      ["a", {}],
      ["b", {}],
      ["c", {}],
    ]);
    expect(idsNeedingHydration(["a", "b", "c"], hydrated, stubs)).toEqual([]);
  });

  it("skips ids that are not known stubs", () => {
    const hydrated = new Map<string, unknown>();
    expect(idsNeedingHydration(["a", "unknown"], hydrated, stubs)).toEqual([
      "a",
    ]);
  });

  it("deduplicates repeated ids", () => {
    const hydrated = new Map<string, unknown>();
    expect(idsNeedingHydration(["a", "a", "b"], hydrated, stubs)).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(idsNeedingHydration([], new Map(), stubs)).toEqual([]);
  });
});
