import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: null,
    toolTags: [],
    layers: [],
    tools: [],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: [],
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    fetchWorkerImageList: vi.fn(),
    workerImageList: [],
  },
}));

import ToolConfigurationItem from "./ToolConfigurationItem.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(ToolConfigurationItem, {
    vuetify: new Vuetify(),
    propsData: {
      item: { type: "text", name: "Test Field" },
      value: "hello",
      ...props,
    },
    stubs: {
      AnnotationConfiguration: true,
      TagAndLayerRestriction: true,
      DockerImage: true,
      TagPicker: true,
    },
  });
}

describe("ToolConfigurationItem", () => {
  it("componentValue getter returns value prop", () => {
    const wrapper = mountComponent({ value: "test-value" });
    expect(wrapper.vm.componentValue).toBe("test-value");
  });

  it("componentValue setter emits input", async () => {
    const wrapper = mountComponent();
    wrapper.vm.componentValue = "new-value";
    expect(wrapper.emitted("input")![0][0]).toBe("new-value");
  });

  it("changed emits change", () => {
    const wrapper = mountComponent();
    wrapper.vm.changed();
    expect(wrapper.emitted("change")).toHaveLength(1);
  });

  it("typeToComponentName maps all expected types", () => {
    const wrapper = mountComponent();
    const map = wrapper.vm.typeToComponentName;
    const expectedKeys = [
      "select",
      "annotation",
      "restrictTagsAndLayer",
      "checkbox",
      "radio",
      "text",
      "dockerImage",
      "tags",
    ];
    expect(Object.keys(map)).toEqual(expectedKeys);
    for (const key of expectedKeys) {
      expect(map[key]).toBeDefined();
    }
  });

  it("renders item name when present", () => {
    const wrapper = mountComponent({
      item: { type: "text", name: "My Field" },
    });
    expect(wrapper.text()).toContain("My Field");
  });
});
