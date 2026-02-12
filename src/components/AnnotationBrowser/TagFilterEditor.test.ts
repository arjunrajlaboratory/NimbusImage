import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    toolTags: [],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: [],
    annotations: [],
    addTagsToAllAnnotations: vi.fn(),
    removeTagsFromAllAnnotations: vi.fn(),
    colorAnnotationIds: vi.fn(),
  },
}));

import TagFilterEditor from "./TagFilterEditor.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(TagFilterEditor, {
    vuetify: new Vuetify(),
    propsData: {
      value: {
        id: "tagFilter",
        exclusive: false,
        enabled: false,
        tags: ["tag1", "tag2"],
      },
      ...props,
    },
    stubs: {
      "tag-cloud-picker": {
        template: "<div></div>",
        props: ["value", "allSelected"],
      },
    },
  });
}

describe("TagFilterEditor", () => {
  it("tags getter reads filter.tags", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.tags).toEqual(["tag1", "tag2"]);
  });

  it("tags setter emits input with updated tags", () => {
    const wrapper = mountComponent();
    wrapper.vm.tags = ["tag3"];
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    expect(emitted![emitted!.length - 1][0].tags).toEqual(["tag3"]);
  });

  it("allSelected getter inversely maps filter.enabled", () => {
    const wrapper = mountComponent();
    // filter.enabled is false, so allSelected should be true
    expect(wrapper.vm.allSelected).toBe(true);
  });

  it("allSelected setter disables exclusive when all selected", () => {
    const wrapper = mountComponent();
    wrapper.vm.allSelected = true;
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    const last = emitted![emitted!.length - 1][0];
    expect(last.enabled).toBe(false);
    expect(last.exclusive).toBe(false);
  });

  it("exclusive setter enables filter", () => {
    const wrapper = mountComponent();
    wrapper.vm.exclusive = true;
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    const last = emitted![emitted!.length - 1][0];
    expect(last.enabled).toBe(true);
    expect(last.exclusive).toBe(true);
  });

  it("exclusiveItems has Any and Only options", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.exclusiveItems).toEqual([
      { text: "Any", value: false },
      { text: "Only", value: true },
    ]);
  });
});
