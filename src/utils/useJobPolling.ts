import { onBeforeUnmount, Ref, watch } from "vue";
import { createSequenceGuard } from "./sequenceGuard";

/** One dialog run owns both its submission and all subsequent polls.
 * Cancellation stops client observation, not the server job. Check isCurrent
 * after every await before publishing results or starting another side effect.
 */
export function useJobPolling(
  open: Ref<boolean>,
  datasetId: () => string | undefined,
  onInvalidate: () => void,
) {
  const guard = createSequenceGuard();
  let timer: ReturnType<typeof setTimeout> | null = null;
  function begin() {
    const token = guard.next();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    onInvalidate();
    return token;
  }
  function isCurrent(token: number) {
    return open.value && guard.isCurrent(token);
  }
  function schedule(token: number, callback: () => void, delay: number) {
    if (!isCurrent(token)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (isCurrent(token)) callback();
    }, delay);
  }
  watch([open, datasetId], begin, { flush: "sync" });
  onBeforeUnmount(begin);
  return { begin, isCurrent, schedule };
}
