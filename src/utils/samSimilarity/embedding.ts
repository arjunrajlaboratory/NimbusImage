// Embedding-space math for the SAM-similarity segmentation tool variant.
// See codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §11 (especially
// §11.3 Algorithm) for the full spec this module implements.
//
// All functions here are pure and operate on typed arrays only; no ONNX or
// worker concerns live in this file.

import { rasterizePolygon } from "@/utils/exampleSegmentation/rasterize";

/**
 * The SAM encoder's image embedding, reshaped into a small struct.
 *
 * `data` is CHW-layout (channel-major planes): channel `c`, grid cell
 * `(x, y)` lives at `data[c * gridWidth * gridHeight + y * gridWidth + x]`.
 * This mirrors the ONNX `image_embed` tensor of shape (1, C, H, W) with the
 * leading batch dimension of 1 dropped.
 *
 * The model input is an aspect-preserving resize of the source image placed
 * in the TOP-LEFT of a padded (typically 1024x1024) square; cells with
 * `x >= validGridWidth` or `y >= validGridHeight` correspond to padding and
 * carry no real image content.
 */
export interface IEmbeddingGrid {
  data: Float32Array;
  channels: number;
  gridWidth: number;
  gridHeight: number;
  validGridWidth: number;
  validGridHeight: number;
}

/**
 * Every "cosine similarity" helper below assumes both operands are already
 * L2-normalized per-cell/per-descriptor vectors (as produced by
 * normalizeEmbeddingCells / poolDescriptor), so a plain dot product already
 * equals the cosine. A zero vector (norm 0, e.g. an all-zero padding cell)
 * naturally dots to 0 with anything, which is the desired "no similarity"
 * convention without any special-casing.
 */

/** Dot product of two equal-length, channel-contiguous vectors. */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let c = 0; c < a.length; ++c) {
    sum += a[c] * b[c];
  }
  return sum;
}

/**
 * Dot product between grid cell `cellIndex`'s channel vector (strided, CHW
 * layout) and a contiguous C-length vector.
 */
function dotCellWithVector(
  data: Float32Array,
  channels: number,
  planeSize: number,
  cellIndex: number,
  vector: Float32Array,
): number {
  let sum = 0;
  for (let c = 0; c < channels; ++c) {
    sum += data[c * planeSize + cellIndex] * vector[c];
  }
  return sum;
}

/** Max cosine (dot) of a grid cell against a set of descriptors; -Infinity if the set is empty. */
function maxCosineCellToSet(
  data: Float32Array,
  channels: number,
  planeSize: number,
  cellIndex: number,
  vectors: Float32Array[],
): number {
  let best = -Infinity;
  for (const vector of vectors) {
    const cosine = dotCellWithVector(
      data,
      channels,
      planeSize,
      cellIndex,
      vector,
    );
    if (cosine > best) {
      best = cosine;
    }
  }
  return best;
}

/** Max cosine (dot) of a flat descriptor against a set of descriptors; -Infinity if the set is empty. */
function maxCosineToSet(vector: Float32Array, set: Float32Array[]): number {
  let best = -Infinity;
  for (const candidate of set) {
    const cosine = dotProduct(vector, candidate);
    if (cosine > best) {
      best = cosine;
    }
  }
  return best;
}

/**
 * Returns a same-layout copy of the embedding where every cell's channel
 * vector is L2-normalized. Cells whose vector is exactly zero are left as
 * zero (there is no direction to normalize to).
 */
export function normalizeEmbeddingCells(grid: IEmbeddingGrid): Float32Array {
  const { data, channels, gridWidth, gridHeight } = grid;
  const planeSize = gridWidth * gridHeight;
  const output = new Float32Array(data.length);
  for (let cellIndex = 0; cellIndex < planeSize; ++cellIndex) {
    let normSquared = 0;
    for (let c = 0; c < channels; ++c) {
      const value = data[c * planeSize + cellIndex];
      normSquared += value * value;
    }
    if (normSquared === 0) {
      continue; // stays zero
    }
    const invNorm = 1 / Math.sqrt(normSquared);
    for (let c = 0; c < channels; ++c) {
      output[c * planeSize + cellIndex] =
        data[c * planeSize + cellIndex] * invNorm;
    }
  }
  return output;
}

