import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

vi.mock("@/components/ImageViewer.vue", () => ({
  default: { template: "<div></div>", name: "ImageViewer" },
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test", time: { length: 5 } },
    configuration: { id: "config-1" },
    setShowTimelapseMode: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    fetchAnnotations: vi.fn(),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    fetchPropertyValues: vi.fn(),
    fetchProperties: vi.fn(),
  },
}));

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import Viewer from "./Viewer.vue";

function mountComponent() {
  return shallowMount(Viewer, {});
}

describe("Viewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dataset delegates to store", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).dataset).toEqual(store.dataset);
  });

  it("configuration delegates to store", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).configuration).toEqual(store.configuration);
  });

  it("mounted calls fetchAnnotations and fetchPropertyValues", async () => {
    mountComponent();
    expect(annotationStore.fetchAnnotations).toHaveBeenCalled();
    // fetchPropertyValues runs after fetchAnnotations resolves (it needs
    // stub-only mode determined first), so flush the microtask queue.
    await flushPromises();
    expect(propertiesStore.fetchPropertyValues).toHaveBeenCalled();
  });

  it("mounted calls fetchProperties", () => {
    mountComponent();
    expect(propertiesStore.fetchProperties).toHaveBeenCalled();
  });

  it("handleResetComplete sets shouldResetMaps false", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).shouldResetMaps = true;
    (wrapper.vm as any).handleResetComplete();
    expect((wrapper.vm as any).shouldResetMaps).toBe(false);
  });
});
