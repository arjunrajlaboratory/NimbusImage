import { describe, it, expect, vi } from "vitest";

const mockStore = {
  dataset: { z: [0, 1, 2] },
  configuration: {
    layers: [
      {
        id: "l1",
        name: "DAPI",
        layerGroup: null,
        color: "#0000FF",
        channel: 0,
        visible: true,
      },
      {
        id: "l2",
        name: "GFP",
        layerGroup: null,
        color: "#00FF00",
        channel: 1,
        visible: true,
      },
    ],
  },
  layers: [
    { id: "l1", name: "DAPI", layerGroup: null },
    { id: "l2", name: "GFP", layerGroup: null },
  ],
  getLayerIndexFromId: vi.fn((id: string) => (id === "l1" ? 0 : 1)),
  setConfigurationLayers: vi.fn(),
  changeLayer: vi.fn(),
  addLayer: vi.fn(),
  toggleGlobalZMaxMerge: vi.fn(),
  toggleGlobalLayerVisibility: vi.fn(),
};

vi.mock("@/store", () => ({
  default: mockStore,
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

vi.mock("vuedraggable", () => ({
  default: {
    name: "draggable",
    template: "<div><slot /></div>",
    props: ["value", "animation", "fallbackOnBody", "swapThreshold", "group"],
  },
}));

vi.mock("./DisplayLayerGroup.vue", () => ({
  default: {
    name: "DisplayLayerGroup",
    template: "<div />",
    props: ["combinedLayers", "singleLayer", "group"],
  },
}));

async function setup() {
  const Vue = (await import("vue")).default;
  const Vuetify = (await import("vuetify")).default;
  Vue.use(Vuetify);
  const { shallowMount } = await import("@vue/test-utils");
  const mod = await import("./DisplayLayers.vue");
  return { shallowMount, Vuetify, Component: mod.default };
}

describe("DisplayLayers", () => {
  it("hasMultipleZ returns true when dataset has multiple z values", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    expect(wrapper.vm.hasMultipleZ).toBe(true);
  });

  it("hasMultipleZ returns false when dataset has one z value", async () => {
    const originalDataset = mockStore.dataset;
    mockStore.dataset = { z: [0] };
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    expect(wrapper.vm.hasMultipleZ).toBe(false);
    mockStore.dataset = originalDataset;
  });

  it("groupsMap builds layer groups correctly", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const groups = wrapper.vm.groupsMap;
    // Two layers with no layerGroup, so each gets its own single-layer-group
    expect(groups.size).toBe(2);
    expect(groups.has("single-layer-group_l1")).toBe(true);
    expect(groups.has("single-layer-group_l2")).toBe(true);
    expect(groups.get("single-layer-group_l1")).toHaveLength(1);
    expect(groups.get("single-layer-group_l2")).toHaveLength(1);
  });

  it("groupsArrayWithSpacers includes spacers between groups", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const arr = wrapper.vm.groupsArrayWithSpacers;
    // 2 groups => spacer, group1, spacer, group2, spacer = 5 entries
    expect(arr).toHaveLength(5);
    // Spacers have null as second element
    expect(arr[0][1]).toBeNull();
    expect(arr[2][1]).toBeNull();
    expect(arr[4][1]).toBeNull();
    // Groups have arrays as second element
    expect(arr[1][1]).toBeTruthy();
    expect(arr[3][1]).toBeTruthy();
  });

  it("addLayer calls store.addLayer", async () => {
    mockStore.addLayer.mockClear();
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    wrapper.vm.addLayer();
    expect(mockStore.addLayer).toHaveBeenCalledOnce();
  });

  it("createGroupFromLayer calls store.changeLayer with a new layerGroup", async () => {
    mockStore.changeLayer.mockClear();
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const combinedLayer = {
      layer: { id: "l1", name: "DAPI", layerGroup: null },
      configurationLayer: { id: "l1", name: "DAPI", layerGroup: null },
    };
    wrapper.vm.createGroupFromLayer(combinedLayer);
    expect(mockStore.changeLayer).toHaveBeenCalledOnce();
    const call = mockStore.changeLayer.mock.calls[0][0];
    expect(call.layerId).toBe("l1");
    expect(call.delta.layerGroup).toBeTruthy();
    // layerGroup should be a UUID string
    expect(typeof call.delta.layerGroup).toBe("string");
  });

  it("changeGroupsInWrapper resets isDragging and sets configuration layers", async () => {
    mockStore.setConfigurationLayers.mockClear();
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    wrapper.vm.isDragging = true;
    const layerA = { id: "l1", name: "DAPI", layerGroup: null };
    const layerB = { id: "l2", name: "GFP", layerGroup: null };
    const groups: [string, any][] = [
      ["spacer_g1", null],
      [
        "g1",
        [
          { layer: layerA, configurationLayer: layerA },
          { layer: layerB, configurationLayer: layerB },
        ],
      ],
      ["spacer_", null],
    ];
    wrapper.vm.changeGroupsInWrapper(groups);
    expect(wrapper.vm.isDragging).toBe(false);
    expect(mockStore.setConfigurationLayers).toHaveBeenCalledOnce();
    expect(mockStore.setConfigurationLayers).toHaveBeenCalledWith([
      layerA,
      layerB,
    ]);
  });

  it("mousetrapGlobalToggles has correct bindings", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const toggles = wrapper.vm.mousetrapGlobalToggles;
    expect(toggles).toHaveLength(2);
    expect(toggles[0].bind).toBe("z");
    expect(toggles[1].bind).toBe("0");
  });

  it("singleLayerPrefix is exposed correctly", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    expect(wrapper.vm.singleLayerPrefix).toBe("single-layer-group_");
  });

  it("spacerUpdate does nothing when configuration is null", async () => {
    const originalConfig = mockStore.configuration;
    mockStore.configuration = null as any;
    mockStore.setConfigurationLayers.mockClear();
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const combinedLayer = {
      layer: { id: "l1", name: "DAPI", layerGroup: null },
      configurationLayer: { id: "l1", name: "DAPI", layerGroup: null },
    };
    wrapper.vm.spacerUpdate([combinedLayer], "spacer_single-layer-group_l2");
    expect(mockStore.setConfigurationLayers).not.toHaveBeenCalled();
    mockStore.configuration = originalConfig;
  });

  it("spacerUpdate does nothing when combinedLayers length is not 1", async () => {
    mockStore.setConfigurationLayers.mockClear();
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    wrapper.vm.spacerUpdate([], "spacer_single-layer-group_l2");
    expect(mockStore.setConfigurationLayers).not.toHaveBeenCalled();
  });
});
