import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { shallowMount } from "@vue/test-utils";

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
    d3Chain[method] = () => d3Chain;
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
  dragBehavior.on = () => dragBehavior;
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

function mountComponent(propsOverrides: any = {}) {
  return shallowMount(PropertyFilterHistogram, {
    props: {
      propertyPath: ["propA", "sub1"],
      ...propsOverrides,
    },
    global: {
      stubs: {
        TagFilterEditor: true,
      },
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
  });

  it("propertyFullName returns null for unknown paths", () => {
    const wrapper = mountComponent({ propertyPath: ["unknown", "path"] });
    const vm = wrapper.vm as any;
    expect(vm.propertyFullName).toBeNull();
  });

  it("defaultMin returns the histogram's lower bound", () => {
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([
      { count: 3, min: 11.7, max: 50 },
      { count: 9, min: 50, max: 100 },
    ]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMin).toBe(11.7);
  });

  it("defaultMax returns the histogram's upper bound", () => {
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([
      { count: 3, min: 11.7, max: 50 },
      { count: 9, min: 50, max: 100 },
    ]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMax).toBe(100);
  });

  it("defaultMin/defaultMax fall back to 0 before the histogram loads", () => {
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMin).toBe(0);
    expect(vm.defaultMax).toBe(0);
  });

  it("derives the range from the histogram, not the bounded propertyValues map", () => {
    // The server histogram is the authoritative full-dataset range; in lazy
    // mode propertyValues holds only the visible subset, so the range must
    // never be derived from it (no wholesale read).
    (propertyStore as any).propertyValues = {
      ann1: { propA: { sub1: 999 } },
    };
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([
      { count: 1, min: 11.7, max: 50 },
      { count: 1, min: 50, max: 100 },
    ]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMin).toBe(11.7);
    expect(vm.defaultMax).toBe(100);
  });

  it("minValue getter returns defaultMin when defaultMinMax is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMinMax).toBe(true);
    expect(vm.minValue).toBe(vm.defaultMin);
  });

  it("maxValue getter returns defaultMax when defaultMinMax is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.maxValue).toBe(vm.defaultMax);
  });

  it("minValue setter rejects values greater than maxValue", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const initialMin = vm.minValue;
    vm.minValue = 999;
    // Should not have called updatePropertyFilter for invalid value
    expect(vm.minValue).toBe(initialMin);
  });

  it("minValue setter rejects values less than defaultMin", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Clear calls from onMounted
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.minValue = -999;
    // Should be rejected (value < defaultMin)
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
  });

  it("minValue setter calls filterStore.updatePropertyFilter for valid values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.minValue = 15;
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
  });

  it("maxValue setter calls filterStore.updatePropertyFilter for valid values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.maxValue = 25;
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
  });

  it("maxValue setter rejects values less than minValue", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.maxValue = -999;
    // Only the onMounted call should have happened, not one for this setter
    // Re-attempt with invalid
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.maxValue = -999;
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
  });

  it("histToPixel returns a scale function", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const scale = vm.histToPixel;
    expect(typeof scale).toBe("function");
    expect(scale.domain()).toEqual([vm.defaultMin, vm.defaultMax]);
  });

  it("toValue returns pixel string for normal value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.toValue(20);
    expect(result).toMatch(/^\d+(\.\d+)?px$/);
  });

  it("toValue returns inverted pixel string for max", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.toValue(20, true);
    expect(result).toMatch(/^\d+(\.\d+)?px$/);
  });

  it("propertyFilter creates a new filter when none exists", () => {
    (filterStore as any).propertyFilters = [];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const filter = vm.propertyFilter;
    expect(filter).toBeTruthy();
    expect(filter.propertyPath).toEqual(["propA", "sub1"]);
    expect(filter.enabled).toBe(true);
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
  });

  it("preserves a restored range when the histogram loads", async () => {
    const histogram = ref<any[]>([]);
    const existingFilter = {
      id: "existing-id",
      propertyPath: ["propA", "sub1"],
      range: { min: 12, max: 24 },
      exclusive: false,
      enabled: true,
      valuesOrRange: "range",
    };
    (filterStore as any).propertyFilters = [existingFilter];
    (filterStore as any).getHistogram = vi.fn(() => histogram.value);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultMinMax).toBe(false);
    expect(vm.minValue).toBe(12);
    expect(vm.maxValue).toBe(24);

    (filterStore.updatePropertyFilter as any).mockClear();
    histogram.value = [{ count: 5, min: 0, max: 100 }];
    await wrapper.vm.$nextTick();

    expect(vm.minValue).toBe(12);
    expect(vm.maxValue).toBe(24);
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
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
  });

  it("area returns empty string when hist is empty", () => {
    (filterStore as any).getHistogram = vi.fn().mockReturnValue([]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.area).toBe("");
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
  });

  it("toggleFilterEnabled calls filterStore.updatePropertyFilter", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.toggleFilterEnabled(false);
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.enabled).toBe(false);
  });

  it("removeFilter calls filterStore.togglePropertyPathFiltering", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.removeFilter();
    expect(filterStore.togglePropertyPathFiltering).toHaveBeenCalledWith([
      "propA",
      "sub1",
    ]);
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
  });

  it("updateValuesFilter clears values when input is emptied (Codex #5)", () => {
    // Emptying the textarea must write values: [] so the previously-applied
    // values filter is actually cleared. The old behavior skipped the update,
    // leaving the stale filter silently active while the UI looked cleared.
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (filterStore.updatePropertyFilter as any).mockClear();
    vm.valuesInput = "";
    vm.updateValuesFilter();
    expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
    const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
    expect(call.values).toEqual([]);
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
  });

  it("onMounted calls filterStore.updateHistograms", () => {
    mountComponent();
    expect(filterStore.updateHistograms).toHaveBeenCalled();
  });

  it("does not mutate the filter when the component unmounts", () => {
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
    wrapper.unmount();
    expect(filterStore.updatePropertyFilter).not.toHaveBeenCalled();
  });

  // Vuetify 3 @change migration: v-checkbox and v-btn-toggle should use @update:model-value
  describe("Vuetify 3 @change migration", () => {
    function mountWithSlotStubs(propsOverrides: any = {}) {
      return shallowMount(PropertyFilterHistogram, {
        props: {
          propertyPath: ["propA", "sub1"],
          ...propsOverrides,
        },
        global: {
          stubs: {
            TagFilterEditor: true,
            VContainer: { template: "<div><slot /></div>" },
            VRow: { template: "<div><slot /></div>" },
            VCol: { template: "<div><slot /></div>" },
            VSpacer: true,
          },
        },
      });
    }

    it("toggleFilterEnabled fires when v-checkbox emits update:modelValue", () => {
      const wrapper = mountWithSlotStubs();
      (filterStore.updatePropertyFilter as any).mockClear();

      const checkboxes = wrapper.findAllComponents({ name: "v-checkbox" });
      expect(checkboxes.length).toBeGreaterThan(0);
      // Emit update:modelValue as Vuetify 3 does on checkbox toggle
      checkboxes[0].vm.$emit("update:modelValue", false);

      // If @update:model-value is wired, toggleFilterEnabled(false) should be called
      expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
      const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
      expect(call.enabled).toBe(false);
    });

    it("updateViewMode fires when v-btn-toggle emits update:modelValue", () => {
      const wrapper = mountWithSlotStubs();
      (filterStore.updatePropertyFilter as any).mockClear();

      const btnToggles = wrapper.findAllComponents({ name: "v-btn-toggle" });
      expect(btnToggles.length).toBeGreaterThan(0);
      // Emit update:modelValue as Vuetify 3 does when selection changes
      btnToggles[0].vm.$emit("update:modelValue", "values");

      // If @update:model-value is wired, updateViewMode("values") should be called
      expect(filterStore.updatePropertyFilter).toHaveBeenCalled();
      const call = (filterStore.updatePropertyFilter as any).mock.calls[0][0];
      expect(call.valuesOrRange).toBe("values");
    });
  });
});
