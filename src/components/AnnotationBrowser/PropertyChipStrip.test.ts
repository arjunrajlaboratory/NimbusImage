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
    // Mirrors the real mutation: replaces the array rather than mutating in
    // place, so computeds depending on it invalidate like in production.
    togglePropertyPathVisibility: vi.fn(),
    setPropertyPathsVisibility: vi.fn(),
    getSubIdsNameFromPath: (path: string[]) =>
      path.length > 1 ? path.slice(1).join(" / ") : `name-of-${path[0]}`,
  },
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

import store from "@/store";
import propertyStore from "@/store/properties";
import PropertyChipStrip from "./PropertyChipStrip.vue";

function applyToggle(path: string[]) {
  const displayed = (propertyStore as any).displayedPropertyPaths;
  const idx = displayed.findIndex(
    (p: string[]) => JSON.stringify(p) === JSON.stringify(path),
  );
  (propertyStore as any).displayedPropertyPaths =
    idx < 0
      ? [...displayed, path]
      : displayed.filter((_: string[], i: number) => i !== idx);
}

function applyBatch({
  paths,
  visible,
}: {
  paths: string[][];
  visible: boolean;
}) {
  const requested = new Set(paths.map((path) => JSON.stringify(path)));
  const displayed = (propertyStore as any).displayedPropertyPaths;
  if (visible) {
    const existing = new Set(
      displayed.map((path: string[]) => JSON.stringify(path)),
    );
    (propertyStore as any).displayedPropertyPaths = [
      ...displayed,
      ...paths.filter((path) => !existing.has(JSON.stringify(path))),
    ];
  } else {
    (propertyStore as any).displayedPropertyPaths = displayed.filter(
      (path: string[]) => !requested.has(JSON.stringify(path)),
    );
  }
}

function mountComponent() {
  return mount(PropertyChipStrip, {
    global: {
      stubs: {
        // Menus teleport; keep the DOM simple for these unit tests.
        VMenu: {
          template: '<div><slot name="activator" :props="{}" /><slot /></div>',
        },
      },
    },
  });
}

describe("PropertyChipStrip", () => {
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
      ["genes", "PECAM1"],
    ];
    (propertyStore as any).displayedPropertyPaths = [["genes", "TCF7"]];
    (propertyStore.togglePropertyPathVisibility as any).mockImplementation(
      applyToggle,
    );
    (propertyStore.setPropertyPathsVisibility as any).mockImplementation(
      applyBatch,
    );
  });

  it("lists only properties that have computed values", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.propertyEntries.map((e: any) => e.property.id)).toEqual([
      "area",
      "genes",
    ]);
  });

  it("counts shown values per property", () => {
    const wrapper = mountComponent();
    const genes = wrapper.vm.propertyEntries.find(
      (e: any) => e.property.id === "genes",
    )!;
    expect(genes.shownCount).toBe(1);
    expect(genes.paths).toHaveLength(3);
  });

  it("filter matches property names", async () => {
    const wrapper = mountComponent();
    wrapper.vm.filterText = "area";
    await wrapper.vm.$nextTick();
    expect(wrapper.vm.filteredEntries.map((e: any) => e.property.id)).toEqual([
      "area",
    ]);
  });

  it("filter matches value names so a gene finds its property", async () => {
    const wrapper = mountComponent();
    wrapper.vm.filterText = "pecam";
    await wrapper.vm.$nextTick();
    expect(wrapper.vm.filteredEntries.map((e: any) => e.property.id)).toEqual([
      "genes",
    ]);
  });

  it("menuPaths narrows to matching values when the property name does not match", async () => {
    const wrapper = mountComponent();
    wrapper.vm.filterText = "pecam";
    await wrapper.vm.$nextTick();
    const genes = wrapper.vm.filteredEntries[0];
    expect(wrapper.vm.menuPaths(genes)).toEqual([["genes", "PECAM1"]]);
  });

  it("menuPaths keeps every value when the property name matches", async () => {
    const wrapper = mountComponent();
    wrapper.vm.filterText = "gene";
    await wrapper.vm.$nextTick();
    const genes = wrapper.vm.filteredEntries[0];
    expect(wrapper.vm.menuPaths(genes)).toHaveLength(3);
  });

  it("togglePath delegates to the store", () => {
    const wrapper = mountComponent();
    wrapper.vm.togglePath(["genes", "SELL"]);
    expect(propertyStore.togglePropertyPathVisibility).toHaveBeenCalledWith([
      "genes",
      "SELL",
    ]);
  });

  it("showAll performs one batched visibility update", () => {
    const wrapper = mountComponent();
    const genes = wrapper.vm.propertyEntries.find(
      (e: any) => e.property.id === "genes",
    )!;
    wrapper.vm.showAll(genes);
    expect(propertyStore.setPropertyPathsVisibility).toHaveBeenCalledTimes(1);
    expect(propertyStore.setPropertyPathsVisibility).toHaveBeenCalledWith({
      paths: genes.paths,
      visible: true,
    });
    expect(propertyStore.togglePropertyPathVisibility).not.toHaveBeenCalled();
    expect(
      (propertyStore as any).displayedPropertyPaths.map((p: string[]) => p[1]),
    ).toEqual(["TCF7", "SELL", "PECAM1"]);
  });

  it("hideAll performs one batched visibility update", () => {
    const wrapper = mountComponent();
    const genes = wrapper.vm.propertyEntries.find(
      (e: any) => e.property.id === "genes",
    )!;
    wrapper.vm.hideAll(genes);
    expect(propertyStore.setPropertyPathsVisibility).toHaveBeenCalledTimes(1);
    expect(propertyStore.setPropertyPathsVisibility).toHaveBeenCalledWith({
      paths: genes.paths,
      visible: false,
    });
    expect(propertyStore.togglePropertyPathVisibility).not.toHaveBeenCalled();
    expect((propertyStore as any).displayedPropertyPaths).toEqual([]);
  });

  it("renders multi-value menus with virtual scrolling", () => {
    const wrapper = mountComponent();
    expect(wrapper.findComponent({ name: "VVirtualScroll" }).exists()).toBe(
      true,
    );
  });

  it("gives every value checkbox a descriptive accessible name", () => {
    const wrapper = mountComponent();
    const labels = wrapper
      .findAll('input[type="checkbox"]')
      .map((checkbox) => checkbox.attributes("aria-label"));

    expect(labels).toEqual(
      expect.arrayContaining([
        "Hide TCF7 column",
        "Show SELL column",
        "Show PECAM1 column",
      ]),
    );
  });

  it("the new-measurement chip opens the Measure dialog", async () => {
    const wrapper = mountComponent();
    await wrapper.find(".chip-new").trigger("click");
    expect(store.setIsAnalyzeDialogOpen).toHaveBeenCalledWith(true);
  });

  it("shows an empty state when the filter matches nothing", async () => {
    const wrapper = mountComponent();
    wrapper.vm.filterText = "does-not-exist";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".strip-empty").text()).toContain("does-not-exist");
  });
});
