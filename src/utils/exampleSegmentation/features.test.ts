import { describe, expect, it } from "vitest";
import {
  buildFeatureStack,
  extractDistinctChannels,
  gaussianBlur,
  gaussianKernel1D,
  gradientMagnitude,
  laplacian,
  PLANES_PER_CHANNEL,
} from "@/utils/exampleSegmentation/features";

describe("gaussianKernel1D", () => {
  it("is normalized and symmetric", () => {
    const kernel = gaussianKernel1D(2);
    const sum = kernel.reduce((acc, v) => acc + v, 0);
    expect(sum).toBeCloseTo(1, 5);
    const radius = (kernel.length - 1) / 2;
    for (let i = 0; i < radius; ++i) {
      expect(kernel[i]).toBeCloseTo(kernel[kernel.length - 1 - i], 6);
    }
  });

  it("has radius ceil(3*sigma)", () => {
    expect(gaussianKernel1D(1).length).toBe(2 * Math.ceil(3) + 1);
    expect(gaussianKernel1D(2.5).length).toBe(2 * Math.ceil(7.5) + 1);
  });
});

describe("gaussianBlur", () => {
  it("smooths an impulse into a shape approximating the analytic kernel", () => {
    const width = 41;
    const height = 41;
    const sigma = 2;
    const plane = new Float32Array(width * height);
    const cx = 20;
    const cy = 20;
    plane[cy * width + cx] = 1;

    const blurred = gaussianBlur(plane, width, height, sigma);
    const kernel = gaussianKernel1D(sigma);
    const radius = (kernel.length - 1) / 2;
    const expectedCenter = kernel[radius] * kernel[radius];

    expect(blurred[cy * width + cx]).toBeCloseTo(expectedCenter, 5);
    // Energy should be conserved (kernel is normalized) far from the border.
    let total = 0;
    for (let i = 0; i < blurred.length; ++i) total += blurred[i];
    expect(total).toBeCloseTo(1, 3);
    // Symmetric around the impulse.
    expect(blurred[cy * width + (cx + 3)]).toBeCloseTo(
      blurred[cy * width + (cx - 3)],
      5,
    );
  });

  it("clamps at the edges instead of wrapping or zero-padding", () => {
    const width = 5;
    const height = 1;
    const plane = Float32Array.from([1, 1, 1, 1, 1]);
    const blurred = gaussianBlur(plane, width, height, 1);
    // A constant plane should stay constant under edge-clamped convolution.
    for (const value of blurred) {
      expect(value).toBeCloseTo(1, 5);
    }
  });
});

describe("gradientMagnitude", () => {
  it("is constant for a linear ramp", () => {
    const width = 10;
    const height = 10;
    const slope = 3;
    const plane = new Float32Array(width * height);
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        plane[y * width + x] = slope * x;
      }
    }
    const grad = gradientMagnitude(plane, width, height);
    // Interior points (away from clamped edges) should all read the same slope.
    for (let y = 1; y < height - 1; ++y) {
      for (let x = 1; x < width - 1; ++x) {
        expect(grad[y * width + x]).toBeCloseTo(slope, 5);
      }
    }
  });

  it("is zero on a constant plane", () => {
    const width = 6;
    const height = 6;
    const plane = new Float32Array(width * height).fill(5);
    const grad = gradientMagnitude(plane, width, height);
    for (const value of grad) {
      expect(value).toBeCloseTo(0, 6);
    }
  });
});

describe("laplacian", () => {
  it("is zero on a linear ramp (interior)", () => {
    const width = 10;
    const height = 10;
    const plane = new Float32Array(width * height);
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        plane[y * width + x] = 2 * x + 3 * y;
      }
    }
    const lap = laplacian(plane, width, height);
    for (let y = 1; y < height - 1; ++y) {
      for (let x = 1; x < width - 1; ++x) {
        expect(lap[y * width + x]).toBeCloseTo(0, 5);
      }
    }
  });

  it("is negative at a local maximum", () => {
    const width = 5;
    const height = 5;
    const plane = new Float32Array(width * height).fill(0);
    plane[2 * width + 2] = 10;
    const lap = laplacian(plane, width, height);
    expect(lap[2 * width + 2]).toBeLessThan(0);
  });
});

function makeRgba(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("extractDistinctChannels", () => {
  it("dedupes to a single channel for a grayscale render (R=G=B)", () => {
    const width = 16;
    const height = 16;
    const rgba = makeRgba(width, height, (x) => {
      const v = (x * 17) % 256;
      return [v, v, v];
    });
    const channels = extractDistinctChannels(rgba, width, height);
    expect(channels.length).toBe(1);
  });

  it("keeps three channels when R, G, B differ", () => {
    const width = 16;
    const height = 16;
    const rgba = makeRgba(width, height, (x, y) => [
      x % 256,
      (x + y) % 256,
      y % 256,
    ]);
    const channels = extractDistinctChannels(rgba, width, height);
    expect(channels.length).toBe(3);
  });

  it("keeps two channels when only two are pixel-identical", () => {
    const width = 16;
    const height = 16;
    const rgba = makeRgba(width, height, (x, y) => {
      const v = (x * 5 + y) % 256;
      return [v, v, (x + y) % 256];
    });
    const channels = extractDistinctChannels(rgba, width, height);
    expect(channels.length).toBe(2);
  });
});

describe("buildFeatureStack", () => {
  it("produces PLANES_PER_CHANNEL planes per distinct channel", () => {
    const width = 12;
    const height = 12;
    const grayscale = makeRgba(width, height, (x, y) => {
      const v = (x * 13 + y * 7) % 256;
      return [v, v, v];
    });
    const stack = buildFeatureStack(grayscale, width, height);
    expect(stack.channelCount).toBe(1);
    expect(stack.planes.length).toBe(PLANES_PER_CHANNEL);
    expect(PLANES_PER_CHANNEL).toBe(13);
    for (const plane of stack.planes) {
      expect(plane.length).toBe(width * height);
    }

    const color = makeRgba(width, height, (x, y) => [
      x % 256,
      (x + y) % 256,
      y % 256,
    ]);
    const colorStack = buildFeatureStack(color, width, height);
    expect(colorStack.channelCount).toBe(3);
    expect(colorStack.planes.length).toBe(3 * PLANES_PER_CHANNEL);
  });
});
