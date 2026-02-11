import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    girderRest: { token: "mock-token" },
  },
}));

import FileItemRow from "./FileItemRow.vue";

Vue.use(Vuetify);

const sampleItem = {
  _id: "item1",
  _modelType: "item" as const,
  name: "Test Item",
  description: "A test item",
  creatorId: "u1",
  folderId: "f1",
  meta: {},
  created: "2024-01-01T00:00:00Z",
  updated: "2024-06-15T12:00:00Z",
};

function mountComponent(props = {}) {
  return shallowMount(FileItemRow, {
    vuetify: new Vuetify(),
    propsData: {
      item: sampleItem,
      debouncedChipsPerItemId: {},
      computedChipsIds: new Set<string>(),
      ...props,
    },
    stubs: {
      ShareDataset: true,
    },
  });
}

describe("FileItemRow", () => {
  it("has shareDialogVisible set to false initially", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.shareDialogVisible).toBe(false);
  });

  it("renders the item info area", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".d-flex.align-center").exists()).toBe(true);
  });

  it("shows first chip when available", () => {
    const wrapper = mountComponent({
      debouncedChipsPerItemId: {
        item1: {
          type: "dataset",
          chips: [{ text: "Dataset", color: "blue" }],
        },
      },
    });
    expect(wrapper.text()).toContain("Dataset");
  });

  it("shows loading chip when computing", () => {
    const wrapper = mountComponent({
      computedChipsIds: new Set(["item1"]),
    });
    expect(wrapper.text()).toContain("Loading info...");
  });
});
