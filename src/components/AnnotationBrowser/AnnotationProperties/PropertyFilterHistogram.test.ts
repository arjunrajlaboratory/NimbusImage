import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const { d3Chain } = vi.hoisted(() => {
  const d3Chain: any = {};
  const methods = [
    "append",
    "attr",
    "style",
    "select",
    "selectAll",
    "data",
    "call",
    "on",
    "remove",
    "enter",
    "exit",
    "merge",
    "transition",
    "duration",
    "text",
  ];
  for (const method of methods) {
    d3Chain[method] = (..._args: any[]) => d3Chain;
  }
  return { d3Chain };
});

vi.mock("d3-selection", () => ({
  select: () => d3Chain,
  selectAll: () => d3Chain,
  event: null,
}));

vi.mock("d3-drag", () => {
  const dragBehavior: any = {};
  dragBehavior.on = (..._args: any[]) => dragBehavior;
  return {
    drag: () => dragBehavior,
  };
});

vi.mock("lodash/debounce", () => ({
  default: (fn: any) => fn,
}));

vi.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    getFullNameFromPath: (path: string[]) => {
      const map: Record<string, string> = {
        "propA.sub1": "Property A > Sub1",
        "propB.sub2": "Property B > Sub2",
      };
      return map[path.join(".")] || null;
    },
    propertyValues: {} as Record<string, any>,
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    propertyFilters: [] as any[],
    updatePropertyFilter: vi.fn(),
    togglePropertyPathFiltering: vi.fn(),
    getHistogram: vi.fn().mockReturnValue([]),
    updateHistograms: vi.fn(),
  },
}));

vi.mock("@/utils/paths", () => ({
  arePathEquals: (a: string[], b: string[]) =>
    a.length === b.length && a.every((v: string, i: number) => v === b[i]),
  getValueFromObjectAndPath: (values: any, path: string[]) => {
    if (!values) return null;
    let current = values;
    for (const key of path) {
      if (current && typeof current === "object" && key in current) {
        current = current[key];
      } else {
        return null;
      }
    }
    return current;
  },
}));

import PropertyFilterHistogram from "./PropertyFilterHistogram.vue";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

Vue.use(Vuetify);

function mountComponent(propsOverrides: any = {}) {
  return shallowMount(PropertyFilterHistogram, {
    vuetify: new Vuetify(),
    propsData: {
      propertyPath: ["propA", "sub1"],
      ...propsOverrides,
    },
    stubs: {
      TagFilterEditor: true,
    },
  });
}

