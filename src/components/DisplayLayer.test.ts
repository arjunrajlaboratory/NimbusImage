import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick, ref } from "vue";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: {
      z: [0, 1, 2],
      xy: [0],
      time: [0],
      channels: [0, 1],
      channelNames: new Map([
        [0, "DAPI"],
        [1, "GFP"],
      ]),
    },
    configuration: { layers: [] },
    getLayerIndexFromId: vi.fn(() => 0),
    hoverValue: null,
    getLayerHistogram: vi.fn(() => null),
    getConfigurationLayerFromId: vi.fn(() => null),
    xy: 0,
    z: 0,
    time: 0,
    changeLayer: vi.fn(),
    toggleLayerVisibility: vi.fn(),
    saveContrastInConfiguration: vi.fn(),
    saveContrastInView: vi.fn(),
    resetContrastInView: vi.fn(),
    removeLayer: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

vi.mock("./DisplaySlice.vue", () => ({
  default: {
    name: "DisplaySlice",
    template: "<div />",
    props: ["modelValue", "label", "maxValue", "displayed", "offset"],
  },
}));

vi.mock("./ContrastHistogram.vue", () => ({
  default: {
    name: "ContrastHistogram",
    template: "<div />",
    props: ["configurationContrast", "viewContrast", "histogram"],
  },
}));

vi.mock("./ColorPickerMenu.vue", () => ({
  default: {
    name: "ColorPickerMenu",
    template: "<div />",
    props: ["modelValue"],
  },
}));

import store from "@/store";
import DisplayLayer from "./DisplayLayer.vue";
import { forgetSharedUiState } from "@/utils/uiState";
import { PANEL_VISIBLE_KEY } from "@/utils/panelVisibility";

const sampleLayer = {
  id: "l1",
  name: "DAPI",
  color: "#0000FF",
  channel: 0,
  visible: true,
  contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
  xy: { type: "current", value: 0 },
  z: { type: "current", value: 0 },
  time: { type: "current", value: 0 },
  layerGroup: null,
};

function mountComponent(propsOverrides = {}) {
  return shallowMount(DisplayLayer, {
    props: {
      modelValue: { ...sampleLayer, ...propsOverrides } as any,
    },
  });
}

describe("DisplayLayer remembered rows", () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetSharedUiState();
  });

  const rowModel = (wrapper: ReturnType<typeof mountComponent>) =>
    wrapper.findAllComponents({ name: "VExpansionPanels" })[0];

  function mountIn(visible: boolean, id = "l1") {
    return shallowMount(DisplayLayer, {
      props: { modelValue: { ...sampleLayer, id } as any },
      global: { provide: { [PANEL_VISIBLE_KEY as symbol]: ref(visible) } },
    });
  }

  it("an expanded row is expanded again on the next page load", async () => {
    const first = mountComponent();
    expect(rowModel(first).props("modelValue")).toBeUndefined();
    rowModel(first).vm.$emit("update:modelValue", "expanded");
    await nextTick();
    expect(rowModel(first).props("modelValue")).toBe("expanded");

    forgetSharedUiState();
    expect(rowModel(mountComponent()).props("modelValue")).toBe("expanded");
    // Another layer's row is not.
    expect(
      rowModel(mountComponent({ id: "l2" })).props("modelValue"),
    ).toBeUndefined();
  });

  it("rows share one list, so expanding one keeps the others", async () => {
    const one = mountComponent({ id: "l1" });
    const two = mountComponent({ id: "l2" });
    rowModel(one).vm.$emit("update:modelValue", "expanded");
    rowModel(two).vm.$emit("update:modelValue", "expanded");
    rowModel(one).vm.$emit("update:modelValue", undefined);
    await nextTick();
    expect(
      JSON.parse(
        window.localStorage.getItem("nimbus.ui.anonymous.layers.expandedIds")!,
      ),
    ).toEqual(["l2"]);
  });

  it("a remembered row stays collapsed while its palette is not on screen", async () => {
    window.localStorage.setItem(
      "nimbus.ui.anonymous.layers.expandedIds",
      '["l1"]',
    );
    const visible = ref(false);
    const wrapper = shallowMount(DisplayLayer, {
      props: { modelValue: { ...sampleLayer } as any },
      global: { provide: { [PANEL_VISIBLE_KEY as symbol]: visible } },
    });
    expect(rowModel(wrapper).props("modelValue")).toBeUndefined();
    // Nothing the hidden row reports changes what is remembered.
    rowModel(wrapper).vm.$emit("update:modelValue", undefined);
    visible.value = true;
    await nextTick();
    expect(rowModel(wrapper).props("modelValue")).toBe("expanded");
    expect(rowModel(mountIn(true)).props("modelValue")).toBe("expanded");
  });

  it("the advanced options are open in every row once opened in one", async () => {
    const advanced = (wrapper: ReturnType<typeof mountComponent>) =>
      wrapper.findAllComponents({ name: "VExpansionPanels" })[1];
    // The advanced options sit inside the row's body, which a shallow mount
    // only renders when asked to render the stubs' slots.
    const mountRow = (id: string) =>
      shallowMount(DisplayLayer, {
        props: { modelValue: { ...sampleLayer, id } as any },
        global: { renderStubDefaultSlot: true },
      });
    const one = mountRow("l1");
    const two = mountRow("l2");
    advanced(one).vm.$emit("update:modelValue", "expanded");
    await nextTick();
    expect(advanced(two).props("modelValue")).toBe("expanded");
    forgetSharedUiState();
    expect(advanced(mountRow("l3")).props("modelValue")).toBe("expanded");
  });
});

