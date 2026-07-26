import { describe, it, expect } from "vitest";
import { bilinearSample, resamplePolyline } from "./lineScan";
import { IRawImageData } from "./tiff";

describe("resamplePolyline", () => {
  it("returns null for degenerate lines", () => {
    expect(resamplePolyline([], 100)).toBeNull();
    expect(resamplePolyline([{ x: 1, y: 1 }], 100)).toBeNull();
    expect(
      resamplePolyline(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        100,
      ),
    ).toBeNull();
  });

  it("samples a straight line at regular intervals", () => {
    const result = resamplePolyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      100,
    );
    expect(result).not.toBeNull();
    expect(result!.samplePoints).toHaveLength(11);
    expect(result!.distances[0]).toBe(0);
    expect(result!.distances[10]).toBe(10);
    expect(result!.samplePoints[5]).toEqual({ x: 5, y: 0 });
  });

  it("caps the number of samples", () => {
    const result = resamplePolyline(
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      50,
    );
    expect(result!.samplePoints).toHaveLength(50);
    expect(result!.distances[49]).toBe(1000);
  });

  it("walks across polyline segments by arc length", () => {
    // L-shaped line of total length 20
    const result = resamplePolyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      100,
    );
    expect(result!.distances[result!.distances.length - 1]).toBe(20);
    // The sample at distance 15 lies on the second segment
    const index = result!.distances.findIndex((d) => d === 15);
    expect(result!.samplePoints[index].x).toBeCloseTo(10);
    expect(result!.samplePoints[index].y).toBeCloseTo(5);
  });
});

describe("bilinearSample", () => {
  const image: IRawImageData = {
    width: 3,
    height: 2,
    samplesPerPixel: 1,
    data: new Uint16Array([10, 20, 30, 40, 50, 60]),
  };

  it("returns exact values at integer coordinates", () => {
    expect(bilinearSample(image, 0, 0)).toBe(10);
    expect(bilinearSample(image, 2, 0)).toBe(30);
    expect(bilinearSample(image, 1, 1)).toBe(50);
  });

  it("interpolates between pixels", () => {
    expect(bilinearSample(image, 0.5, 0)).toBeCloseTo(15);
    expect(bilinearSample(image, 0, 0.5)).toBeCloseTo(25);
    expect(bilinearSample(image, 0.5, 0.5)).toBeCloseTo(30);
  });

  it("returns null outside the image", () => {
    expect(bilinearSample(image, -0.1, 0)).toBeNull();
    expect(bilinearSample(image, 0, 1.5)).toBeNull();
    expect(bilinearSample(image, 2.5, 0)).toBeNull();
  });

  it("averages the color bands of multi-band pixels", () => {
    const rgb: IRawImageData = {
      width: 1,
      height: 1,
      samplesPerPixel: 3,
      data: new Uint8Array([10, 20, 60]),
    };
    expect(bilinearSample(rgb, 0, 0)).toBeCloseTo(30);
  });
});
