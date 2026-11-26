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
      scalarMapsError: null as string | null,
      loading: false,
      refreshScalarMaps: mocks.refreshMaps,
      ensureScalarMapColormapStops: mocks.ensureColormapStops,
      deleteScalarMap: mocks.deleteMap,
      updateScalarMapDisplay: mocks.updateDisplay,
      setScalarMapThresholdPercent: mocks.setThresholdPercent,
      setScalarMapThresholdValue: mocks.setThresholdValue,
      setScalarMapThresholdSide: vi.fn(),
      resetScalarMapRange: vi.fn(),
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
    (scalarMapsStore as any).scalarMapsError = null;
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
    // The share is an estimate over every position of the map.
    expect(vm.thresholdText(MAP)).toBe(
      "Value ≥ 160 µm² · ≈ top 20% of tissue (all positions)",
    );
    (scalarMapsStore as any).display = {
      a: display({
        threshold: 20,
        thresholdPercent: null,
        thresholdSide: "below",
      }),
    };
    expect(vm.thresholdText(MAP)).toBe(
      "Value ≤ 20 µm² · ≈ bottom 10% of tissue (all positions)",
    );
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
      "Value ≤ 0 µm² · ≈ bottom 60% of tissue (all positions); 50% requested, more selected because of ties at the cutoff",
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

  it("shows and offers to copy a set share exactly as set", () => {
    const vm = mount().vm as any;
    // 12.5% on the slider's 0.5 steps: never rounded to 13 (a different
    // percentile from the one previewed).
    (scalarMapsStore as any).display = {
      a: display({ threshold: 175, thresholdPercent: 12.5 }),
    };
    expect(vm.thresholdText(MAP)).toBe(
      "Value ≥ 175 µm² · ≈ top 12.5% of tissue (all positions)",
    );
    expect(vm.workerForms(MAP)[0]).toEqual({
      type: "Top percent of tissue",
      threshold: "12.5",
      approximate: true,
    });
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
  });

  it("keeps the range one position wide instead of dropping a collapsed range", () => {
    const vm = mount().vm as any;
    // Display [0, 200] is positions [0, 1000]; the high thumb is dragged
    // all the way down onto the low one.
    vm.onRange(MAP, [0, 0]);
    expect(mocks.updateDisplay).toHaveBeenLastCalledWith({
      itemId: "a",
      changes: { min: 0, max: 0.2 },
    });
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

  it("closes a pending confirmation on a dataset switch and never deletes the previous dataset's map", async () => {
    const vm = mount().vm as any;
    vm.askDelete(MAP);
    expect(vm.deleteDialog).toBe(true);
    // Browser Back to another dataset with the dialog open.
    (store as any).dataset = { id: "ds2" };
    (scalarMapsStore as any).currentMaps = [];
    await nextTick();
    expect(vm.deleteDialog).toBe(false);
    await vm.confirmDelete();
    expect(mocks.deleteMap).not.toHaveBeenCalled();
  });

  it("ends a confirmation when the palette is hidden", async () => {
    const wrapper = mount();
    const vm = wrapper.vm as any;
    vm.askDelete(MAP);
    // Navigating Home hides the palette with the dataset unchanged.
    await wrapper.setProps({ visible: false });
    expect(vm.deleteDialog).toBe(false);
  });

  it("ends a confirmation when its map leaves the list", async () => {
    const vm = mount().vm as any;
    vm.askDelete(MAP);
    // A job's re-list removed it.
    (scalarMapsStore as any).currentMaps = [];
    await nextTick();
    expect(vm.deleteDialog).toBe(false);
    await vm.confirmDelete();
    expect(mocks.deleteMap).not.toHaveBeenCalled();
  });

  it("applies a delete's result only to the confirmation that started it", async () => {
    const vm = mount().vm as any;
    let reject!: (error: unknown) => void;
    mocks.deleteMap.mockReturnValueOnce(
      new Promise((_resolve, rejectDelete) => {
        reject = rejectDelete;
      }),
    );
    vm.askDelete(MAP);
    const inFlight = vm.confirmDelete();
    // Escape while it runs, then a new confirmation.
    vm.deleteDialog = false;
    await nextTick();
    vm.askDelete(MAP);
    reject(new Error("Write access denied"));
    await inFlight;
    expect(vm.deleteDialog).toBe(true);
    expect(vm.deleteError).toBeNull();
    expect(vm.deleting).toBe(false);
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