/**
 * Averages the normalized per-cell feature vectors over the cells selected
 * by `cellMask`, then L2-normalizes the mean into a single descriptor.
 * Returns null when the mask selects no cells at all (nothing to pool).
 * If the selected cells' mean happens to be the zero vector, a zero
 * descriptor is returned (the mask was non-empty, just uninformative).
 */
export function poolDescriptor(
  normalizedData: Float32Array,
  grid: IEmbeddingGrid,
  cellMask: Uint8Array,
): Float32Array | null {
  const { channels, gridWidth, gridHeight } = grid;
  const planeSize = gridWidth * gridHeight;
  const sum = new Float32Array(channels);
  let cellCount = 0;
  for (let cellIndex = 0; cellIndex < planeSize; ++cellIndex) {
    if (!cellMask[cellIndex]) {
      continue;
    }
    cellCount++;
    for (let c = 0; c < channels; ++c) {
      sum[c] += normalizedData[c * planeSize + cellIndex];
    }
  }
  if (cellCount === 0) {
    return null;
  }
  let normSquared = 0;
  for (let c = 0; c < channels; ++c) {
    sum[c] /= cellCount;
    normSquared += sum[c] * sum[c];
  }
  if (normSquared === 0) {
    return sum;
  }
  const invNorm = 1 / Math.sqrt(normSquared);
  for (let c = 0; c < channels; ++c) {
    sum[c] *= invNorm;
  }
  return sum;
}

/**
 * Mean, over the mask's cells, of the cosine between each cell's normalized
 * feature and `descriptor`. Used to calibrate similarity thresholds against
 * an example's own self-similarity. Returns 0 for an empty mask.
 */
export function meanMaskSimilarity(
  normalizedData: Float32Array,
  grid: IEmbeddingGrid,
  cellMask: Uint8Array,
  descriptor: Float32Array,
): number {
  const { channels, gridWidth, gridHeight } = grid;
  const planeSize = gridWidth * gridHeight;
  let sum = 0;
  let cellCount = 0;
  for (let cellIndex = 0; cellIndex < planeSize; ++cellIndex) {
    if (!cellMask[cellIndex]) {
      continue;
    }
    cellCount++;
    sum += dotCellWithVector(
      normalizedData,
      channels,
      planeSize,
      cellIndex,
      descriptor,
    );
  }
  return cellCount === 0 ? 0 : sum / cellCount;
}

/**
 * Per-cell score: max_i cos(f, positives[i]) - negativeWeight * max_j cos(f, negatives[j]).
 * Padding cells (outside validGridWidth/validGridHeight) are forced to
 * -Infinity so they never win a peak search.
 */
export function computeSimilarityMap(
  normalizedData: Float32Array,
  grid: IEmbeddingGrid,
  positives: Float32Array[],
  negatives: Float32Array[],
  negativeWeight: number,
): Float32Array {
  const { channels, gridWidth, gridHeight, validGridWidth, validGridHeight } =
    grid;
  const planeSize = gridWidth * gridHeight;
  const map = new Float32Array(planeSize);
  for (let y = 0; y < gridHeight; ++y) {
    for (let x = 0; x < gridWidth; ++x) {
      const cellIndex = y * gridWidth + x;
      if (x >= validGridWidth || y >= validGridHeight) {
        map[cellIndex] = -Infinity;
        continue;
      }
      const positiveScore = maxCosineCellToSet(
        normalizedData,
        channels,
        planeSize,
        cellIndex,
        positives,
      );
      const negativeScore =
        negatives.length > 0
          ? maxCosineCellToSet(
              normalizedData,
              channels,
              planeSize,
              cellIndex,
              negatives,
            )
          : 0;
      map[cellIndex] = positiveScore - negativeWeight * negativeScore;
    }
  }
  return map;
}

/**
 * Scores a single already-pooled descriptor against positives/negatives
 * with the same formula as computeSimilarityMap, used to verify candidate
 * masks after decoding.
 */
