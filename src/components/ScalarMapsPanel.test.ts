import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { shallowMount, enableAutoUnmount } from "@vue/test-utils";

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
  refreshMaps: vi.fn(),
  ensureColormapStops: vi.fn(),
  deleteMap: vi.fn(),
  updateDisplay: vi.fn(),
  setThresholdPercent: vi.fn(),
  setThresholdValue: vi.fn(),
  requestTileRetry: vi.fn(),
  locationKey: null as any,
  setDrawAnnotations: vi.fn(),
  reorderMaps: vi.fn(),
}));

// Spy on the per-card position lookup (the only part of a card that reads
// the viewer's XY/Z/Time) while keeping its real behavior.
vi.mock("@/utils/scalarMap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/scalarMap")>();
  mocks.locationKey = vi.fn(actual.scalarMapLocationKey);
  return { ...actual, scalarMapLocationKey: mocks.locationKey };
});

vi.mock("@/store", async () => ({
  default: (await import("vue")).reactive({
    dataset: { id: "ds1" } as { id: string } | null,
    isLoggedIn: true,
    girderUser: { _id: "u1" } as any,
    xy: 0,
    z: 0,
    time: 0,
    drawAnnotations: true,
    setDrawAnnotations: mocks.setDrawAnnotations,
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
      deletingMapIds: [] as string[],
      tileFailedMapIds: [] as string[],
      requestScalarMapTileRetry: mocks.requestTileRetry,
      refreshScalarMaps: mocks.refreshMaps,
      ensureScalarMapColormapStops: mocks.ensureColormapStops,
      deleteScalarMap: mocks.deleteMap,
      updateScalarMapDisplay: mocks.updateDisplay,
      setScalarMapThresholdPercent: mocks.setThresholdPercent,
      setScalarMapThresholdValue: mocks.setThresholdValue,
      setScalarMapThresholdSide: vi.fn(),
      resetScalarMapRange: vi.fn(),
      reorderScalarMaps: mocks.reorderMaps,
    }),
  };
});

