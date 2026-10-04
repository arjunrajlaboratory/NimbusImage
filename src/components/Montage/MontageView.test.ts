import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, flushPromises, VueWrapper } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  montage: null as any,
  annotations: new Map<string, any>(),
  hydrateAnnotations: null as any,
  getPropertyValuesForIds: null as any,
  getLayersDownloadUrls: null as any,
  goToAnnotationLocation: null as any,
  properties: null as any,
  annotationStore: null as any,
}));

vi.mock("@/store/montage", async () => {
  const { reactive } = await import("vue");
  mocks.montage = reactive({
    isOpen: true,
    listPageItems: [] as { id: string; index: number }[],
    settings: {
      panelSize: 100,
      padding: 10,
      scaleMode: "uniform",
      showOutlines: true,
      showIndex: true,
      labelPropertyPaths: [] as string[][],
    },
    setIsOpen: vi.fn((value: boolean) => {
      mocks.montage.isOpen = value;
    }),
    updateSettings: vi.fn((changes: any) => {
      mocks.montage.settings = { ...mocks.montage.settings, ...changes };
    }),
  });
  return { default: mocks.montage };
});

vi.mock("@/store", () => ({
  default: {
    dataset: {
      id: "ds1",
      name: "Dataset",
      width: 1000,
      height: 1000,
      anyImage: () => ({ item: { _id: "item1" } }),
    },
    layers: [{ id: "l1", channel: 0, color: "#00ff00", visible: true }],
    girderRest: { apiRoot: "http://host/api/v1" },
    api: { getSnapshotImage: vi.fn() },
  },
}));

vi.mock("@/store/annotation", () => {
  mocks.hydrateAnnotations = vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      ...mocks.annotations.get(id),
      coordinates: [
        { x: 0, y: 0 },
        { x: 40, y: 20 },
      ],
      name: null,
      datasetId: "ds1",
    })),
  );
  mocks.annotationStore = {
    getAnnotationOrStubFromId: (id: string) => mocks.annotations.get(id),
    annotationsAPI: {
      hydrateAnnotations: (...args: any[]) => mocks.hydrateAnnotations(...args),
    },
    isAnnotationSelected: () => false,
    hoveredAnnotationId: null as string | null,
    setHoveredAnnotationId: vi.fn((id: string | null) => {
      mocks.annotationStore.hoveredAnnotationId = id;
    }),
    toggleSelected: vi.fn(),
  };
  return { default: mocks.annotationStore };
});

vi.mock("@/store/annotationListServer", () => ({ default: { rows: [] } }));

vi.mock("@/store/properties", async () => {
  const { reactive } = await import("vue");
  mocks.getPropertyValuesForIds = vi.fn(async (_ds: string, ids: string[]) =>
    ids.map((annotationId) => ({ annotationId, values: { p1: { a: 7 } } })),
  );
  mocks.properties = reactive({ propertyValuesRevision: 0 });
  return {
    default: {
      get propertyValuesRevision() {
        return mocks.properties.propertyValuesRevision;
      },
      computedPropertyPaths: [["p1", "a"]],
      getFullNameFromPath: (path: string[]) => path.join(" / "),
      getSubIdsNameFromPath: (path: string[]) => path.slice(1).join(" / "),
      getPropertyById: (id: string) => (id === "p1" ? { id } : null),
      propertiesAPI: {
        getPropertyValuesForIds: (...args: any[]) =>
          mocks.getPropertyValuesForIds(...args),
      },
    },
  };
});

vi.mock("@/utils/screenshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/screenshot")>();
  mocks.getLayersDownloadUrls = vi.fn(async (baseUrl: URL) => [
    { url: new URL(baseUrl), layerIds: ["l1"] },
  ]);
  return {
    ...actual,
    getLayersDownloadUrls: (...args: any[]) =>
      mocks.getLayersDownloadUrls(...args),
  };
});

