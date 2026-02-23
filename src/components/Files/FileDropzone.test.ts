import { describe, it, expect } from "vitest";
import { shallowMount } from "@vue/test-utils";
import FileDropzone from "./FileDropzone.vue";

function mountComponent(props = {}) {
  return shallowMount(FileDropzone, {
    props: {
      modelValue: [],
      ...props,
    },
  });
}

describe("FileDropzone", () => {
  it("renders with default props", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".dropzone-wrapper").exists()).toBe(true);
  });

  it("respects multiple prop", () => {
    const wrapper = mountComponent({ multiple: false });
    expect(wrapper.vm.multiple).toBe(false);
  });

  it("emits input with files on onChange", () => {
    const wrapper = mountComponent();
    const file = new File(["content"], "test.txt");
    const input = wrapper.find('input[type="file"]');
    // Simulate change event
    Object.defineProperty(input.element, "files", {
      value: [file],
    });
    input.trigger("change");
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0][0]).toEqual([file]);
  });

  it("initializes dropzoneClass as null", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.dropzoneClass).toBeNull();
  });
});
