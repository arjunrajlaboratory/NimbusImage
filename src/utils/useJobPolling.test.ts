import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { useJobPolling } from "./useJobPolling";

function setup() {
  const open = ref(true);
  const datasetId = ref("ds1");
  const onInvalidate = vi.fn();
  let polling!: ReturnType<typeof useJobPolling>;
  const wrapper = mount(
    defineComponent({
      setup() {
        polling = useJobPolling(open, () => datasetId.value, onInvalidate);
        return () => null;
      },
    }),
  );
  return { open, datasetId, onInvalidate, polling, wrapper };
}

describe("useJobPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a run live, and polling, after the dialog closes", async () => {
    const { open, polling } = setup();
    const token = polling.begin();
    const callback = vi.fn();
    polling.schedule(token, callback, 100);
    open.value = false;
    await nextTick();
    expect(polling.isCurrent(token)).toBe(false);
    expect(polling.isLive(token)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(1);
    // Reopening does not revive the old run's UI, and a new run does not
    // cancel the old one's data side effects.
    open.value = true;
    await nextTick();
    const next = polling.begin();
    expect(polling.isCurrent(token)).toBe(false);
    expect(polling.isLive(token)).toBe(true);
    expect(polling.isCurrent(next)).toBe(true);
  });

  it("retires every run and pending poll when the dataset changes", async () => {
    const { datasetId, polling, onInvalidate } = setup();
    const token = polling.begin();
    const callback = vi.fn();
    polling.schedule(token, callback, 100);
    datasetId.value = "ds2";
    await nextTick();
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    expect(polling.isLive(token)).toBe(false);
    expect(polling.isCurrent(token)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).not.toHaveBeenCalled();
    polling.schedule(token, callback, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).not.toHaveBeenCalled();
    expect(polling.isCurrent(polling.begin())).toBe(true);
  });

  it("retires runs on unmount", async () => {
    const { polling, wrapper } = setup();
    const token = polling.begin();
    const callback = vi.fn();
    polling.schedule(token, callback, 100);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).not.toHaveBeenCalled();
    expect(polling.isLive(token)).toBe(false);
  });
});
