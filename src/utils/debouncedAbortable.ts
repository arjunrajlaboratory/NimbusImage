/**
 * A trailing-edge debounced task whose runs are also cancellable via an
 * AbortSignal. Each fire aborts the previous run's signal, so a stale in-flight
 * async operation (e.g. an HTTP request superseded by a newer one) can bail out
 * instead of overwriting newer state.
 *
 * Used for viewport-driven annotation hydration (C1): rapid pan/zoom/frame
 * changes collapse to one fetch, and a fetch still in flight when a newer one
 * starts is aborted so its response can't clobber the newer cache state.
 */
export interface IDebouncedAbortableTask<T> {
  // Schedule a run with `payload`. Resets the debounce timer; only the latest
  // payload runs when the timer fires.
  schedule(payload: T): void;
  // Cancel a pending run and abort the most recent in-flight run's signal.
  cancel(): void;
}

/**
 * True when an error is an aborted/cancelled request rather than a real
 * failure. Covers axios's CanceledError (name/code) and the native
 * AbortController's DOMException AbortError, so callers can swallow it silently
 * instead of logging a spurious error.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === "CanceledError" || name === "AbortError" || code === "ERR_CANCELED"
  );
}

export function createDebouncedAbortableTask<T>(
  run: (payload: T, signal: AbortSignal) => void | Promise<void>,
  delayMs: number,
): IDebouncedAbortableTask<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let pending: { payload: T } | null = null;

  return {
    schedule(payload: T) {
      pending = { payload };
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        const current = pending;
        pending = null;
        if (!current) {
          return;
        }
        // Supersede any still-in-flight run; its result is now stale.
        if (controller) {
          controller.abort();
        }
        controller = new AbortController();
        run(current.payload, controller.signal);
      }, delayMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (controller) {
        controller.abort();
        controller = null;
      }
      pending = null;
    },
  };
}
