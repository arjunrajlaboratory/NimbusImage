import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    fetchWorkerImageList: vi.fn(),
    workerImageList: [],
  },
}));

import DockerImage from "./DockerImage.vue";

function mountComponent(props = {}) {
  return mount(DockerImage, {
    props: props,
    global: {
      stubs: {
        DockerImageSelect: true,
      },
    },
  });
}

describe("DockerImage", () => {
  it("image starts as null", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).image).toBeNull();
  });

  it("annotationImageFilter returns true when isAnnotationWorker is defined", () => {
    const wrapper = mountComponent();
    expect(
      (wrapper.vm as any).annotationImageFilter({ isAnnotationWorker: "true" }),
    ).toBe(true);
  });

  it("annotationImageFilter returns false when isAnnotationWorker is undefined", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).annotationImageFilter({} as any)).toBe(false);
  });

  it("updateFromValue syncs image from prop", async () => {
    const wrapper = mountComponent({
      modelValue: { image: "test-image:latest" },
    });
    expect((wrapper.vm as any).image).toBe("test-image:latest");
  });

  it("updateFromValue resets when value is undefined", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).image = "something";
    (wrapper.vm as any).updateFromValue();
    expect((wrapper.vm as any).image).toBeNull();
  });

  it("reset sets image to null and calls changed", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).image = "something";
    (wrapper.vm as any).reset();
    expect((wrapper.vm as any).image).toBeNull();
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
  });

  it("changed emits input and change", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).image = "my-image";
    (wrapper.vm as any).changed();
    const inputEvents = wrapper.emitted("update:modelValue")!;
    expect(inputEvents[inputEvents.length - 1][0]).toEqual({
      image: "my-image",
    });
    expect(wrapper.emitted("change")).toBeTruthy();
  });

  it("watch on image triggers changed", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).image = "new-image";
    await wrapper.vm.$nextTick();
    const inputEvents = wrapper.emitted("update:modelValue");
    expect(inputEvents).toBeTruthy();
    expect(inputEvents![inputEvents!.length - 1][0]).toEqual({
      image: "new-image",
    });
  });
});