export function scoreDescriptor(
  descriptor: Float32Array,
  positives: Float32Array[],
  negatives: Float32Array[],
  negativeWeight: number,
): number {
  const positiveScore = maxCosineToSet(descriptor, positives);
  const negativeScore =
    negatives.length > 0 ? maxCosineToSet(descriptor, negatives) : 0;
  return positiveScore - negativeWeight * negativeScore;
}

export interface ISimilarityPeak {
  cellX: number;
  cellY: number;
  score: number;
}

/**
 * Finds 3x3-neighborhood local maxima of `map` (score >= every in-bounds
 * neighbor, so flat plateaus qualify in full), keeps only those scoring at
 * least `threshold`, then greedily selects peaks in descending score order
 * such that no two kept peaks are closer than `minSeparation` (Euclidean, in
 * cells), capped at `maxCount`.
 */
export function findSimilarityPeaks(
  map: Float32Array,
  gridWidth: number,
  gridHeight: number,
  threshold: number,
  maxCount: number,
  minSeparation: number,
): ISimilarityPeak[] {
  const candidates: ISimilarityPeak[] = [];
  for (let y = 0; y < gridHeight; ++y) {
    for (let x = 0; x < gridWidth; ++x) {
      const score = map[y * gridWidth + x];
      if (!Number.isFinite(score) || score < threshold) {
        continue;
      }
      let isLocalMax = true;
      for (let dy = -1; dy <= 1 && isLocalMax; ++dy) {
        const neighborY = y + dy;
        if (neighborY < 0 || neighborY >= gridHeight) {
          continue;
        }
        for (let dx = -1; dx <= 1; ++dx) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const neighborX = x + dx;
          if (neighborX < 0 || neighborX >= gridWidth) {
            continue;
          }
          if (map[neighborY * gridWidth + neighborX] > score) {
            isLocalMax = false;
            break;
          }
        }
      }
      if (isLocalMax) {
        candidates.push({ cellX: x, cellY: y, score });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const minSeparationSquared = minSeparation * minSeparation;
  const peaks: ISimilarityPeak[] = [];
  for (const candidate of candidates) {
    if (peaks.length >= maxCount) {
      break;
    }
    let farEnough = true;
    for (const kept of peaks) {
      const dx = candidate.cellX - kept.cellX;
      const dy = candidate.cellY - kept.cellY;
      if (dx * dx + dy * dy < minSeparationSquared) {
        farEnough = false;
        break;
      }
    }
    if (farEnough) {
      peaks.push(candidate);
    }
  }
  return peaks;
}

/**
 * Rasterizes a polygon given in embedding-grid coordinates (caller
 * pre-scales from model-input px) into a width*height cell mask, reusing
 * exampleSegmentation's even-odd scanline rasterizer. Per spec §11.3 step 2,
 * a polygon too small to cover any cell center falls back to marking the
 * single cell containing the polygon's centroid (vertex average), clamped
 * to the grid.
 */
export function polygonToCellMask(
  points: { x: number; y: number }[],
  gridWidth: number,
  gridHeight: number,
): Uint8Array {
  const mask = rasterizePolygon(points, gridWidth, gridHeight);
  if (points.length === 0) {
    return mask;
  }
  let hasCell = false;
  for (let i = 0; i < mask.length; ++i) {
    if (mask[i]) {
      hasCell = true;
      break;
    }
  }
  if (hasCell) {
    return mask;
  }

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const centroidX = sumX / points.length;
  const centroidY = sumY / points.length;
  const cellX = Math.min(gridWidth - 1, Math.max(0, Math.floor(centroidX)));
  const cellY = Math.min(gridHeight - 1, Math.max(0, Math.floor(centroidY)));
  mask[cellY * gridWidth + cellX] = 1;
  return mask;
}

/** Intersection-over-union of two same-length binary masks; 0 if both empty (union 0). */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; ++i) {
    const inA = a[i] !== 0;
    const inB = b[i] !== 0;
    if (inA || inB) {
      union++;
    }
    if (inA && inB) {
      intersection++;
    }
  }
  return union === 0 ? 0 : intersection / union;
}
