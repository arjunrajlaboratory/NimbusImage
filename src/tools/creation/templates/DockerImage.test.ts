import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(DockerImage, {
    vuetify: new Vuetify(),
    propsData: props,
    stubs: {
      DockerImageSelect: true,
    },
  });
}

describe("DockerImage", () => {
  it("image starts as null", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.image).toBeNull();
  });

  it("annotationImageFilter returns true when isAnnotationWorker is defined", () => {
    const wrapper = mountComponent();
    expect(
      wrapper.vm.annotationImageFilter({ isAnnotationWorker: "true" }),
    ).toBe(true);
  });

  it("annotationImageFilter returns false when isAnnotationWorker is undefined", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.annotationImageFilter({} as any)).toBe(false);
  });

  it("updateFromValue syncs image from prop", async () => {
    const wrapper = mountComponent({
      value: { image: "test-image:latest" },
    });
    expect(wrapper.vm.image).toBe("test-image:latest");
  });

  it("updateFromValue resets when value is undefined", () => {
    const wrapper = mountComponent();
    wrapper.vm.image = "something";
    wrapper.vm.updateFromValue();
    expect(wrapper.vm.image).toBeNull();
  });

  it("reset sets image to null and calls changed", () => {
    const wrapper = mountComponent();
    wrapper.vm.image = "something";
    wrapper.vm.reset();
    expect(wrapper.vm.image).toBeNull();
    expect(wrapper.emitted("input")).toBeTruthy();
  });

  it("changed emits input and change", () => {
    const wrapper = mountComponent();
    wrapper.vm.image = "my-image";
    wrapper.vm.changed();
    const inputEvents = wrapper.emitted("input")!;
    expect(inputEvents[inputEvents.length - 1][0]).toEqual({
      image: "my-image",
    });
    expect(wrapper.emitted("change")).toBeTruthy();
  });

  it("watch on image triggers changed", async () => {
    const wrapper = mountComponent();
    wrapper.vm.image = "new-image";
    await wrapper.vm.$nextTick();
    const inputEvents = wrapper.emitted("input");
    expect(inputEvents).toBeTruthy();
    expect(inputEvents![inputEvents!.length - 1][0]).toEqual({
      image: "new-image",
    });
  });
});
