import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "datasetview" }),
}));

const mockStore = vi.hoisted(() => ({ value: null as any }));
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  mockStore.value = reactive({
    dataset: { id: "ds1" },
    annotationSelectionType: "ADD",
    setAnnotationSelectionType: vi.fn(),
    drawAnnotations: true,
    setDrawAnnotations: vi.fn(),
    showTooltips: false,
    setShowTooltips: vi.fn(),
    filteredAnnotationTooltips: false,
    setFilteredAnnotationTooltips: vi.fn(),
    filteredDraw: false,
    setFilteredDraw: vi.fn(),
    drawAnnotationConnections: true,
    setDrawAnnotationConnections: vi.fn(),
  });
  return { default: mockStore.value };
});

import AnnotationToggles from "./AnnotationToggles.vue";
import { enabledCommands } from "@/commands/registry";
import store from "@/store";

function mountComponent() {
  return shallowMount(AnnotationToggles, {});
}

describe("AnnotationToggles", () => {
  it("annotationSelectionType getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.annotationSelectionType).toBe("ADD");
  });

  it("annotationSelectionType setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.annotationSelectionType = "TOGGLE" as any;
    expect(store.setAnnotationSelectionType).toHaveBeenCalledWith("TOGGLE");
  });

  it("drawAnnotations getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.drawAnnotations).toBe(true);
  });

  it("drawAnnotations setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.drawAnnotations = false;
    expect(store.setDrawAnnotations).toHaveBeenCalledWith(false);
  });

  it("showTooltips getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.showTooltips).toBe(false);
  });

  it("showTooltips setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.showTooltips = true;
    expect(store.setShowTooltips).toHaveBeenCalledWith(true);
  });

  it("filteredAnnotationTooltips getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredAnnotationTooltips).toBe(false);
  });

  it("filteredAnnotationTooltips setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.filteredAnnotationTooltips = true;
    expect(store.setFilteredAnnotationTooltips).toHaveBeenCalledWith(true);
  });

  it("filteredDraw getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredDraw).toBe(false);
  });

  it("filteredDraw setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.filteredDraw = true;
    expect(store.setFilteredDraw).toHaveBeenCalledWith(true);
  });

  it("drawConnections getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.drawConnections).toBe(true);
  });

  it("drawConnections setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.drawConnections = false;
    expect(store.setDrawAnnotationConnections).toHaveBeenCalledWith(false);
  });

  it("annotationsSelectionTypeItems has 3 items", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.annotationsSelectionTypeItems).toHaveLength(3);
  });

  it("registers the filtered-tooltips switch, gated like the switch", () => {
    const wrapper = mountComponent();
    const ids = () => enabledCommands.value.map((command) => command.id);
    // Tooltips are off: the switch is disabled, so is the command.
    mockStore.value.showTooltips = false;
    expect(ids()).not.toContain("objects.toggleFilteredTooltips");
    mockStore.value.showTooltips = true;
    expect(ids()).toContain("objects.toggleFilteredTooltips");
    mockStore.value.drawAnnotations = false;
    expect(ids()).not.toContain("objects.toggleFilteredTooltips");
    mockStore.value.drawAnnotations = true;
    mockStore.value.showTooltips = false;
    // Selection modes: the two that aren't current.
    expect(ids()).toEqual(
      expect.arrayContaining([
        "objects.selectionMode.TOGGLE",
        "objects.selectionMode.REMOVE",
      ]),
    );
    expect(ids()).not.toContain("objects.selectionMode.ADD");
    wrapper.unmount();
  });

  it("keeps 'filter' queries off the commands that turn filtering off", async () => {
    const { rankCommands } = await import("@/commands/scorer");
    const wrapper = mountComponent();
    const found = (query: string) =>
      rankCommands(enabledCommands.value, query).map((command) => command.id);
    mockStore.value.filteredDraw = true;
    mockStore.value.showTooltips = true;
    mockStore.value.filteredAnnotationTooltips = true;
    expect(found("filter objects")).not.toContain("objects.toggleFilteredDraw");
    expect(found("filter tooltips")).not.toContain(
      "objects.toggleFilteredTooltips",
    );
    // While off, the same queries find the commands that turn it on.
    mockStore.value.filteredDraw = false;
    mockStore.value.filteredAnnotationTooltips = false;
    expect(found("filter objects")).toContain("objects.toggleFilteredDraw");
    expect(found("filter tooltips")).toContain(
      "objects.toggleFilteredTooltips",
    );
    mockStore.value.showTooltips = false;
    wrapper.unmount();
  });
});
