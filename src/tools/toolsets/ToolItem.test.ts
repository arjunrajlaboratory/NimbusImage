import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    selectedTool: null,
    setSelectedToolId: vi.fn(),
    editToolInConfiguration: vi.fn(),
    removeToolFromConfiguration: vi.fn(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    jobIdForToolId: {} as Record<string, string>,
    getPromiseForJobId: vi.fn(),
  },
}));

import store from "@/store";
import jobs from "@/store/jobs";
import ToolItem from "./ToolItem.vue";

Vue.use(Vuetify);
Vue.directive("mousetrap", {});
Vue.directive("tour-trigger", {});

const baseTool = {
  id: "tool-1",
  name: "Test Tool",
  hotkey: "t",
  type: "create" as const,
  template: { name: "test" },
  values: {},
};

function mountComponent(props = {}) {
  return mount(ToolItem, {
    vuetify: new Vuetify(),
    propsData: {
      tool: baseTool,
      ...props,
    },
    stubs: {
      ToolIcon: true,
      ToolEdition: true,
    },
  });
}

describe("ToolItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).selectedTool = null;
    (jobs as any).jobIdForToolId = {};
  });

  it("isToolSelected is false when no tool is selected", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isToolSelected).toBe(false);
  });

  it("isToolSelected is true when store matches tool id", () => {
    (store as any).selectedTool = { configuration: { id: "tool-1" } };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isToolSelected).toBe(true);
  });

  it("toggleTool calls setSelectedToolId with tool id when not selected", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).toggleTool();
    expect(store.setSelectedToolId).toHaveBeenCalledWith("tool-1");
  });

  it("toggleTool calls setSelectedToolId with null when selected", () => {
    (store as any).selectedTool = { configuration: { id: "tool-1" } };
    const wrapper = mountComponent();
    (wrapper.vm as any).toggleTool();
    expect(store.setSelectedToolId).toHaveBeenCalledWith(null);
  });

  it("isToolLoading is true when not selected but has jobId", () => {
    (jobs as any).jobIdForToolId = { "tool-1": "job-123" };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isToolLoading).toBe(true);
  });

  it("isToolLoading is false when selected", () => {
    (store as any).selectedTool = { configuration: { id: "tool-1" } };
    (jobs as any).jobIdForToolId = { "tool-1": "job-123" };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isToolLoading).toBe(false);
  });

  it("jobId returns null when no job", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).jobId).toBeNull();
  });

  it("jobId returns job id when present", () => {
    (jobs as any).jobIdForToolId = { "tool-1": "job-456" };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).jobId).toBe("job-456");
  });

  it("onJobChanged resolves promise and sets statusIcon", async () => {
    (jobs as any).jobIdForToolId = { "tool-1": "job-789" };
    (jobs.getPromiseForJobId as any).mockResolvedValue(true);
    const wrapper = mountComponent();
    (wrapper.vm as any).onJobChanged();
    await vi.waitFor(() => {
      expect((wrapper.vm as any).statusIcon).toBe("mdi-check");
    });
  });

  it("onJobChanged sets mdi-close on failure", async () => {
    (jobs as any).jobIdForToolId = { "tool-1": "job-789" };
    (jobs.getPromiseForJobId as any).mockResolvedValue(false);
    const wrapper = mountComponent();
    (wrapper.vm as any).onJobChanged();
    await vi.waitFor(() => {
      expect((wrapper.vm as any).statusIcon).toBe("mdi-close");
    });
  });
});
