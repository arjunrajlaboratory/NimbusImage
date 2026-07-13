import { IGeoJSPosition } from "@/store/model";
import { IRawImageData } from "@/utils/tiff";

export interface IResampledLine {
  // Points at regular intervals along the polyline, in the same coordinate
  // space as the input vertices
  samplePoints: IGeoJSPosition[];
  // Distance of each sample point from the start of the line, in input units
  distances: number[];
}

/**
 * Resample a polyline at (at most maxSamples) regularly spaced points along
 * its arc length. Aims for roughly one sample per unit of length (i.e. one
 * per pixel when the input is in pixel coordinates).
 */
export function resamplePolyline(
  vertices: IGeoJSPosition[],
  maxSamples: number,
): IResampledLine | null {
  if (vertices.length < 2) {
    return null;
  }
  const cumulative: number[] = [0];
  for (let i = 1; i < vertices.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(
          vertices[i].x - vertices[i - 1].x,
          vertices[i].y - vertices[i - 1].y,
        ),
    );
  }
  const totalLength = cumulative[vertices.length - 1];
  if (totalLength <= 0) {
    return null;
  }
  const sampleCount = Math.min(
    maxSamples,
    Math.max(2, Math.ceil(totalLength) + 1),
  );
  const samplePoints: IGeoJSPosition[] = [];
  const distances: number[] = [];
  let segment = 0;
  for (let i = 0; i < sampleCount; i++) {
    const distance = (totalLength * i) / (sampleCount - 1);
    while (
      segment < vertices.length - 2 &&
      cumulative[segment + 1] < distance
    ) {
      segment++;
    }
    const segmentLength = cumulative[segment + 1] - cumulative[segment];
    const t =
      segmentLength > 0 ? (distance - cumulative[segment]) / segmentLength : 0;
    samplePoints.push({
      x:
        vertices[segment].x +
        t * (vertices[segment + 1].x - vertices[segment].x),
      y:
        vertices[segment].y +
        t * (vertices[segment + 1].y - vertices[segment].y),
    });
    distances.push(distance);
  }
  return { samplePoints, distances };
}

function sampleValueAt(image: IRawImageData, x: number, y: number): number {
  const { width, samplesPerPixel, data } = image;
  const base = (y * width + x) * samplesPerPixel;
  if (samplesPerPixel === 1) {
    return data[base];
  }
  // Multi-band pixels (e.g. RGB sources): average the color bands, ignoring
  // a potential alpha band
  const bands = Math.min(samplesPerPixel, 3);
  let sum = 0;
  for (let s = 0; s < bands; s++) {
    sum += data[base + s];
  }
  return sum / bands;
}

/**
 * Bilinearly interpolate the intensity of a raw image region at fractional
 * pixel coordinates. Returns null when the position is outside the image.
 */
export function bilinearSample(
  image: IRawImageData,
  x: number,
  y: number,
): number | null {
  const { width, height } = image;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
    return null;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = sampleValueAt(image, x0, y0);
  const v10 = sampleValueAt(image, x1, y0);
  const v01 = sampleValueAt(image, x0, y1);
  const v11 = sampleValueAt(image, x1, y1);
  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}
