import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [
      { id: "prop-1", name: "Prop 1" },
      { id: "prop-2", name: "Prop 2" },
    ],
    uncomputedAnnotationsPerProperty: {
      "prop-1": ["ann-1"],
      "prop-2": [],
    },
    propertyStatuses: {
      "prop-1": { running: false },
      "prop-2": { running: false },
    },
    computeProperty: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      running: false,
      progressInfo: {},
      errorInfo: { errors: [] },
    }),
  },
  IPropertyStatus: {},
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

import propertyStore from "@/store/properties";
import PropertyList from "./PropertyList.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(PropertyList, {
    vuetify: new Vuetify(),
    propsData: props,
    stubs: {
      AnnotationProperty: true,
      AnnotationPropertyBody: true,
    },
  });
}

describe("PropertyList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (propertyStore as any).properties = [
      { id: "prop-1", name: "Prop 1" },
      { id: "prop-2", name: "Prop 2" },
    ];
    (propertyStore as any).uncomputedAnnotationsPerProperty = {
      "prop-1": ["ann-1"],
      "prop-2": [],
    };
    (propertyStore as any).propertyStatuses = {
      "prop-1": { running: false },
      "prop-2": { running: false },
    };
  });

  it("properties reads from propertyStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.properties).toHaveLength(2);
  });

  it("uncomputedProperties filters those with uncomputed annotations", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedProperties).toHaveLength(1);
    expect(wrapper.vm.uncomputedProperties[0].id).toBe("prop-1");
  });

  it("uncomputedRunning counts running properties", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedRunning).toBe(0);
  });

  it("uncomputedRunning counts running properties when some are running", () => {
    (propertyStore as any).propertyStatuses = {
      "prop-1": { running: true },
      "prop-2": { running: false },
    };
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedRunning).toBe(1);
  });

  it("computeUncomputedProperties calls computeProperty for each", () => {
    const wrapper = mountComponent();
    wrapper.vm.computeUncomputedProperties();
    expect(propertyStore.computeProperty).toHaveBeenCalledTimes(1);
  });

  it("computeUncomputedProperties with applyToAllDatasets emits compute-properties-batch", () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    wrapper.vm.computeUncomputedProperties();
    expect(wrapper.emitted("compute-properties-batch")).toBeTruthy();
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });
});
