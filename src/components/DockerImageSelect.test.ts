import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    workerImageList: {
      "image1:latest": {
        interfaceName: "Algorithm A",
        interfaceCategory: "Segmentation",
        description: "Segment things",
      },
      "image2:latest": {
        interfaceName: "Algorithm B",
        interfaceCategory: "Segmentation",
        description: undefined,
      },
      "image3:latest": {
        interfaceName: "Algorithm C",
        interfaceCategory: "Detection",
        description: "Detect things",
      },
    },
    fetchWorkerImageList: vi.fn(),
  },
}));

import DockerImageSelect from "./DockerImageSelect.vue";
import propertiesStore from "@/store/properties";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return shallowMount(DockerImageSelect, {
    vuetify: new Vuetify(),
    propsData: {
      value: "",
      imageFilter: () => true,
      ...props,
    },
  });
}

describe("DockerImageSelect", () => {
  it("images reads from propertiesStore.workerImageList", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.images).toBe(propertiesStore.workerImageList);
  });

  it("items groups images by category with dividers and headers", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.items;
    const headers = items.filter((i: any) => i.header);
    expect(headers.length).toBe(2);
    const headerNames = headers.map((h: any) => h.header);
    expect(headerNames).toContain("Segmentation");
    expect(headerNames).toContain("Detection");
  });

  it("items respects imageFilter", () => {
    const wrapper = mountComponent({
      imageFilter: (labels: any) => labels.interfaceCategory === "Detection",
    });
    const items = wrapper.vm.items;
    const headers = items.filter((i: any) => i.header);
    expect(headers.length).toBe(1);
    expect(headers[0].header).toBe("Detection");
  });

  it("mounted calls fetchWorkerImageList", () => {
    mountComponent();
    expect(propertiesStore.fetchWorkerImageList).toHaveBeenCalled();
  });
});
