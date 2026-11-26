import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, enableAutoUnmount } from "@vue/test-utils";

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
  refreshMaps: vi.fn(),
  deleteMap: vi.fn(),
  updateDisplay: vi.fn(),
}));

vi.mock("@/store", async () => ({
  default: (await import("vue")).reactive({
    dataset: { id: "ds1" } as { id: string } | null,
    isLoggedIn: true,
    girderUser: { _id: "u1" } as any,
    xy: 0,
    z: 0,
    time: 0,
  }),
}));

vi.mock("@/store/scalarMaps", async () => {
  const { reactive } = await import("vue");
  return {
    defaultScalarMapDisplay: () => ({}),
    default: reactive({
      currentMaps: [] as any[],
      display: {} as Record<string, any>,
      error: null as string | null,
      loading: false,
      refreshMaps: mocks.refreshMaps,
      deleteMap: mocks.deleteMap,
      updateDisplay: mocks.updateDisplay,
      resetRange: vi.fn(),
    }),
  };
});

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));

import ScalarMapsPanel from "./ScalarMapsPanel.vue";
import scalarMapsStore from "@/store/scalarMaps";
import store from "@/store";

// Uniform 0..200: percentile i is 2i.
const PERCENTILES = Array.from({ length: 101 }, (_, i) => 2 * i);

const MAP = {
  itemId: "a",
  updated: "u",
  meta: {
    name: "Area mean, 50 µm",
    property: "Area",
    statistic: "Mean",
    cutoff: null,
    radius: 50,
    radiusUnit: "µm",
    locations: [{ XY: 0, Z: 0, Time: 0, key: "xy0_z0_t0" }],
    valueRange: [0, 200],
    percentiles: PERCENTILES,
    units: "µm²",
  },
};

function display(overrides: Record<string, any> = {}) {
  return {
    visible: true,
    opacity: 0.7,
    colormap: "viridis",
    min: 0,
    max: 200,
    thresholdEnabled: true,
    threshold: 160,
    thresholdSide: "above",
    ...overrides,
  };
}

function mount(visible = true) {
  return shallowMount(ScalarMapsPanel, { props: { visible } });
}

describe("ScalarMapsPanel", () => {
  beforeEach(() => {
    mocks.refreshMaps.mockClear();
    mocks.deleteMap.mockReset().mockResolvedValue(undefined);
    mocks.updateDisplay.mockClear();
    (store as any).dataset = { id: "ds1" };
    (store as any).isLoggedIn = true;
    (store as any).girderUser = { _id: "u1" };
    (scalarMapsStore as any).currentMaps = [MAP];
    (scalarMapsStore as any).display = { a: display() };
    (scalarMapsStore as any).error = null;
  });

  it("lists maps only while shown, and again for a new dataset", async () => {
    const wrapper = mount(false);
    await nextTick();
    expect(mocks.refreshMaps).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    expect(mocks.refreshMaps).toHaveBeenCalledTimes(1);
    (store as any).dataset = { id: "ds2" };
    await nextTick();
    expect(mocks.refreshMaps).toHaveBeenCalledTimes(2);
  });

  it("reads the threshold as a value and as a share of tissue", () => {
    const vm = mount().vm as any;
    expect(vm.thresholdText(MAP)).toBe("Value ≥ 160 µm² · top 20% of tissue");
    expect(vm.workerForms(MAP)).toEqual([
      { type: "Top percent of tissue", threshold: "20" },
      { type: "Value at least", threshold: "160" },
    ]);
    (scalarMapsStore as any).display = {
      a: display({ threshold: 20, thresholdSide: "below" }),
    };
    expect(vm.thresholdText(MAP)).toBe("Value ≤ 20 µm² · bottom 10% of tissue");
  });

  it("sets the threshold from a share of tissue on the chosen side", () => {
    const vm = mount().vm as any;
    vm.onShare(MAP, 30);
    expect(mocks.updateDisplay).toHaveBeenLastCalledWith({
      itemId: "a",
      changes: { threshold: 140 },
    });
  });

  it("ignores an empty display range", () => {
    const vm = mount().vm as any;
    vm.onRange(MAP, [50, 50]);
    expect(mocks.updateDisplay).not.toHaveBeenCalled();
    vm.onRange(MAP, [20, 80]);
    expect(mocks.updateDisplay).toHaveBeenCalledWith({
      itemId: "a",
      changes: { min: 20, max: 80 },
    });
  });

  it("deletes after confirmation and shows the server's reason on failure", async () => {
    const vm = mount().vm as any;
    mocks.deleteMap.mockRejectedValueOnce(new Error("Write access denied"));
    vm.askDelete(MAP);
    await vm.confirmDelete();
    expect(mocks.deleteMap).toHaveBeenCalledWith("a");
    expect(vm.deleteError).toBe("Write access denied");
    expect(vm.deleteDialog).toBe(true);
    await vm.confirmDelete();
    expect(vm.deleteDialog).toBe(false);
    expect(vm.deleteError).toBeNull();
  });

  it("offers delete only to sessions that can write", () => {
    expect((mount().vm as any).canDelete).toBe(true);
    (store as any).girderUser = { _id: "u2", shareLink: "link1" };
    expect((mount().vm as any).canDelete).toBe(false);
    (store as any).isLoggedIn = false;
    (store as any).girderUser = null;
    expect((mount().vm as any).canDelete).toBe(false);
  });
});
