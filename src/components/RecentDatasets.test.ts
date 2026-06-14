import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RecentDatasets from "./RecentDatasets.vue";
import type { IRecentDatasetViewItem } from "@/store/model";

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
] as unknown as IRecentDatasetViewItem[];

function mountComponent(props = {}) {
  return mount(RecentDatasets, {
    props: {
      datasetViewItems: sampleItems,
      getUserDisplayName: vi.fn((id: string) => `User ${id} (u-${id}@x)`),
      getUserShortName: vi.fn((id: string) => `User ${id}`),
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

  it("calls getUserShortName for items with creatorId", () => {
    const getUserShortName = vi.fn(() => "Test User");
    mountComponent({ getUserShortName });
    expect(getUserShortName).toHaveBeenCalledWith("u1");
  });

  it("emits dataset-clicked when a dataset is clicked", async () => {
    const wrapper = mountComponent();
    const listItems = wrapper.findAll(".recent-item");
    await listItems.at(0)!.trigger("click");
    expect(wrapper.emitted("dataset-clicked")).toBeTruthy();
    expect(wrapper.emitted("dataset-clicked")![0]).toEqual(["dv1"]);
  });
});
