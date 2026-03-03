import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

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

function mountComponent(props = {}) {
  return shallowMount(PropertyWorkerMenu, {
    props: {
      modelValue: {},
      image: null,
      ...props,
    },
    global: {
      stubs: {
        WorkerInterfaceValues: true,
        VContainer: { template: "<div><slot /></div>" },
        VRow: { template: "<div><slot /></div>" },
        VCol: { template: "<div><slot /></div>" },
      },
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
    // Access the computed to ensure it's evaluated
    const result = wrapper.vm.workerInterface;
    expect(propertiesStore.getWorkerInterface).toHaveBeenCalledWith(
      "my-image:latest",
    );
    expect(result).toEqual({ some: "interface" });
  });

  it("renders progress when workerInterface is undefined", () => {
    (propertiesStore.getWorkerInterface as any).mockReturnValueOnce(undefined);
    const wrapper = mountComponent({ image: "loading-image" });
    expect(wrapper.find("v-progress-circular-stub").exists()).toBe(true);
  });

  it("emits update:modelValue when interfaceValues setter is called", () => {
    const wrapper = mountComponent({ image: "img" });
    // Directly invoke the computed setter via the exposed property
    (wrapper.vm as any).interfaceValues = { key: "value" };
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
  });
});
