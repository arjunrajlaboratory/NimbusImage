export function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

// Median of the positive, finite gaps between consecutive values — used to
// infer a uniform spacing (e.g. a z-step) from a list of positions.
export function medianPositiveSpacing(values: number[]): number | null {
  const diffs = values
    .slice(1)
    .map((value, index) => Math.abs(value - values[index]))
    .filter((diff) => diff > 0 && Number.isFinite(diff));
  return median(diffs);
}
