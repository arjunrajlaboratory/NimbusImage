import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    toolTags: ["t1", "t2"],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: ["t2", "t3"],
    annotations: [
      { id: "a1", tags: ["t1", "t2"] },
      { id: "a2", tags: ["t2"] },
      { id: "a3", tags: ["t3"] },
    ],
    addTagsToAllAnnotations: vi.fn(),
    removeTagsFromAllAnnotations: vi.fn(),
    colorAnnotationIds: vi.fn(),
  },
}));

import TagCloudPicker from "./TagCloudPicker.vue";
import annotationStore from "@/store/annotation";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(TagCloudPicker, {
    vuetify: new Vuetify(),
    propsData: {
      value: ["t1"],
      allSelected: false,
      ...props,
    },
    stubs: {
      "select-all-none-chips": {
        template: '<div class="stub-chips"><slot></slot></div>',
      },
      "color-picker-menu": { template: "<div></div>" },
    },
  });
}

describe("TagCloudPicker", () => {
  it("availableTags deduplicates annotationTags and toolTags", () => {
    const wrapper = mountComponent();
    const tags = wrapper.vm.availableTags;
    expect(tags).toContain("t1");
    expect(tags).toContain("t2");
    expect(tags).toContain("t3");
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("displayedTags filters by tagSearchFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.tagSearchFilter = "t1";
    expect(wrapper.vm.displayedTags).toEqual(["t1"]);
  });

  it("displayedTags returns all when tagSearchFilter is empty", () => {
    const wrapper = mountComponent();
    wrapper.vm.tagSearchFilter = "";
    expect(wrapper.vm.displayedTags).toEqual(wrapper.vm.availableTags);
  });

  it("selectAll sets allSelectedInternal to true", () => {
    const wrapper = mountComponent();
    wrapper.vm.selectAll();
    expect(wrapper.vm.allSelectedInternal).toBe(true);
  });

  it("selectNone empties tags", () => {
    const wrapper = mountComponent({ value: ["t1", "t2"] });
    wrapper.vm.selectNone();
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    const lastEmit = emitted![emitted!.length - 1][0];
    expect(lastEmit).toEqual([]);
  });

  it("setTagsFromUserInput sets allSelectedInternal to false", () => {
    const wrapper = mountComponent();
    wrapper.vm.allSelectedInternal = true;
    wrapper.vm.setTagsFromUserInput(["t1"]);
    expect(wrapper.vm.allSelectedInternal).toBe(false);
  });

  it("emits update:allSelected when allSelectedInternal changes", async () => {
    const wrapper = mountComponent();
    wrapper.vm.allSelectedInternal = true;
    await Vue.nextTick();
    const emitted = wrapper.emitted("update:allSelected");
    expect(emitted).toBeTruthy();
    expect(emitted![emitted!.length - 1][0]).toBe(true);
  });

  it("syncs allSelectedInternal from allSelected prop", async () => {
    const wrapper = mountComponent({ allSelected: true });
    expect(wrapper.vm.allSelectedInternal).toBe(true);
  });

  it("handleTagAddToAll delegates to annotationStore", async () => {
    const wrapper = mountComponent();
    await wrapper.vm.handleTagAddToAll("t1");
    expect(annotationStore.addTagsToAllAnnotations).toHaveBeenCalledWith([
      "t1",
    ]);
  });

  it("handleTagRemoveFromAll delegates to annotationStore", async () => {
    const wrapper = mountComponent();
    await wrapper.vm.handleTagRemoveFromAll("t1");
    expect(annotationStore.removeTagsFromAllAnnotations).toHaveBeenCalledWith([
      "t1",
    ]);
  });

  it("applyColorToTag filters annotations and calls colorAnnotationIds", async () => {
    const wrapper = mountComponent();
    wrapper.vm.tagColor = "#FF0000";
    wrapper.vm.colorOption = "defined";
    await wrapper.vm.applyColorToTag("t2");
    expect(annotationStore.colorAnnotationIds).toHaveBeenCalledWith({
      annotationIds: ["a1", "a2"],
      color: "#FF0000",
      randomize: false,
    });
  });

  it("applyColorToTag with layer option passes null color", async () => {
    const wrapper = mountComponent();
    wrapper.vm.colorOption = "layer";
    await wrapper.vm.applyColorToTag("t1");
    expect(annotationStore.colorAnnotationIds).toHaveBeenCalledWith({
      annotationIds: ["a1"],
      color: null,
      randomize: false,
    });
  });

  it("applyColorToTag with random option sets randomize true", async () => {
    const wrapper = mountComponent();
    wrapper.vm.colorOption = "random";
    await wrapper.vm.applyColorToTag("t1");
    expect(annotationStore.colorAnnotationIds).toHaveBeenCalledWith({
      annotationIds: ["a1"],
      color: expect.anything(),
      randomize: true,
    });
  });
});
