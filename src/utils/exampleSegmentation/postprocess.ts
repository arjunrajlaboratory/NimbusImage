// Cheap, re-runnable post-processing for the example-based auto-segmentation
// tool: threshold, connected components, size filter, contour tracing.
// See EXAMPLE_SEGMENTATION_TOOL.md §4.4.

import { IWorkerPoint } from "./types";

/** Binarizes a probability map at the given threshold (>= is foreground). */
export function thresholdProbabilityMap(
  probabilityMap: Float32Array,
  threshold: number,
): Uint8Array {
  const mask = new Uint8Array(probabilityMap.length);
  for (let i = 0; i < probabilityMap.length; ++i) {
    mask[i] = probabilityMap[i] >= threshold ? 1 : 0;
  }
  return mask;
}

export interface IConnectedComponentsResult {
  // 0 = background; 1..componentCount = component labels.
  labels: Int32Array;
  componentCount: number;
}

/**
 * Labels 8-connected components of a binary mask using an iterative
 * (stack-based, no recursion) scanline flood fill: each pop extends a run of
 * same-row foreground pixels, then seeds the rows above/below (expanded by
 * one pixel on each side to also catch diagonal-only connections).
 */
export function labelConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): IConnectedComponentsResult {
  const labels = new Int32Array(width * height);
  let nextLabel = 0;
  // Flattened (x, y) pairs, pushed/popped two at a time.
  const stack: number[] = [];

  for (let startY = 0; startY < height; ++startY) {
    for (let startX = 0; startX < width; ++startX) {
      const startIndex = startY * width + startX;
      if (!mask[startIndex] || labels[startIndex] !== 0) {
        continue;
      }
      nextLabel++;
      stack.push(startX, startY);
      while (stack.length > 0) {
        const y = stack.pop() as number;
        const x = stack.pop() as number;
        const rowOffset = y * width;
        if (labels[rowOffset + x] !== 0 || !mask[rowOffset + x]) {
          continue;
        }

        let left = x;
        while (
          left > 0 &&
          mask[rowOffset + left - 1] &&
          labels[rowOffset + left - 1] === 0
        ) {
          left--;
        }
        let right = x;
        while (
          right < width - 1 &&
          mask[rowOffset + right + 1] &&
          labels[rowOffset + right + 1] === 0
        ) {
          right++;
        }
        for (let i = left; i <= right; ++i) {
          labels[rowOffset + i] = nextLabel;
        }

        // Expand by one pixel on each side to also pick up diagonal (8-conn) neighbors.
        const seedLeft = Math.max(0, left - 1);
        const seedRight = Math.min(width - 1, right + 1);
        if (y > 0) {
          pushRowSeeds(mask, labels, width, y - 1, seedLeft, seedRight, stack);
        }
        if (y < height - 1) {
          pushRowSeeds(mask, labels, width, y + 1, seedLeft, seedRight, stack);
        }
      }
    }
  }
  return { labels, componentCount: nextLabel };
}

function pushRowSeeds(
  mask: Uint8Array,
  labels: Int32Array,
  width: number,
  y: number,
  fromX: number,
  toX: number,
  stack: number[],
): void {
  const rowOffset = y * width;
  let x = fromX;
  while (x <= toX) {
    if (mask[rowOffset + x] && labels[rowOffset + x] === 0) {
      stack.push(x, y);
      // Skip the rest of this run; it will be expanded from the seed above.
      while (x <= toX && mask[rowOffset + x] && labels[rowOffset + x] === 0) {
        x++;
      }
    } else {
      x++;
    }
  }
}

/** Pixel area of each component; index 0 is unused (0 = background). */
export function computeComponentAreas(
  labels: Int32Array,
  componentCount: number,
): Uint32Array {
  const areas = new Uint32Array(componentCount + 1);
  for (let i = 0; i < labels.length; ++i) {
    const label = labels[i];
    if (label > 0) {
      areas[label]++;
    }
  }
  return areas;
}

/**
 * Auto size range from foreground example areas (§4.4 step 3):
 * [0.25 * median, 4 * median]. Returns null when there are no examples yet.
 */