vi.mock("@/utils/annotationNavigation", () => {
  mocks.goToAnnotationLocation = vi.fn();
  return {
    goToAnnotationLocation: (id: string) => mocks.goToAnnotationLocation(id),
  };
});

import MontageView from "./MontageView.vue";

function stub(id: string, overrides: any = {}) {
  return {
    id,
    centroid: { x: 100, y: 100 },
    location: { XY: 0, Z: 2, Time: 3 },
    shape: "polygon",
    channel: 0,
    tags: [],
    color: null,
    estimatedRadius: 5,
    ...overrides,
  };
}

function full(id: string, coordinates: { x: number; y: number }[]) {
  return {
    id,
    name: null,
    tags: [],
    shape: "polygon",
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates,
    datasetId: "ds1",
    color: "#123456",
  };
}

let wrapper: VueWrapper<any> | null = null;

function mountView() {
  wrapper = shallowMount(MontageView, {
    global: {
      stubs: {
        MontagePanel: true,
        // Auto-stubs of these forward a `prefix` attr jsdom can't set.
        VTextField: { template: "<div />" },
        VSelect: { template: "<div />" },
      },
    },
  });
  return wrapper.vm as any;
}

describe("MontageView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.annotations.clear();
    mocks.properties.propertyValuesRevision = 0;
    // Some tests swap in hanging builds; clearMocks doesn't undo that.
    mocks.getLayersDownloadUrls.mockImplementation(async (baseUrl: URL) => [
      { url: new URL(baseUrl), layerIds: ["l1"] },
    ]);
    mocks.annotationStore.hoveredAnnotationId = null;
    mocks.montage.isOpen = true;
    mocks.montage.listPageItems = [];
    mocks.montage.settings = {
      ...mocks.montage.settings,
      scaleMode: "uniform",
      padding: 10,
      labelPropertyPaths: [],
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it("shows the list page's objects in list order", () => {
    mocks.annotations.set("b", stub("b", { shape: "point" }));
    mocks.annotations.set("a", stub("a", { shape: "point" }));
    mocks.montage.listPageItems = [
      { id: "b", index: 9 },
      { id: "a", index: 2 },
      { id: "missing", index: 5 },
    ];
    const vm = mountView();
    expect(vm.panels.map((p: any) => p.id)).toEqual(["b", "a"]);
    expect(vm.panels[0].content.indexLabel).toBe("#9");
  });

  it("hydrates only unhydrated non-point objects, in one request", async () => {
    mocks.annotations.set("poly", stub("poly"));
    mocks.annotations.set("point", stub("point", { shape: "point" }));
    mocks.annotations.set(
      "done",
      full("done", [
        { x: 0, y: 0 },
        { x: 4, y: 4 },
      ]),
    );
    mocks.montage.listPageItems = [
      { id: "poly", index: 1 },
      { id: "point", index: 2 },
      { id: "done", index: 3 },
    ];
    const vm = mountView();
    await flushPromises();
    expect(mocks.hydrateAnnotations).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateAnnotations.mock.calls[0][0]).toEqual(["poly"]);
    // The hydrated outline replaces the stub's centroid-only geometry.
    const poly = vm.panels.find((p: any) => p.id === "poly");
    expect(poly.content.outline.coordinates).toHaveLength(2);
  });

  it("draws a point stub's outline at its centroid", () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    expect(vm.panels[0].content.outline).toEqual({
      shape: "point",
      coordinates: [{ x: 100, y: 100 }],
    });
  });

  it("gives every panel the same window size in uniform mode", () => {
    mocks.annotations.set(
      "small",
      full("small", [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    );
    mocks.annotations.set(
      "big",
      full("big", [
        { x: 200, y: 200 },
        { x: 300, y: 260 },
      ]),
    );
    mocks.montage.listPageItems = [
      { id: "small", index: 1 },
      { id: "big", index: 2 },
    ];
    const vm = mountView();
    const sides = vm.panels.map(
      (p: any) => p.content.window.right - p.content.window.left,
    );
    expect(sides).toEqual([120, 120]);
  });

  it("only labels with properties this configuration has", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    mocks.montage.settings.labelPropertyPaths = [
      ["p1", "a"],
      ["fromAnotherConfiguration", "x"],
    ];
    const vm = mountView();
    await flushPromises();
    expect(mocks.getPropertyValuesForIds).toHaveBeenCalledWith(
      "ds1",
      ["pt"],
      [["p1", "a"]],
    );
    expect(vm.panels[0].content.textLines).toEqual(["a: 7"]);
  });

  it("builds a crop only when a panel asks, for the object's own frame", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    // Settled, but nothing requested it yet: no style/histogram work.
    expect(mocks.getLayersDownloadUrls).not.toHaveBeenCalled();

    const crop = await vm.loadCrop(vm.cropKeyFor("pt"));
    const [baseUrl, mode, , , location] =
      mocks.getLayersDownloadUrls.mock.calls.at(-1);
    expect(mode).toBe("composite");
    expect(location).toEqual({ xy: 0, z: 2, time: 3 });
    // Centroid 100, radius 5, padding 10 → region 85..115.
    expect(baseUrl.searchParams.get("left")).toBe("85");
    expect(baseUrl.searchParams.get("right")).toBe("115");
    expect(crop.imageRect).toEqual({
      left: 85,
      top: 85,
      right: 115,
      bottom: 115,
    });
  });

  it("builds each crop once per settled generation", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    const key = vm.cropKeyFor("pt");
    await Promise.all([vm.loadCrop(key), vm.loadCrop(key)]);
    expect(mocks.getLayersDownloadUrls).toHaveBeenCalledTimes(1);
  });

  it("rejects a crop key an input change has superseded", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    const oldKey = vm.cropKeyFor("pt");
    mocks.montage.settings = { ...mocks.montage.settings, padding: 40 };
    await vi.advanceTimersByTimeAsync(0);
    // Settling: no key, so panels keep their current image.
    expect(vm.cropKeyFor("pt")).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(vm.cropKeyFor("pt")).not.toBe(oldKey);
    await expect(vm.loadCrop(oldKey)).rejects.toMatchObject({
      name: "StaleCropError",
    });
  });

  it("drops a queued crop build whose inputs changed before it started", async () => {
    // Five objects; the first four builds hang, so the fifth queues.
    const ids = ["a", "b", "c", "d", "e"];
    ids.forEach((id) =>
      mocks.annotations.set(id, stub(id, { shape: "point" })),
    );
    mocks.montage.listPageItems = ids.map((id, index) => ({ id, index }));
    const hanging: (() => void)[] = [];
    mocks.getLayersDownloadUrls.mockImplementation(
      (baseUrl: URL) =>
        new Promise((resolve) =>
          hanging.push(() =>
            resolve([{ url: new URL(baseUrl), layerIds: [] }]),
          ),
        ),
    );
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    const builds = ids.map((id) =>
      vm.loadCrop(vm.cropKeyFor(id)).catch((error: Error) => error),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getLayersDownloadUrls).toHaveBeenCalledTimes(4);

    // The page's settings change while "e" waits in the queue.
    mocks.montage.settings = { ...mocks.montage.settings, padding: 40 };
    await vi.advanceTimersByTimeAsync(300);
    hanging.forEach((finish) => finish());
    const results = await Promise.all(builds);
    expect(mocks.getLayersDownloadUrls).toHaveBeenCalledTimes(4);
    expect(results[4]).toMatchObject({ name: "StaleCropError" });
  });

  it("treats a missing plane as expected, other build failures as errors", async () => {
    const { LayerSelectionError } = await import("@/utils/screenshot");
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    mocks.getLayersDownloadUrls.mockRejectedValueOnce(
      new LayerSelectionError("No image for layer"),
    );
    await expect(vm.loadCrop(vm.cropKeyFor("pt"))).rejects.toMatchObject({
      name: "MontageCropError",
    });
    mocks.getLayersDownloadUrls.mockRejectedValueOnce(new Error("500"));
    await expect(vm.loadCrop(vm.cropKeyFor("pt"))).rejects.toMatchObject({
      message: "500",
    });
  });

  it("exports from captured inputs when settings move on mid-export", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    const key = vm.cropKeyFor("pt");
    const captured = vm.settledCrops.inputs.get("pt");
    mocks.montage.settings = { ...mocks.montage.settings, padding: 40 };
    await vi.advanceTimersByTimeAsync(300);
    // The key is stale now; the export still gets the crop it captured.
    const pending = vm.exportCrop(key, captured);
    await vi.advanceTimersByTimeAsync(0);
    const crop = await pending;
    expect(crop.imageRect).toEqual(captured.imageRect);
  });

  it("reports an object outside the image instead of requesting it", async () => {
    mocks.annotations.set(
      "out",
      stub("out", { shape: "point", centroid: { x: 5000, y: 5000 } }),
    );
    mocks.montage.listPageItems = [{ id: "out", index: 1 }];
    const vm = mountView();
    await vi.advanceTimersByTimeAsync(300);
    await expect(vm.loadCrop(vm.cropKeyFor("out"))).rejects.toMatchObject({
      name: "MontageCropError",
      message: "Object is outside the image",
    });
    expect(mocks.getLayersDownloadUrls).not.toHaveBeenCalled();
  });

  it("disables export until the crops match the current inputs", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    const vm = mountView();
    expect(vm.canExport).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(vm.canExport).toBe(true);
    mocks.montage.settings = { ...mocks.montage.settings, padding: 40 };
    await vi.advanceTimersByTimeAsync(0);
    expect(vm.canExport).toBe(false);
  });

  it("keeps label choices made under other configurations", () => {
    mocks.montage.settings.labelPropertyPaths = [
      ["p1", "a"],
      ["fromAnotherConfiguration", "x"],
    ];
    const vm = mountView();
    vm.setLabelKeys([]);
    expect(mocks.montage.settings.labelPropertyPaths).toEqual([
      ["fromAnotherConfiguration", "x"],
    ]);
  });

  it("ignores an emptied padding field", () => {
    const vm = mountView();
    vm.setPadding("");
    expect(mocks.montage.settings.padding).toBe(10);
    vm.setPadding("25");
    expect(mocks.montage.settings.padding).toBe(25);
  });

  it("refetches labels when property values are recomputed", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    mocks.montage.settings.labelPropertyPaths = [["p1", "a"]];
    mountView();
    await flushPromises();
    mocks.getPropertyValuesForIds.mockClear();
    mocks.properties.propertyValuesRevision++;
    await vi.advanceTimersByTimeAsync(350);
    expect(mocks.getPropertyValuesForIds).toHaveBeenCalledTimes(1);
  });

  it("clears its hover when it closes under the cursor", () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    mountView();
    mocks.annotationStore.hoveredAnnotationId = "pt";
    wrapper!.unmount();
    wrapper = null;
    expect(mocks.annotationStore.hoveredAnnotationId).toBeNull();
  });

  it("closes the montage and navigates from a panel", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    mountView();
    await wrapper!.findComponent({ name: "MontagePanel" }).vm.$emit("navigate");
    expect(mocks.montage.setIsOpen).toHaveBeenCalledWith(false);
    expect(mocks.goToAnnotationLocation).toHaveBeenCalledWith("pt");
  });

  it("cancels pending crop work on unmount", async () => {
    mocks.annotations.set("pt", stub("pt", { shape: "point" }));
    mocks.montage.listPageItems = [{ id: "pt", index: 1 }];
    mountView();
    const vm = wrapper!.vm as any;
    const generation = vm.settledCrops.generation;
    wrapper!.unmount();
    wrapper = null;
    await vi.advanceTimersByTimeAsync(300);
    expect(vm.settledCrops.generation).toBe(generation);
  });
});
