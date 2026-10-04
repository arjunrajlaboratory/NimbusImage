import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, shallowMount } from "@vue/test-utils";

const { getPropertyDistinctValues } = vi.hoisted(() => ({
  getPropertyDistinctValues: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: { dataset: { id: "ds1" } },
}));

vi.mock("@/store/properties", () => ({
  default: { propertiesAPI: { getPropertyDistinctValues } },
}));

import PropertyCategoryFilter from "./PropertyCategoryFilter.vue";

const GENES = {
  values: [
    { value: "KIT", count: 9 },
    { value: "KITLG", count: 4 },
    { value: "TP53", count: 3 },
    { value: "MYC", count: 2 },
  ],
  truncated: false,
};

let wrapper: ReturnType<typeof shallowMount> | null = null;

async function mountComponent(modelValue: string[] = []) {
  wrapper = shallowMount(PropertyCategoryFilter, {
    props: { propertyPath: ["p", "gene"], modelValue },
  });
  await flushPromises();
  return wrapper;
}

function lastEmitted(w: ReturnType<typeof shallowMount>) {
  const events = w.emitted("update:modelValue") ?? [];
  return events[events.length - 1]?.[0];
}

describe("PropertyCategoryFilter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getPropertyDistinctValues.mockReset();
    getPropertyDistinctValues.mockResolvedValue(GENES);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it("loads the distinct values once for the property", async () => {
    const w = await mountComponent();
    expect(getPropertyDistinctValues).toHaveBeenCalledTimes(1);
    expect(getPropertyDistinctValues).toHaveBeenCalledWith(
      "ds1",
      ["p", "gene"],
      "",
    );
    expect((w.vm as any).shownEntries).toHaveLength(4);
  });

  it("searches a complete list locally, case-insensitively, without a request", async () => {
    const w = await mountComponent();
    (w.vm as any).search = "kit";
    await flushPromises();
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect((w.vm as any).shownEntries.map((e: any) => e.value)).toEqual([
      "KIT",
      "KITLG",
    ]);
    expect(getPropertyDistinctValues).toHaveBeenCalledTimes(1);
  });

  it("toggles values on and off (OR selection)", async () => {
    const w = await mountComponent(["TP53"]);
    (w.vm as any).toggle("KIT");
    expect(lastEmitted(w)).toEqual(["TP53", "KIT"]);
    (w.vm as any).toggle("TP53");
    expect(lastEmitted(w)).toEqual([]);
  });

  it("Enter picks the exact match over the top result, then clears the search", async () => {
    const w = await mountComponent();
    (w.vm as any).search = "kitlg";
    await flushPromises();
    (w.vm as any).toggleFirstShown();
    expect(lastEmitted(w)).toEqual(["KITLG"]);
    expect((w.vm as any).search).toBe("");

    (w.vm as any).search = "KI";
    await flushPromises();
    (w.vm as any).toggleFirstShown();
    expect(lastEmitted(w)).toEqual(["KIT"]);
  });

  it("selects every shown match without duplicating already-selected ones", async () => {
    const w = await mountComponent(["KIT"]);
    (w.vm as any).search = "kit";
    await flushPromises();
    (w.vm as any).selectShown();
    expect(lastEmitted(w)).toEqual(["KIT", "KITLG"]);
  });

  it("asks the server when the full list was truncated", async () => {
    getPropertyDistinctValues.mockImplementation(
      async (_ds: string, _path: string[], search: string) =>
        search
          ? { values: [{ value: "ZAP70", count: 1 }], truncated: false }
          : { ...GENES, truncated: true },
    );
    const w = await mountComponent();
    (w.vm as any).search = "zap";
    await flushPromises();
    vi.advanceTimersByTime(400);
    await flushPromises();
    expect(getPropertyDistinctValues).toHaveBeenLastCalledWith(
      "ds1",
      ["p", "gene"],
      "zap",
    );
    expect((w.vm as any).shownEntries.map((e: any) => e.value)).toEqual([
      "ZAP70",
    ]);
  });

  it("ignores a stale search response that resolves after a newer one", async () => {
    const pending: Record<string, (v: any) => void> = {};
    getPropertyDistinctValues.mockImplementation(
      (_ds: string, _path: string[], search: string) =>
        search
          ? new Promise((resolve) => {
              pending[search] = resolve;
            })
          : Promise.resolve({ ...GENES, truncated: true }),
    );
    const w = await mountComponent();
    (w.vm as any).search = "a";
    await flushPromises();
    vi.advanceTimersByTime(400);
    (w.vm as any).search = "ab";
    await flushPromises();
    vi.advanceTimersByTime(400);
    pending.ab({ values: [{ value: "AB", count: 1 }], truncated: false });
    await flushPromises();
    pending.a({ values: [{ value: "A-stale", count: 1 }], truncated: false });
    await flushPromises();
    expect((w.vm as any).shownEntries.map((e: any) => e.value)).toEqual(["AB"]);
  });
});
