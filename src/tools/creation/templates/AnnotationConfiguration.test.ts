import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { z: [0, 1, 2], time: [0, 1, 2, 3] },
    availableToolShapes: [
      { text: "Point", value: "point" },
      { text: "Line", value: "line" },
    ],
    getLayerFromId: vi.fn().mockReturnValue({ name: "TestLayer" }),
    layers: [
      { id: "layer-1", name: "TestLayer" },
      { id: "layer-2", name: "Layer 2" },
    ],
  },
}));

vi.mock("@/store/Persister", () => ({
  default: {
    get: vi.fn().mockReturnValue("alreadyRun"),
    set: vi.fn(),
  },
}));

vi.mock("@/store/model", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
  };
});

vi.mock("@/components/LayerSelect.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("@/components/TagPicker.vue", () => ({
  default: { template: "<div />" },
}));

import AnnotationConfiguration from "./AnnotationConfiguration.vue";
import store from "@/store";

function mountComponent(props = {}) {
  return mount(AnnotationConfiguration, {
    props: {
      ...props,
    },
    global: {
      mocks: {
        $isTourActive: () => true,
        $startTour: vi.fn(),
      },
    },
  });
}

describe("AnnotationConfiguration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-setup the mock return value after restoreAllMocks
    (store.getLayerFromId as any).mockReturnValue({ name: "TestLayer" });
  });

  it("default shape is AnnotationShape.Point", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).shape).toBe("point");
  });

  it("maxZ returns dataset.z.length + 1", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).maxZ).toBe(4); // 3 + 1
  });

  it("maxTime returns dataset.time.length + 1", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).maxTime).toBe(5); // 4 + 1
  });

  it("autoTags builds from layer name and shape name", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // Set a layer so autoTags can compute
    vm.coordinateAssignments.layer = "layer-1";
    // shape is "point" by default, AnnotationNames["point"] = "Point" -> "point" (lowercase)
    const tags = vm.autoTags;
    expect(tags).toEqual(["TestLayer point"]);
  });

  it("reset sets shape to defaultShape, clears tags, emits change", () => {
    const wrapper = mountComponent({ defaultShape: "line" });
    const vm = wrapper.vm as any;

    // Set some state first
    vm.shape = "polygon";
    vm.tagsInternal = ["tag1", "tag2"];

    vm.reset();

    expect(vm.shape).toBe("line");
    expect(vm.tagsInternal).toEqual([]);
    expect(wrapper.emitted("change")).toBeTruthy();
  });

  it("updateFromValue syncs coordinateAssignments, shape, tags from prop", () => {
    const valueProp = {
      tags: ["custom-tag"],
      coordinateAssignments: {
        layer: "layer-2",
        Z: { type: "assign", value: 2, max: 4 },
        Time: { type: "layer", value: 1, max: 5 },
      },
      shape: "polygon" as const,
      color: undefined,
    };
    const wrapper = mountComponent({ modelValue: valueProp });
    const vm = wrapper.vm as any;

    expect(vm.shape).toBe("polygon");
    expect(vm.tagsInternal).toEqual(["custom-tag"]);
    expect(vm.coordinateAssignments.Z.type).toBe("assign");
    expect(vm.coordinateAssignments.Z.value).toBe(2);
  });

  it("updateFromValue resets when value is undefined", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.shape = "polygon";
    vm.tagsInternal = ["tag1"];

    // Call updateFromValue with no value set
    vm.updateFromValue();

    // Should reset to defaults
    expect(vm.shape).toBe("point"); // defaultShape
    expect(vm.tagsInternal).toEqual([]);
  });

  it("changed emits input with IAnnotationSetup and emits change", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.shape = "line";
    vm.changed();

    const inputEvents = wrapper.emitted("update:modelValue")!;
    expect(inputEvents).toBeTruthy();
    const lastInput = inputEvents[inputEvents.length - 1][0];
    expect(lastInput).toHaveProperty("tags");
    expect(lastInput).toHaveProperty("coordinateAssignments");
    expect(lastInput).toHaveProperty("shape", "line");
    expect(lastInput).toHaveProperty("color");

    expect(wrapper.emitted("change")).toBeTruthy();
  });

  it("color computed: get returns undefined when customColorEnabled is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.customColorEnabled = false;
    expect(vm.color).toBeUndefined();
  });

  it("color computed: get returns customColorValue when customColorEnabled is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.customColorEnabled = true;
    vm.customColorValue = "#FF0000";
    expect(vm.color).toBe("#FF0000");
  });

  it("color setter enables custom color when given a value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.color = "#00FF00";
    expect(vm.customColorEnabled).toBe(true);
    expect(vm.customColorValue).toBe("#00FF00");
  });

  it("color setter disables custom color when given undefined", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.customColorEnabled = true;
    vm.color = undefined;
    expect(vm.customColorEnabled).toBe(false);
  });

  it("tags returns autoTags when useAutoTags is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.useAutoTags = true;
    vm.coordinateAssignments.layer = "layer-1";
    const tags = vm.tags;
    // autoTags should return based on layer name and shape
    expect(tags).toEqual(["TestLayer point"]);
  });

  it("tags returns tagsInternal when useAutoTags is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.useAutoTags = false;
    vm.tagsInternal = ["manual-tag"];
    expect(vm.tags).toEqual(["manual-tag"]);
  });

  it("layer getter/setter works with coordinateAssignments", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    expect(vm.layer).toBeNull();
    vm.layer = "new-layer-id";
    expect(vm.coordinateAssignments.layer).toBe("new-layer-id");
  });

  // Vuetify 3 @change migration: v-select should use @update:model-value
  describe("Vuetify 3 @change migration", () => {
    it("v-select shape change triggers changed() via update:modelValue", () => {
      const wrapper = mountComponent();
      const vSelect = wrapper.findComponent({ name: "v-select" });
      expect(vSelect.exists()).toBe(true);

      // Clear previous emits
      const changeEmitsBefore = (wrapper.emitted("change") || []).length;

      // Emit update:modelValue as Vuetify 3 does when selection changes
      vSelect.vm.$emit("update:modelValue", "line");

      // If @update:model-value is wired, changed() should have emitted a new "change"
      const changeEmitsAfter = (wrapper.emitted("change") || []).length;
      expect(changeEmitsAfter).toBeGreaterThan(changeEmitsBefore);
    });

    it("v-radio-group coordinate change triggers changed() via update:modelValue", () => {
      // Ensure getLayerFromId returns a full layer object for rendering
      (store.getLayerFromId as any).mockReturnValue({
        name: "TestLayer",
        z: { type: "current", value: 0 },
        time: { type: "current", value: 0 },
      });
      const wrapper = mountComponent({ advanced: true });
      const radioGroups = wrapper.findAllComponents({ name: "v-radio-group" });
      expect(radioGroups.length).toBeGreaterThan(0);

      const changeEmitsBefore = (wrapper.emitted("change") || []).length;

      // Emit update:modelValue as Vuetify 3 does when radio selection changes
      radioGroups[0].vm.$emit("update:modelValue", "assign");

      const changeEmitsAfter = (wrapper.emitted("change") || []).length;
      expect(changeEmitsAfter).toBeGreaterThan(changeEmitsBefore);
    });
  });
});
