import { describe, it, expect, vi } from "vitest";
import {
  hashString,
  selectRandomSubset,
  estimateAnnotationRadius,
  getStubStyleFromBaseStyle,
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

  it("computes bounding box diagonal / 2 for polygon", () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const expected = Math.sqrt(200) / 2;
    expect(estimateAnnotationRadius(coords)).toBeCloseTo(expected);
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

  it("enforces minimum radius of 3", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, false, 1);
    expect(style.radius).toBe(3);
  });

  it("applies annotation color when provided", () => {
    const style = getStubStyleFromBaseStyle("red");
    expect(style.fillColor).toBe("red");
  });
});
