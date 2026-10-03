// Polygon rasterization and background sampling for the example-based
// auto-segmentation tool. See EXAMPLE_SEGMENTATION_TOOL.md §1 and §4.2.
//
// Masks are flat row-major Uint8Array buffers of length width*height,
// with 1 = inside / selected, 0 = outside.

import { IWorkerPoint } from "./types";

/**
 * Rasterizes a polygon into a working-resolution mask using an even-odd
 * scanline fill. Pixel (x, y) is considered filled when its center
 * (x + 0.5, y + 0.5) is inside the polygon. Points outside [0, width) x
 * [0, height) are naturally clipped since only in-bounds pixels are ever
 * written; a polygon entirely outside the canvas rasterizes to an all-zero
 * mask.
 */
export function rasterizePolygon(
  points: IWorkerPoint[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const vertexCount = points.length;
  if (vertexCount < 3) {
    return mask;
  }

  for (let y = 0; y < height; ++y) {
    const scanY = y + 0.5;
    const intersectionXs: number[] = [];
    for (let i = 0; i < vertexCount; ++i) {
      const a = points[i];
      const b = points[(i + 1) % vertexCount];
      if (a.y === b.y) {
        continue; // horizontal edges never cross a scanline
      }
      const crossesScanline =
        (scanY >= a.y && scanY < b.y) || (scanY >= b.y && scanY < a.y);
      if (crossesScanline) {
        const t = (scanY - a.y) / (b.y - a.y);
        intersectionXs.push(a.x + t * (b.x - a.x));
      }
    }
    intersectionXs.sort((p, q) => p - q);

    const rowOffset = y * width;
    for (let i = 0; i + 1 < intersectionXs.length; i += 2) {
      // Fill pixels whose center lies in [intersectionXs[i], intersectionXs[i + 1]).
      const xStart = Math.max(0, Math.ceil(intersectionXs[i] - 0.5));
      const xEnd = Math.min(
        width - 1,
        Math.ceil(intersectionXs[i + 1] - 0.5) - 1,
      );
      for (let x = xStart; x <= xEnd; ++x) {
        mask[rowOffset + x] = 1;
      }
    }
  }
  return mask;
}

/** Number of set pixels in a mask. */
export function computeMaskArea(mask: Uint8Array): number {
  let area = 0;
  for (let i = 0; i < mask.length; ++i) {
    area += mask[i];
  }
  return area;
}

/** Annulus ring width in working pixels, per spec §1: max(5, 0.5*sqrt(area)). */
export function computeAnnulusRingWidth(area: number): number {
  return Math.max(5, 0.5 * Math.sqrt(area));
}

function dilateHorizontal(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; ++y) {
    const rowOffset = y * width;
    let windowSum = 0;
    const initialEnd = Math.min(radius, width - 1);
    for (let x = 0; x <= initialEnd; ++x) {
      windowSum += mask[rowOffset + x];
    }
    for (let x = 0; x < width; ++x) {
      output[rowOffset + x] = windowSum > 0 ? 1 : 0;
      const leavingIndex = x - radius;
      const enteringIndex = x + radius + 1;
      if (leavingIndex >= 0) {
        windowSum -= mask[rowOffset + leavingIndex];
      }
      if (enteringIndex < width) {
        windowSum += mask[rowOffset + enteringIndex];
      }
    }
  }
  return output;
}

function dilateVertical(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  for (let x = 0; x < width; ++x) {
    let windowSum = 0;
    const initialEnd = Math.min(radius, height - 1);
    for (let y = 0; y <= initialEnd; ++y) {
      windowSum += mask[y * width + x];
    }
    for (let y = 0; y < height; ++y) {
      output[y * width + x] = windowSum > 0 ? 1 : 0;
      const leavingIndex = y - radius;
      const enteringIndex = y + radius + 1;
      if (leavingIndex >= 0) {
        windowSum -= mask[leavingIndex * width + x];
      }
      if (enteringIndex < height) {
        windowSum += mask[enteringIndex * width + x];
      }
    }
  }
  return output;
}

/**
 * Binary dilation with a square structuring element (Chebyshev radius),
 * implemented as two separable sliding-window max passes for O(width*height)
 * cost regardless of radius.
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const roundedRadius = Math.round(radius);
  if (roundedRadius <= 0) {
    return mask.slice();
  }
  const horizontal = dilateHorizontal(mask, width, height, roundedRadius);
  return dilateVertical(horizontal, width, height, roundedRadius);
}

/**
 * Ring of pixels around a foreground example mask: the mask dilated by
 * ringWidth, minus the original mask. Used to auto-sample background pixels
 * near an example when the user hasn't drawn explicit background examples.
 */
export function computeAnnulusMask(
  foregroundMask: Uint8Array,
  width: number,
  height: number,
  ringWidth: number,
): Uint8Array {
  const dilated = dilateMask(foregroundMask, width, height, ringWidth);
  const ring = new Uint8Array(width * height);
  for (let i = 0; i < ring.length; ++i) {
    ring[i] = dilated[i] && !foregroundMask[i] ? 1 : 0;
  }
  return ring;
}

/**
 * Deterministically samples up to maxSamples pixel indices that are not set
 * in excludeMask, evenly spread across the image (no RNG, so results are
 * reproducible given identical inputs).
 */
export function sampleFarFieldBackground(
  excludeMask: Uint8Array,
  width: number,
  height: number,
  maxSamples: number,
): Uint32Array {
  const pixelCount = width * height;
  if (maxSamples <= 0 || pixelCount === 0) {
    return new Uint32Array(0);
  }
  // Oversample the stride so the scan sweeps the whole image even when a
  // large fraction of candidate pixels are excluded.
  const stride = Math.max(1, Math.floor(pixelCount / (maxSamples * 4)));
  const samples: number[] = [];
  for (
    let pixel = 0;
    pixel < pixelCount && samples.length < maxSamples;
    pixel += stride
  ) {
    if (!excludeMask[pixel]) {
      samples.push(pixel);
    }
  }
  return Uint32Array.from(samples);
}
