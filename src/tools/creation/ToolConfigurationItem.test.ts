import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

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

function mountComponent(props = {}) {
  return mount(ToolConfigurationItem, {
    props: {
      item: { type: "text", name: "Test Field" },
      modelValue: "hello",
      ...props,
    },
    global: {
      stubs: {
        AnnotationConfiguration: true,
        TagAndLayerRestriction: true,
        DockerImage: true,
        TagPicker: true,
      },
    },
  });
}

describe("ToolConfigurationItem", () => {
  it("componentValue getter returns value prop", () => {
    const wrapper = mountComponent({ modelValue: "test-value" });
    expect(wrapper.vm.componentValue).toBe("test-value");
  });

  it("componentValue setter emits input", async () => {
    const wrapper = mountComponent();
    wrapper.vm.componentValue = "new-value";
    expect(wrapper.emitted("update:modelValue")![0][0]).toBe("new-value");
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

  // Vuetify 3 @change migration: dynamic Vuetify component should use @update:model-value
  it("dynamic component triggers changed() via update:modelValue, not @change", () => {
    const wrapper = mountComponent({
      item: { type: "text", name: "Test" },
      modelValue: "hello",
    });

    // Find the VTextField rendered via <component :is="...">
    const textField = wrapper.findComponent({ name: "v-text-field" });
    expect(textField.exists()).toBe(true);

    // Emit update:modelValue as Vuetify 3 does on input
    textField.vm.$emit("update:modelValue", "world");

    // If @update:model-value is wired, changed() should emit "change"
    expect(wrapper.emitted("change")).toBeTruthy();
  });
});
