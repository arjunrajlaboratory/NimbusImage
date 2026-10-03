import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

const { volumeViewMock, filtersMock } = vi.hoisted(() => ({
  volumeViewMock: { viewMode: "2d" },
  // `state` is replaced with a reactive object per test: a plain property here
  // would let the watcher assertions pass without any reactivity involved.
  filtersMock: {
    state: { signature: "idle" } as { signature: string },
    refreshAnalysis: vi.fn(),
  },
}));

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

vi.mock("@/store/volumeView", () => ({
  default: volumeViewMock,
}));

vi.mock("@/store/filters", () => ({
  default: {
    get analysisInputSignature() {
      return filtersMock.state.signature;
    },
    refreshAnalysis: filtersMock.refreshAnalysis,
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
import volumeViewStore from "@/store/volumeView";

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

// The analysis gate refresh is hosted here rather than in AnnotationViewer
// because ImageViewer — and with it AnnotationViewer — is unmounted entirely in
// 3D mode. Hosted there, a dataset opened directly in 3D never resolved its
// persisted gate, so a saved filter silently did not apply.
describe("Viewer analysis gate refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    volumeViewStore.viewMode = "2d";
    filtersMock.state = reactive({ signature: "idle" });
  });

  it("refreshes on mount, so a gate hydrated before this view resolves", () => {
    shallowMount(Viewer, {});
    expect(filtersMock.refreshAnalysis).toHaveBeenCalledTimes(1);
  });

  it("still refreshes when the dataset opens in 3D volume mode", async () => {
    volumeViewStore.viewMode = "3d";
    const wrapper = shallowMount(Viewer, {});
    expect(wrapper.findComponent({ name: "ImageViewer" }).exists()).toBe(false);
    expect(filtersMock.refreshAnalysis).toHaveBeenCalledTimes(1);

    // ...and keeps refreshing while in 3D, where AnnotationViewer is gone.
    filtersMock.state.signature = "changed";
    await flushPromises();
    expect(filtersMock.refreshAnalysis).toHaveBeenCalledTimes(2);
  });

  // Server-mode (over-cap) signatures debounce: contentRevision bursts during
  // bulk edits, and each refresh is a whole-dataset request
  // (SERVER_GATING.md, Phase 1). Below-cap refreshes stay immediate.
  it("debounces server-mode signature changes into one refresh", async () => {
    vi.useFakeTimers();
    try {
      filtersMock.state = reactive({ signature: "server|ds1|[]|0|0" });
      shallowMount(Viewer, {});
      expect(filtersMock.refreshAnalysis).not.toHaveBeenCalled();
      filtersMock.state.signature = "server|ds1|[]|0|1";
      await flushPromises();
      filtersMock.state.signature = "server|ds1|[]|0|2";
      await flushPromises();
      expect(filtersMock.refreshAnalysis).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(filtersMock.refreshAnalysis).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending server refresh when dropping below the cap", async () => {
    vi.useFakeTimers();
    try {
      filtersMock.state = reactive({ signature: "server|ds1|[]|0|0" });
      shallowMount(Viewer, {});
      // Below-cap signature arrives before the debounce fires: refresh runs
      // immediately, and the stale debounced call must not double-fire.
      filtersMock.state.signature = "idle";
      await flushPromises();
      expect(filtersMock.refreshAnalysis).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(filtersMock.refreshAnalysis).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
