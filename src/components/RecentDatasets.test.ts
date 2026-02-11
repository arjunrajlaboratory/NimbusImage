import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import RecentDatasets from "./RecentDatasets.vue";

Vue.use(Vuetify);

const sampleItems = [
  {
    datasetView: { id: "dv1", lastViewed: 1700000000000 },
    datasetInfo: { name: "Dataset A", description: "Desc A", creatorId: "u1" },
    configInfo: { name: "Config 1", description: "Conf Desc" },
  },
  {
    datasetView: { id: "dv2", lastViewed: 1700001000000 },
    datasetInfo: { name: "Dataset B", description: "", creatorId: "" },
    configInfo: { name: "Config 2", description: "" },
  },
];

function mountComponent(props = {}) {
  return mount(RecentDatasets, {
    vuetify: new Vuetify(),
    propsData: {
      datasetViewItems: sampleItems,
      getUserDisplayName: vi.fn((id: string) => `User ${id}`),
      formatDateNumber: vi.fn((d: number) => new Date(d).toLocaleString()),
      ...props,
    },
  });
}

describe("RecentDatasets", () => {
  it("renders dataset items", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Dataset A");
    expect(wrapper.text()).toContain("Dataset B");
  });

  it("renders configuration names", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Config 1");
    expect(wrapper.text()).toContain("Config 2");
  });

  it("calls getUserDisplayName for items with creatorId", () => {
    const getUserDisplayName = vi.fn(() => "Test User");
    mountComponent({ getUserDisplayName });
    expect(getUserDisplayName).toHaveBeenCalledWith("u1");
  });

  it("emits dataset-clicked when a dataset is clicked", async () => {
    const wrapper = mountComponent();
    const listItems = wrapper.findAll(".v-list-item");
    await listItems.at(0).trigger("click");
    expect(wrapper.emitted("dataset-clicked")).toBeTruthy();
    expect(wrapper.emitted("dataset-clicked")![0]).toEqual(["dv1"]);
  });
});
