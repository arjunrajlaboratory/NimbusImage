import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

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

function mountComponent(props = {}) {
  return shallowMount(DockerImageSelect, {
    props: {
      modelValue: "",
      imageFilter: () => true,
      ...props,
    },
  });
}

describe("DockerImageSelect", () => {
  it("images reads from propertiesStore.workerImageList", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).images).toBe(propertiesStore.workerImageList);
  });

  it("items groups images by category with dividers and subheaders", () => {
    const wrapper = mountComponent();
    const items = (wrapper.vm as any).items;
    const subheaders = items.filter((i: any) => i.type === "subheader");
    expect(subheaders.length).toBe(2);
    const headerNames = subheaders.map((h: any) => h.title);
    expect(headerNames).toContain("Segmentation");
    expect(headerNames).toContain("Detection");
  });

  it("items respects imageFilter", () => {
    const wrapper = mountComponent({
      imageFilter: (labels: any) => labels.interfaceCategory === "Detection",
    });
    const items = (wrapper.vm as any).items;
    const subheaders = items.filter((i: any) => i.type === "subheader");
    expect(subheaders.length).toBe(1);
    expect(subheaders[0].title).toBe("Detection");
  });

  it("mounted calls fetchWorkerImageList", () => {
    mountComponent();
    expect(propertiesStore.fetchWorkerImageList).toHaveBeenCalled();
  });
});
