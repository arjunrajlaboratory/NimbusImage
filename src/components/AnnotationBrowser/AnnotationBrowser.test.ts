import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store/filters", () => ({
  default: {
    addTagToTagFilter: vi.fn(),
  },
}));

const annotationMock = vi.hoisted(() => ({
  annotationCount: 0,
  annotationConnections: [] as unknown[],
}));

vi.mock("@/store/annotation", () => ({ default: annotationMock }));

import AnnotationBrowser from "./AnnotationBrowser.vue";
import filterStore from "@/store/filters";
import store from "@/store";
import { setUiStateScope } from "@/utils/uiState";

function mountComponent() {
  return shallowMount(AnnotationBrowser, {});
}

describe("AnnotationBrowser", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setUiStateScope(null);
    store.setAnnotationBrowserTab("objects");
  });

  it("remembers the active tab for the next page load", async () => {
    const first = mountComponent();
    first.vm.activeTab = "measurements";
    await nextTick();
    first.unmount();

    // A new page: the store starts on its default tab again.
    store.setAnnotationBrowserTab("objects");
    mountComponent();
    expect(store.annotationBrowserTab).toBe("measurements");
  });

  it("remembers a tab another panel opened, and ignores a stored tab it does not know", async () => {
    const first = mountComponent();
    store.openAnnotationBrowserTab("connections");
    await nextTick();
    first.unmount();
    expect(
      window.localStorage.getItem("nimbus.ui.anonymous.objectBrowser.tab"),
    ).toBe('"connections"');

    window.localStorage.setItem(
      "nimbus.ui.anonymous.objectBrowser.tab",
      '"renamedTab"',
    );
    store.setAnnotationBrowserTab("objects");
    mountComponent();
    expect(store.annotationBrowserTab).toBe("objects");
  });

  it("switches to the tab of a user who logs in", async () => {
    setUiStateScope("user-1");
    window.localStorage.setItem(
      "nimbus.ui.user-1.objectBrowser.tab",
      '"connections"',
    );
    setUiStateScope(null);
    mountComponent();
    expect(store.annotationBrowserTab).toBe("objects");
    setUiStateScope("user-1");
    await nextTick();
    expect(store.annotationBrowserTab).toBe("connections");
  });

  // Both badges are dataset-wide totals. annotationCount must come from the
  // store getter, never annotationsForIteration.length, which materializes an
  // array from the 700K-entry stub map just to read a length.
  it("badges both tabs with dataset-wide totals", () => {
    annotationMock.annotationCount = 52282;
    annotationMock.annotationConnections = new Array(54);
    const wrapper = mountComponent();
    expect(wrapper.vm.objectCount).toBe(52282);
    expect(wrapper.vm.connectionCount).toBe(54);
  });

  it("hides a badge when the dataset has none", () => {
    annotationMock.annotationCount = 0;
    annotationMock.annotationConnections = [];
    const wrapper = mountComponent();
    expect(wrapper.vm.objectCount).toBe(0);
    expect(wrapper.vm.connectionCount).toBe(0);
  });

  it("clickedTag calls filterStore.addTagToTagFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.clickedTag("myTag");
    expect(filterStore.addTagToTagFilter).toHaveBeenCalledWith("myTag");
  });
});
