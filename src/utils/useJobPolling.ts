import { onBeforeUnmount, Ref, watch } from "vue";
import { createSequenceGuard } from "./sequenceGuard";

/** One dialog run owns its submission and all subsequent polls.
 *
 * A run has two lifetimes:
 * - `isCurrent(token)`: the dialog is open and no newer run, open or close
 *   superseded it. Guard every write to the dialog's own UI (running flag,
 *   messages, the result it shows) with this.
 * - `isLive(token)`: the dataset (and the component) is unchanged. Polling
 *   continues while live, and a job's data side effects (reloading property
 *   values, re-reading the active table) run on success while live, so
 *   closing a dialog on a job that takes minutes still refreshes the app.
 *
 * Cancellation stops client observation, not the server job. Check the
 * matching guard after every await before publishing a result or starting
 * another side effect.
 */
export function useJobPolling(
  open: Ref<boolean>,
  datasetId: () => string | undefined,
  onInvalidate: () => void,
) {
  const guard = createSequenceGuard();
  // Tokens at or below this belong to a dataset (or component) that is gone.
  let retiredThrough = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function begin() {
    const token = guard.next();
    onInvalidate();
    return token;
  }
  function isCurrent(token: number) {
    return open.value && guard.isCurrent(token) && isLive(token);
  }
  function isLive(token: number) {
    return token > retiredThrough;
  }
  function schedule(token: number, callback: () => void, delay: number) {
    if (!isLive(token)) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (isLive(token)) callback();
    }, delay);
    timers.add(timer);
  }
  function retire() {
    retiredThrough = begin();
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  }
  watch(open, begin, { flush: "sync" });
  watch(datasetId, retire, { flush: "sync" });
  onBeforeUnmount(retire);
  return { begin, isCurrent, isLive, schedule };
}
