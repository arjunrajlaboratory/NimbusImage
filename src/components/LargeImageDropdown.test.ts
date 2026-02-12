import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(LargeImageDropdown, {
    vuetify: new Vuetify(),
  });
}

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

  it("mounted sets previousNumberOfImages", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.previousNumberOfImages).toBe(store.allLargeImages.length);
  });
});
