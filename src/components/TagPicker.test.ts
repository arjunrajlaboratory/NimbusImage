import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    toolTags: ["tag1"],
    layers: [],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: ["tag2", "tag3"],
  },
}));

import TagPicker from "./TagPicker.vue";

function mountComponent(props = {}) {
  return mount(TagPicker, {
    props: {
      modelValue: ["tag1"],
      ...props,
    },
  });
}

describe("TagPicker", () => {
  it("tagList merges and deduplicates annotationTags and toolTags", () => {
    const wrapper = mountComponent();
    const tagList = wrapper.vm.tagList;
    expect(tagList).toContain("tag1");
    expect(tagList).toContain("tag2");
    expect(tagList).toContain("tag3");
    // No duplicates
    expect(new Set(tagList).size).toBe(tagList.length);
  });

  it("onTagChange does not throw when combobox ref is available", async () => {
    const wrapper = mountComponent();
    // In script setup, template refs are managed internally
    // Just verify onTagChange doesn't throw
    expect(() => wrapper.vm.onTagChange()).not.toThrow();
    await nextTick();
  });
});
