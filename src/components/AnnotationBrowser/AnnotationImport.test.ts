import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, shallowMount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "TestDataset" },
    isLoggedIn: true,
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [{ id: "a1" }, { id: "a2" }],
    annotationsForIteration: [{ id: "a1" }, { id: "a2" }],
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [{ id: "p1", name: "Area" }],
    getPropertyById: (id: string) =>
      id === "p1" ? { id: "p1", name: "Area" } : undefined,
  },
}));

vi.mock("@/store/progress", () => ({
  default: { createNotification: vi.fn() },
}));

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
vi.mock("@/store/pipelines", () => ({
  default: {
    // Keyed by property id, so checking the wrong property shows nothing.
    pipelineStepsLinkedToProperty: (propertyId: string) =>
      propertyId === "p1" ? pipelinesMock.state.linkedSteps : [],
    runningPipelineComputingProperty: (propertyId: string) =>
      propertyId === "p1" ? pipelinesMock.state.runningPipeline : null,
  },
}));

// The real pipeline-step helpers (over the store mocks above); only the
// import itself is mocked.
vi.mock("@/utils/annotationImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/annotationImport")>()),
  importAnnotationsFromData: vi.fn().mockResolvedValue(undefined),
}));

import AnnotationImport from "./AnnotationImport.vue";
import store from "@/store";
import { importAnnotationsFromData } from "@/utils/annotationImport";
import { nextTick } from "vue";

function mountComponent() {
  return shallowMount(AnnotationImport, {});
}

describe("AnnotationImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipelinesMock.state.linkedSteps = [];
    pipelinesMock.state.runningPipeline = null;
    document.body.innerHTML = "";
  });

  it("canImport is true when dataset exists", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.canImport).toBe(true);
  });

  it("canImport is false when no dataset", () => {
    const prev = store.dataset;
    (store as any).dataset = null;
    const wrapper = mountComponent();
    expect(wrapper.vm.canImport).toBe(false);
    (store as any).dataset = prev;
  });

  it("initializes with default import options", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.importAnnotations).toBe(true);
    expect(wrapper.vm.importConnections).toBe(true);
    expect(wrapper.vm.importProperties).toBe(true);
    expect(wrapper.vm.importValues).toBe(true);
    expect(wrapper.vm.overwriteAnnotations).toBe(false);
    expect(wrapper.vm.overwriteProperties).toBe(false);
  });

  it("reset clears all state", () => {
    const wrapper = mountComponent();
    wrapper.vm.importDialog = true;
    wrapper.vm.isJsonLoaded = true;
    wrapper.vm.reset();
    expect(wrapper.vm.importDialog).toBe(false);
    expect(wrapper.vm.isJsonLoaded).toBe(false);
    expect(wrapper.vm.annotations).toEqual([]);
    expect(wrapper.vm.connections).toEqual([]);
  });

  it("submit calls importAnnotationsFromData", async () => {
    const wrapper = mountComponent();
    wrapper.vm.isJsonLoaded = true;
    wrapper.vm.annotations = [{ id: "a1" }] as any;
    wrapper.vm.connections = [];
    wrapper.vm.properties = [];
    wrapper.vm.values = {};
    await wrapper.vm.submit();
    expect(importAnnotationsFromData).toHaveBeenCalled();
  });

  it("submit does nothing when not json loaded", async () => {
    const wrapper = mountComponent();
    wrapper.vm.isJsonLoaded = false;
    await wrapper.vm.submit();
    expect(importAnnotationsFromData).not.toHaveBeenCalled();
  });

  // Mounted with the dialog open and a file loaded, "Overwrite properties"
  // checked: returns the dialog's text and its Import button.
  async function openWithOverwriteProperties() {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const wrapper = mount(AnnotationImport, {
      attachTo: div,
      props: { open: true },
    });
    const vm = wrapper.vm as any;
    vm.isJsonLoaded = true;
    vm.overwriteProperties = true;
    await nextTick();
    await nextTick();
    const card = document.body.querySelector(".v-dialog .v-card");
    const importButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Import selection") as
      | HTMLButtonElement
      | undefined;
    return { wrapper, text: card?.textContent ?? "", importButton };
  }

  it("lists the pipeline steps that use the properties an overwrite would remove", async () => {
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
    const { text, importButton } = await openWithOverwriteProperties();

    expect(text).toContain("Segment and measure: Blob metrics");
    expect(text).toContain('"Area"');
    expect(text).toContain("Old run: Counts");
    expect(text).toContain("(created it)");
    expect(text).toContain("(disabled)");
    expect(text).toContain("new pipeline-owned property");
    // A warning, not a block.
    expect(importButton?.disabled).toBe(false);
  });

  it("disables the import while a pipeline that computes an overwritten property runs", async () => {
    pipelinesMock.state.runningPipeline = { id: "pipe1", name: "Segment" };
    const { wrapper, text, importButton } = await openWithOverwriteProperties();

    expect(text).toContain('The pipeline "Segment" is running');
    expect(text).toContain('computes the property "Area"');
    expect(importButton?.disabled).toBe(true);
    await (wrapper.vm as any).submit();
    expect(importAnnotationsFromData).not.toHaveBeenCalled();

    // Unchecking "Overwrite properties" lifts the block.
    (wrapper.vm as any).overwriteProperties = false;
    await nextTick();
    expect(importButton?.disabled).toBe(false);
  });

  it("counts a step that uses two overwritten properties once", async () => {
    const step = {
      pipelineId: "pipe1",
      pipelineName: "Segment",
      stepId: "s1",
      stepName: "Measure",
      enabled: true,
    };
    pipelinesMock.state.linkedSteps = [
      { ...step, use: "linked" },
      { ...step, use: "created" },
    ];
    const { wrapper } = await openWithOverwriteProperties();
    expect((wrapper.vm as any).overwrittenPropertyLinks).toHaveLength(2);
    expect((wrapper.vm as any).overwrittenStepCount).toBe(1);
  });

  it("reset clears Overwrite properties", () => {
    const wrapper = mountComponent();
    wrapper.vm.overwriteProperties = true;
    wrapper.vm.reset();
    expect(wrapper.vm.overwriteProperties).toBe(false);
  });
});
