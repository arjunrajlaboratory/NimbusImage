import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("geojs", () => {
  const mockDraw = vi.fn();
  const mockData = vi.fn().mockReturnValue({ draw: mockDraw });
  const mockCreateFeature = vi.fn().mockReturnValue({
    data: mockData,
    draw: mockDraw,
  });
  const mockGeoOn = vi.fn();
  const mockFeatureLayer = {
    createFeature: mockCreateFeature,
    geoOn: mockGeoOn,
  };
  const mockOsmLayer = { url: vi.fn() };
  const mockCreateLayer = vi.fn().mockImplementation((type: string) => {
    if (type === "osm") return mockOsmLayer;
    return mockFeatureLayer;
  });
  const mockMapObj = {
    createLayer: mockCreateLayer,
    draw: vi.fn(),
    node: vi.fn().mockImplementation(() => {
      const arr: any = [document.createElement("div")];
      arr.width = vi.fn().mockReturnValue(150);
      arr.height = vi.fn().mockReturnValue(150);
      return arr;
    }),
    rotation: vi.fn().mockReturnValue(0),
    zoom: vi.fn().mockReturnValue(1),
    size: vi.fn(),
    unitsPerPixel: vi.fn().mockReturnValue(1),
    displayToGcs: vi.fn((pt: any) => pt),
  };

  return {
    default: {
      map: vi.fn(() => mockMapObj),
      mapInteractor: vi.fn(() => ({})),
      util: {
        pixelCoordinateParams: vi.fn(() => ({
          map: { node: document.createElement("div") },
          layer: {},
        })),
        distanceToPolygon2d: vi.fn(() => 10),
      },
      event: {
        mouseclick: "mouseclick",
        actiondown: "actiondown",
        actionmove: "actionmove",
        actionselection: "actionselection",
        zoomselect: "zoomselect",
      },
    },
  };
});

// Use Vue.observable so the computed properties are reactive
vi.mock("@/store", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
      dataset: null as any,
      layers: [] as any[],
      currentLocation: {},
      girderRest: { apiRoot: "/api/v1" },
    }),
  };
});

vi.mock("@/utils/screenshot", () => ({
  getBaseURLFromDownloadParameters: vi.fn(() => "http://test/base"),
  getLayersDownloadUrls: vi
    .fn()
    .mockResolvedValue([{ url: "http://test/tile" }]),
}));

import ImageOverview from "./ImageOverview.vue";
import store from "@/store";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  (store as any).dataset = null;
  return shallowMount(ImageOverview, {
    vuetify: new Vuetify(),
    propsData: {
      parentCameraInfo: {
        center: { x: 0, y: 0 },
        zoom: 1,
        rotate: 0,
        gcsBounds: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
      ...props,
    },
  });
}

describe("ImageOverview", () => {
  beforeEach(() => {
    (store as any).dataset = null;
  });

  it("cornerToIcon returns top-left icon", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.cornerToIcon({ top: true, left: true })).toBe(
      "mdi-arrow-top-left",
    );
    wrapper.destroy();
  });

  it("cornerToIcon returns top-right icon", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.cornerToIcon({ top: true, left: false })).toBe(
      "mdi-arrow-top-right",
    );
    wrapper.destroy();
  });

  it("cornerToIcon returns bottom-left icon", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.cornerToIcon({ top: false, left: true })).toBe(
      "mdi-arrow-bottom-left",
    );
    wrapper.destroy();
  });

  it("cornerToIcon returns bottom-right icon", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.cornerToIcon({ top: false, left: false })).toBe(
      "mdi-arrow-bottom-right",
    );
    wrapper.destroy();
  });

  it("moveOverviewToCorner sets top-left styles", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.moveOverviewToCorner({ top: true, left: true });
    // The function returns { top, left } when overviewWrapper exists
    expect(result).toEqual({ top: true, left: true });
    wrapper.destroy();
  });

  it("moveOverviewToCorner sets bottom-right styles", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.moveOverviewToCorner({ top: false, left: false });
    expect(result).toEqual({ top: false, left: false });
    wrapper.destroy();
  });

  it("dataset computed reflects store.dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.dataset).toBeNull();
    const mockDataset = { name: "test", anyImage: vi.fn() };
    (store as any).dataset = mockDataset;
    expect(vm.dataset).toBe(mockDataset);
    wrapper.destroy();
  });

  it("dataset computed returns null when store has no dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.dataset).toBeNull();
    wrapper.destroy();
  });

  it("create returns early when no dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.create();
    expect(vm.map).toBeNull();
    wrapper.destroy();
  });

  it("create returns early when dataset has no image", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (store as any).dataset = { anyImage: vi.fn().mockReturnValue(null) };
    vm.create();
    expect(vm.map).toBeNull();
    wrapper.destroy();
  });

  it("create sets map when dataset and element exist", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (store as any).dataset = {
      name: "test",
      anyImage: vi.fn().mockReturnValue({
        sizeX: 1000,
        sizeY: 1000,
        tileWidth: 256,
        tileHeight: 256,
        item: { _id: "item1" },
      }),
    };
    vm.create();
    expect(vm.map).toBeTruthy();
    expect(vm.osmLayer).toBeTruthy();
    expect(vm.featureLayer).toBeTruthy();
    expect(vm.outlineFeature).toBeTruthy();
    wrapper.destroy();
  });

  it("onParentPan updates outline feature data", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const mockOutlineData = vi.fn().mockReturnValue({ draw: vi.fn() });
    vm.map = { rotation: vi.fn().mockReturnValue(0), zoom: vi.fn() };
    vm.outlineFeature = { data: mockOutlineData };
    vm.onParentPan();
    expect(mockOutlineData).toHaveBeenCalled();
    wrapper.destroy();
  });

  it("onParentPan sets rotation when map rotation differs from parent", () => {
    const wrapper = mountComponent({
      parentCameraInfo: {
        center: { x: 0, y: 0 },
        zoom: 1,
        rotate: 1.5,
        gcsBounds: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
    });
    const vm = wrapper.vm as any;
    const rotation = vi.fn().mockReturnValue(0);
    const zoom = vi.fn();
    vm.map = { rotation, zoom };
    vm.outlineFeature = {
      data: vi.fn().mockReturnValue({ draw: vi.fn() }),
    };
    vm.onParentPan();
    expect(rotation).toHaveBeenCalledWith(1.5);
    expect(zoom).toHaveBeenCalledWith(-Infinity);
    wrapper.destroy();
  });

  it("onUrlChanged does nothing when osmLayer is null", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.osmLayer = null;
    await vm.onUrlChanged();
    wrapper.destroy();
  });

  it("onUrlChanged sets empty url when no urlPromise (no dataset)", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const urlFn = vi.fn();
    vm.osmLayer = { url: urlFn };
    await vm.onUrlChanged();
    expect(urlFn).toHaveBeenCalledWith("");
    wrapper.destroy();
  });

  it("map is initially null when no dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.map).toBeNull();
    wrapper.destroy();
  });

  it("osmLayer is initially null when no dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.osmLayer).toBeNull();
    wrapper.destroy();
  });
});
