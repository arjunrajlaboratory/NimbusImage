import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store/properties", () => ({
  default: {
    deleteProperty: vi.fn(),
    deletePropertyValues: vi.fn(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    jobIdForPropertyId: {},
    getJobLog: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({ dataset: { id: "ds-a" } as any }));
vi.mock("@/store", () => ({ default: storeMock }));

const progressMock = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock("@/store/progress", () => ({ default: progressMock }));

// Reactive, so a run that starts while the dialog is open reaches the
// component's computeds as it would through the real Vuex getters.
const pipelinesMock = await vi.hoisted(async () => {
  const { reactive } = await import("vue");
  return {
    state: reactive({
      linkedSteps: [] as any[],
      runningPipeline: null as any,
    }),
  };
});
vi.mock("@/store/pipelines", () => {
  return {
    default: {
      // Keyed by property id, so passing the wrong id would show nothing.
      pipelineStepsLinkedToProperty: (propertyId: string) =>
        propertyId === "prop-1" ? pipelinesMock.state.linkedSteps : [],
      runningPipelineComputingProperty: (propertyId: string) =>
        propertyId === "prop-1" ? pipelinesMock.state.runningPipeline : null,
    },
  };
});

import { nextTick } from "vue";
import PropertyBody from "./PropertyBody.vue";
import propertyStore from "@/store/properties";
import jobsStore from "@/store/jobs";

const baseProperty = {
  id: "prop-1",
  name: "Test Property",
  image: "test-image",
  tags: { tags: ["tag1"], exclusive: false },
  shape: "point",
  workerInterface: { param1: "value1" },
} as any;

function mountComponent(props = {}) {
  const div = document.createElement("div");
  div.setAttribute("data-app", "true");
  document.body.appendChild(div);

  return mount(PropertyBody, {
    attachTo: div,
    props: {
      property: baseProperty,
      ...props,
    },
  });
}

describe("PropertyBody", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (propertyStore.deleteProperty as any) = vi.fn();
    (propertyStore.deletePropertyValues as any) = vi.fn();
    (jobsStore as any).jobIdForPropertyId = {};
    (jobsStore.getJobLog as any) = vi.fn().mockReturnValue(null);
    pipelinesMock.state.linkedSteps = [];
    pipelinesMock.state.runningPipeline = null;
    storeMock.dataset = { id: "ds-a" };
    progressMock.createNotification.mockClear();
    document.body.innerHTML = "";
  });

  // The open dialog's buttons, by label (the dialog is teleported to body).
  async function openDeleteDialog(wrapper: any) {
    wrapper.vm.deleteDialog = true;
    await nextTick();
    await nextTick();
    const buttons = [...document.body.querySelectorAll(".v-dialog button")];
    return {
      text: document.body.querySelector(".v-dialog")?.textContent ?? "",
      button: (label: string) =>
        buttons.find((b) => b.textContent?.trim() === label) as
          | HTMLButtonElement
          | undefined,
    };
  }

  it("names the pipeline steps linked to the property and offers Remove anyway", async () => {
    pipelinesMock.state.linkedSteps = [
      {
        pipelineId: "pipe1",
        pipelineName: "Segment and measure",
        stepId: "s1",
        stepName: "Blob metrics",
        enabled: true,
        use: "linked",
      },
      {
        pipelineId: "pipe2",
        pipelineName: "Old run",
        stepId: "s2",
        stepName: "Counts",
        enabled: false,
        use: "created",
      },
    ];
    const wrapper = mountComponent();
    const dialog = await openDeleteDialog(wrapper);

    expect(dialog.text).toContain("Segment and measure");
    expect(dialog.text).toContain("Blob metrics");
    expect(dialog.text).toContain("Counts");
    expect(dialog.text).toContain("(created it)");
    expect(dialog.text).toContain("(disabled)");
    expect(dialog.text).toContain("new pipeline-owned property");
    expect(dialog.button("Remove")).toBeUndefined();
    dialog.button("Remove anyway")!.click();
    await nextTick();
    expect(propertyStore.deleteProperty).toHaveBeenCalledWith("prop-1");
  });

  it("keeps the dialog open and says why when the removal is refused", async () => {
    (propertyStore.deleteProperty as any) = vi
      .fn()
      .mockRejectedValue(new Error("properties have not loaded"));
    const wrapper = mountComponent();
    const dialog = await openDeleteDialog(wrapper);

    dialog.button("Remove")!.click();
    await vi.waitFor(() =>
      expect(document.body.querySelector(".v-dialog")?.textContent).toContain(
        '"Test Property" was not removed',
      ),
    );
    expect((wrapper.vm as any).deleteDialog).toBe(true);
    expect(propertyStore.deletePropertyValues).not.toHaveBeenCalled();
    // The removal unmounts this row before it saves, so the reason is also
    // reported where it is seen once the row is gone.
    expect(progressMock.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Property not removed",
      }),
    );
  });

  it("deletes the computed values of the dataset the removal started on", async () => {
    let finishRemoval!: () => void;
    (propertyStore.deleteProperty as any) = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        }),
    );
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.deleteComputedValues = true;

    const removal = vm.deleteProperty();
    // Another dataset opens while the removal saves.
    storeMock.dataset = { id: "ds-b" };
    finishRemoval();
    await removal;

    expect(propertyStore.deletePropertyValues).toHaveBeenCalledWith({
      propertyId: "prop-1",
      datasetId: "ds-a",
    });
  });

  it("keeps the plain delete confirmation when no pipeline step links to the property", async () => {
    const wrapper = mountComponent();
    const dialog = await openDeleteDialog(wrapper);

    expect(dialog.text).not.toContain("pipeline-owned");
    expect(dialog.button("Remove anyway")).toBeUndefined();
    expect(dialog.button("Remove")).toBeDefined();
  });

  it("blocks removing a property while a pipeline that computes it is running", async () => {
    pipelinesMock.state.linkedSteps = [
      {
        pipelineId: "pipe1",
        pipelineName: "Segment and measure",
        stepId: "s1",
        stepName: "Blob metrics",
      },
    ];
    const wrapper = mountComponent();
    // The run starts after the component mounted.
    pipelinesMock.state.runningPipeline = {
      id: "pipe1",
      name: "Segment and measure",
      steps: [],
    };
    const dialog = await openDeleteDialog(wrapper);

    expect(dialog.text).toContain("is running");
    expect(dialog.button("Remove anyway")).toBeUndefined();
    expect(dialog.button("Delete")).toBeUndefined();
    // Nor through the handler itself (a run that starts once the dialog is
    // open).
    (wrapper.vm as any).deleteProperty();
    expect(propertyStore.deleteProperty).not.toHaveBeenCalled();
    expect(propertyStore.deletePropertyValues).not.toHaveBeenCalled();
  });

  it("currentJobId returns null when no mapping exists for property", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBeUndefined();
  });

  it("currentJobId returns jobId from store when property exists in mapping", () => {
    (jobsStore as any).jobIdForPropertyId = { "prop-1": "job-123" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBe("job-123");
  });

  it("deleteProperty calls propertyStore.deleteProperty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.deleteComputedValues = false;
    vm.deleteProperty();
    expect(propertyStore.deleteProperty).toHaveBeenCalledWith("prop-1");
    expect(propertyStore.deletePropertyValues).not.toHaveBeenCalled();
  });

  it("deleteProperty with deleteComputedValues calls deletePropertyValues too", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.deleteComputedValues = true;
    await vm.deleteProperty();
    expect(propertyStore.deleteProperty).toHaveBeenCalledWith("prop-1");
    expect(propertyStore.deletePropertyValues).toHaveBeenCalledWith({
      propertyId: "prop-1",
      datasetId: "ds-a",
    });
  });

  it("copyLogToClipboard uses navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    (jobsStore as any).jobIdForPropertyId = { "prop-1": "job-123" };
    (jobsStore.getJobLog as any) = vi.fn().mockReturnValue("some log output");

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.copyLogToClipboard();
    expect(writeText).toHaveBeenCalledWith("some log output");
  });
});
