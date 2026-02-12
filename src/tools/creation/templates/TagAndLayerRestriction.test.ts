import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test Dataset" },
    toolTags: ["tagA", "tagB", "tagC"],
    layers: [],
    tools: [
      {
        type: "create",
        values: { annotation: { tags: ["tagA", "tagB"] } },
      },
      {
        type: "snap",
        values: { annotation: { tags: ["tagC"] } },
      },
      {
        type: "connection",
        values: {},
      },
    ],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: [],
  },
}));

import TagAndLayerRestriction from "./TagAndLayerRestriction.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(TagAndLayerRestriction, {
    vuetify: new Vuetify(),
    propsData: props,
    stubs: {
      TagPicker: true,
      LayerSelect: true,
    },
  });
}

describe("TagAndLayerRestriction", () => {
  it("updateFromValue syncs from prop", () => {
    const wrapper = mountComponent({
      value: {
        tags: ["x", "y"],
        layer: "layer-1",
        tagsInclusive: false,
      },
    });
    expect(wrapper.vm.newTags).toEqual(["x", "y"]);
    expect(wrapper.vm.selectedLayer).toBe("layer-1");
    expect(wrapper.vm.areTagsInclusive).toBe(false);
  });

  it("reset clears state and calls changed", () => {
    const wrapper = mountComponent({
      value: {
        tags: ["x"],
        layer: "layer-1",
        tagsInclusive: false,
      },
    });
    wrapper.vm.reset();
    expect(wrapper.vm.newTags).toEqual([]);
    expect(wrapper.vm.selectedLayer).toBeNull();
    expect(wrapper.vm.areTagsInclusive).toBe(true);
    expect(wrapper.emitted("input")).toBeTruthy();
  });

  it("changed emits input and change with correct shape", () => {
    const wrapper = mountComponent();
    wrapper.vm.newTags = ["a"];
    wrapper.vm.selectedLayer = "layer-2";
    wrapper.vm.areTagsInclusive = true;
    wrapper.vm.changed();
    const inputEvents = wrapper.emitted("input")!;
    const lastInput = inputEvents[inputEvents.length - 1][0];
    expect(lastInput).toEqual({
      tags: ["a"],
      layer: "layer-2",
      tagsInclusive: true,
    });
    expect(wrapper.emitted("change")).toBeTruthy();
  });

  it("changed omits tagsInclusive when inclusiveToggle is false", () => {
    const wrapper = mountComponent({ inclusiveToggle: false });
    wrapper.vm.changed();
    const inputEvents = wrapper.emitted("input")!;
    const lastInput = inputEvents[inputEvents.length - 1][0];
    expect(lastInput).not.toHaveProperty("tagsInclusive");
  });

  it("layerLabelWithDefault returns prop when set", () => {
    const wrapper = mountComponent({ layerLabel: "Custom Label" });
    expect(wrapper.vm.layerLabelWithDefault).toBe("Custom Label");
  });

  it("layerLabelWithDefault returns fallback when not set", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.layerLabelWithDefault).toBe("Filter by layer");
  });

  it("tagList extracts tags from store tools", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.tagList).toEqual(["tagA", "tagB", "tagC"]);
  });

  it("dataset delegates to store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.dataset).toEqual({
      id: "ds-1",
      name: "Test Dataset",
    });
  });
});
