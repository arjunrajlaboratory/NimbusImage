import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";

vi.mock("@/utils/v-mousetrap", () => ({
  default: vi.fn(),
  boundKeys: ref({
    "ctrl+z": { section: "General", description: "Undo" },
    "ctrl+y": { section: "General", description: "Redo" },
    d: { section: "Annotation", description: "Delete selected" },
  }),
}));

vi.mock("@/utils/v-description", () => ({
  default: vi.fn(),
  descriptions: ref({
    0: {
      section: "Layers",
      title: "Visibility",
      description: "Toggle layer visibility",
    },
    1: {
      section: "Annotation",
      title: "Snap",
      description: "Snap to nearest point",
    },
    2: {
      section: "Layers",
      title: "Color",
      description: "Change layer color",
    },
  }),
}));

import HelpPanel from "./HelpPanel.vue";

function mountComponent() {
  return mount(HelpPanel, {});
}

describe("HelpPanel", () => {
  it("groups hotkey items by section", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.hotkeyItems;
    const sectionNames = items.map(([name]: [string, any]) => name);
    expect(sectionNames).toContain("General");
    expect(sectionNames).toContain("Annotation");
  });

  it("sorts hotkey sections alphabetically", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.hotkeyItems;
    const sectionNames = items.map(([name]: [string, any]) => name);
    expect(sectionNames).toEqual([...sectionNames].sort());
  });

  it("groups feature items by section", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.featureItems;
    const sectionNames = items.map(([name]: [string, any]) => name);
    expect(sectionNames).toContain("Layers");
    expect(sectionNames).toContain("Annotation");
  });

  it("sorts feature sections alphabetically", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.featureItems;
    const sectionNames = items.map(([name]: [string, any]) => name);
    expect(sectionNames).toEqual([...sectionNames].sort());
  });

  it("has correct number of items per hotkey section", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.hotkeyItems;
    const generalSection = items.find(
      ([name]: [string, any]) => name === "General",
    );
    expect(generalSection![1]).toHaveLength(2);
    const annotationSection = items.find(
      ([name]: [string, any]) => name === "Annotation",
    );
    expect(annotationSection![1]).toHaveLength(1);
  });

  it("has correct number of items per feature section", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.featureItems;
    const layersSection = items.find(
      ([name]: [string, any]) => name === "Layers",
    );
    expect(layersSection![1]).toHaveLength(2);
  });
});
