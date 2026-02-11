import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import AnnotationActionPanel from "./AnnotationActionPanel.vue";

vi.mock("@/store/annotation", () => ({
  default: {
    selectedAnnotationIds: ["id1", "id2", "id3"],
  },
}));

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(AnnotationActionPanel, {
    vuetify: new Vuetify(),
    propsData: {
      selectedCount: 3,
      ...props,
    },
  });
}

describe("AnnotationActionPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders selected count text", () => {
    const wrapper = mountComponent({ selectedCount: 5 });
    expect(wrapper.text()).toContain("5 objects selected");
  });

  it("emits delete-selected on button click", async () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    await buttons.at(0).trigger("click");
    expect(wrapper.emitted("delete-selected")).toBeTruthy();
  });

  it("emits delete-unselected on button click", async () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    await buttons.at(1).trigger("click");
    expect(wrapper.emitted("delete-unselected")).toBeTruthy();
  });

  it("emits tag-selected on button click", async () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    await buttons.at(2).trigger("click");
    expect(wrapper.emitted("tag-selected")).toBeTruthy();
  });

  it("emits color-selected on button click", async () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    await buttons.at(3).trigger("click");
    expect(wrapper.emitted("color-selected")).toBeTruthy();
  });

  it("copies annotation IDs to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    await buttons.at(4).trigger("click");
    expect(writeText).toHaveBeenCalledWith("id1\nid2\nid3");
  });

  it("emits deselect-all on button click", async () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    await buttons.at(5).trigger("click");
    expect(wrapper.emitted("deselect-all")).toBeTruthy();
  });
});
