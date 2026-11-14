import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount, shallowMount } from "@vue/test-utils";

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
  describe("import lifecycle", () => {
    function loaded() {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isJsonLoaded = true;
      vm.annotations = [{ id: "a1" }];
      return { wrapper, vm };
    }

    it("ignores a second submit while an import is running", async () => {
      let finish!: () => void;
      vi.mocked(importAnnotationsFromData).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      const { vm } = loaded();
      const first = vm.submit();
      await vm.submit();
      expect(importAnnotationsFromData).toHaveBeenCalledTimes(1);
      finish();
      await first;
    });

    it("disables the Import selection button while importing", async () => {
      let finish!: () => void;
      vi.mocked(importAnnotationsFromData).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      const div = document.createElement("div");
      document.body.appendChild(div);
      const wrapper = mount(AnnotationImport, {
        attachTo: div,
        props: { open: true },
      });
      const vm = wrapper.vm as any;
      vm.isJsonLoaded = true;
      await nextTick();
      const button = () =>
        Array.from(document.body.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Import selection"),
        ) as HTMLButtonElement;
      expect(button().disabled).toBe(false);
      const pending = vm.submit();
      await nextTick();
      expect(button().disabled).toBe(true);
      // Left pending: a successful import closes the dialog, and Vuetify's
      // close transition throws once the test tears the DOM down.
      void finish;
      void pending;
    });

    it("shows an import failure in the dialog", async () => {
      vi.mocked(importAnnotationsFromData).mockRejectedValueOnce(
        new Error("Server said no"),
      );
      const { vm } = loaded();
      await vm.submit();
      expect(vm.importError).toBe("Server said no");
      expect(vm.isImporting).toBe(false);
      // The dialog keeps its loaded file so the user can retry.
      expect(vm.isJsonLoaded).toBe(true);
    });

    it("resets the overwrite choices when the dialog closes", async () => {
      const wrapper = shallowMount(AnnotationImport, { props: { open: true } });
      const vm = wrapper.vm as any;
      vm.isJsonLoaded = true;
      vm.overwriteAnnotations = true;
      vm.overwriteProperties = true;
      vm.importError = "old failure";
      await wrapper.setProps({ open: false });
      await nextTick();
      expect(vm.overwriteAnnotations).toBe(false);
      expect(vm.overwriteProperties).toBe(false);
      expect(vm.isJsonLoaded).toBe(false);
      expect(vm.importError).toBe("");
      wrapper.unmount();
    });

    it("keeps the in-progress state when the dialog closes mid-import", async () => {
      let finish!: () => void;
      vi.mocked(importAnnotationsFromData).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      const wrapper = shallowMount(AnnotationImport, { props: { open: true } });
      const vm = wrapper.vm as any;
      vm.isJsonLoaded = true;
      const pending = vm.submit();
      await wrapper.setProps({ open: false });
      await nextTick();
      expect(vm.isImporting).toBe(true);
      await vm.submit();
      expect(importAnnotationsFromData).toHaveBeenCalledTimes(1);
      finish();
      await pending;
      wrapper.unmount();
    });

    it("keeps the latest file when an earlier file's read finishes last", async () => {
      const reads: Array<(text: string) => void> = [];
      const fakeFile = () =>
        ({
          text: () => new Promise<string>((resolve) => reads.push(resolve)),
        }) as unknown as File;
      const json = (id: string) =>
        JSON.stringify({
          annotations: [{ id }],
          annotationConnections: [],
          annotationProperties: [],
          annotationPropertyValues: {},
        });
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.jsonFile = fakeFile();
      await nextTick();
      vm.jsonFile = fakeFile();
      await nextTick();
      expect(reads).toHaveLength(2);
      reads[1](json("newer"));
      await flushPromises();
      reads[0](json("older"));
      await flushPromises();
      expect(vm.annotations).toEqual([{ id: "newer" }]);
      expect(vm.isJsonLoaded).toBe(true);
    });

    it("stops the file spinner when the picked file is not valid JSON", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.jsonFile = {
        text: () => Promise.resolve("{ not json"),
      } as unknown as File;
      await nextTick();
      expect(vm.isLoadingFile).toBe(true);
      await flushPromises();
      expect(vm.jsonFile).toBeNull();
      expect(vm.isLoadingFile).toBe(false);
      expect(vm.isJsonLoaded).toBe(false);
    });

    it("stops the file spinner when the file is cleared mid-read", async () => {
      let finishRead!: (text: string) => void;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.jsonFile = {
        text: () => new Promise<string>((resolve) => (finishRead = resolve)),
      } as unknown as File;
      await nextTick();
      expect(vm.isLoadingFile).toBe(true);
      vm.jsonFile = null;
      await nextTick();
      expect(vm.isLoadingFile).toBe(false);
      finishRead("{}");
      await flushPromises();
      expect(vm.isLoadingFile).toBe(false);
      expect(vm.isJsonLoaded).toBe(false);
    });
  });
});
