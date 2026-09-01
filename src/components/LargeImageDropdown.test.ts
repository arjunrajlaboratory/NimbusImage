import { describe, it, expect, vi, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    allLargeImages: [
      { _id: "img1", name: "__default__", meta: {} },
      { _id: "img2", name: "output.tiff", meta: { tool: "SAM" } },
    ],
    currentLargeImage: { _id: "img1", name: "__default__" },
    updateCurrentLargeImage: vi.fn(),
    deleteLargeImage: vi.fn(),
  },
}));

vi.mock("@/girder/index", () => ({
  DEFAULT_LARGE_IMAGE_SOURCE: "__default__",
}));

import LargeImageDropdown from "./LargeImageDropdown.vue";
import store from "@/store";
import { logError } from "@/utils/log";

function mountComponent() {
  return shallowMount(LargeImageDropdown, {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LargeImageDropdown", () => {
  it("shouldShow is true when largeImages.length > 1", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.shouldShow).toBe(true);
  });

  it("shouldShow is false when only one image", () => {
    const orig = store.allLargeImages;
    (store as any).allLargeImages = [
      { _id: "img1", name: "__default__", meta: {} },
    ];
    const wrapper = mountComponent();
    expect(wrapper.vm.shouldShow).toBe(false);
    (store as any).allLargeImages = orig;
  });

  it("formatName returns 'Original image' for default source", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.formatName("__default__")).toBe("Original image");
  });

  it("formatName strips file extension", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.formatName("output.tiff")).toBe("output");
  });

  it("currentLargeImage getter returns store image id", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.currentLargeImage).toBe("img1");
  });

  it("currentLargeImage setter calls store.updateCurrentLargeImage", () => {
    const wrapper = mountComponent();
    wrapper.vm.currentLargeImage = "img2";
    expect(store.updateCurrentLargeImage).toHaveBeenCalled();
  });

  it("formatMeta formats metadata pairs", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.formatMeta({ tool: "SAM", size: "large" })).toBe(
      "tool: SAM; size: large",
    );
  });

  it("formatMeta renders nested objects instead of [object Object]", () => {
    const wrapper = mountComponent();
    expect(
      wrapper.vm.formatMeta({
        tool: "Stitch Refinement",
        worker_version: "1.0.0",
        refinement: { method: "cross-correlation", overlap: 0.1 },
      }),
    ).toBe(
      "tool: Stitch Refinement; " +
        "refinement: {method: cross-correlation, overlap: 0.1}; " +
        "worker_version: 1.0.0",
    );
  });

  it("formatMeta renders an object-valued tool key without [object Object]", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.formatMeta({ tool: { name: "SAM", version: 2 } })).toBe(
      "tool: {name: SAM, version: 2}",
    );
  });

  it("formatMeta renders arrays and deep nesting", () => {
    const wrapper = mountComponent();
    expect(
      wrapper.vm.formatMeta({
        channels: [0, 1],
        source: { item: { name: "Well_2" } },
      }),
    ).toBe("channels: [0, 1]; source: {item: {name: Well_2}}");
  });

  it("formatMeta returns an empty string for empty meta, hiding the subtitle", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.formatMeta({})).toBe("");
  });

  it("formattedLargeImages precomputes metaText per image", () => {
    const wrapper = mountComponent();
    const [original, output] = wrapper.vm.formattedLargeImages;
    expect(original.metaText).toBe("");
    expect(output.metaText).toBe("tool: SAM");
  });

  it("copyMetaText copies the full text and shows transient feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const wrapper = mountComponent();
    await wrapper.vm.copyMetaText({ _id: "img2", metaText: "tool: SAM" });
    expect(writeText).toHaveBeenCalledWith("tool: SAM");
    expect(wrapper.vm.copiedImageId).toBe("img2");
    vi.advanceTimersByTime(2000);
    expect(wrapper.vm.copiedImageId).toBe(null);
  });

  it("copyMetaText logs and shows no feedback when the clipboard fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const wrapper = mountComponent();
    await wrapper.vm.copyMetaText({ _id: "img2", metaText: "tool: SAM" });
    expect(logError).toHaveBeenCalled();
    expect(wrapper.vm.copiedImageId).toBe(null);
  });

  it("mounted sets previousNumberOfImages", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.previousNumberOfImages).toBe(store.allLargeImages.length);
  });
});
