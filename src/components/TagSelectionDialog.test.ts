import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

import TagSelectionDialog from "./TagSelectionDialog.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return mount(TagSelectionDialog, {
    vuetify: new Vuetify(),
    propsData: {
      show: true,
      ...props,
    },
    stubs: {
      TagPicker: true,
    },
    attachTo: app,
  });
}

describe("TagSelectionDialog", () => {
  it("renders dialog title", () => {
    const wrapper = mountComponent();
    expect(document.body.textContent).toContain(
      "Add tags to or remove tags from selected objects",
    );
    wrapper.destroy();
  });

  it("emits update:show when dialog is closed", async () => {
    const wrapper = mountComponent();
    wrapper.vm.showDialog = false;
    await Vue.nextTick();
    expect(wrapper.emitted("update:show")).toBeTruthy();
    expect(wrapper.emitted("update:show")![0]).toEqual([false]);
    wrapper.destroy();
  });

  it("emits submit with payload on submit", async () => {
    const wrapper = mountComponent();
    wrapper.vm.localTags = ["tag1", "tag2"];
    wrapper.vm.localAddOrRemove = "remove";
    wrapper.vm.localReplaceExisting = true;
    wrapper.vm.submit();
    await Vue.nextTick();
    expect(wrapper.emitted("submit")).toBeTruthy();
    expect(wrapper.emitted("submit")![0][0]).toEqual({
      tags: ["tag1", "tag2"],
      addOrRemove: "remove",
      replaceExisting: true,
    });
    wrapper.destroy();
  });

  it("resets state after submit", () => {
    const wrapper = mountComponent();
    wrapper.vm.localTags = ["tag1"];
    wrapper.vm.localAddOrRemove = "remove";
    wrapper.vm.localReplaceExisting = true;
    wrapper.vm.submit();
    expect(wrapper.vm.localTags).toEqual([]);
    expect(wrapper.vm.localAddOrRemove).toBe("add");
    expect(wrapper.vm.localReplaceExisting).toBe(false);
    wrapper.destroy();
  });

  it("clears tags on clearTags", () => {
    const wrapper = mountComponent();
    wrapper.vm.localTags = ["tag1", "tag2"];
    wrapper.vm.clearTags();
    expect(wrapper.vm.localTags).toEqual([]);
    wrapper.destroy();
  });

  it("renders radio options for add/remove", () => {
    const wrapper = mountComponent();
    expect(document.body.textContent).toContain("Add tags to selected objects");
    expect(document.body.textContent).toContain(
      "Remove tags from selected objects",
    );
    wrapper.destroy();
  });
});