export function computeAutoSizeRange(
  exampleAreas: number[],
): { min: number; max: number } | null {
  if (exampleAreas.length === 0) {
    return null;
  }
  const sorted = [...exampleAreas].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min: 0.25 * median, max: 4 * median };
}

/** Keep/drop flags per label (index 0 unused); bounds are inclusive. */
export function filterComponentsBySize(
  areas: Uint32Array,
  minArea: number,
  maxArea: number,
): boolean[] {
  const keep: boolean[] = new Array(areas.length).fill(false);
  for (let label = 1; label < areas.length; ++label) {
    const area = areas[label];
    keep[label] = area >= minArea && area <= maxArea;
  }
  return keep;
}

// Moore-neighborhood offsets in clockwise order, starting from North.
const MOORE_OFFSETS: IWorkerPoint[] = [
  { x: 0, y: -1 }, // N
  { x: 1, y: -1 }, // NE
  { x: 1, y: 0 }, // E
  { x: 1, y: 1 }, // SE
  { x: 0, y: 1 }, // S
  { x: -1, y: 1 }, // SW
  { x: -1, y: 0 }, // W
  { x: -1, y: -1 }, // NW
];

/**
 * Traces the outer boundary of one 8-connected component via Moore-neighbor
 * tracing. (startX, startY) must be the topmost, then leftmost, pixel of the
 * component so that the pixel to its west is guaranteed background - the
 * standard starting condition for this algorithm. Tracing stops as soon as
 * it steps back onto the start pixel, which is correct for the simple,
 * hole-free blobs produced by thresholding + connected components (v1 scope,
 * §4.4 - pathological single-pixel-wide spurs through the exact start pixel
 * are not handled).
 */
export function traceBoundary(
  labels: Int32Array,
  width: number,
  height: number,
  label: number,
  startX: number,
  startY: number,
): IWorkerPoint[] {
  const isForeground = (x: number, y: number): boolean =>
    x >= 0 &&
    x < width &&
    y >= 0 &&
    y < height &&
    labels[y * width + x] === label;

  const boundary: IWorkerPoint[] = [{ x: startX, y: startY }];
  let current = { x: startX, y: startY };
  // Guaranteed background: (startX, startY) is the topmost-then-leftmost
  // pixel of the component, so its west neighbor cannot be foreground.
  let backtrackDir = 6; // W

  const maxIterations = 4 * (width + height) + width * height;
  for (let iteration = 0; iteration < maxIterations; ++iteration) {
    let foundDir = -1;
    for (let step = 1; step <= 8; ++step) {
      const dir = (backtrackDir + step) % 8;
      const offset = MOORE_OFFSETS[dir];
      if (isForeground(current.x + offset.x, current.y + offset.y)) {
        foundDir = dir;
        break;
      }
    }
    if (foundDir === -1) {
      break; // isolated single-pixel component
    }

    const offset = MOORE_OFFSETS[foundDir];
    const next = { x: current.x + offset.x, y: current.y + offset.y };
    if (next.x === startX && next.y === startY) {
      break; // back where we started - the boundary is closed
    }

    boundary.push(next);
    current = next;
    backtrackDir = (foundDir + 4) % 8;
  }

  return boundary;
}

/**
 * Traces the outer contour of every kept component in one pass: finds each
 * component's start pixel with a single scan, then runs Moore tracing per
 * component. `keep[label]` gates which components produce a contour.
 */
export function traceAllContours(
  labels: Int32Array,
  width: number,
  height: number,
  componentCount: number,
  keep: boolean[],
): IWorkerPoint[][] {
  const startIndices = new Int32Array(componentCount + 1).fill(-1);
  for (let i = 0; i < labels.length; ++i) {
    const label = labels[i];
    if (label > 0 && startIndices[label] === -1) {
      startIndices[label] = i;
    }
  }

  const contours: IWorkerPoint[][] = [];
  for (let label = 1; label <= componentCount; ++label) {
    if (!keep[label] || startIndices[label] === -1) {
      continue;
    }
    const startIndex = startIndices[label];
    const startX = startIndex % width;
    const startY = Math.floor(startIndex / width);
    contours.push(traceBoundary(labels, width, height, label, startX, startY));
  }
  return contours;
}
