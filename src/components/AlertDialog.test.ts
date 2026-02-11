import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import AlertDialog from "./AlertDialog.vue";

Vue.use(Vuetify);

function mountComponent() {
  // Vuetify dialogs need a [data-app] element
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return mount(AlertDialog, {
    vuetify: new Vuetify(),
    attachTo: app,
  });
}

describe("AlertDialog", () => {
  it("renders without an alert initially", () => {
    const wrapper = mountComponent();
    // No alert visible when first rendered
    expect(wrapper.find(".v-alert").exists()).toBe(false);
    wrapper.destroy();
  });

  it("exposes openAlert method via defineExpose", () => {
    const wrapper = mountComponent();
    expect(typeof wrapper.vm.openAlert).toBe("function");
    wrapper.destroy();
  });

  it("shows alert after openAlert is called", async () => {
    const wrapper = mountComponent();
    wrapper.vm.openAlert({ type: "success", message: "Test passed!" });
    await wrapper.vm.$nextTick();
    // The v-dialog should now be active (Vuetify renders dialogs in body)
    const alerts = document.querySelectorAll(".v-alert");
    expect(alerts.length).toBeGreaterThan(0);
    wrapper.destroy();
  });

  it("displays the correct alert message", async () => {
    const wrapper = mountComponent();
    wrapper.vm.openAlert({ type: "error", message: "Something went wrong" });
    await wrapper.vm.$nextTick();
    // Check the full document since v-dialog may teleport content
    expect(document.body.textContent).toContain("Something went wrong");
    wrapper.destroy();
  });

  it("supports all alert types", async () => {
    const wrapper = mountComponent();
    for (const type of ["success", "info", "warning", "error"] as const) {
      wrapper.vm.openAlert({ type, message: `${type} test` });
      await wrapper.vm.$nextTick();
      expect(document.body.textContent).toContain(`${type} test`);
    }
    wrapper.destroy();
  });
});
