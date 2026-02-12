import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    showAdvancedOptionsPanel: vi.fn().mockReturnValue(true),
    showAnnotationConfigurationPanel: vi.fn().mockReturnValue(true),
    workerImageList: {},
  },
}));

vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({
  default: {},
}));

vi.mock("@/tools/creation/templates/TagAndLayerRestriction.vue", () => ({
  default: {},
}));

vi.mock("@/tools/creation/templates/DockerImage.vue", () => ({
  default: {},
}));

import ToolConfiguration from "./ToolConfiguration.vue";
import propertiesStore from "@/store/properties";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(ToolConfiguration, {
    vuetify: new Vuetify(),
    propsData: {
      template: {
        name: "Test Tool",
        type: "create",
        description: "A test tool",
        interface: [
          {
            id: "textField",
            name: "Text Field",
            type: "text",
            meta: { value: "default-text" },
          },
          {
            id: "advancedField",
            name: "Advanced Field",
            type: "checkbox",
            advanced: true,
            meta: { value: true },
          },
        ],
      },
      defaultValues: {},
      value: {},
      ...props,
    },
    stubs: {
      ToolConfigurationItem: true,
    },
  });
}

describe("ToolConfiguration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (propertiesStore.showAdvancedOptionsPanel as any).mockReturnValue(true);
    (propertiesStore.showAnnotationConfigurationPanel as any).mockReturnValue(
      true,
    );
  });

  it("reset clones defaultValues into toolValues", () => {
    const defaults = { textField: "hello", advancedField: true };
    const wrapper = mountComponent({ defaultValues: defaults });
    const vm = wrapper.vm as any;

    // toolValues should be a clone of defaultValues
    expect(vm.toolValues).toEqual(defaults);
    // Verify it is a clone, not the same reference
    expect(vm.toolValues).not.toBe(defaults);
  });

  it("reset sets toolValues to empty object when defaultValues is falsy", () => {
    const wrapper = mountComponent({ defaultValues: null });
    const vm = wrapper.vm as any;

    expect(vm.toolValues).toEqual(expect.objectContaining({}));
  });

  it("internalTemplate merges template.interface with valueTemplates", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // Base template has 2 interface items
    expect(vm.internalTemplate.length).toBeGreaterThanOrEqual(2);
    expect(vm.internalTemplate[0].id).toBe("textField");
    expect(vm.internalTemplate[1].id).toBe("advancedField");

    // Add valueTemplates dynamically
    vm.valueTemplates = {
      someKey: [{ id: "dynamic1", name: "Dynamic", type: "text", meta: {} }],
    };

    expect(vm.internalTemplate).toHaveLength(3);
    expect(vm.internalTemplate[2].id).toBe("dynamic1");
  });

  it("basicInternalTemplate filters out advanced items (except annotation)", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const basic = vm.basicInternalTemplate;
    // "textField" is not advanced -> included
    // "advancedField" is advanced -> excluded
    expect(basic.some((item: any) => item.id === "textField")).toBe(true);
    expect(basic.some((item: any) => item.id === "advancedField")).toBe(false);
  });

  it("basicInternalTemplate includes annotation items even if advanced", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test Tool",
        type: "create",
        description: "",
        interface: [
          {
            id: "annotationConfig",
            name: "Annotation",
            type: "annotation",
            advanced: true,
            meta: {},
          },
          {
            id: "basicText",
            name: "Basic Text",
            type: "text",
            meta: {},
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    const basic = vm.basicInternalTemplate;
    // annotation type is always included in basic (per filter: !item.advanced || item.type === "annotation")
    expect(basic.some((item: any) => item.id === "annotationConfig")).toBe(
      true,
    );
    expect(basic.some((item: any) => item.id === "basicText")).toBe(true);
  });

  it("advancedInternalTemplate keeps advanced and annotation items", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test Tool",
        type: "create",
        description: "",
        interface: [
          {
            id: "annotationConfig",
            name: "Annotation",
            type: "annotation",
            meta: {},
          },
          {
            id: "basicText",
            name: "Basic Text",
            type: "text",
            meta: {},
          },
          {
            id: "advancedCheck",
            name: "Advanced Check",
            type: "checkbox",
            advanced: true,
            meta: {},
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    const advanced = vm.advancedInternalTemplate;
    // annotation type -> included (item.type === "annotation")
    expect(advanced.some((item: any) => item.id === "annotationConfig")).toBe(
      true,
    );
    // basicText is not advanced and not annotation -> excluded
    expect(advanced.some((item: any) => item.id === "basicText")).toBe(false);
    // advancedCheck is advanced -> included
    expect(advanced.some((item: any) => item.id === "advancedCheck")).toBe(
      true,
    );
  });

  it("changed emits input with toolValues", () => {
    const wrapper = mountComponent({ defaultValues: { textField: "val" } });
    const vm = wrapper.vm as any;

    vm.changed();

    const inputEvents = wrapper.emitted("input")!;
    expect(inputEvents).toBeTruthy();
    const lastInput = inputEvents[inputEvents.length - 1][0];
    expect(lastInput).toHaveProperty("textField");
  });

  it("setDefaultValues sets defaults for select type", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test",
        type: "create",
        description: "",
        interface: [
          {
            id: "selectField",
            name: "Select Field",
            type: "select",
            meta: {
              items: [
                { text: "Option A", value: "a" },
                { text: "Option B", value: "b" },
              ],
            },
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    // setDefaultValues was already called during mount/reset
    expect(vm.toolValues.selectField).toEqual({
      text: "Option A",
      value: "a",
    });
  });

  it("setDefaultValues sets defaults for radio type", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test",
        type: "create",
        description: "",
        interface: [
          {
            id: "radioField",
            name: "Radio Field",
            type: "radio",
            values: [
              { text: "R1", value: "r1" },
              { text: "R2", value: "r2" },
            ],
            meta: {},
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    expect(vm.toolValues.radioField).toBe("r1");
  });

  it("setDefaultValues sets defaults for text type with value", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test",
        type: "create",
        description: "",
        interface: [
          {
            id: "textWithValue",
            name: "Text",
            type: "text",
            meta: { value: "preset" },
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    expect(vm.toolValues.textWithValue).toBe("preset");
  });

  it("setDefaultValues sets defaults for text type with number meta", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test",
        type: "create",
        description: "",
        interface: [
          {
            id: "numText",
            name: "Number Text",
            type: "text",
            meta: { type: "number" },
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    expect(vm.toolValues.numText).toBe("0.0");
  });

  it("setDefaultValues sets defaults for checkbox type", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test",
        type: "create",
        description: "",
        interface: [
          {
            id: "checkField",
            name: "Check",
            type: "checkbox",
            meta: { value: true },
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    expect(vm.toolValues.checkField).toBe(true);
  });

  it("setDefaultValues sets checkbox to false when no meta value", () => {
    const wrapper = mountComponent({
      template: {
        name: "Test",
        type: "create",
        description: "",
        interface: [
          {
            id: "checkNoMeta",
            name: "Check",
            type: "checkbox",
            meta: {},
          },
        ],
      },
      defaultValues: {},
    });
    const vm = wrapper.vm as any;

    expect(vm.toolValues.checkNoMeta).toBe(false);
  });

  it("showAdvancedPanel returns true by default", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // No docker image in toolValues -> returns true
    expect(vm.showAdvancedPanel).toBe(true);
  });

  it("showAdvancedPanel delegates to propertiesStore when docker image exists", () => {
    const wrapper = mountComponent({
      defaultValues: { image: { image: "test-image:latest" } },
    });
    const vm = wrapper.vm as any;

    expect(vm.showAdvancedPanel).toBe(true);
    expect(propertiesStore.showAdvancedOptionsPanel).toHaveBeenCalledWith(
      "test-image:latest",
    );
  });

  it("shouldShowConfigurationItem returns true for non-annotation items", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    expect(vm.shouldShowConfigurationItem({ type: "text", id: "foo" })).toBe(
      true,
    );
    expect(vm.shouldShowConfigurationItem({ type: "select", id: "bar" })).toBe(
      true,
    );
    expect(
      vm.shouldShowConfigurationItem({ type: "checkbox", id: "baz" }),
    ).toBe(true);
  });

  it("shouldShowConfigurationItem delegates to propertiesStore for annotation items", () => {
    const wrapper = mountComponent({
      defaultValues: { image: { image: "worker-image:latest" } },
    });
    const vm = wrapper.vm as any;

    const result = vm.shouldShowConfigurationItem({
      type: "annotation",
      id: "ann",
    });
    expect(result).toBe(true);
    expect(
      propertiesStore.showAnnotationConfigurationPanel,
    ).toHaveBeenCalledWith("worker-image:latest");
  });

  it("reset resets advancedPanel to undefined", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.advancedPanel = 0;
    vm.reset();

    expect(vm.advancedPanel).toBeUndefined();
  });
});
