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
    properties: [],
    uncomputedCountByProperty: {},
    propertyStatuses: {},
    computeProperty: vi.fn(),
    computeProperties: vi.fn(),
  },
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

import propertyStore from "@/store/properties";
import ComputeAllStatus from "./ComputeAllStatus.vue";

function mountComponent(props = {}) {
  return mount(ComputeAllStatus, { props });
}

describe("ComputeAllStatus", () => {
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

  it("uncomputedProperties filters properties with uncomputed counts", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedProperties).toHaveLength(1);
    expect(wrapper.vm.uncomputedProperties[0].id).toBe("prop-1");
  });

  it("shows 'Computations done' when nothing is uncomputed", () => {
    (propertyStore as any).uncomputedCountByProperty = {
      "prop-1": 0,
      "prop-2": 0,
    };
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Computations done");
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("uncomputedRunning counts running uncomputed properties", () => {
    (propertyStore as any).propertyStatuses["prop-1"].running = true;
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedRunning).toBe(1);
  });

  it("computeUncomputedProperties submits the group through one store action", () => {
    const wrapper = mountComponent();
    wrapper.vm.computeUncomputedProperties();
    expect(propertyStore.computeProperties).toHaveBeenCalledTimes(1);
    expect(propertyStore.computeProperties).toHaveBeenCalledWith([
      expect.objectContaining({ id: "prop-1" }),
    ]);
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("does not create per-property error state in the component", () => {
    const wrapper = mountComponent();
    wrapper.vm.computeUncomputedProperties();
    expect((propertyStore as any).propertyStatuses["prop-1"].errorInfo).toBe(
      undefined,
    );
  });

  it("with applyToAllDatasets emits compute-properties-batch instead", () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    wrapper.vm.computeUncomputedProperties();
    expect(wrapper.emitted("compute-properties-batch")).toBeTruthy();
    expect(propertyStore.computeProperties).not.toHaveBeenCalled();
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("labels an over-limit run as the next bounded batch", () => {
    (propertyStore as any).properties = Array.from(
      { length: 101 },
      (_, index) => ({ id: `prop-${index}`, name: `Prop ${index}` }),
    );
    (propertyStore as any).uncomputedCountByProperty = Object.fromEntries(
      (propertyStore as any).properties.map((property: any) => [
        property.id,
        1,
      ]),
    );
    (propertyStore as any).propertyStatuses = {};

    const wrapper = mountComponent();

    expect(wrapper.text()).toContain("Compute next 100");
  });
});
