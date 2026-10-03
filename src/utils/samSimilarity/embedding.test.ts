import { describe, expect, it } from "vitest";
import {
  IEmbeddingGrid,
  computeSimilarityMap,
  findSimilarityPeaks,
  maskIoU,
  meanMaskSimilarity,
  normalizeEmbeddingCells,
  polygonToCellMask,
  poolDescriptor,
  scoreDescriptor,
} from "@/utils/samSimilarity/embedding";
import { rasterizePolygon } from "@/utils/exampleSegmentation/rasterize";

/** Builds a CHW-layout grid from per-cell vectors, row-major over (y, x). */
function buildGrid(
  cellsRowMajor: number[][],
  gridWidth: number,
  gridHeight: number,
  validGridWidth = gridWidth,
  validGridHeight = gridHeight,
): IEmbeddingGrid {
  const channels = cellsRowMajor[0].length;
  const planeSize = gridWidth * gridHeight;
  const data = new Float32Array(channels * planeSize);
  for (let cellIndex = 0; cellIndex < cellsRowMajor.length; ++cellIndex) {
    for (let c = 0; c < channels; ++c) {
      data[c * planeSize + cellIndex] = cellsRowMajor[cellIndex][c];
    }
  }
  return {
    data,
    channels,
    gridWidth,
    gridHeight,
    validGridWidth,
    validGridHeight,
  };
}

