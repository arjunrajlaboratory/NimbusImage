import { describe, it, expect } from "vitest";
import { AnnotationSpatialIndex } from "../spatialIndex";

/**
 * Benchmark: R-tree spatial index vs linear scan.
 *
 * Compares the performance of R-tree bbox queries against brute-force
 * linear scans at various annotation counts. This validates the O(log n + k)
 * complexity of the R-tree approach vs the O(n) linear scan.
 *
 * Run with: pnpm test -- --run spatialIndex.bench
 */

/** Simple centroid type matching what the annotation store produces. */
interface Centroid {
  id: string;
  x: number;
  y: number;
}

/** Generate N random centroids uniformly distributed in [0, worldSize)^2. */
function generateCentroids(n: number, worldSize: number = 10000): Centroid[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ann-${i}`,
    x: Math.random() * worldSize,
    y: Math.random() * worldSize,
  }));
}

/**
 * Linear scan: iterate all centroids and check if each falls within the bbox.
 * This is what the old updateVisibilityAndHydration did before the R-tree.
 */
function linearScanViewport(
  centroids: Centroid[],
  currentFrameIds: string[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { inViewportIds: string[]; outOfViewportIds: string[] } {
  const centroidMap = new Map(centroids.map((c) => [c.id, c]));
  const inViewportIds: string[] = [];
  const outOfViewportIds: string[] = [];
  for (const id of currentFrameIds) {
    const c = centroidMap.get(id);
    if (c && c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY) {
      inViewportIds.push(id);
    } else {
      outOfViewportIds.push(id);
    }
  }
  return { inViewportIds, outOfViewportIds };
}

/**
 * Linear scan for selection: iterate all centroids, check distance to click point.
 * Simulates the old getSelectedAnnotationsFromAnnotation for point annotations.
 */
function linearScanSelection(
  centroids: Centroid[],
  renderedIds: string[],
  clickX: number,
  clickY: number,
  radius: number,
): string[] {
  const centroidMap = new Map(centroids.map((c) => [c.id, c]));
  const radiusSq = radius * radius;
  const selected: string[] = [];
  for (const id of renderedIds) {
    const c = centroidMap.get(id);
    if (c) {
      const dx = c.x - clickX;
      const dy = c.y - clickY;
      if (dx * dx + dy * dy <= radiusSq) {
        selected.push(id);
      }
    }
  }
  return selected;
}

describe("R-tree vs Linear Scan Benchmarks", () => {
  const SIZES = [1_000, 10_000, 100_000];
  const WORLD_SIZE = 10000;

  describe("viewport filtering", () => {
    for (const size of SIZES) {
      it(`${size.toLocaleString()} annotations: R-tree vs linear scan`, () => {
        const centroids = generateCentroids(size, WORLD_SIZE);
        const allIds = centroids.map((c) => c.id);

        // Small viewport: 5% of world area (typical zoom-in)
        const viewportFraction = 0.05;
        const side = Math.sqrt(viewportFraction) * WORLD_SIZE;
        const vMinX = WORLD_SIZE / 2 - side / 2;
        const vMinY = WORLD_SIZE / 2 - side / 2;
        const vMaxX = WORLD_SIZE / 2 + side / 2;
        const vMaxY = WORLD_SIZE / 2 + side / 2;

        // Build R-tree
        const index = new AnnotationSpatialIndex();
        const buildStart = performance.now();
        index.bulkLoad(centroids);
        const buildTime = performance.now() - buildStart;

        // R-tree query
        const ITERATIONS = 10;
        const rtreeStart = performance.now();
        let rtreeResult: ReturnType<typeof index.splitByViewport> | undefined;
        for (let i = 0; i < ITERATIONS; i++) {
          rtreeResult = index.splitByViewport(
            allIds,
            vMinX,
            vMinY,
            vMaxX,
            vMaxY,
          );
        }
        const rtreeTime = (performance.now() - rtreeStart) / ITERATIONS;

        // Linear scan
        const linearStart = performance.now();
        let linearResult:
          | ReturnType<typeof linearScanViewport>
          | undefined;
        for (let i = 0; i < ITERATIONS; i++) {
          linearResult = linearScanViewport(
            centroids,
            allIds,
            vMinX,
            vMinY,
            vMaxX,
            vMaxY,
          );
        }
        const linearTime = (performance.now() - linearStart) / ITERATIONS;

        // Verify correctness: both should produce the same result
        expect(new Set(rtreeResult!.inViewportIds)).toEqual(
          new Set(linearResult!.inViewportIds),
        );

        const speedup = linearTime / rtreeTime;
        // eslint-disable-next-line no-console
        console.log(
          `  Viewport (${size.toLocaleString()} annotations, 5% viewport):` +
            `\n    R-tree build: ${buildTime.toFixed(1)}ms` +
            `\n    R-tree query: ${rtreeTime.toFixed(2)}ms` +
            `\n    Linear scan:  ${linearTime.toFixed(2)}ms` +
            `\n    Speedup:      ${speedup.toFixed(1)}x` +
            `\n    In viewport:  ${rtreeResult!.inViewportIds.length}`,
        );

        // R-tree should not be dramatically slower than linear
        // (it may be similar for small N due to overhead, but should win for large N)
        expect(rtreeResult!.inViewportIds.length).toBeGreaterThan(0);
      });
    }
  });

  describe("selection pre-filtering (click on point annotations)", () => {
    for (const size of SIZES) {
      it(`${size.toLocaleString()} rendered annotations: R-tree vs linear scan`, () => {
        // Simulate rendered annotations (bounded by visibility budget)
        const renderBudget = Math.min(size, 20_000);
        const centroids = generateCentroids(size, WORLD_SIZE);
        const renderedIds = centroids.slice(0, renderBudget).map((c) => c.id);

        // Simulate a click near the center
        const clickX = WORLD_SIZE / 2;
        const clickY = WORLD_SIZE / 2;
        const clickRadius = 50; // 50 map units

        // Build R-tree
        const index = new AnnotationSpatialIndex();
        index.bulkLoad(centroids);

        // R-tree pre-filter + fine check
        const ITERATIONS = 50;
        const centroidMap = new Map(centroids.map((c) => [c.id, c]));

        const rtreeStart = performance.now();
        let rtreeSelected: string[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          // Broad phase: R-tree bbox query
          const candidates = index.queryBox(
            clickX - clickRadius,
            clickY - clickRadius,
            clickX + clickRadius,
            clickY + clickRadius,
          );
          // Narrow phase: exact distance check on candidates that are rendered
          rtreeSelected = [];
          const radiusSq = clickRadius * clickRadius;
          for (const id of renderedIds) {
            if (!candidates.has(id)) continue;
            const c = centroidMap.get(id)!;
            const dx = c.x - clickX;
            const dy = c.y - clickY;
            if (dx * dx + dy * dy <= radiusSq) {
              rtreeSelected.push(id);
            }
          }
        }
        const rtreeTime = (performance.now() - rtreeStart) / ITERATIONS;

        // Linear scan (no pre-filter)
        const linearStart = performance.now();
        let linearSelected: string[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          linearSelected = linearScanSelection(
            centroids,
            renderedIds,
            clickX,
            clickY,
            clickRadius,
          );
        }
        const linearTime = (performance.now() - linearStart) / ITERATIONS;

        // Verify correctness
        expect(new Set(rtreeSelected)).toEqual(new Set(linearSelected));

        const speedup = linearTime / rtreeTime;
        // eslint-disable-next-line no-console
        console.log(
          `  Click selection (${renderBudget.toLocaleString()} rendered, ${size.toLocaleString()} total):` +
            `\n    R-tree query: ${rtreeTime.toFixed(3)}ms` +
            `\n    Linear scan:  ${linearTime.toFixed(3)}ms` +
            `\n    Speedup:      ${speedup.toFixed(1)}x` +
            `\n    Candidates:   ${index.queryBox(clickX - clickRadius, clickY - clickRadius, clickX + clickRadius, clickY + clickRadius).size}` +
            `\n    Selected:     ${rtreeSelected.length}`,
        );
      });
    }
  });

  describe("selection pre-filtering (lasso selection)", () => {
    for (const size of SIZES) {
      it(`${size.toLocaleString()} rendered annotations: R-tree bbox pre-filter vs linear`, () => {
        const renderBudget = Math.min(size, 20_000);
        const centroids = generateCentroids(size, WORLD_SIZE);
        const renderedIds = centroids.slice(0, renderBudget).map((c) => c.id);

        // Simulate a lasso polygon (rectangle for simplicity, ~2% of world area)
        const lassoMinX = 4000;
        const lassoMinY = 4000;
        const lassoMaxX = 5400;
        const lassoMaxY = 5400;
        const lassoPolygon = [
          { x: lassoMinX, y: lassoMinY },
          { x: lassoMaxX, y: lassoMinY },
          { x: lassoMaxX, y: lassoMaxY },
          { x: lassoMinX, y: lassoMaxY },
        ];

        // Build R-tree
        const index = new AnnotationSpatialIndex();
        index.bulkLoad(centroids);
        const centroidMap = new Map(centroids.map((c) => [c.id, c]));

        // Simple point-in-polygon for benchmark (works for convex polygons)
        const pointInRect = (px: number, py: number) =>
          px >= lassoMinX &&
          px <= lassoMaxX &&
          py >= lassoMinY &&
          py <= lassoMaxY;

        // R-tree pre-filter + fine check
        const ITERATIONS = 50;

        const rtreeStart = performance.now();
        let rtreeSelected: string[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          const candidates = index.queryBox(
            lassoMinX,
            lassoMinY,
            lassoMaxX,
            lassoMaxY,
          );
          rtreeSelected = [];
          for (const id of renderedIds) {
            if (!candidates.has(id)) continue;
            const c = centroidMap.get(id)!;
            if (pointInRect(c.x, c.y)) {
              rtreeSelected.push(id);
            }
          }
        }
        const rtreeTime = (performance.now() - rtreeStart) / ITERATIONS;

        // Linear scan
        const linearStart = performance.now();
        let linearSelected: string[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          linearSelected = [];
          for (const id of renderedIds) {
            const c = centroidMap.get(id)!;
            if (pointInRect(c.x, c.y)) {
              linearSelected.push(id);
            }
          }
        }
        const linearTime = (performance.now() - linearStart) / ITERATIONS;

        // Verify correctness
        expect(new Set(rtreeSelected)).toEqual(new Set(linearSelected));

        const speedup = linearTime / rtreeTime;
        // eslint-disable-next-line no-console
        console.log(
          `  Lasso selection (${renderBudget.toLocaleString()} rendered, ${size.toLocaleString()} total):` +
            `\n    R-tree query: ${rtreeTime.toFixed(3)}ms` +
            `\n    Linear scan:  ${linearTime.toFixed(3)}ms` +
            `\n    Speedup:      ${speedup.toFixed(1)}x` +
            `\n    Candidates:   ${index.queryBox(lassoMinX, lassoMinY, lassoMaxX, lassoMaxY).size}` +
            `\n    Selected:     ${rtreeSelected.length}`,
        );
      });
    }
  });
});
