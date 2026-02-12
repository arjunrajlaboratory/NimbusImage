import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: { z: [0, 1], time: [0, 1, 2] },
    availableToolShapes: [
      { text: "Point", value: "point" },
      { text: "Line", value: "line" },
    ],
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [] as any[],
    workerImageList: {
      "test-image": {
        isUPennContrastWorker: "true",
        isPropertyWorker: "true",
        interfaceName: "Test Worker",
        annotationShape: "point",
      },
    },
    computeProperty: vi.fn(),
    createProperty: vi.fn().mockResolvedValue({ id: "prop1", name: "test" }),
    fetchWorkerInterface: vi.fn(),
    togglePropertyPathVisibility: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [] as any[],
  },
}));

vi.mock("@/utils/annotation", () => ({
  tagFilterFunction: vi.fn(),
}));

import PropertyCreation from "./PropertyCreation.vue";
import propertyStore from "@/store/properties";

Vue.use(Vuetify);
Vue.directive("description", {});
Vue.directive("tour-trigger", {});

function mountComponent(props = {}) {
  return shallowMount(PropertyCreation, {
    vuetify: new Vuetify(),
    propsData: props,
  });
}

describe("PropertyCreation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (propertyStore as any).properties = [];
    (propertyStore as any).workerImageList = {
      "test-image": {
        isUPennContrastWorker: "true",
        isPropertyWorker: "true",
        interfaceName: "Test Worker",
        annotationShape: "point",
      },
    };
    (propertyStore.computeProperty as any) = vi.fn();
    (propertyStore.createProperty as any) = vi
      .fn()
      .mockResolvedValue({ id: "prop1", name: "test" });
    (propertyStore.fetchWorkerInterface as any) = vi.fn();
    (propertyStore.togglePropertyPathVisibility as any) = vi.fn();
  });

  it("generatedName builds 'All No image' when no tags or docker image", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.generatedName).toBe("All No image");
  });

  it("generatedName builds from tags and docker image interface name", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringTags = ["tagA", "tagB"];
    vm.dockerImage = "test-image";
    expect(vm.generatedName).toBe("tagA, tagB Test Worker");
  });

  it("generatedName shows 'No tag' when areTagsExclusive is true and no tags", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.areTagsExclusive = true;
    // removeRepeatedWords deduplicates "No" (case-insensitive), so "No tag No image" becomes "No tag image"
    expect(vm.generatedName).toBe("No tag image");
  });

  it("generatedName falls back to docker image string when interfaceName is missing", () => {
    (propertyStore as any).workerImageList = {
      "unknown-image": {
        isUPennContrastWorker: "true",
        isPropertyWorker: "true",
        annotationShape: "point",
      },
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "unknown-image";
    expect(vm.generatedName).toBe("All unknown-image");
  });

  it("deduplicatedName returns original name when no conflicts", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.originalName = "My Property";
    expect(vm.deduplicatedName).toBe("My Property");
  });

  it("deduplicatedName appends (1) when name already exists in properties", () => {
    (propertyStore as any).properties = [{ name: "New Property" }];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.originalName = "New Property";
    expect(vm.deduplicatedName).toBe("New Property (1)");
  });

  it("deduplicatedName appends (2) when name and (1) both exist", () => {
    (propertyStore as any).properties = [
      { name: "New Property" },
      { name: "New Property (1)" },
    ];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.originalName = "New Property";
    expect(vm.deduplicatedName).toBe("New Property (2)");
  });

  it("reset clears all fields to defaults", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringTags = ["tag1"];
    vm.areTagsExclusive = true;
    vm.filteringShape = "point";
    vm.dockerImage = "test-image";
    vm.originalName = "Custom Name";
    vm.isNameGenerated = false;

    vm.reset();

    expect(vm.filteringTags).toEqual([]);
    expect(vm.areTagsExclusive).toBe(false);
    expect(vm.filteringShape).toBeNull();
    expect(vm.dockerImage).toBeNull();
    expect(vm.originalName).toBe("New Property");
    expect(vm.isNameGenerated).toBe(true);
  });

  it("createProperty returns early if no dockerImage", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringShape = "point";
    vm.dockerImage = null;

    vm.createProperty();

    expect(propertyStore.createProperty).not.toHaveBeenCalled();
  });

  it("createProperty returns early if no filteringShape", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShape = null;

    vm.createProperty();

    expect(propertyStore.createProperty).not.toHaveBeenCalled();
  });

  it("createProperty calls propertyStore.createProperty with correct args", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShape = "point";
    vm.filteringTags = ["tag1"];
    vm.areTagsExclusive = true;
    vm.originalName = "My Prop";
    vm.interfaceValues = { key: "value" };

    vm.createProperty();

    expect(propertyStore.createProperty).toHaveBeenCalledWith({
      name: "My Prop",
      image: "test-image",
      tags: {
        tags: ["tag1"],
        exclusive: true,
      },
      shape: "point",
      workerInterface: { key: "value" },
    });
  });

  it("createProperty calls reset after creating", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShape = "point";

    vm.createProperty();

    // After reset, fields should be back to defaults
    expect(vm.filteringTags).toEqual([]);
    expect(vm.dockerImage).toBeNull();
    expect(vm.filteringShape).toBeNull();
  });

  it("createProperty toggles visibility and computes upon creation", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShape = "point";
    vm.computeUponCreation = true;

    vm.createProperty();

    // Wait for the promise chain to resolve
    await vi.waitFor(() => {
      expect(propertyStore.togglePropertyPathVisibility).toHaveBeenCalledWith([
        "prop1",
      ]);
    });
    expect(propertyStore.computeProperty).toHaveBeenCalledWith({
      property: { id: "prop1", name: "test" },
      errorInfo: { errors: [] },
    });
  });

  it("createProperty emits compute-property-batch when applyToAllDatasets is true", async () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShape = "point";
    vm.computeUponCreation = true;

    vm.createProperty();

    await vi.waitFor(() => {
      expect(propertyStore.togglePropertyPathVisibility).toHaveBeenCalled();
    });
    expect(wrapper.emitted("compute-property-batch")).toBeTruthy();
    expect(wrapper.emitted("compute-property-batch")![0][0]).toEqual({
      id: "prop1",
      name: "test",
    });
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("createProperty does not compute when computeUponCreation is false", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShape = "point";
    vm.computeUponCreation = false;

    vm.createProperty();

    await vi.waitFor(() => {
      expect(propertyStore.togglePropertyPathVisibility).toHaveBeenCalled();
    });
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("shapeSelectionString returns 'Or by shape:' when no tags", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringTags = [];
    expect(vm.shapeSelectionString).toBe("Or by shape:");
  });

  it("shapeSelectionString returns 'Of shape:' when tags present", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringTags = ["tag1"];
    expect(vm.shapeSelectionString).toBe("Of shape:");
  });

  it("filteringShapeChanged sets dockerImage to null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.filteringShapeChanged();
    expect(vm.dockerImage).toBeNull();
  });

  it("propertyImageFilter returns a filter function", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const filterFn = vm.propertyImageFilter;
    expect(typeof filterFn).toBe("function");
  });

  it("propertyImageFilter accepts labels matching shape with isPropertyWorker", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringShape = "point";
    const filterFn = vm.propertyImageFilter;

    expect(
      filterFn({
        isUPennContrastWorker: "true",
        isPropertyWorker: "true",
        annotationShape: "point",
      }),
    ).toBe(true);
  });

  it("propertyImageFilter rejects labels without isPropertyWorker", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringShape = "point";
    const filterFn = vm.propertyImageFilter;

    expect(
      filterFn({
        isUPennContrastWorker: "true",
        annotationShape: "point",
      }),
    ).toBe(false);
  });

  it("propertyImageFilter rejects labels with wrong shape", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringShape = "point";
    const filterFn = vm.propertyImageFilter;

    expect(
      filterFn({
        isUPennContrastWorker: "true",
        isPropertyWorker: "true",
        annotationShape: "line",
      }),
    ).toBe(false);
  });

  it("propertyImageFilter accepts labels with 'any' annotationShape", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filteringShape = "point";
    const filterFn = vm.propertyImageFilter;

    expect(
      filterFn({
        isUPennContrastWorker: "true",
        isPropertyWorker: "true",
        annotationShape: "any",
      }),
    ).toBe(true);
  });

  it("dockerImageChanged sets isNameGenerated to true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.isNameGenerated = false;
    vm.dockerImageChanged();
    expect(vm.isNameGenerated).toBe(true);
  });

  it("dockerImageChanged calls fetchWorkerInterface when dockerImage is set", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = "test-image";
    vm.dockerImageChanged();
    expect(propertyStore.fetchWorkerInterface).toHaveBeenCalledWith({
      image: "test-image",
    });
  });

  it("dockerImageChanged does not call fetchWorkerInterface when dockerImage is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dockerImage = null;
    vm.dockerImageChanged();
    expect(propertyStore.fetchWorkerInterface).not.toHaveBeenCalled();
  });
});
