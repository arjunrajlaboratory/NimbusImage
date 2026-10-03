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

  it("uses a semantic expand button with aria-expanded state", async () => {
    const wrapper = mountComponent();
    const genesToggle = wrapper.findAll(".group-toggle")[1];

    expect(genesToggle.element.tagName).toBe("BUTTON");
    expect(genesToggle.attributes("aria-expanded")).toBe("false");
    await genesToggle.trigger("keydown", { key: "Enter" });
    expect(genesToggle.attributes("aria-expanded")).toBe("true");
  });

  it("renders expanded property values with virtual scrolling", async () => {
    const wrapper = mountComponent();
    wrapper.vm.toggleExpanded("genes");
    await wrapper.vm.$nextTick();

    const virtualScroll = wrapper.findComponent({ name: "VVirtualScroll" });
    expect(virtualScroll.exists()).toBe(true);
    expect(virtualScroll.props("items")).toEqual([
      ["genes", "TCF7"],
      ["genes", "SELL"],
    ]);
  });

  it("gives value checkboxes descriptive accessible names", async () => {
    const wrapper = mountComponent();
    wrapper.vm.toggleExpanded("genes");
    await wrapper.vm.$nextTick();

    const labels = wrapper
      .findAll('input[type="checkbox"]')
      .map((checkbox) => checkbox.attributes("aria-label"));
    expect(labels).toEqual(
      expect.arrayContaining(["Hide TCF7 column", "Show SELL column"]),
    );
  });

  it("keeps a stable accessible name and disables Run while computing", () => {
    (propertyStore as any).propertyStatuses.pending.running = true;
    const wrapper = mountComponent();
    const runButtons = wrapper.findAll(".run-property");
    const pendingRun = runButtons[2];

    expect(pendingRun.attributes("aria-label")).toBe(
      "Computing Not Computed Yet",
    );
    expect(pendingRun.attributes("disabled")).toBeDefined();
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
