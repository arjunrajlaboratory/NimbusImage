import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    selectedTool: null,
    dataset: { id: "ds-1" },
    selectedConfigurationId: "config-1",
    setSelectedToolId: vi.fn(),
    setToolPinned: vi.fn(),
    editToolInConfiguration: vi.fn(),
    removeToolFromConfiguration: vi.fn(),
  },
}));

// Reactive, with the real module's scoping: setToolJobOutcome replaces the
// map like the real mutation, and toolJobOutcome only reports an outcome
// whose scope is the current toolJobScope.
vi.mock("@/store/jobs", async () => {
  const { reactive } = await import("vue");
  const jobs: any = reactive({
    // Tracked tool jobs per dataset: { [datasetId]: { [toolId]: jobId } }
    trackedToolJobs: {} as Record<string, Record<string, string>>,
    jobIdForToolInDataset: (toolId: string, datasetId: string | null) =>
      jobs.trackedToolJobs[String(datasetId)]?.[toolId] ?? null,
    toolJobOutcomes: {} as Record<string, { scope: string; success: boolean }>,
    toolJobScope: "user:dataset:config",
    toolJobOutcome: (toolId: string) => {
      const outcome = jobs.toolJobOutcomes[toolId];
      return outcome?.scope === jobs.toolJobScope ? outcome.success : undefined;
    },
    getPromiseForJobId: vi.fn(),
    setToolJobOutcome: vi.fn(
      ({
        toolId,
        scope,
        success,
      }: {
        toolId: string;
        scope: string;
        success: boolean;
      }) => {
        jobs.toolJobOutcomes = {
          ...jobs.toolJobOutcomes,
          [toolId]: { scope, success },
        };
      },
    ),
  });
  return { default: jobs };
});

import store from "@/store";
import jobs from "@/store/jobs";
import ToolItem from "./ToolItem.vue";
import { resetBatchRuns, runBatch } from "@/store/batchRuns";

const baseTool = {
  id: "tool-1",
  name: "Test Tool",
  hotkey: "t",
  type: "create" as const,
  template: { name: "test" },
  values: {},
} as any;

function mountComponent(props = {}) {
  return mount(ToolItem, {
    props: {
      tool: baseTool,
      ...props,
    },
    global: {
      stubs: {
        ToolIcon: true,
        ToolEdition: true,
      },
    },
  });
}

describe("ToolItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).selectedTool = null;
    (jobs as any).trackedToolJobs = {};
    (jobs as any).toolJobOutcomes = {};
    (jobs as any).toolJobScope = "user:dataset:config";
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
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-123" } };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isToolLoading).toBe(true);
  });

  it("isToolLoading is false when selected", () => {
    (store as any).selectedTool = { configuration: { id: "tool-1" } };
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-123" } };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isToolLoading).toBe(false);
  });

  it("shows the tool busy while its batch over the collection runs", async () => {
    let finish!: () => void;
    const batch = runBatch(
      "workerTool",
      "config-1",
      baseTool.id,
      3,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    try {
      const wrapper = mountComponent();
      // The batch is working on another dataset: no job on this one
      expect(wrapper.vm.jobId).toBeNull();
      expect(wrapper.vm.isToolLoading).toBe(true);

      finish();
      await batch;
      expect(wrapper.vm.isToolLoading).toBe(false);
    } finally {
      resetBatchRuns();
    }
  });

  it("does not show the tool busy for its run on another dataset", () => {
    // Tool ids are shared by every dataset of a collection
    (jobs as any).trackedToolJobs = { "ds-other": { "tool-1": "job-123" } };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).jobId).toBeNull();
    expect((wrapper.vm as any).isToolLoading).toBe(false);
  });

  it("jobId returns null when no job", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).jobId).toBeNull();
  });

  it("jobId returns job id when present", () => {
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-456" } };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).jobId).toBe("job-456");
  });

  it("onJobChanged resolves promise and sets statusIcon", async () => {
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-789" } };
    (jobs.getPromiseForJobId as any).mockResolvedValue(true);
    const wrapper = mountComponent();
    (wrapper.vm as any).onJobChanged();
    await vi.waitFor(() => {
      expect((wrapper.vm as any).statusIcon).toBe("mdi-check");
    });
  });

  it("onJobChanged sets mdi-close on failure", async () => {
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-789" } };
    (jobs.getPromiseForJobId as any).mockResolvedValue(false);
    const wrapper = mountComponent();
    (wrapper.vm as any).onJobChanged();
    await vi.waitFor(() => {
      expect((wrapper.vm as any).statusIcon).toBe("mdi-close");
    });
  });

  it("keeps the job status icon when the item remounts (e.g. after pinning)", async () => {
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-789" } };
    (jobs.getPromiseForJobId as any).mockResolvedValue(true);
    const first = mountComponent();
    (first.vm as any).onJobChanged();
    await vi.waitFor(() => {
      expect((first.vm as any).statusIcon).toBe("mdi-check");
    });
    first.unmount();

    (jobs as any).trackedToolJobs = {};
    const remounted = mountComponent();
    expect((remounted.vm as any).statusIcon).toBe("mdi-check");
  });

  it("hides the status icon once the user, dataset or collection changes", async () => {
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-789" } };
    (jobs.getPromiseForJobId as any).mockResolvedValue(true);
    const wrapper = mountComponent();
    (wrapper.vm as any).onJobChanged();
    await vi.waitFor(() => {
      expect((wrapper.vm as any).statusIcon).toBe("mdi-check");
    });

    // e.g. logout + another user, or the same tool id in a duplicated
    // collection.
    (jobs as any).toolJobScope = "other-user:dataset:config";
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).statusIcon).toBeNull();
  });

  it("does not report a job that finishes after the scope changed", async () => {
    (jobs as any).trackedToolJobs = { "ds-1": { "tool-1": "job-789" } };
    let finish!: (success: boolean) => void;
    (jobs.getPromiseForJobId as any).mockReturnValue(
      new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const wrapper = mountComponent();
    (wrapper.vm as any).onJobChanged();

    (jobs as any).toolJobScope = "user:other-dataset:config";
    finish(true);
    await vi.waitFor(() => {
      expect(jobs.setToolJobOutcome).toHaveBeenCalled();
    });
    expect((wrapper.vm as any).statusIcon).toBeNull();
  });

  it("the pin button pins an unpinned tool without toggling it", async () => {
    const wrapper = mountComponent();
    await wrapper.find(".tool-item__pin").trigger("click");

    expect(store.setToolPinned).toHaveBeenCalledWith({
      toolId: "tool-1",
      pinned: true,
    });
    expect(store.setSelectedToolId).not.toHaveBeenCalled();
  });

  it("the pin button unpins a pinned tool", async () => {
    const wrapper = mountComponent({ tool: { ...baseTool, pinned: true } });
    const pin = wrapper.find(".tool-item__pin");
    expect(pin.attributes("aria-label")).toBe("Unpin tool");
    await pin.trigger("click");

    expect(store.setToolPinned).toHaveBeenCalledWith({
      toolId: "tool-1",
      pinned: false,
    });
  });

  it("clicking the drag handle does not toggle the tool", async () => {
    const wrapper = mountComponent();
    await wrapper.find(".tool-item__drag-handle").trigger("click");

    expect(store.setSelectedToolId).not.toHaveBeenCalled();
  });
});
