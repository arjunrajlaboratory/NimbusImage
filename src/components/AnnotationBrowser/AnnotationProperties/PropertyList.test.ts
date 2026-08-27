import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

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
    uncomputedCountByProperty: {
      "prop-1": 1,
      "prop-2": 0,
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
import ComputeAllStatus from "./ComputeAllStatus.vue";

function mountComponent(props = {}) {
  return mount(PropertyList, {
    props: props,
    global: {
      stubs: {
        AnnotationProperty: true,
        AnnotationPropertyBody: true,
      },
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
    (propertyStore as any).uncomputedCountByProperty = {
      "prop-1": 1,
      "prop-2": 0,
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

  it("renders the shared compute-all status in the header", () => {
    const wrapper = mountComponent();
    expect(wrapper.findComponent(ComputeAllStatus).exists()).toBe(true);
  });

  it("forwards applyToAllDatasets to the compute-all status", () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    expect(
      wrapper.findComponent(ComputeAllStatus).props("applyToAllDatasets"),
    ).toBe(true);
  });

  it("forwards compute-properties-batch from the compute-all status", () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    const batch = [{ id: "prop-1", name: "Prop 1" }];
    wrapper
      .findComponent(ComputeAllStatus)
      .vm.$emit("compute-properties-batch", batch);
    expect(wrapper.emitted("compute-properties-batch")).toEqual([[batch]]);
  });
});
