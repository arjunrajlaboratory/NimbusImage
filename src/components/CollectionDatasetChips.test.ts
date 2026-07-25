import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { routerProvider } from "@/test/helpers";
import CollectionDatasetChips from "./CollectionDatasetChips.vue";

const sampleChips = {
  col1: {
    type: "collection",
    chips: [
      {
        text: "Dataset A",
        color: "dataset",
        to: { name: "dataset", params: { datasetId: "d1" } },
      },
      { text: "Dataset B", color: "dataset" },
    ],
  },
};

function mountComponent(props = {}) {
  const mockRouter = { push: vi.fn() };
  return mount(CollectionDatasetChips, {
    props: {
      collectionId: "col1",
      debouncedChipsPerItemId: sampleChips,
      ...props,
    },
    global: {
      provide: {
        ...routerProvider(mockRouter),
      },
    },
  });
}

describe("CollectionDatasetChips", () => {
  it("renders dataset chips", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Dataset A");
    expect(wrapper.text()).toContain("Dataset B");
  });

  it("navigateToChip calls $router.push when chip has to", () => {
    const mockRouter = { push: vi.fn() };
    const wrapper = mount(CollectionDatasetChips, {
      props: {
        collectionId: "col1",
        debouncedChipsPerItemId: sampleChips,
      },
      global: {
        provide: { ...routerProvider(mockRouter) },
      },
    });
    wrapper.vm.navigateToChip(sampleChips.col1.chips[0]);
    expect(mockRouter.push).toHaveBeenCalledWith(sampleChips.col1.chips[0].to);
  });

  it("navigateToChip does nothing when chip has no to", () => {
    const mockRouter = { push: vi.fn() };
    const wrapper = mount(CollectionDatasetChips, {
      props: {
        collectionId: "col1",
        debouncedChipsPerItemId: sampleChips,
      },
      global: {
        provide: { ...routerProvider(mockRouter) },
      },
    });
    wrapper.vm.navigateToChip(sampleChips.col1.chips[1]);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("shows the loading state while chips have not been resolved", () => {
    const wrapper = mountComponent({ debouncedChipsPerItemId: {} });
    expect(wrapper.text()).toContain("Loading datasets...");
  });

  it("shows 'No datasets' once resolved to an empty chip list", () => {
    const wrapper = mountComponent({
      debouncedChipsPerItemId: { col1: { type: "collection", chips: [] } },
    });
    expect(wrapper.text()).toContain("No datasets");
    expect(wrapper.text()).not.toContain("Loading datasets...");
  });
});