describe("PropertyFilterHistogram", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (propertyStore as any).getFullNameFromPath = (path: string[]) => {
      const map: Record<string, string> = {
        "propA.sub1": "Property A > Sub1",
        "propB.sub2": "Property B > Sub2",
      };
      return map[path.join(".")] || null;
    };
    (propertyStore as any).propertyValues = {
      ann1: { propA: { sub1: 10 } },
      ann2: { propA: { sub1: 20 } },
      ann3: { propA: { sub1: 30 } },
    };
    (filterStore as any).propertyFilters = [];
    (filterStore as any).updatePropertyFilter = vi.fn();
    (filterStore as any).togglePropertyPathFiltering = vi.fn();
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([]);
    (filterStore as any).updateHistograms = vi.fn();
  });

  it("propertyFullName returns the full name from propertyStore", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.propertyFullName).toBe("Property A > Sub1");
    wrapper.destroy();
  });

  it("propertyFullName returns null for unknown paths", () => {
    const wrapper = mountComponent({ propertyPath: ["unknown", "path"] });
    const vm = wrapper.vm as any;
    expect(vm.propertyFullName).toBeNull();
    wrapper.destroy();
  });

  it("values extracts numeric values from propertyStore.propertyValues", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.values).toEqual(expect.arrayContaining([10, 20, 30]));
    expect(vm.values).toHaveLength(3);
    wrapper.destroy();
  });

  it("values returns empty array when no matching property values", () => {
    (propertyStore as any).propertyValues = {};
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.values).toEqual([]);
    wrapper.destroy();
  });

  it("defaultMin returns minimum of values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMin).toBe(10);
    wrapper.destroy();
  });

  it("defaultMax returns maximum of values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMax).toBe(30);
    wrapper.destroy();
  });

  it("minValue getter returns defaultMin when defaultMinMax is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMinMax).toBe(true);
    expect(vm.minValue).toBe(vm.defaultMin);
    wrapper.destroy();
  });

  it("maxValue getter returns defaultMax when defaultMinMax is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.maxValue).toBe(vm.defaultMax);
    wrapper.destroy();
  });

  it("minValue setter rejects values greater than maxValue", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const initialMin = vm.minValue;
    vm.minValue = 999;
    // Should not have called updatePropertyFilter for invalid value
    expect(vm.minValue).toBe(initialMin);
    wrapper.destroy();
  });

  it("minValue setter rejects values less than defaultMin", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Clear calls from onMounted
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.minValue = -999;
    // Should be rejected (value < defaultMin)
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("minValue setter calls filterStore.updatePropertyFilter for valid values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.minValue = 15;
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    wrapper.destroy();
  });

  it("maxValue setter calls filterStore.updatePropertyFilter for valid values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.maxValue = 25;
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    wrapper.destroy();
  });

  it("maxValue setter rejects values less than minValue", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.maxValue = -999;
    // Only the onMounted call should have happened, not one for this setter
    const callsFromOnMounted = (filterStore.updatePropertyFilter as any).mock
      .calls.length;
    // Re-attempt with invalid
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.maxValue = -999;
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("histToPixel returns a scale function", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const scale = vm.histToPixel;
    expect(typeof scale).toBe("function");
    expect(scale.domain()).toEqual([vm.defaultMin, vm.defaultMax]);
    wrapper.destroy();
  });

  it("toValue returns pixel string for normal value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.toValue(20);
    expect(result).toMatch(/^\d+(\.\d+)?px$/);
    wrapper.destroy();
  });

  it("toValue returns inverted pixel string for max", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.toValue(20, true);
    expect(result).toMatch(/^\d+(\.\d+)?px$/);
    wrapper.destroy();
  });

  it("propertyFilter creates a new filter when none exists", () => {
    (filterStore as any).propertyFilters = [];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const filter = vm.propertyFilter;
    expect(filter).toBeTruthy();
    expect(filter.propertyPath).toEqual(["propA", "sub1"]);
    expect(filter.enabled).toBe(true);
    wrapper.destroy();
  });

  it("propertyFilter returns existing filter when one matches", () => {
    const existingFilter = {
      id: "existing-id",
      propertyPath: ["propA", "sub1"],
      range: { min: 5, max: 25 },
      exclusive: false,
      enabled: true,
      valuesOrRange: "range",
    };
    (filterStore as any).propertyFilters = [existingFilter];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.propertyFilter.id).toBe("existing-id");
    wrapper.destroy();
  });

  it("hist returns histogram from filterStore", () => {
    const histData = [
      { count: 5, min: 10, max: 15 },
      { count: 10, min: 15, max: 20 },
    ];
    (filterStore as any).getHistogram = vi.fn().mockReturnValue(histData);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hist).toEqual(histData);
    wrapper.destroy();
  });

  it("area returns empty string when hist is empty", () => {
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.area).toBe("");
    wrapper.destroy();
  });

  it("area returns path string when hist has data", () => {
    const histData = [
      { count: 5, min: 10, max: 15 },
      { count: 10, min: 15, max: 20 },
      { count: 3, min: 20, max: 30 },
    ];
    (filterStore as any).getHistogram = vi.fn().mockReturnValue(histData);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.area).toBeTruthy();
    expect(typeof vm.area).toBe("string");
    wrapper.destroy();
  });

  it("area with CDF mode accumulates densities", () => {
    const histData = [
      { count: 5, min: 10, max: 15 },
      { count: 10, min: 15, max: 20 },
      { count: 3, min: 20, max: 30 },
    ];
    (filterStore as any).getHistogram = vi.fn().mockReturnValue(histData);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.useCDF = true;
    expect(vm.area).toBeTruthy();
    expect(typeof vm.area).toBe("string");
    wrapper.destroy();
  });

  it("area with log mode uses symlog scale", () => {
    const histData = [
      { count: 5, min: 10, max: 15 },
      { count: 10, min: 15, max: 20 },
      { count: 3, min: 20, max: 30 },
    ];
    (filterStore as any).getHistogram = vi.fn().mockReturnValue(histData);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.useLog = true;
    expect(vm.area).toBeTruthy();
    expect(typeof vm.area).toBe("string");
    wrapper.destroy();
  });

  it("toggleFilterEnabled calls filterStore.updatePropertyFilter", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.toggleFilterEnabled(false);
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.enabled).toBe(false);
    wrapper.destroy();
  });

  it("removeFilter calls filterStore.togglePropertyPathFiltering", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.removeFilter();
    expect(filterStore.togglePropertyPathFiltering).toHaveBeenCalledWith([
      "propA",
      "sub1",
    ]);
    wrapper.destroy();
  });

  it("updateViewMode with range mode calls updatePropertyFilter", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.updateViewMode("range");
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.valuesOrRange).toBe("range");
    expect(call.values).toBeUndefined();
    wrapper.destroy();
  });

  it("updateViewMode with values mode retains existing values", () => {
    const existingFilter = {
      id: "existing-id",
      propertyPath: ["propA", "sub1"],
      range: { min: 10, max: 30 },
      exclusive: false,
      enabled: true,
      valuesOrRange: "range",
      values: [15, 25],
    };
    (filterStore as any).propertyFilters = [existingFilter];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.updateViewMode("values");
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.valuesOrRange).toBe("values");
    expect(call.values).toEqual([15, 25]);
    wrapper.destroy();
  });

  it("updateValuesFilter parses valuesInput and updates filter", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.valuesInput = "1, 2, 3";
    vm.updateValuesFilter();
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.values).toEqual([1, 2, 3]);
    wrapper.destroy();
  });

  it("updateValuesFilter does not update when input is empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.valuesInput = "";
    vm.updateValuesFilter();
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("updateValuesFilter handles tab/newline/semicolon separators", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.valuesInput = "1\t2\n3;4 5";
    vm.updateValuesFilter();
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.values).toEqual([1, 2, 3, 4, 5]);
    wrapper.destroy();
  });

  it("onMounted calls filterStore.updateHistograms", () => {
    const wrapper = mountComponent();
    expect(filterStore.updateHistograms).toHaveBeenCalled();
    wrapper.destroy();
  });

  it("onBeforeUnmount disables filter if it was enabled", () => {
    const existingFilter = {
      id: "test-id",
      propertyPath: ["propA", "sub1"],
      range: { min: 10, max: 30 },
      exclusive: false,
      enabled: true,
      valuesOrRange: "range",
    };
    (filterStore as any).propertyFilters = [existingFilter];
    const wrapper = mountComponent();
    (filterStore.updatePropertyFilter as any).mockClear();
    wrapper.destroy();
    // Should have been called to disable the filter
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.enabled).toBe(false);
  });
});
