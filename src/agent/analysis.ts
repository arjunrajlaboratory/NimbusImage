// Pure, store-free helpers for the AI-panel data-analysis tools (ports of PR
// #1221's Python helpers). Everything here is unit-testable without the Vuex
// store; the executors that need store data live in executors.ts.

export const MAX_PLOT_POINTS = 50000;
export const MAX_BOX_POINTS = 20000;
export const MAX_HISTOGRAM_BUCKETS = 200;
export const MAX_SAMPLE_ROWS = 100;
export const SIGNIFICANT_DIGITS = 6;

export interface IHistogramBucket {
  min: number;
  max: number;
  count: number;
}

export interface IPathStats {
  count: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  median: number;
  p25: number;
  p75: number;
}

export interface IBoxStats {
  q1: number;
  median: number;
  q3: number;
  // Whisker endpoints: the most extreme data values still within 1.5*IQR of
  // the quartiles (Tukey), matching how Plotly draws whiskers from raw points.
  lowerFence: number;
  upperFence: number;
  mean: number;
}

// Linear-interpolation percentile on an already-sorted, non-empty array,
// matching Python statistics.quantiles(method="inclusive").
function percentileOfSorted(sorted: number[], q: number): number {
  const count = sorted.length;
  const pos = (count - 1) * q;
  const lower = Math.floor(pos);
  const lowerValue = sorted[lower];
  const upperValue = lower + 1 < count ? sorted[lower + 1] : lowerValue;
  return lowerValue + (pos - lower) * (upperValue - lowerValue);
}

// Round to SIGNIFICANT_DIGITS significant digits. null passes through as null;
// non-finite values (Infinity/NaN) pass through unchanged.
export function roundSignificant(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return value;
  }
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

// Deterministic every-k-th downsample preserving order. Returns
// [sampled, wasDownsampled]; the original array is returned untouched when it
// already fits within the limit.
export function downsample<T>(items: T[], limit: number): [T[], boolean] {
  if (items.length <= limit) {
    return [items, false];
  }
  const step = Math.ceil(items.length / limit);
  const sampled: T[] = [];
  for (let i = 0; i < items.length; i += step) {
    sampled.push(items[i]);
  }
  return [sampled, true];
}

// Walk path segments through a nested values object (objects keyed by segment).
// Returns the leaf only when it is a finite number, else null.
export function resolvePathValue(values: any, path: string[]): number | null {
  let current = values;
  for (const segment of path) {
    if (current == null || typeof current !== "object") {
      return null;
    }
    current = current[segment];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : null;
}

// Statistics over a non-empty numeric array (caller guarantees non-empty).
// Unrounded — callers round. std is the sample standard deviation (n-1
// divisor), 0 for count === 1. median/p25/p75 are linear-interpolation
// percentiles on the sorted array, matching Python
// statistics.quantiles(method="inclusive").
export function computeStats(values: number[]): IPathStats {
  const count = values.length;
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const std =
    count === 1
      ? 0
      : Math.sqrt(
          values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
            (count - 1),
        );
  return {
    count,
    mean,
    std,
    min: sorted[0],
    max: sorted[count - 1],
    median: percentileOfSorted(sorted, 0.5),
    p25: percentileOfSorted(sorted, 0.25),
    p75: percentileOfSorted(sorted, 0.75),
  };
}

// Box-plot statistics over a non-empty numeric array: quartiles plus Tukey
// whisker endpoints (the most extreme data values within 1.5*IQR of the
// quartiles). Used to render an exact box for datasets too large to ship every
// point; individual outlier markers are omitted, but the box and whiskers match
// what Plotly would draw from the raw points.
export function computeBoxStats(values: number[]): IBoxStats {
  const sorted = values.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const q1 = percentileOfSorted(sorted, 0.25);
  const q3 = percentileOfSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  let lowerFence = sorted[0];
  for (const value of sorted) {
    if (value >= lowerBound) {
      lowerFence = value;
      break;
    }
  }
  let upperFence = sorted[count - 1];
  for (let i = count - 1; i >= 0; i--) {
    if (sorted[i] <= upperBound) {
      upperFence = sorted[i];
      break;
    }
  }
  return {
    q1,
    median: percentileOfSorted(sorted, 0.5),
    q3,
    lowerFence,
    upperFence,
    mean: sorted.reduce((sum, value) => sum + value, 0) / count,
  };
}

// Uniform bins over [min, max] of the values. Constant data (min === max) or
// buckets <= 1 collapses to a single bucket spanning [min, max] with the full
// count. Otherwise bucket i spans [min + i*w, min + (i+1)*w] with
// w = (max-min)/buckets; the max value lands in the last bucket (index
// clamped). Zero-count buckets are kept for contiguous coverage. Bounds are
// unrounded.
export function uniformHistogram(
  values: number[],
  buckets: number,
): IHistogramBucket[] {
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  if (min === max || buckets <= 1) {
    return [{ min, max, count: values.length }];
  }
  const width = (max - min) / buckets;
  const result: IHistogramBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    result.push({ min: min + i * width, max: min + (i + 1) * width, count: 0 });
  }
  for (const value of values) {
    const index = Math.min(buckets - 1, Math.floor((value - min) / width));
    result[index].count++;
  }
  return result;
}
