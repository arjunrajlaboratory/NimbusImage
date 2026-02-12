import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockGetCommunity = vi.fn();
const mockGetCommunityRecords = vi.fn();

vi.mock("@/store", () => ({
  default: {
    girderRestProxy: {},
  },
}));

vi.mock("@/store/ZenodoAPI", () => ({
  default: vi.fn().mockImplementation(() => ({
    getCommunity: mockGetCommunity,
    getCommunityRecords: mockGetCommunityRecords,
  })),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/utils/strings", () => ({
  getTourStepId: vi.fn().mockReturnValue("test-tourstep"),
  getTourTriggerId: vi.fn().mockReturnValue("test-tourtrigger"),
}));

import ZenodoCommunityDisplay from "./ZenodoCommunityDisplay.vue";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

function mountComponent(props = {}) {
  return shallowMount(ZenodoCommunityDisplay, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
  });
}

describe("ZenodoCommunityDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommunity.mockResolvedValue({
      id: "nimbusimagesampledatasets",
      title: "NimbusImage Sample Datasets",
      description: "Sample datasets",
      created: "2024-01-01",
      updated: "2024-06-01",
      logo_url: "",
      links: { self: "", html: "" },
    });
    mockGetCommunityRecords.mockResolvedValue({
      hits: { hits: [], total: 0 },
      links: { self: "" },
    });
  });

  it("formatSize returns correct human-readable strings", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    expect(vm.formatSize(500)).toBe("500 B");
    expect(vm.formatSize(1024)).toBe("1.00 KB");
    expect(vm.formatSize(1048576)).toBe("1.00 MB");
    expect(vm.formatSize(1073741824)).toBe("1.00 GB");
  });

  it("getTotalSize sums file sizes", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    const files = [
      {
        id: "f1",
        key: "a.tif",
        size: 100,
        checksum: "",
        links: { self: "", download: "" },
      },
      {
        id: "f2",
        key: "b.tif",
        size: 200,
        checksum: "",
        links: { self: "", download: "" },
      },
      {
        id: "f3",
        key: "c.csv",
        size: 50,
        checksum: "",
        links: { self: "", download: "" },
      },
    ];
    expect(vm.getTotalSize(files)).toBe(350);
  });

  it("selectDataset emits dataset-selected", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    const dataset = { id: "rec-1", title: "Test" };
    vm.selectDataset(dataset);
    expect(wrapper.emitted("dataset-selected")).toBeTruthy();
    expect(wrapper.emitted("dataset-selected")![0][0]).toEqual(dataset);
  });

  it("mounted fetches community and records", async () => {
    const wrapper = mountComponent();
    // Wait for the async mounted() to complete
    await Vue.nextTick();
    await Vue.nextTick();
    // Flush all pending promises
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Vue.nextTick();

    expect(mockGetCommunity).toHaveBeenCalledWith("nimbusimagesampledatasets");
    expect(mockGetCommunityRecords).toHaveBeenCalledWith(
      "nimbusimagesampledatasets",
      1,
      10,
    );
  });

  it("formatDate returns formatted date string", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    const result = vm.formatDate("2024-01-15T00:00:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