describe("DisplayLayer", () => {
  it("index returns store layer index", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).index).toBe(0);
  });

  it("visible getter returns layer visibility", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).visible).toBe(true);
  });

  it("changeProp calls store.changeLayer", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).changeProp("name", "NewName");
    expect(store.changeLayer).toHaveBeenCalledWith({
      layerId: "l1",
      delta: { name: "NewName" },
    });
  });

  it("changeProp does not call store when value is the same", async () => {
    (store.changeLayer as any).mockClear();
    const wrapper = mountComponent();
    (wrapper.vm as any).changeProp("name", "DAPI");
    expect(store.changeLayer).not.toHaveBeenCalled();
  });

  it("removeLayer calls store.removeLayer", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).removeLayer();
    expect(store.removeLayer).toHaveBeenCalledWith("l1");
  });

  it("channelName returns name from dataset", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).channelName(0)).toBe("DAPI");
    expect((wrapper.vm as any).channelName(1)).toBe("GFP");
  });

  it("channelName falls back to channel number string", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).channelName(99)).toBe("99");
  });

  it("channels returns dataset channels", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).channels).toEqual([0, 1]);
  });

  it("currentContrast returns layer contrast", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).currentContrast).toEqual({
      mode: "percentile",
      blackPoint: 0,
      whitePoint: 100,
    });
  });

  it("hasMultipleZ returns true when dataset has multiple z values", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).hasMultipleZ).toBe(true);
  });

  it("maxZ returns dataset z length minus 1", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).maxZ).toBe(2);
  });

  it("isZMaxMerge returns false for current slice type", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isZMaxMerge).toBe(false);
  });

  it("isZMaxMerge returns true for max-merge slice type", async () => {
    const wrapper = mountComponent({
      z: { type: "max-merge", value: null },
    });
    expect((wrapper.vm as any).isZMaxMerge).toBe(true);
  });

  it("changeContrast with syncConfiguration calls saveContrastInConfiguration", async () => {
    const wrapper = mountComponent();
    const contrast = { mode: "absolute", blackPoint: 10, whitePoint: 200 };
    (wrapper.vm as any).changeContrast(contrast, true);
    expect(store.saveContrastInConfiguration).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("changeContrast without syncConfiguration calls saveContrastInView", async () => {
    const wrapper = mountComponent();
    const contrast = { mode: "absolute", blackPoint: 10, whitePoint: 200 };
    (wrapper.vm as any).changeContrast(contrast, false);
    expect(store.saveContrastInView).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("resetContrastInView calls store.resetContrastInView", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).resetContrastInView();
    expect(store.resetContrastInView).toHaveBeenCalledWith("l1");
  });

  it("zMaxMergeBinding includes the index", async () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).zMaxMergeBinding).toBe("shift+1");
  });

  // The name text-field uses native @change with $event.target.value
  // to avoid [object Event] issues with Vuetify 3
  it("name text-field calls changeLayer on native change event", async () => {
    (store.changeLayer as any).mockClear();
    const wrapper = shallowMount(DisplayLayer, {
      props: {
        modelValue: { ...sampleLayer } as any,
      },
      global: {
        stubs: {
          "v-expansion-panels": { template: "<div><slot /></div>" },
          "v-expansion-panel": { template: "<div><slot /></div>" },
          "v-expansion-panel-title": { template: "<div><slot /></div>" },
          "v-expansion-panel-text": { template: "<div><slot /></div>" },
        },
      },
    });
    const textFields = wrapper.findAllComponents({ name: "v-text-field" });
    const nameField = textFields.find(
      (c) => c.props("label") === "Name" || c.attributes("label") === "Name",
    );
    expect(nameField).toBeTruthy();
    // Simulate native change event with target.value
    nameField!.vm.$emit("change", {
      target: { value: "NewLayerName" },
    });
    await wrapper.vm.$nextTick();
    expect(store.changeLayer).toHaveBeenCalledWith({
      layerId: "l1",
      delta: { name: "NewLayerName" },
    });
  });
});
