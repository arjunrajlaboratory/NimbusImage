import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ColorSelectionDialog from "./ColorSelectionDialog.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return mount(ColorSelectionDialog, {
    vuetify: new Vuetify(),
    propsData: {
      show: true,
      ...props,
    },
    stubs: {
      ColorPickerMenu: true,
    },
    attachTo: app,
  });
}

describe("ColorSelectionDialog", () => {
  it("renders dialog title", () => {
    const wrapper = mountComponent();
    expect(document.body.textContent).toContain("Color selected annotations");
    wrapper.destroy();
  });

  it("renders radio options", () => {
    const wrapper = mountComponent();
    expect(document.body.textContent).toContain("Use color from layer");
    expect(document.body.textContent).toContain("Defined color");
    expect(document.body.textContent).toContain("Random color");
    wrapper.destroy();
  });

  it("emits update:show when dialog is closed", async () => {
    const wrapper = mountComponent();
    wrapper.vm.showDialog = false;
    await Vue.nextTick();
    expect(wrapper.emitted("update:show")).toBeTruthy();
    expect(wrapper.emitted("update:show")![0]).toEqual([false]);
    wrapper.destroy();
  });

  it("emits submit with layer option by default", () => {
    const wrapper = mountComponent();
    wrapper.vm.submit();
    expect(wrapper.emitted("submit")![0][0]).toEqual({
      useColorFromLayer: true,
      color: "#FFFFFF",
      randomize: false,
    });
    wrapper.destroy();
  });

  it("emits submit with random option", () => {
    const wrapper = mountComponent();
    wrapper.vm.colorOption = "random";
    wrapper.vm.submit();
    expect(wrapper.emitted("submit")![0][0]).toEqual({
      useColorFromLayer: false,
      color: "#FFFFFF",
      randomize: true,
    });
    wrapper.destroy();
  });

  it("emits submit with defined color", () => {
    const wrapper = mountComponent();
    wrapper.vm.colorOption = "defined";
    wrapper.vm.localCustomColor = "#FF0000";
    wrapper.vm.submit();
    expect(wrapper.emitted("submit")![0][0]).toEqual({
      useColorFromLayer: false,
      color: "#FF0000",
      randomize: false,
    });
    wrapper.destroy();
  });

  it("resets state after submit", () => {
    const wrapper = mountComponent();
    wrapper.vm.colorOption = "random";
    wrapper.vm.localCustomColor = "#123456";
    wrapper.vm.submit();
    expect(wrapper.vm.colorOption).toBe("layer");
    expect(wrapper.vm.localCustomColor).toBe("#FFFFFF");
    wrapper.destroy();
  });
});
