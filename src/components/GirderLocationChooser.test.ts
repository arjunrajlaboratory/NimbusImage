import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

import GirderLocationChooser from "./GirderLocationChooser.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return shallowMount(GirderLocationChooser, {
    vuetify: new Vuetify(),
    propsData: {
      value: null,
      ...props,
    },
    stubs: {
      CustomFileManager: true,
      GirderBreadcrumb: true,
    },
  });
}

describe("GirderLocationChooser", () => {
  it("dialogInternal uses dialog prop when provided", () => {
    const wrapper = mountComponent({ dialog: true });
    expect(wrapper.vm.dialogInternal).toBe(true);
  });

  it("dialogInternal falls back to dialogInternalCache when dialog prop is null", () => {
    const wrapper = mountComponent({ dialog: null });
    expect(wrapper.vm.dialogInternal).toBe(false);
  });

  it("dialogInternal setter emits update:dialog", () => {
    const wrapper = mountComponent();
    wrapper.vm.dialogInternal = true;
    expect(wrapper.emitted("update:dialog")).toBeTruthy();
    expect(wrapper.emitted("update:dialog")![0][0]).toBe(true);
  });

  it("selectedName returns name when selected", () => {
    const wrapper = mountComponent({
      value: { name: "My Folder", _modelType: "folder" },
    });
    expect(wrapper.vm.selectedName).toBe("My Folder");
  });

  it("selectedName returns fallback when not selected", () => {
    const wrapper = mountComponent({ value: null });
    expect(wrapper.vm.selectedName).toBe("Select a folder...");
  });

  it("select closes dialog and emits input", () => {
    const wrapper = mountComponent({
      value: { name: "Folder", _modelType: "folder" },
    });
    wrapper.vm.dialogInternal = true;
    wrapper.vm.select();
    expect(wrapper.vm.dialogInternal).toBe(false);
    expect(wrapper.emitted("input")).toBeTruthy();
  });

  it("mounted initializes selected from value", () => {
    const location = { name: "Test", _modelType: "folder" };
    const wrapper = mountComponent({ value: location });
    expect(wrapper.vm.selected).toEqual(location);
  });

  it("watch on value syncs selected", async () => {
    const wrapper = mountComponent({ value: null });
    expect(wrapper.vm.selected).toBeNull();
    const newVal = { name: "New Folder", _modelType: "folder" };
    await wrapper.setProps({ value: newVal });
    expect(wrapper.vm.selected).toEqual(newVal);
  });
});
