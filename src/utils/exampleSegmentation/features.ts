// Multi-scale image features for the example-based auto-segmentation tool.
// See codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §4.1 (normative).
//
// Every plane is a flat row-major Float32Array of length width*height.
// All convolutions clamp at the image edge (nearest-neighbor extension).

// Sigmas used to build the multi-scale feature stack.
export const FEATURE_SIGMAS = [1, 2, 4, 8] as const;

// Number of planes produced per distinct channel: raw + (G, |grad G|, LoG) per sigma.
export const PLANES_PER_CHANNEL = 1 + FEATURE_SIGMAS.length * 3;

export interface IFeatureStack {
  width: number;
  height: number;
  // Number of distinct source channels found after dedupe (1-3).
  channelCount: number;
  // channelCount * PLANES_PER_CHANNEL planes, grouped by channel:
  // [raw, G(s0), |grad G(s0)|, LoG(s0), G(s1), |grad G(s1)|, LoG(s1), ...]
  planes: Float32Array[];
}

// Number of sample points used to detect duplicate channels (e.g. grayscale
// renders where R=G=B cost one channel instead of three).
const CHANNEL_DEDUPE_SAMPLE_COUNT = 256;

function channelsMatchAtSamples(
  a: Float32Array,
  b: Float32Array,
  pixelCount: number,
): boolean {
  const sampleCount = Math.min(CHANNEL_DEDUPE_SAMPLE_COUNT, pixelCount);
  const stride = Math.max(1, Math.floor(pixelCount / sampleCount));
  for (let i = 0; i < pixelCount; i += stride) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Extracts the R, G, B channel planes from an RGBA buffer, dropping any
 * channel that is pixel-identical (on a sampled basis) to one already kept.
 * Grayscale renders produce R=G=B and should cost one channel, not three.
 */
export function extractDistinctChannels(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array[] {
  const pixelCount = width * height;
  const channels: Float32Array[] = [];
  for (let channelOffset = 0; channelOffset < 3; ++channelOffset) {
    const plane = new Float32Array(pixelCount);
    for (let pixel = 0; pixel < pixelCount; ++pixel) {
      plane[pixel] = rgba[pixel * 4 + channelOffset];
    }
    const isDuplicate = channels.some((kept) =>
      channelsMatchAtSamples(kept, plane, pixelCount),
    );
    if (!isDuplicate) {
      channels.push(plane);
    }
  }
  return channels;
}

/** Normalized 1D Gaussian kernel with radius ceil(3*sigma), per spec §4.1. */
export function gaussianKernel1D(sigma: number): Float32Array {
  const radius = Math.ceil(3 * sigma);
  const size = 2 * radius + 1;
  const kernel = new Float32Array(size);
  const twoSigmaSquared = 2 * sigma * sigma;
  let sum = 0;
  for (let i = 0; i < size; ++i) {
    const x = i - radius;
    const value = Math.exp(-(x * x) / twoSigmaSquared);
    kernel[i] = value;
    sum += value;
  }
  for (let i = 0; i < size; ++i) {
    kernel[i] /= sum;
  }
  return kernel;
}

function clampIndex(index: number, size: number): number {
  if (index < 0) return 0;
  if (index >= size) return size - 1;
  return index;
}

// Convolves each row with `kernel` (edge clamped). Pixels far enough from the
// left/right border that clamping never applies use a branch-free inner loop
// - this dominates the cost for large sigmas (radius up to 24) and is the
// difference between this running in milliseconds vs. seconds on a ~1MP plane.
function convolveRows(
  plane: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
  radius: number,
): Float32Array {
  const output = new Float32Array(width * height);
  const kernelLength = kernel.length;
  const interiorStart = Math.min(radius, width);
  const interiorEnd = Math.max(width - radius, interiorStart);

  for (let y = 0; y < height; ++y) {
    const rowOffset = y * width;
    for (let x = 0; x < interiorStart; ++x) {
      let sum = 0;
      for (let k = 0; k < kernelLength; ++k) {
        sum += plane[rowOffset + clampIndex(x - radius + k, width)] * kernel[k];
      }
      output[rowOffset + x] = sum;
    }
    for (let x = interiorStart; x < interiorEnd; ++x) {
      let sum = 0;
      const base = rowOffset + x - radius;
      for (let k = 0; k < kernelLength; ++k) {
        sum += plane[base + k] * kernel[k];
      }
      output[rowOffset + x] = sum;
    }
    for (let x = interiorEnd; x < width; ++x) {
      let sum = 0;
      for (let k = 0; k < kernelLength; ++k) {
        sum += plane[rowOffset + clampIndex(x - radius + k, width)] * kernel[k];
      }
      output[rowOffset + x] = sum;
    }
  }
  return output;
}

// Convolves each column with `kernel` (edge clamped). Whole rows are either
// entirely inside the clamped border or entirely interior, so the branch is
// per-row rather than per-pixel.
function convolveColumns(
  plane: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
  radius: number,
): Float32Array {
  const output = new Float32Array(width * height);
  const kernelLength = kernel.length;

  for (let y = 0; y < height; ++y) {
    const rowOffset = y * width;
    if (y >= radius && y < height - radius) {
      const baseRowOffset = (y - radius) * width;
      for (let x = 0; x < width; ++x) {
        let sum = 0;
        let sampleIndex = baseRowOffset + x;
        for (let k = 0; k < kernelLength; ++k) {
          sum += plane[sampleIndex] * kernel[k];
          sampleIndex += width;
        }
        output[rowOffset + x] = sum;
      }
    } else {
      for (let x = 0; x < width; ++x) {
        let sum = 0;
        for (let k = 0; k < kernelLength; ++k) {
          sum +=
            plane[clampIndex(y - radius + k, height) * width + x] * kernel[k];
        }
        output[rowOffset + x] = sum;
      }
    }
  }
  return output;
}

/** Separable Gaussian convolution on a Float32Array plane, edges clamped. */
export function gaussianBlur(
  plane: Float32Array,
  width: number,
  height: number,
  sigma: number,
): Float32Array {
  const kernel = gaussianKernel1D(sigma);
  const radius = (kernel.length - 1) / 2;
  const horizontal = convolveRows(plane, width, height, kernel, radius);
  return convolveColumns(horizontal, width, height, kernel, radius);
}

/** Gradient magnitude via central differences, edges clamped. */
export function gradientMagnitude(
  plane: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    const rowOffset = y * width;
    const rowAbove = clampIndex(y - 1, height) * width;
    const rowBelow = clampIndex(y + 1, height) * width;
    for (let x = 0; x < width; ++x) {
      const colLeft = clampIndex(x - 1, width);
      const colRight = clampIndex(x + 1, width);
      const dx = (plane[rowOffset + colRight] - plane[rowOffset + colLeft]) / 2;
      const dy = (plane[rowBelow + x] - plane[rowAbove + x]) / 2;
      output[rowOffset + x] = Math.sqrt(dx * dx + dy * dy);
    }
  }
  return output;
}

/** Discrete Laplacian (4-neighbor stencil) of a plane, edges clamped. */
export function laplacian(
  plane: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    const rowOffset = y * width;
    const rowAbove = clampIndex(y - 1, height) * width;
    const rowBelow = clampIndex(y + 1, height) * width;
    for (let x = 0; x < width; ++x) {
      const colLeft = clampIndex(x - 1, width);
      const colRight = clampIndex(x + 1, width);
      const center = plane[rowOffset + x];
      output[rowOffset + x] =
        plane[rowOffset + colLeft] +
        plane[rowOffset + colRight] +
        plane[rowAbove + x] +
        plane[rowBelow + x] -
        4 * center;
    }
  }
  return output;
}

/**
 * Builds the full per-channel feature stack (§4.1): for each distinct
 * channel, [raw, G(s), |grad G(s)|, LoG(s)] for s in FEATURE_SIGMAS.
 * The Laplacian-of-Gaussian is the discrete Laplacian of the already-smoothed
 * plane (no separate second convolution).
 */
export function buildFeatureStack(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): IFeatureStack {
  const channels = extractDistinctChannels(rgba, width, height);
  const planes: Float32Array[] = [];
  for (const channel of channels) {
    planes.push(channel);
    for (const sigma of FEATURE_SIGMAS) {
      const smoothed = gaussianBlur(channel, width, height, sigma);
      planes.push(smoothed);
      planes.push(gradientMagnitude(smoothed, width, height));
      planes.push(laplacian(smoothed, width, height));
    }
  }
  return { width, height, channelCount: channels.length, planes };
}
