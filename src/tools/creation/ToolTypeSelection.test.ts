import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    toolTemplateList: [
      {
        name: "Manual object tool",
        type: "create",
        description: "Create annotations",
        interface: [
          {
            id: "annotation",
            name: "Annotation",
            type: "annotation",
            isSubmenu: true,
            meta: {},
          },
        ],
      },
      {
        name: "Tagging tools",
        type: "tagging",
        description: "Tag annotations",
        interface: [
          {
            id: "submenu",
            name: "Submenu",
            type: "select",
            isSubmenu: true,
            meta: {
              items: [
                { text: "Tag by click", value: "tagByClick" },
                { text: "Tag by region", value: "tagByRegion" },
              ],
            },
          },
        ],
      },
    ],
    availableToolShapes: [
      { text: "Point", value: "point" },
      { text: "Line", value: "line" },
    ],
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    workerImageList: {},
    fetchWorkerImageList: vi.fn(),
  },
}));

vi.mock("@/utils/strings", () => ({
  getTourStepId: vi.fn((x: string) => x),
  getTourTriggerId: vi.fn((x: string) => x),
}));

vi.mock("@/utils/log", () => ({
  logWarning: vi.fn(),
}));

vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({
  default: {},
}));

import ToolTypeSelection from "./ToolTypeSelection.vue";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

// Mock global fetch
const mockFetch = vi.fn().mockResolvedValue({ ok: false });
vi.stubGlobal("fetch", mockFetch);

function mountComponent() {
  return mount(ToolTypeSelection, {
    vuetify: new Vuetify(),
  });
}

describe("ToolTypeSelection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockResolvedValue({ ok: false });
  });

  it("templates returns store.toolTemplateList", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.templates).toHaveLength(2);
    expect(vm.templates[0].name).toBe("Manual object tool");
    expect(vm.templates[1].name).toBe("Tagging tools");
  });

  it("submenus generates correctly from templates", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const submenus = vm.submenus;

    // First template is "Manual object tool" with annotation submenu type
    // which uses store.availableToolShapes for items
    expect(submenus.length).toBeGreaterThanOrEqual(2);

    // First submenu should have items from availableToolShapes
    const manualSubmenu = submenus[0];
    expect(manualSubmenu.template.name).toBe("Manual object tool");
    expect(manualSubmenu.items).toHaveLength(2);
    expect(manualSubmenu.items[0].text).toBe("Point");
    expect(manualSubmenu.items[1].text).toBe("Line");

    // Second submenu should have items from the select meta
    const taggingSubmenu = submenus[1];
    expect(taggingSubmenu.template.name).toBe("Tagging tools");
    expect(taggingSubmenu.items).toHaveLength(2);
    expect(taggingSubmenu.items[0].text).toBe("Tag by click");
  });

  it("selectItem emits selected with TReturnType", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const submenus = vm.submenus;

    // Select the first item from the first submenu
    const item = { ...submenus[0].items[0], submenu: submenus[0] };
    vm.selectItem(item);

    const emitted = wrapper.emitted("selected");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toHaveProperty("template");
    expect(emitted![0][0]).toHaveProperty("defaultValues");
    expect(emitted![0][0]).toHaveProperty("selectedItem");
  });

  it("selectItem sets computedTemplate and defaultToolValues", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const submenus = vm.submenus;

    const item = { ...submenus[1].items[0], submenu: submenus[1] };
    vm.selectItem(item);

    expect(vm.computedTemplate).not.toBeNull();
    expect(vm.selectedItem).toBe(item);
  });

  it("reset clears state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // Set some state
    vm.selectedItem = { text: "test" };
    vm.computedTemplate = { name: "test" };
    vm.defaultToolValues = { key: "value" };

    vm.reset();

    expect(vm.selectedItem).toBeNull();
    expect(vm.computedTemplate).toBeNull();
    expect(vm.defaultToolValues).toEqual({});
  });

  it("featuredItems returns empty array when featuredToolNames is empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.featuredToolNames = [];
    expect(vm.featuredItems).toEqual([]);
  });

  it("featuredItems collects matching items from submenus", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.featuredToolNames = ["Point", "Tag by click"];

    const featured = vm.featuredItems;
    expect(featured).toHaveLength(2);
    expect(featured[0].text).toBe("Point");
    expect(featured[1].text).toBe("Tag by click");
  });

  it("featuredItems maintains order from featuredToolNames", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.featuredToolNames = ["Tag by click", "Point"];

    const featured = vm.featuredItems;
    expect(featured).toHaveLength(2);
    expect(featured[0].text).toBe("Tag by click");
    expect(featured[1].text).toBe("Point");
  });
});
