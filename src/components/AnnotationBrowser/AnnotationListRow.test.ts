import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AnnotationListRow from "./AnnotationListRow.vue";

function makeItem(overrides: any = {}) {
  return {
    annotation: {
      id: "a1",
      name: null,
      tags: ["t1", "t2"],
      location: { XY: 0, Z: 1, Time: 2 },
    },
    index: 7,
    shapeName: "Point",
    isSelected: false,
    properties: {},
    ...overrides,
  };
}

function mountRow(props: any = {}) {
  return mount(AnnotationListRow, {
    props: {
      item: makeItem(),
      selectedColumns: ["index", "annotation.tags", "annotation.location.XY"],
      displayedPropertyPaths: [],
      hoveredId: null,
      tableItemClass: "px-1",
      ...props,
    },
    global: {
      stubs: {
        VCheckbox: {
          template:
            '<input type="checkbox" @click="$emit(\'click\', $event)" />',
        },
        VChip: {
          template:
            '<span class="v-chip" @click="$emit(\'click\', $event)"><slot /></span>',
        },
        VTextField: true,
        VIcon: true,
      },
    },
  });
}

describe("AnnotationListRow", () => {
  it("renders a tr with the selected columns", () => {
    const wrapper = mountRow();
    expect(wrapper.find("tr").exists()).toBe(true);
    expect(wrapper.text()).toContain("7"); // index
    expect(wrapper.text()).toContain("t1"); // tag
    expect(wrapper.text()).toContain("1"); // location.XY + 1 == 1
  });

  it("emits navigate on row click", async () => {
    const wrapper = mountRow();
    await wrapper.find("tr").trigger("click");
    expect(wrapper.emitted("navigate")?.[0]).toEqual(["a1"]);
  });

  it("emits hover with id on mouseover and null on mouseleave", async () => {
    const wrapper = mountRow();
    await wrapper.find("tr").trigger("mouseover");
    await wrapper.find("tr").trigger("mouseleave");
    expect(wrapper.emitted("hover")?.[0]).toEqual(["a1"]);
    expect(wrapper.emitted("hover")?.[1]).toEqual([null]);
  });

  it("emits toggle-select (not navigate) when the checkbox is clicked", async () => {
    const wrapper = mountRow();
    await wrapper.find('input[type="checkbox"]').trigger("click");
    expect(wrapper.emitted("toggle-select")?.[0]?.[0]).toMatchObject({
      id: "a1",
    });
    // @click.stop on the checkbox must keep the row click (navigate) from firing.
    expect(wrapper.emitted("navigate")).toBeUndefined();
  });

  it("emits clicked-tag when a tag chip is clicked", async () => {
    const wrapper = mountRow();
    const chips = wrapper.findAll(".v-chip");
    await chips[0].trigger("click");
    expect(wrapper.emitted("clicked-tag")?.[0]).toEqual(["t1"]);
  });

  it("applies is-hovered class when hoveredId matches", () => {
    const wrapper = mountRow({ hoveredId: "a1" });
    expect(wrapper.find("tr").classes()).toContain("is-hovered");
  });

  it("renders a property cell per displayed property path", () => {
    const wrapper = mountRow({
      displayedPropertyPaths: [["p", "Area"]],
      item: makeItem({ properties: { p: { Area: 42 } } }),
    });
    expect(wrapper.text()).toContain("42");
  });
});
