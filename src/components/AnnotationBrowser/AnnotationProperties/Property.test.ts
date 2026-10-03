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
    getStatus: vi.fn().mockReturnValue({
      running: false,
      previousRun: null,
      progressInfo: {},
      errorInfo: { errors: [] },
    }),
    uncomputedCountByProperty: {
      "prop-1": 2,
    },
    propertyStatuses: {},
    computeProperty: vi.fn(),
  },
  IPropertyStatus: {},
}));

vi.mock("@/utils/propertyCompute", () => ({
  computePropertyWithStatus: vi.fn(),
}));

import propertyStore from "@/store/properties";
import { computePropertyWithStatus } from "@/utils/propertyCompute";
import Property from "./Property.vue";

const baseProperty = {
  id: "prop-1",
  name: "Test Property",
  image: "test-image",
  tags: [],
  shape: "point",
  workerInterface: {},
} as any;

function mountComponent(props = {}) {
  return mount(Property, {
    props: {
      property: baseProperty,
      ...props,
    },
  });
}

describe("Property", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (propertyStore.getStatus as any).mockReturnValue({
      running: false,
      previousRun: null,
      progressInfo: {},
      errorInfo: { errors: [] },
    });
    (propertyStore as any).propertyStatuses = {};
  });

  it("status delegates to propertyStore.getStatus", () => {
    const wrapper = mountComponent();
    wrapper.vm.status;
    expect(propertyStore.getStatus).toHaveBeenCalledWith("prop-1");
  });

  it("uncomputed reads the count map from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputed).toBe(propertyStore.uncomputedCountByProperty);
  });

  it("shows the uncomputed count for the property", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("2");
  });

  it("filteredErrors filters by ERROR type", () => {
    (propertyStore.getStatus as any).mockReturnValue({
      running: false,
      progressInfo: {},
      errorInfo: {
        errors: [
          { error: "err1", type: "error", title: "Error 1" },
          { warning: "warn1", type: "warning", title: "Warning 1" },
        ],
      },
    });
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredErrors).toHaveLength(1);
    expect(wrapper.vm.filteredErrors[0].error).toBe("err1");
  });

  it("filteredWarnings filters by WARNING type", () => {
    (propertyStore.getStatus as any).mockReturnValue({
      running: false,
      progressInfo: {},
      errorInfo: {
        errors: [
          { error: "err1", type: "error", title: "Error 1" },
          { warning: "warn1", type: "warning", title: "Warning 1" },
        ],
      },
    });
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredWarnings).toHaveLength(1);
    expect(wrapper.vm.filteredWarnings[0].warning).toBe("warn1");
  });

  it("compute uses the shared status-aware helper", () => {
    const wrapper = mountComponent();
    wrapper.vm.compute();
    expect(computePropertyWithStatus).toHaveBeenCalledWith(baseProperty);
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("compute is no-op when running", () => {
    (propertyStore.getStatus as any).mockReturnValue({
      running: true,
      progressInfo: {},
      errorInfo: { errors: [] },
    });
    const wrapper = mountComponent();
    wrapper.vm.compute();
    expect(computePropertyWithStatus).not.toHaveBeenCalled();
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("compute with applyToAllDatasets emits compute-property-batch", () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    wrapper.vm.compute();
    expect(wrapper.emitted("compute-property-batch")).toBeTruthy();
    expect(wrapper.emitted("compute-property-batch")![0][0]).toStrictEqual(
      baseProperty,
    );
    expect(computePropertyWithStatus).not.toHaveBeenCalled();
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });
});
