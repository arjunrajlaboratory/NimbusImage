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

  it("typeToComponentName maps types correctly", () => {
    const wrapper = mountComponent();
    const map = wrapper.vm.typeToComponentName;
    expect(map.select).toBe("v-select");
    expect(map.annotation).toBe("annotation-configuration");
    expect(map.restrictTagsAndLayer).toBe("tag-and-layer-restriction");
    expect(map.checkbox).toBe("v-checkbox");
    expect(map.radio).toBe("v-radio-group");
    expect(map.text).toBe("v-text-field");
    expect(map.dockerImage).toBe("docker-image");
    expect(map.tags).toBe("tag-picker");
  });

  it("renders item name when present", () => {
    const wrapper = mountComponent({
      item: { type: "text", name: "My Field" },
    });
    expect(wrapper.text()).toContain("My Field");
  });
});
