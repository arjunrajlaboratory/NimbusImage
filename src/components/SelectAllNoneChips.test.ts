import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SelectAllNoneChips from "./SelectAllNoneChips.vue";

function mountComponent() {
  return mount(SelectAllNoneChips, {});
}

describe("SelectAllNoneChips", () => {
  it("renders two buttons", () => {
    const wrapper = mountComponent();
    const btns = wrapper.findAll(".v-btn");
    expect(btns).toHaveLength(2);
  });

  it("renders Select all and Select none text", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Select all");
    expect(wrapper.text()).toContain("Select none");
  });

  it("emits selectAll when first button is clicked", async () => {
    const wrapper = mountComponent();
    const btns = wrapper.findAll(".v-btn");
    await btns.at(0)!.trigger("click");
    expect(wrapper.emitted("selectAll")).toHaveLength(1);
  });

  it("emits selectNone when second button is clicked", async () => {
    const wrapper = mountComponent();
    const btns = wrapper.findAll(".v-btn");
    await btns.at(1)!.trigger("click");
    expect(wrapper.emitted("selectNone")).toHaveLength(1);
  });

  it("does not emit selectNone when selectAll is clicked", async () => {
    const wrapper = mountComponent();
    const btns = wrapper.findAll(".v-btn");
    await btns.at(0)!.trigger("click");
    expect(wrapper.emitted("selectNone")).toBeUndefined();
  });
});
