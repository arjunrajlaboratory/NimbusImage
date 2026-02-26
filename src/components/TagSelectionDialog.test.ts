import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    toolTags: [],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: [],
  },
}));

import TagSelectionDialog from "./TagSelectionDialog.vue";

function mountComponent(props = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return mount(TagSelectionDialog, {
    props: {
      show: true,
      ...props,
    },
    global: {
      stubs: {
        TagPicker: true,
      },
    },
    attachTo: app,
  });
}

describe("TagSelectionDialog", () => {
  it("renders dialog title", () => {
    mountComponent();
    expect(document.body.textContent).toContain(
      "Add tags to or remove tags from selected objects",
    );
  });

  it("emits update:show when dialog is closed", async () => {
    const wrapper = mountComponent();
    wrapper.vm.showDialog = false;
    await nextTick();
    expect(wrapper.emitted("update:show")).toBeTruthy();
    expect(wrapper.emitted("update:show")![0]).toEqual([false]);
  });

  it("emits submit with payload on submit", async () => {
    const wrapper = mountComponent();
    wrapper.vm.localTags = ["tag1", "tag2"];
    wrapper.vm.localAddOrRemove = "remove";
    wrapper.vm.localReplaceExisting = true;
    wrapper.vm.submit();
    await nextTick();
    expect(wrapper.emitted("submit")).toBeTruthy();
    expect(wrapper.emitted("submit")![0][0]).toEqual({
      tags: ["tag1", "tag2"],
      addOrRemove: "remove",
      replaceExisting: true,
    });
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
  });

  it("clears tags on clearTags", () => {
    const wrapper = mountComponent();
    wrapper.vm.localTags = ["tag1", "tag2"];
    wrapper.vm.clearTags();
    expect(wrapper.vm.localTags).toEqual([]);
  });

  it("renders radio options for add/remove", () => {
    mountComponent();
    expect(document.body.textContent).toContain("Add tags to selected objects");
    expect(document.body.textContent).toContain(
      "Remove tags from selected objects",
    );
  });
});
