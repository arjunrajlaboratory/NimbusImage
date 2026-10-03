import { describe, expect, it } from "vitest";
import {
  computeAutoSizeRange,
  computeComponentAreas,
  filterComponentsBySize,
  labelConnectedComponents,
  thresholdProbabilityMap,
  traceAllContours,
  traceBoundary,
} from "@/utils/exampleSegmentation/postprocess";

function maskFromRows(rows: string[]): {
  mask: Uint8Array;
  width: number;
  height: number;
} {
  const height = rows.length;
  const width = rows[0].length;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      mask[y * width + x] = rows[y][x] === "#" ? 1 : 0;
    }
  }
  return { mask, width, height };
}

describe("thresholdProbabilityMap", () => {
  it("keeps values >= threshold", () => {
    const map = Float32Array.from([0, 0.3, 0.5, 0.7, 1]);
    const mask = thresholdProbabilityMap(map, 0.5);
    expect(Array.from(mask)).toEqual([0, 0, 1, 1, 1]);
  });
});

describe("labelConnectedComponents", () => {
  it("counts two separate 4-connected blobs", () => {
    const { mask, width, height } = maskFromRows([
      "##...",
      "##...",
      "...##",
      "...##",
    ]);
    const { labels, componentCount } = labelConnectedComponents(
      mask,
      width,
      height,
    );
    expect(componentCount).toBe(2);
    expect(labels[0]).toBe(labels[width + 1]);
    expect(labels[0]).not.toBe(labels[2 * width + 3]);
  });

  it("merges components touching only at a diagonal (8-connectivity)", () => {
    const { mask, width, height } = maskFromRows(["#..", ".#.", "..#"]);
    const { labels, componentCount } = labelConnectedComponents(
      mask,
      width,
      height,
    );
    expect(componentCount).toBe(1);
    expect(labels[0]).toBe(labels[width + 1]);
    expect(labels[0]).toBe(labels[2 * width + 2]);
  });

  it("returns zero components for an empty mask", () => {
    const mask = new Uint8Array(9);
    const { componentCount } = labelConnectedComponents(mask, 3, 3);
    expect(componentCount).toBe(0);
  });

  it("computes correct areas per component", () => {
    const { mask, width, height } = maskFromRows(["###", "...", ".##"]);
    const { labels, componentCount } = labelConnectedComponents(
      mask,
      width,
      height,
    );
    expect(componentCount).toBe(2);
    const areas = computeComponentAreas(labels, componentCount);
    const sorted = Array.from(areas.slice(1)).sort((a, b) => a - b);
    expect(sorted).toEqual([2, 3]);
  });
});

describe("computeAutoSizeRange", () => {
  it("returns null when there are no examples", () => {
    expect(computeAutoSizeRange([])).toBeNull();
  });

  it("computes [0.25*median, 4*median] for odd-length input", () => {
    const range = computeAutoSizeRange([10, 20, 30]);
    expect(range).toEqual({ min: 5, max: 80 });
  });

  it("computes the median correctly for even-length input", () => {
    const range = computeAutoSizeRange([10, 20, 30, 40]);
    // median = (20+30)/2 = 25
    expect(range).toEqual({ min: 6.25, max: 100 });
  });
});

describe("filterComponentsBySize", () => {
  it("keeps areas within [min, max] inclusive", () => {
    const areas = Uint32Array.from([0, 5, 10, 15, 20]); // index 0 unused
    const keep = filterComponentsBySize(areas, 10, 15);
    expect(keep.slice(1)).toEqual([false, true, true, false]);
  });
});

describe("traceBoundary", () => {
  it("traces the boundary of a solid square", () => {
    const { mask, width, height } = maskFromRows([
      ".....",
      ".###.",
      ".###.",
      ".###.",
      ".....",
    ]);
    const { labels } = labelConnectedComponents(mask, width, height);
    const boundary = traceBoundary(labels, width, height, 1, 1, 1);

    // Boundary of a solid 3x3 square is its full 8-pixel perimeter (interior
    // pixel(s) aren't part of the outer boundary trace for a filled square this small).
    expect(boundary.length).toBe(8);
    const asSet = new Set(boundary.map((p) => `${p.x},${p.y}`));
    for (let x = 1; x <= 3; ++x) {
      expect(asSet.has(`${x},1`)).toBe(true);
      expect(asSet.has(`${x},3`)).toBe(true);
    }
    for (let y = 1; y <= 3; ++y) {
      expect(asSet.has(`1,${y}`)).toBe(true);
      expect(asSet.has(`3,${y}`)).toBe(true);
    }
  });

  it("returns a single point for an isolated pixel", () => {
    const { mask, width, height } = maskFromRows(["...", ".#.", "..."]);
    const { labels } = labelConnectedComponents(mask, width, height);
    const boundary = traceBoundary(labels, width, height, 1, 1, 1);
    expect(boundary).toEqual([{ x: 1, y: 1 }]);
  });

  it("traces a non-square rectangle in order around the perimeter", () => {
    const { mask, width, height } = maskFromRows([
      "......",
      ".####.",
      ".####.",
      "......",
    ]);
    const { labels } = labelConnectedComponents(mask, width, height);
    const boundary = traceBoundary(labels, width, height, 1, 1, 1);
    // Perimeter of a 4x2 solid rectangle: 2*(4+2) - 4 = 8 boundary pixels.
    expect(boundary.length).toBe(8);
    // Every traced point should be adjacent (including diagonally) to the next.
    for (let i = 0; i < boundary.length; ++i) {
      const a = boundary[i];
      const b = boundary[(i + 1) % boundary.length];
      expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBe(1);
    }
  });
});

describe("traceAllContours", () => {
  it("only traces kept components", () => {
    const { mask, width, height } = maskFromRows(["#....", "....#", "....."]);
    const { labels, componentCount } = labelConnectedComponents(
      mask,
      width,
      height,
    );
    expect(componentCount).toBe(2);
    const keep = [false, true, false]; // keep only label 1
    const contours = traceAllContours(
      labels,
      width,
      height,
      componentCount,
      keep,
    );
    expect(contours.length).toBe(1);
    expect(contours[0]).toEqual([{ x: 0, y: 0 }]);
  });
});