describe("normalizeEmbeddingCells", () => {
  it("L2-normalizes each cell's channel vector", () => {
    // 2 cells, 2 channels: cell0 = (3, 4) -> norm 5; cell1 = zero vector.
    const grid = buildGrid(
      [
        [3, 4],
        [0, 0],
      ],
      2,
      1,
    );
    const normalized = normalizeEmbeddingCells(grid);
    const planeSize = 2;
    // channel0 plane, channel1 plane
    expect(normalized[0 * planeSize + 0]).toBeCloseTo(0.6, 6);
    expect(normalized[1 * planeSize + 0]).toBeCloseTo(0.8, 6);
    let norm = 0;
    for (let c = 0; c < 2; ++c) {
      const v = normalized[c * planeSize + 0];
      norm += v * v;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
  });

  it("leaves zero vectors as zero (no divide-by-zero)", () => {
    const grid = buildGrid([[0, 0]], 1, 1);
    const normalized = normalizeEmbeddingCells(grid);
    expect(Array.from(normalized)).toEqual([0, 0]);
    expect(Number.isNaN(normalized[0])).toBe(false);
  });
});

describe("poolDescriptor", () => {
  it("matches hand-computed mean + renormalization over masked cells", () => {
    // Raw vectors per cell, row-major (y then x) over a 2x2 grid:
    // (0,0)=(3,4)->normalized(0.6,0.8); (1,0)=(0,5)->normalized(0,1)
    // (0,1)=(0,0)->zero;                (1,1)=(1,1)->normalized(~0.7071,~0.7071)
    const grid = buildGrid(
      [
        [3, 4],
        [0, 5],
        [0, 0],
        [1, 1],
      ],
      2,
      2,
    );
    const normalized = normalizeEmbeddingCells(grid);
    // Select the top row only: cells (0,0) and (1,0).
    const cellMask = new Uint8Array([1, 1, 0, 0]);
    const descriptor = poolDescriptor(normalized, grid, cellMask);
    expect(descriptor).not.toBeNull();
    // mean of (0.6,0.8) and (0,1) = (0.3, 0.9); norm sqrt(0.9) -> normalized.
    expect(descriptor![0]).toBeCloseTo(0.31622776602, 6);
    expect(descriptor![1]).toBeCloseTo(0.94868329805, 6);
    let normSquared = 0;
    for (const v of descriptor!) {
      normSquared += v * v;
    }
    expect(Math.sqrt(normSquared)).toBeCloseTo(1, 6);
  });

  it("returns null for an empty mask", () => {
    const grid = buildGrid(
      [
        [1, 0],
        [0, 1],
      ],
      2,
      1,
    );
    const normalized = normalizeEmbeddingCells(grid);
    const emptyMask = new Uint8Array(2);
    expect(poolDescriptor(normalized, grid, emptyMask)).toBeNull();
  });
});

describe("meanMaskSimilarity", () => {
  it("is exactly 1 when all in-mask cells are identical", () => {
    const grid = buildGrid(
      [
        [1, 0],
        [1, 0],
      ],
      2,
      1,
    );
    const normalized = normalizeEmbeddingCells(grid);
    const cellMask = new Uint8Array([1, 1]);
    const descriptor = poolDescriptor(normalized, grid, cellMask)!;
    expect(
      meanMaskSimilarity(normalized, grid, cellMask, descriptor),
    ).toBeCloseTo(1, 10);
  });

  it("is high but not necessarily 1 for a mixed mask, and 0 for an empty mask", () => {
    const grid = buildGrid(
      [
        [3, 4],
        [0, 5],
        [0, 0],
        [1, 1],
      ],
      2,
      2,
    );
    const normalized = normalizeEmbeddingCells(grid);
    const cellMask = new Uint8Array([1, 1, 0, 0]);
    const descriptor = poolDescriptor(normalized, grid, cellMask)!;
    const similarity = meanMaskSimilarity(
      normalized,
      grid,
      cellMask,
      descriptor,
    );
    expect(similarity).toBeGreaterThan(0.9);
    expect(similarity).toBeLessThan(1);

    expect(
      meanMaskSimilarity(normalized, grid, new Uint8Array(4), descriptor),
    ).toBe(0);
  });
});

describe("computeSimilarityMap", () => {
  // 2x2 grid, only cell (0,0) is valid content; the rest is padding.
  const grid = buildGrid(
    [
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
    ],
    2,
    2,
    1,
    1,
  );

  it("marks padding cells as -Infinity", () => {
    const map = computeSimilarityMap(
      grid.data,
      grid,
      [new Float32Array([1, 0])],
      [],
      0,
    );
    expect(map[0]).toBe(1); // cell (0,0): cos((1,0),(1,0)) = 1
    expect(map[1]).toBe(-Infinity); // (1,0): padding
    expect(map[2]).toBe(-Infinity); // (0,1): padding
    expect(map[3]).toBe(-Infinity); // (1,1): padding
  });

  it("reduces the score using negativeWeight * max negative cosine", () => {
    const positives = [new Float32Array([1, 0])];
    const withoutNegatives = computeSimilarityMap(
      grid.data,
      grid,
      positives,
      [],
      0.5,
    );
    const withNegatives = computeSimilarityMap(
      grid.data,
      grid,
      positives,
      [new Float32Array([1, 0])],
      0.5,
    );
    expect(withoutNegatives[0]).toBeCloseTo(1, 6);
    expect(withNegatives[0]).toBeCloseTo(0.5, 6);
  });

  it("returns -Infinity for valid cells when there are no positives", () => {
    const map = computeSimilarityMap(grid.data, grid, [], [], 0);
    expect(map[0]).toBe(-Infinity);
  });
});

describe("scoreDescriptor", () => {
  it("applies max-positive-cosine minus weighted max-negative-cosine", () => {
    const descriptor = new Float32Array([1, 0]);
    const positives = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const negatives = [new Float32Array([1, 0])];
    expect(scoreDescriptor(descriptor, positives, negatives, 0.5)).toBeCloseTo(
      0.5,
      6,
    );
    expect(scoreDescriptor(descriptor, positives, [], 0.5)).toBeCloseTo(1, 6);
  });

  it("is -Infinity when there are no positives", () => {
    const descriptor = new Float32Array([1, 0]);
    expect(scoreDescriptor(descriptor, [], [], 0)).toBe(-Infinity);
  });
});

describe("findSimilarityPeaks", () => {
  function makeMap(gridWidth: number, gridHeight: number): Float32Array {
    return new Float32Array(gridWidth * gridHeight);
  }

  it("finds a single isolated maximum", () => {
    const gridWidth = 7;
    const gridHeight = 7;
    const map = makeMap(gridWidth, gridHeight);
    map[3 * gridWidth + 3] = 1;
    const peaks = findSimilarityPeaks(map, gridWidth, gridHeight, 0.5, 10, 1);
    expect(peaks).toEqual([{ cellX: 3, cellY: 3, score: 1 }]);
  });

  it("collapses a flat plateau into peaks respecting minSeparation", () => {
    const gridWidth = 7;
    const gridHeight = 7;
    const map = makeMap(gridWidth, gridHeight);
    // 3x3 plateau of equal high value, centered at (3,3).
    for (let y = 2; y <= 4; ++y) {
      for (let x = 2; x <= 4; ++x) {
        map[y * gridWidth + x] = 10;
      }
    }
    const peaks = findSimilarityPeaks(map, gridWidth, gridHeight, 0.5, 10, 4);
    // minSeparation=4 is bigger than the plateau's diagonal, so only one
    // representative peak from the plateau should survive.
    expect(peaks.length).toBe(1);
    expect(peaks[0].score).toBe(10);

    // With a tiny minSeparation, multiple plateau cells can coexist.
    const loosePeaks = findSimilarityPeaks(
      map,
      gridWidth,
      gridHeight,
      0.5,
      10,
      0.5,
    );
    expect(loosePeaks.length).toBeGreaterThan(1);
    for (let i = 0; i < loosePeaks.length; ++i) {
      for (let j = i + 1; j < loosePeaks.length; ++j) {
        const dx = loosePeaks[i].cellX - loosePeaks[j].cellX;
        const dy = loosePeaks[i].cellY - loosePeaks[j].cellY;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it("filters out scores below threshold", () => {
    const gridWidth = 5;
    const gridHeight = 5;
    const map = makeMap(gridWidth, gridHeight);
    map[2 * gridWidth + 2] = 0.3;
    expect(findSimilarityPeaks(map, gridWidth, gridHeight, 0.5, 10, 1)).toEqual(
      [],
    );
  });

  it("caps at maxCount and orders by descending score", () => {
    const gridWidth = 10;
    const gridHeight = 1;
    const map = makeMap(gridWidth, gridHeight);
    // Three well-separated isolated peaks with distinct scores.
    map[1] = 0.6;
    map[5] = 0.9;
    map[8] = 0.7;
    const peaks = findSimilarityPeaks(map, gridWidth, gridHeight, 0.5, 2, 1);
    expect(peaks.length).toBe(2);
    expect(peaks[0].score).toBeCloseTo(0.9, 6);
    expect(peaks[1].score).toBeCloseTo(0.7, 6);
  });

  it("ignores non-finite (padding) scores", () => {
    const gridWidth = 3;
    const gridHeight = 1;
    const map = new Float32Array([-Infinity, -Infinity, -Infinity]);
    expect(
      findSimilarityPeaks(map, gridWidth, gridHeight, -100, 10, 1),
    ).toEqual([]);
  });
});

describe("polygonToCellMask", () => {
  it("matches rasterizePolygon for a polygon large enough to cover full cells", () => {
    const gridWidth = 10;
    const gridHeight = 10;
    const square = [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ];
    const mask = polygonToCellMask(square, gridWidth, gridHeight);
    const expected = rasterizePolygon(square, gridWidth, gridHeight);
    expect(Array.from(mask)).toEqual(Array.from(expected));
    let area = 0;
    for (const v of mask) area += v;
    expect(area).toBeGreaterThan(0);
  });

  it("falls back to the centroid cell for a polygon too small to rasterize", () => {
    const gridWidth = 10;
    const gridHeight = 10;
    // A tiny triangle entirely inside cell (5,5), far from any cell-center
    // scanline (which sits at y=5.5), so rasterizePolygon yields nothing.
    const tiny = [
      { x: 5.1, y: 5.1 },
      { x: 5.2, y: 5.1 },
      { x: 5.1, y: 5.2 },
    ];
    expect(
      Array.from(rasterizePolygon(tiny, gridWidth, gridHeight)).every(
        (v) => v === 0,
      ),
    ).toBe(true);
    const mask = polygonToCellMask(tiny, gridWidth, gridHeight);
    let onCount = 0;
    let onIndex = -1;
    for (let i = 0; i < mask.length; ++i) {
      if (mask[i]) {
        onCount++;
        onIndex = i;
      }
    }
    expect(onCount).toBe(1);
    expect(onIndex).toBe(5 * gridWidth + 5);
  });

  it("clamps the centroid fallback to the grid bounds", () => {
    const gridWidth = 4;
    const gridHeight = 4;
    // Degenerate polygon whose centroid sits outside the grid.
    const outside = [
      { x: 100, y: 100 },
      { x: 100.05, y: 100 },
      { x: 100, y: 100.05 },
    ];
    const mask = polygonToCellMask(outside, gridWidth, gridHeight);
    expect(mask[(gridHeight - 1) * gridWidth + (gridWidth - 1)]).toBe(1);
    let area = 0;
    for (const v of mask) area += v;
    expect(area).toBe(1);
  });
});

describe("maskIoU", () => {
  it("computes intersection over union", () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([1, 0, 0, 0]);
    expect(maskIoU(a, b)).toBeCloseTo(1 / 2, 6);
  });

  it("is 1 for identical masks", () => {
    const a = new Uint8Array([1, 0, 1, 0]);
    expect(maskIoU(a, a)).toBe(1);
  });

  it("is 0 when both masks are empty", () => {
    const a = new Uint8Array(4);
    const b = new Uint8Array(4);
    expect(maskIoU(a, b)).toBe(0);
  });

  it("is 0 for disjoint masks", () => {
    const a = new Uint8Array([1, 0]);
    const b = new Uint8Array([0, 1]);
    expect(maskIoU(a, b)).toBe(0);
  });
});
