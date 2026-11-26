import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, enableAutoUnmount } from "@vue/test-utils";

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
  refreshMaps: vi.fn(),
  ensureColormapStops: vi.fn(),
  deleteMap: vi.fn(),
  updateDisplay: vi.fn(),
  setThresholdPercent: vi.fn(),
  setThresholdValue: vi.fn(),
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
      colormapStops: null as Record<string, string[]> | null,
      error: null as string | null,
      loading: false,
      refreshMaps: mocks.refreshMaps,
      ensureColormapStops: mocks.ensureColormapStops,
      deleteMap: mocks.deleteMap,
      updateDisplay: mocks.updateDisplay,
      setThresholdPercent: mocks.setThresholdPercent,
      setThresholdValue: mocks.setThresholdValue,
      setThresholdSide: vi.fn(),
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
// 60% of the tissue at the minimum.
const TIED = Array.from({ length: 101 }, (_, i) => (i <= 60 ? 0 : i - 60));

function scalarMap(
  percentiles = PERCENTILES,
  valueRange: [number, number] = [0, 200],
) {
  return {
    itemId: "a",
    updated: "u",
    revision: "r",
    meta: {
      name: "Area mean, 50 µm",
      property: "Area",
      statistic: "Mean",
      cutoff: null,
      radius: 50,
      radiusUnit: "µm",
      locations: [{ XY: 0, Z: 0, Time: 0, key: "xy0_z0_t0" }],
      valueRange,
      percentiles,
      units: "µm²",
    },
  };
}

const MAP = scalarMap();

function display(overrides: Record<string, any> = {}) {
  return {
    visible: true,
    opacity: 0.7,
    colormap: "viridis",
    min: 0,
    max: 200,
    thresholdEnabled: true,
    threshold: 160,
    thresholdPercent: 20,
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
    mocks.ensureColormapStops.mockClear();
    mocks.deleteMap.mockReset().mockResolvedValue(undefined);
    mocks.updateDisplay.mockClear();
    mocks.setThresholdPercent.mockClear();
    mocks.setThresholdValue.mockClear();
    (store as any).dataset = { id: "ds1" };
    (store as any).isLoggedIn = true;
    (store as any).girderUser = { _id: "u1" };
    (scalarMapsStore as any).currentMaps = [MAP];
    (scalarMapsStore as any).display = { a: display() };
    (scalarMapsStore as any).colormapStops = null;
    (scalarMapsStore as any).error = null;
  });

  it("lists maps only while shown, and again for a new dataset", async () => {
    const wrapper = mount(false);
    await nextTick();
    expect(mocks.refreshMaps).not.toHaveBeenCalled();
    expect(mocks.ensureColormapStops).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    expect(mocks.refreshMaps).toHaveBeenCalledTimes(1);
    expect(mocks.ensureColormapStops).toHaveBeenCalledTimes(1);
    (store as any).dataset = { id: "ds2" };
    await nextTick();
    expect(mocks.refreshMaps).toHaveBeenCalledTimes(2);
  });

  it("draws the legend from the server's colormap table", () => {
    const vm = mount().vm as any;
    expect(vm.legendGradient("viridis")).toBeNull();
    (scalarMapsStore as any).colormapStops = {
      viridis: ["#440154", "#fde725"],
    };
    expect(vm.legendGradient("viridis")).toBe(
      "linear-gradient(to right, #440154, #fde725)",
    );
  });

  it("reads the threshold as a value and as a share of tissue", () => {
    const vm = mount().vm as any;
    expect(vm.thresholdText(MAP)).toBe("Value ≥ 160 µm² · top 20% of tissue");
    (scalarMapsStore as any).display = {
      a: display({
        threshold: 20,
        thresholdPercent: null,
        thresholdSide: "below",
      }),
    };
    expect(vm.thresholdText(MAP)).toBe("Value ≤ 20 µm² · bottom 10% of tissue");
  });

  it("says when ties select more tissue than was asked for", () => {
    const tied = scalarMap(TIED, [0, 40]);
    (scalarMapsStore as any).currentMaps = [tied];
    (scalarMapsStore as any).display = {
      a: display({
        threshold: 0,
        thresholdPercent: 50,
        thresholdSide: "below",
      }),
    };
    const vm = mount().vm as any;
    expect(vm.thresholdText(tied)).toBe(
      "Value ≤ 0 µm² · bottom 50% requested, 60% selected (ties)",
    );
  });

  it("gives the worker the exact cutoff, and marks an inexact percent", () => {
    const vm = mount().vm as any;
    (scalarMapsStore as any).display = {
      a: display({ threshold: 123.456789, thresholdPercent: null }),
    };
    expect(vm.workerForms(MAP)).toEqual([
      expect.objectContaining({ approximate: true }),
      {
        type: "Value at least",
        threshold: "123.456789",
        approximate: false,
      },
    ]);
  });

  it("keeps the chosen share as state when set by percent", () => {
    const vm = mount().vm as any;
    vm.onShare(MAP, 30);
    expect(mocks.setThresholdPercent).toHaveBeenLastCalledWith({
      itemId: "a",
      percent: 30,
    });
  });

  it("drives value sliders with integer positions, even on a tiny range", () => {
    const tiny = scalarMap(
      Array.from({ length: 101 }, (_, i) => i * 1e-9),
      [0, 1e-7],
    );
    (scalarMapsStore as any).currentMaps = [tiny];
    (scalarMapsStore as any).display = {
      a: display({ min: 0, max: 1e-7, threshold: 5e-8 }),
    };
    const vm = mount().vm as any;
    expect(vm.rangePositions(tiny)).toEqual([0, 1000]);
    expect(vm.thresholdPosition(tiny)).toBe(500);
    vm.onThresholdPosition(tiny, 250);
    expect(mocks.setThresholdValue).toHaveBeenLastCalledWith({
      itemId: "a",
      value: 2.5e-8,
    });
    vm.onRange(tiny, [100, 900]);
    const { changes } = mocks.updateDisplay.mock.lastCall![0];
    expect(changes.min).toBeCloseTo(1e-8, 20);
    expect(changes.max).toBeCloseTo(9e-8, 20);
    // An empty range is ignored.
    mocks.updateDisplay.mockClear();
    vm.onRange(tiny, [400, 400]);
    expect(mocks.updateDisplay).not.toHaveBeenCalled();
  });

  it("gives a constant map a usable slider range", () => {
    const flat = scalarMap(new Array(101).fill(4), [4, 4]);
    (scalarMapsStore as any).currentMaps = [flat];
    (scalarMapsStore as any).display = {
      a: display({ min: 3.5, max: 4.5, threshold: 4 }),
    };
    const vm = mount().vm as any;
    expect(vm.rangePositions(flat)).toEqual([0, 1000]);
    expect(vm.thresholdPosition(flat)).toBe(500);
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
