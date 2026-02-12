import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(Viewer, {
    vuetify: new Vuetify(),
  });
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

  it("mounted calls fetchAnnotations and fetchPropertyValues", () => {
    mountComponent();
    expect(annotationStore.fetchAnnotations).toHaveBeenCalled();
    expect(propertiesStore.fetchPropertyValues).toHaveBeenCalled();
  });

  it("mounted calls fetchProperties", () => {
    mountComponent();
    expect(propertiesStore.fetchProperties).toHaveBeenCalled();
  });

  it("handleImageChanged sets shouldResetMaps true", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).handleImageChanged();
    expect((wrapper.vm as any).shouldResetMaps).toBe(true);
  });

  it("handleResetComplete sets shouldResetMaps false", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).shouldResetMaps = true;
    (wrapper.vm as any).handleResetComplete();
    expect((wrapper.vm as any).shouldResetMaps).toBe(false);
  });
});
