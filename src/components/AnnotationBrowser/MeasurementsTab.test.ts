import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    setIsAnalyzeDialogOpen: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [],
    computedPropertyPaths: [],
    displayedPropertyPaths: [],
    uncomputedCountByProperty: {},
    propertyStatuses: {},
    computeProperty: vi.fn(),
    togglePropertyPathVisibility: vi.fn(),
    getSubIdsNameFromPath: (path: string[]) =>
      path.length > 1 ? path.slice(1).join(" / ") : `name-of-${path[0]}`,
  },
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

import store from "@/store";
import propertyStore from "@/store/properties";
import MeasurementsTab from "./MeasurementsTab.vue";

function mountComponent(props: { isActive: boolean } = { isActive: true }) {
  return mount(MeasurementsTab, { props });
}

describe("MeasurementsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (propertyStore as any).properties = [
      { id: "area", name: "Area" },
      { id: "genes", name: "Gene Expression" },
      { id: "pending", name: "Not Computed Yet" },
    ];
    (propertyStore as any).computedPropertyPaths = [
      ["area"],
      ["genes", "TCF7"],
      ["genes", "SELL"],
    ];
    (propertyStore as any).displayedPropertyPaths = [["genes", "TCF7"]];
    (propertyStore as any).uncomputedCountByProperty = {
      area: 0,
      genes: 0,
      pending: 42,
    };
    (propertyStore as any).propertyStatuses = {
      area: { running: false },
      genes: { running: false },
      pending: { running: false },
    };
  });

  it("lists every property, including ones with no computed values", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.propertyEntries.map((e: any) => e.property.id)).toEqual([
      "area",
      "genes",
      "pending",
    ]);
    const pending = wrapper.vm.propertyEntries[2];
    expect(pending.paths).toHaveLength(0);
    expect(wrapper.text()).toContain("not computed");
  });

  it("uncomputedProperties reflects the store counts", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedProperties.map((p: any) => p.id)).toEqual([
      "pending",
    ]);
  });

  it("compute delegates to the store", () => {
    const wrapper = mountComponent();
    wrapper.vm.compute({ id: "pending", name: "Not Computed Yet" } as any);
    expect(propertyStore.computeProperty).toHaveBeenCalledTimes(1);
    expect(
      (propertyStore.computeProperty as any).mock.calls[0][0].property.id,
    ).toBe("pending");
  });

  it("compute is a no-op while the property is running", () => {
    (propertyStore as any).propertyStatuses.pending.running = true;
    const wrapper = mountComponent();
    wrapper.vm.compute({ id: "pending", name: "Not Computed Yet" } as any);
    expect(propertyStore.computeProperty).not.toHaveBeenCalled();
  });

  it("computeUncomputedProperties runs each property with uncomputed objects", () => {
    const wrapper = mountComponent();
    wrapper.vm.computeUncomputedProperties();
    expect(propertyStore.computeProperty).toHaveBeenCalledTimes(1);
  });

  it("uncomputedRunning counts running uncomputed properties", () => {
    (propertyStore as any).propertyStatuses.pending.running = true;
    const wrapper = mountComponent();
    expect(wrapper.vm.uncomputedRunning).toBe(1);
  });

  it("togglePath delegates to the store", () => {
    const wrapper = mountComponent();
    wrapper.vm.togglePath(["genes", "SELL"]);
    expect(propertyStore.togglePropertyPathVisibility).toHaveBeenCalledWith([
      "genes",
      "SELL",
    ]);
  });

  it("toggleExpanded expands and collapses a group", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.expanded.has("genes")).toBe(false);
    wrapper.vm.toggleExpanded("genes");
    expect(wrapper.vm.expanded.has("genes")).toBe(true);
    wrapper.vm.toggleExpanded("genes");
    expect(wrapper.vm.expanded.has("genes")).toBe(false);
  });

  it("the New measurement button opens the Measure dialog", async () => {
    const wrapper = mountComponent();
    await wrapper.find("button").trigger("click");
    expect(store.setIsAnalyzeDialogOpen).toHaveBeenCalledWith(true);
  });

  it("shows an empty state when there are no properties", () => {
    (propertyStore as any).properties = [];
    const wrapper = mountComponent();
    expect(wrapper.find(".measurements-empty").exists()).toBe(true);
  });

  it("renders nothing while inactive so a hidden tab does no work", () => {
    const wrapper = mountComponent({ isActive: false });
    expect(wrapper.find(".measurements-tab").exists()).toBe(false);
  });

  it("surfaces compute errors registered on the property status", () => {
    (propertyStore as any).propertyStatuses.pending = {
      running: false,
      errorInfo: {
        errors: [
          { type: "error", error: "boom", title: "Compute failed" },
          { type: "warning", warning: "slow", title: "Heads up" },
        ],
      },
    };
    const wrapper = mountComponent();
    const alerts = wrapper.findAll(".group-alert");
    expect(alerts).toHaveLength(2);
    expect(wrapper.text()).toContain("Compute failed: boom");
    expect(wrapper.text()).toContain("Heads up: slow");
  });
});
