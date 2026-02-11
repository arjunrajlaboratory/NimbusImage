import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import SelectAllNoneChips from "./SelectAllNoneChips.vue";

Vue.use(Vuetify);

function mountComponent() {
  return mount(SelectAllNoneChips, {
    vuetify: new Vuetify(),
  });
}

describe("SelectAllNoneChips", () => {
  it("renders two chips", () => {
    const wrapper = mountComponent();
    const chips = wrapper.findAll(".v-chip");
    expect(chips).toHaveLength(2);
  });

  it("renders Select All and Select None text", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Select All");
    expect(wrapper.text()).toContain("Select None");
  });

  it("emits selectAll when first chip is clicked", async () => {
    const wrapper = mountComponent();
    const chips = wrapper.findAll(".v-chip");
    await chips.at(0).trigger("click");
    expect(wrapper.emitted("selectAll")).toHaveLength(1);
  });

  it("emits selectNone when second chip is clicked", async () => {
    const wrapper = mountComponent();
    const chips = wrapper.findAll(".v-chip");
    await chips.at(1).trigger("click");
    expect(wrapper.emitted("selectNone")).toHaveLength(1);
  });

  it("does not emit selectNone when selectAll is clicked", async () => {
    const wrapper = mountComponent();
    const chips = wrapper.findAll(".v-chip");
    await chips.at(0).trigger("click");
    expect(wrapper.emitted("selectNone")).toBeUndefined();
  });
});
