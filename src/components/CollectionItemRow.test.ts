import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import CollectionItemRow from "./CollectionItemRow.vue";

Vue.use(Vuetify);

const sampleCollection = {
  _id: "col1",
  _modelType: "upenn_collection" as const,
  name: "Test Collection",
  description: "A test collection",
  creatorId: "u1",
  folderId: "f1",
  meta: {},
  created: "2024-01-01T00:00:00Z",
  updated: "2024-06-15T12:00:00Z",
};

const sampleChips = {
  col1: {
    chips: [
      {
        text: "Dataset A",
        color: "blue",
        to: { name: "dataset", params: { id: "d1" } },
      },
      { text: "Dataset B", color: "green" },
    ],
  },
};

function mountComponent(props = {}) {
  const mockRouter = { push: vi.fn() };
  return mount(CollectionItemRow, {
    vuetify: new Vuetify(),
    propsData: {
      collection: sampleCollection,
      debouncedChipsPerItemId: sampleChips,
      computedChipsIds: new Set<string>(),
      ...props,
    },
    mocks: {
      $router: mockRouter,
    },
  });
}

describe("CollectionItemRow", () => {
  it("renders the collection type indicator", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Collection");
  });

  it("renders dataset chips", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Dataset A");
    expect(wrapper.text()).toContain("Dataset B");
  });

  it("navigateToChip calls $router.push when chip has to", async () => {
    const mockRouter = { push: vi.fn() };
    const wrapper = mount(CollectionItemRow, {
      vuetify: new Vuetify(),
      propsData: {
        collection: sampleCollection,
        debouncedChipsPerItemId: sampleChips,
        computedChipsIds: new Set<string>(),
      },
      mocks: { $router: mockRouter },
    });
    wrapper.vm.navigateToChip(sampleChips.col1.chips[0]);
    expect(mockRouter.push).toHaveBeenCalledWith(sampleChips.col1.chips[0].to);
  });

  it("navigateToChip does nothing when chip has no to", () => {
    const mockRouter = { push: vi.fn() };
    const wrapper = mount(CollectionItemRow, {
      vuetify: new Vuetify(),
      propsData: {
        collection: sampleCollection,
        debouncedChipsPerItemId: sampleChips,
        computedChipsIds: new Set<string>(),
      },
      mocks: { $router: mockRouter },
    });
    wrapper.vm.navigateToChip(sampleChips.col1.chips[1]);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("shows loading state when chips are computing", () => {
    const wrapper = mountComponent({
      debouncedChipsPerItemId: {},
      computedChipsIds: new Set(["col1"]),
    });
    expect(wrapper.text()).toContain("Loading datasets...");
  });

  it("shows no datasets state when no chips", () => {
    const wrapper = mountComponent({
      debouncedChipsPerItemId: {},
      computedChipsIds: new Set<string>(),
    });
    expect(wrapper.text()).toContain("No datasets");
  });
});
