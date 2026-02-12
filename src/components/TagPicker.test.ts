import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(TagPicker, {
    vuetify: new Vuetify(),
    propsData: {
      value: ["tag1"],
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
    await Vue.nextTick();
  });
});
