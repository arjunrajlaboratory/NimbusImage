import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

// Reactive, so the component's filterPaths watcher can be driven.
vi.mock("@/store/filters", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      tagFilter: {
        id: "tagFilter",
        exclusive: false,
        enabled: false,
        tags: [],
      },
      onlyCurrentFrame: false,
      filterPaths: [["prop", "area"]],
      propertyFilters: [],
      setTagFilter: vi.fn(),
      setOnlyCurrentFrame: vi.fn(),
    }),
  };
});

vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "datasetview" }),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    showAnnotationsFromHiddenLayers: false,
    setShowAnnotationsFromHiddenLayers: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

import AnnotationFilters from "./AnnotationFilters.vue";
import filterStore from "@/store/filters";
import store from "@/store";

function mountComponent(props = {}) {
  return shallowMount(AnnotationFilters, {
    props: {
      ...props,
    },
  });
}

describe("AnnotationFilters", () => {
  it("tagFilter getter reads from filterStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.tagFilter).toBe(filterStore.tagFilter);
  });

  it("tagFilter setter calls filterStore.setTagFilter", () => {
    const wrapper = mountComponent();
    const newFilter = {
      id: "tagFilter",
      exclusive: true,
      enabled: true,
      tags: ["t"],
    };
    wrapper.vm.tagFilter = newFilter;
    expect(filterStore.setTagFilter).toHaveBeenCalledWith(newFilter);
  });

  it("onlyCurrentFrame getter reads from filterStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.onlyCurrentFrame).toBe(false);
  });

  it("onlyCurrentFrame setter calls filterStore.setOnlyCurrentFrame", () => {
    const wrapper = mountComponent();
    wrapper.vm.onlyCurrentFrame = true;
    expect(filterStore.setOnlyCurrentFrame).toHaveBeenCalledWith(true);
  });

  it("showAnnotationsFromHiddenLayers getter reads from main store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.showAnnotationsFromHiddenLayers).toBe(false);
  });

  it("showAnnotationsFromHiddenLayers setter calls store method", () => {
    const wrapper = mountComponent();
    wrapper.vm.showAnnotationsFromHiddenLayers = true;
    expect(store.setShowAnnotationsFromHiddenLayers).toHaveBeenCalledWith(true);
  });

  it("propertyPaths reads from filterStore.filterPaths", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.propertyPaths).toEqual([["prop", "area"]]);
  });

  it("expands Property values when a filter is added from elsewhere", async () => {
    // The palette's "Add filter: …" or the agent adds a path while the
    // section is collapsed; the new filter must not stay out of sight.
    (filterStore as any).filterPaths = [];
    const wrapper = mountComponent();
    expect(wrapper.vm.propertyValuesOpen).toBe(false);
    (filterStore as any).filterPaths = [["prop", "area"]];
    await nextTick();
    expect(wrapper.vm.propertyValuesOpen).toBe(true);
    // Closing it again stays the user's choice: a removal doesn't reopen.
    wrapper.vm.propertyValuesOpen = false;
    (filterStore as any).filterPaths = [];
    await nextTick();
    expect(wrapper.vm.propertyValuesOpen).toBe(false);
    (filterStore as any).filterPaths = [["prop", "area"]];
  });

  it("keeps 'filter current frame' off the command that turns it off", async () => {
    const { rankCommands } = await import("@/commands/scorer");
    const { enabledCommands } = await import("@/commands/registry");
    const wrapper = mountComponent();
    const found = (query: string) =>
      rankCommands(enabledCommands.value, query).map((command) => command.id);
    (filterStore as any).onlyCurrentFrame = true;
    expect(found("filter current frame")).not.toContain(
      "filters.onlyCurrentFrame",
    );
    expect(found("filter frame")).not.toContain("filters.onlyCurrentFrame");
    (filterStore as any).onlyCurrentFrame = false;
    expect(found("filter current frame")).toContain("filters.onlyCurrentFrame");
    wrapper.unmount();
  });
});
