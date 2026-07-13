import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/components/ImageViewer.vue", () => ({
  default: { template: "<div></div>", name: "ImageViewer" },
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test", time: { length: 5 } },
    configuration: { id: "config-1" },
    isLoggedIn: true,
    toolTemplateList: [{ type: "create" }],
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

vi.mock("@/store/toolSuggestions", () => ({
  default: {
    clear: vi.fn(),
    maybeSuggestForCurrentConfiguration: vi.fn(),
  },
}));

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import toolSuggestionsStore from "@/store/toolSuggestions";
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

  it("mounted calls fetchAnnotations and fetchPropertyValues", () => {
    mountComponent();
    expect(annotationStore.fetchAnnotations).toHaveBeenCalled();
    expect(propertiesStore.fetchPropertyValues).toHaveBeenCalled();
  });

  it("mounted calls fetchProperties", () => {
    mountComponent();
    expect(propertiesStore.fetchProperties).toHaveBeenCalled();
  });

  it("configurationChanged clears stale tool suggestions and fetches properties", () => {
    const wrapper = mountComponent();
    vi.clearAllMocks();

    (wrapper.vm as any).configurationChanged();

    expect(toolSuggestionsStore.clear).toHaveBeenCalled();
    expect(propertiesStore.fetchProperties).toHaveBeenCalled();
  });

  it("handleLayersReady asks for tool suggestions and marks layers rendered", () => {
    const wrapper = mountComponent();

    (wrapper.vm as any).handleLayersReady();

    expect(
      toolSuggestionsStore.maybeSuggestForCurrentConfiguration,
    ).toHaveBeenCalled();
    expect((wrapper.vm as any).layersHaveRendered).toBe(true);
  });

  it("configurationChanged resets layersHaveRendered", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).handleLayersReady();
    expect((wrapper.vm as any).layersHaveRendered).toBe(true);

    (wrapper.vm as any).configurationChanged();

    expect((wrapper.vm as any).layersHaveRendered).toBe(false);
  });

  it("retrySuggestWhenReady re-asks once prerequisites arrive after render", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).handleLayersReady(); // image already rendered
    vi.clearAllMocks();

    (wrapper.vm as any).retrySuggestWhenReady(true);

    expect(
      toolSuggestionsStore.maybeSuggestForCurrentConfiguration,
    ).toHaveBeenCalledTimes(1);
  });

  it("retrySuggestWhenReady does nothing before the image has rendered", () => {
    const wrapper = mountComponent();
    // No handleLayersReady yet, so layersHaveRendered is false.

    (wrapper.vm as any).retrySuggestWhenReady(true);

    expect(
      toolSuggestionsStore.maybeSuggestForCurrentConfiguration,
    ).not.toHaveBeenCalled();
  });

  it("retrySuggestWhenReady does nothing while prerequisites are not ready", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).handleLayersReady();
    vi.clearAllMocks();

    (wrapper.vm as any).retrySuggestWhenReady(false);

    expect(
      toolSuggestionsStore.maybeSuggestForCurrentConfiguration,
    ).not.toHaveBeenCalled();
  });

  it("suggestPrerequisitesReady reflects login and template readiness", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).suggestPrerequisitesReady).toBe(true);
  });

  it("handleResetComplete sets shouldResetMaps false", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).shouldResetMaps = true;
    (wrapper.vm as any).handleResetComplete();
    expect((wrapper.vm as any).shouldResetMaps).toBe(false);
  });
});
