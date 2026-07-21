// Human-readable labels for the long-running annotation load/query steps that
// would otherwise be silent (the lazy-mode stub fetch and each server-side list
// query). Kept pure so they can be unit-tested without the stores/components.

// "708,983 annotations" / "1 annotation" — locale-grouped count + plural noun.
function formatAnnotationCount(count: number): string {
  const noun = Math.abs(count) === 1 ? "annotation" : "annotations";
  return `${count.toLocaleString()} ${noun}`;
}

// Title for the lazy-mode stub-fetch progress bar (B1). The count is usually
// known up front (getAnnotationCount), so even an indeterminate bar can state
// the magnitude of the load instead of leaving the canvas silently empty. When
// the count is unknown (the count request failed and the caller fell back to
// stub-only mode, passing a non-finite count), omit the magnitude.
export function annotationLoadingTitle(count: number): string {
  if (!Number.isFinite(count)) {
    return "Loading annotations…";
  }
  return `Loading ${formatAnnotationCount(count)}…`;
}

// Status shown while a server-side list query is in flight (B2). Before the
// first response `total` is 0/unset, so fall back to a count-less message rather
// than claiming "0 annotations".
export function listQueryingMessage(total: number): string {
  if (total <= 0) {
    return "Querying annotations…";
  }
  return `Querying ${formatAnnotationCount(total)}…`;
}