vi.mock("@/store/sync", async () => ({
  default: (await import("vue")).reactive({ datasetLoading: false }),
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));

import ScalarMapsPanel from "./ScalarMapsPanel.vue";
import scalarMapsStore from "@/store/scalarMaps";
import store from "@/store";
import sync from "@/store/sync";

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

// shallowMount's own stub of vuedraggable renders no `#item` slot, so no
// card: this one renders it for each element, as vuedraggable does.
const DraggableStub = defineComponent({
  name: "draggable",
  props: {
    modelValue: { type: Array, default: () => [] },
    itemKey: { type: String, default: "" },
    handle: { type: String, default: "" },
  },
  emits: ["update:modelValue", "start", "end"],
  setup(props, { slots }) {
    return () =>
      h(
        "div",
        { class: "draggable-stub" },
        props.modelValue.map((element, index) =>
          slots.item?.({ element, index }),
        ),
      );
  },
});

const stubs = { draggable: DraggableStub };

function mount(visible = true) {
  return shallowMount(ScalarMapsPanel, {
    props: { visible },
    global: { stubs },
  });
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
    (sync as any).datasetLoading = false;
    (store as any).girderUser = { _id: "u1" };
    (scalarMapsStore as any).currentMaps = [MAP];
    (scalarMapsStore as any).display = { a: display() };
    (scalarMapsStore as any).colormapStops = null;
    (scalarMapsStore as any).scalarMapsError = null;
    (scalarMapsStore as any).deletingMapIds = [];
    (scalarMapsStore as any).tileFailedMapIds = [];
    (store as any).xy = 0;
    (store as any).z = 0;
    (store as any).time = 0;
    mocks.requestTileRetry.mockClear();
    mocks.locationKey.mockClear();
    mocks.reorderMaps.mockClear();
  });

  // Renders the slots of the stubbed Vuetify children, so the card bodies
  // (and their position lookups) actually render.
  function mountWithCards(visible = true) {
    return shallowMount(ScalarMapsPanel, {
      props: { visible },
      global: { renderStubDefaultSlot: true, stubs },
    });
  }

  // The store's contract (scalarMaps.test.ts): an item id is in
  // `deletingMapIds` from the DELETE until it settles.
  function deleteThatTracksPending(request: Promise<void>) {
    return (itemId: string) => {
      const pending = (scalarMapsStore as any).deletingMapIds as string[];
      pending.push(itemId);
      return request.finally(() => {
        pending.splice(pending.indexOf(itemId), 1);
      });
    };
  }

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

  it("closes a pending confirmation when a dataset view starts loading and sends no DELETE while it loads", async () => {
    const vm = mount().vm as any;
    vm.askDelete(MAP);
    expect(vm.deleteDialog).toBe(true);
    // Browser Back to another view: the load starts while store.dataset and
    // the listed maps are still the dataset being left.
    (sync as any).datasetLoading = true;
    await nextTick();
    expect(vm.deleteDialog).toBe(false);
    vm.askDelete(MAP);
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
    mocks.deleteMap.mockImplementationOnce(
      deleteThatTracksPending(
        new Promise((_resolve, rejectDelete) => {
          reject = rejectDelete;
        }),
      ),
    );
    vm.askDelete(MAP);
    const inFlight = vm.confirmDelete();
    // Escape while it runs, then a new confirmation.
    vm.deleteDialog = false;
    await nextTick();
    vm.askDelete(MAP);
    // Still running: the reopened confirmation shows it.
    expect(vm.deleting).toBe(true);
    reject(new Error("Write access denied"));
    await inFlight.catch(() => {});
    await nextTick();
    expect(vm.deleteDialog).toBe(true);
    expect(vm.deleteError).toBeNull();
    expect(vm.deleting).toBe(false);
  });

  it("sends one DELETE when the confirmation is closed mid-delete, reopened and confirmed", async () => {
    const vm = mount().vm as any;
    let resolve!: () => void;
    mocks.deleteMap.mockImplementationOnce(
      deleteThatTracksPending(
        new Promise<void>((resolveDelete) => {
          resolve = resolveDelete;
        }),
      ),
    );
    vm.askDelete(MAP);
    const inFlight = vm.confirmDelete();
    expect(vm.deleting).toBe(true);
    // Escape while the DELETE runs.
    vm.deleteDialog = false;
    await nextTick();
    expect(vm.deleting).toBe(true);
    vm.askDelete(MAP);
    expect(vm.deleteDialog).toBe(true);
    expect(vm.deleting).toBe(true);
    await vm.confirmDelete();
    expect(mocks.deleteMap).toHaveBeenCalledTimes(1);
    resolve();
    await inFlight;
    expect(vm.deleting).toBe(false);
    expect(mocks.deleteMap).toHaveBeenCalledTimes(1);
  });

  it("offers delete only to sessions that can write", () => {
    expect((mount().vm as any).canDelete).toBe(true);
    (store as any).girderUser = { _id: "u2", shareLink: "link1" };
    expect((mount().vm as any).canDelete).toBe(false);
    (store as any).isLoggedIn = false;
    (store as any).girderUser = null;
    expect((mount().vm as any).canDelete).toBe(false);
  });
  it("shows and sets the viewer's object switch", async () => {
    (store as any).drawAnnotations = true;
    mocks.setDrawAnnotations.mockClear();
    const wrapper = mount();
    const toggle = () =>
      wrapper.find(".objects-toggle").findComponent({ name: "VCheckboxBtn" });
    expect(toggle().props("modelValue")).toBe(true);
    toggle().vm.$emit("update:modelValue", false);
    expect(mocks.setDrawAnnotations).toHaveBeenCalledWith(false);
    // Follows the store, which hotkey A and the settings panel also write.
    (store as any).drawAnnotations = false;
    await nextTick();
    expect(toggle().props("modelValue")).toBe(false);
    (store as any).drawAnnotations = true;
  });

  it("Refresh lists the maps again and requests failed tiles again", () => {
    (mount().vm as any).refresh();
    expect(mocks.requestTileRetry).toHaveBeenCalledTimes(1);
    expect(mocks.refreshMaps).toHaveBeenLastCalledWith(true);
  });

  it("warns on a map's card when some of its tiles failed to load", async () => {
    const wrapper = mountWithCards();
    expect(wrapper.find(".tiles-failed").exists()).toBe(false);
    (scalarMapsStore as any).tileFailedMapIds = ["a"];
    await nextTick();
    expect(wrapper.find(".tiles-failed").text()).toContain("Press Refresh");
  });

  it("does no per-frame rendering while hidden, and shows current values when reopened", async () => {
    const wrapper = mountWithCards(false);
    expect(wrapper.find(".map-card").exists()).toBe(true);
    expect(wrapper.find(".threshold-readout").exists()).toBe(false);
    mocks.locationKey.mockClear();
    // Scrubbing with the palette closed reads no position.
    (store as any).z = 1;
    await nextTick();
    (store as any).time = 1;
    await nextTick();
    expect(mocks.locationKey).not.toHaveBeenCalled();
    // Reopened at a position without data: says so at once.
    await wrapper.setProps({ visible: true });
    expect(wrapper.find(".no-data-here").exists()).toBe(true);
    expect(wrapper.find(".threshold-readout").exists()).toBe(true);
    // Open, a scrub re-reads the position.
    mocks.locationKey.mockClear();
    (store as any).z = 0;
    (store as any).time = 0;
    await nextTick();
    expect(mocks.locationKey).toHaveBeenCalled();
    expect(wrapper.find(".no-data-here").exists()).toBe(false);
  });

  it("keeps the delete confirmation working with the card bodies gated", async () => {
    const wrapper = mountWithCards();
    const vm = wrapper.vm as any;
    vm.askDelete(MAP);
    await nextTick();
    expect(vm.deleteDialog).toBe(true);
    expect(wrapper.text()).toContain("Delete saved map?");
    await vm.confirmDelete();
    expect(mocks.deleteMap).toHaveBeenCalledWith("a");
    expect(vm.deleteDialog).toBe(false);
  });

  describe("map order", () => {
    const MAP_B = { ...scalarMap(), itemId: "b" };

    it("commits the new order when a card is dropped", () => {
      (scalarMapsStore as any).currentMaps = [MAP, MAP_B];
      (scalarMapsStore as any).display = { a: display(), b: display() };
      const wrapper = mountWithCards();
      const list = wrapper.findComponent(DraggableStub);
      expect(list.props("handle")).toBe(".map-drag-handle");
      expect(
        wrapper
          .findAll(".map-card")
          .map((card) => card.attributes("data-map-id")),
      ).toEqual(["a", "b"]);
      list.vm.$emit("update:modelValue", [MAP_B, MAP]);
      expect(mocks.reorderMaps).toHaveBeenCalledWith(["b", "a"]);
    });

    it("ignores a drop on a list that changed during the drag and mounts the list again", async () => {
      const MAP_C = { ...MAP, itemId: "c" };
      (scalarMapsStore as any).currentMaps = [MAP, MAP_B, MAP_C];
      (scalarMapsStore as any).display = {
        a: display(),
        b: display(),
        c: display(),
      };
      const wrapper = mountWithCards();
      const list = () => wrapper.findComponent(DraggableStub);
      const mounted = list().vm;
      list().vm.$emit("start");
      // A re-list after a job ended drops the first map mid-drag.
      (scalarMapsStore as any).currentMaps = [MAP_B, MAP_C];
      await nextTick();
      list().vm.$emit("update:modelValue", [MAP_C, MAP_B]);
      expect(mocks.reorderMaps).not.toHaveBeenCalled();
      list().vm.$emit("end");
      await nextTick();
      expect(list().vm).not.toBe(mounted);
      // The next drag is a new session.
      list().vm.$emit("start");
      list().vm.$emit("update:modelValue", [MAP_C, MAP_B]);
      expect(mocks.reorderMaps).toHaveBeenCalledWith(["c", "b"]);
    });

    it("keeps the list mounted after an ordinary drop", async () => {
      (scalarMapsStore as any).currentMaps = [MAP, MAP_B];
      (scalarMapsStore as any).display = { a: display(), b: display() };
      // The store applies the order, as the real mutation does.
      mocks.reorderMaps.mockImplementation((ids: string[]) => {
        (scalarMapsStore as any).currentMaps = ids.map((id) =>
          id === "a" ? MAP : MAP_B,
        );
      });
      const wrapper = mountWithCards();
      const list = () => wrapper.findComponent(DraggableStub);
      const mounted = list().vm;
      list().vm.$emit("start");
      list().vm.$emit("update:modelValue", [MAP_B, MAP]);
      list().vm.$emit("end");
      await nextTick();
      expect(mocks.reorderMaps).toHaveBeenCalledWith(["b", "a"]);
      expect(list().vm).toBe(mounted);
      mocks.reorderMaps.mockReset();
    });

    it("offers the drag handle and its hint only with more than one map", async () => {
      const wrapper = mountWithCards();
      expect(wrapper.find(".map-card").exists()).toBe(true);
      expect(wrapper.find(".map-drag-handle").exists()).toBe(false);
      expect(wrapper.find(".reorder-hint").exists()).toBe(false);
      (scalarMapsStore as any).currentMaps = [MAP, MAP_B];
      (scalarMapsStore as any).display = { a: display(), b: display() };
      await nextTick();
      const handles = wrapper.findAll(".map-drag-handle");
      expect(handles).toHaveLength(2);
      expect(handles[0].attributes("aria-label")).toBe(
        "Drag to reorder Area mean, 50 µm",
      );
      expect(wrapper.find(".reorder-hint").text()).toBe(
        "Drag to reorder. The top map is drawn on top.",
      );
    });
  });
});
