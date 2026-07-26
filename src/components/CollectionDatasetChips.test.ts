import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "fs";
import { resolve } from "path";
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
      chipsPerCollectionId: sampleChips,
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
        chipsPerCollectionId: sampleChips,
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
        chipsPerCollectionId: sampleChips,
      },
      global: {
        provide: { ...routerProvider(mockRouter) },
      },
    });
    wrapper.vm.navigateToChip(sampleChips.col1.chips[1]);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("shows the loading state while chips have not been resolved", () => {
    const wrapper = mountComponent({ chipsPerCollectionId: {} });
    expect(wrapper.text()).toContain("Loading datasets...");
  });

  it("shows 'No datasets' once resolved to an empty chip list", () => {
    const wrapper = mountComponent({
      chipsPerCollectionId: { col1: { type: "collection", chips: [] } },
    });
    expect(wrapper.text()).toContain("No datasets");
    expect(wrapper.text()).not.toContain("Loading datasets...");
  });

  // AnnotationBrowser/AnnotationList.vue ships an UNLAYERED, non-scoped
  // `td span { text-align: center; margin: auto; }`. Vuetify 4 puts its utility
  // classes in a cascade layer, and unlayered rules beat every layered one
  // regardless of specificity — so that rule defeats `ma-1` and centers these
  // chips in their cell, under a left-aligned column header. The component must
  // restore its own horizontal spacing. Asserted against the source because
  // jsdom does not apply SFC styles, so nothing at runtime sees the cascade.
  it("restores chip spacing against the global unlayered td-span rule", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/CollectionDatasetChips.vue"),
      "utf8",
    );
    const style = source.slice(source.indexOf("<style"));
    expect(style).toMatch(/\.colored-chip\s*\{[^}]*margin:\s*4px/);
    expect(style).toMatch(/\.no-datasets\s*\{[^}]*text-align:\s*left/);
  });
});
