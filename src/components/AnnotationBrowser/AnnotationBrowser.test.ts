import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store/filters", () => ({
  default: {
    addTagToTagFilter: vi.fn(),
  },
}));

import AnnotationBrowser from "./AnnotationBrowser.vue";
import filterStore from "@/store/filters";

function mountComponent() {
  return shallowMount(AnnotationBrowser, {});
}

describe("AnnotationBrowser", () => {
  it("clickedTag calls filterStore.addTagToTagFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.clickedTag("myTag");
    expect(filterStore.addTagToTagFilter).toHaveBeenCalledWith("myTag");
  });
});
