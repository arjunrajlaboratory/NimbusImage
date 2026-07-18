// Small shared numeric helpers.

/**
 * Constrain `value` to the inclusive range [lo, hi].
 *
 * Extracted from the three sibling visibility utilities
 * (visibilityBudget, visibilityConfigBounds, renderCoverage) that each
 * reimplemented `Math.min(hi, Math.max(lo, value))`.
 */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
