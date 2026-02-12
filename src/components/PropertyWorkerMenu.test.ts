import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {
    getWorkerInterface: vi.fn().mockReturnValue({ some: "interface" }),
  },
}));

import PropertyWorkerMenu from "./PropertyWorkerMenu.vue";
import propertiesStore from "@/store/properties";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return shallowMount(PropertyWorkerMenu, {
    vuetify: new Vuetify(),
    propsData: {
      value: {},
      image: null,
      ...props,
    },
    stubs: {
      WorkerInterfaceValues: true,
    },
  });
}

describe("PropertyWorkerMenu", () => {
  it("workerInterface returns null when image is null", () => {
    const wrapper = mountComponent({ image: null });
    expect(wrapper.vm.workerInterface).toBeNull();
  });

  it("workerInterface returns store value when image is set", () => {
    const wrapper = mountComponent({ image: "my-image:latest" });
    expect(propertiesStore.getWorkerInterface).toHaveBeenCalledWith(
      "my-image:latest",
    );
    expect(wrapper.vm.workerInterface).toEqual({ some: "interface" });
  });

  it("renders progress when workerInterface is undefined", () => {
    (propertiesStore.getWorkerInterface as any).mockReturnValueOnce(undefined);
    const wrapper = mountComponent({ image: "loading-image" });
    expect(wrapper.find("v-progress-circular-stub").exists()).toBe(true);
  });

  it("emits input when interfaceValues changes", () => {
    const wrapper = mountComponent({ image: "img" });
    wrapper.vm.interfaceValues = { key: "value" };
    expect(wrapper.emitted("input")).toBeTruthy();
  });
});
