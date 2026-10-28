import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  properties: {
    workerInterfaces: {} as Record<string, any>,
    getWorkerInterface: vi.fn(),
    workerImageList: { "img/tool": {} } as Record<string, any>,
    fetchWorkerImageList: vi.fn(),
    fetchWorkerInterface: vi.fn(),
  },
}));

vi.mock("@/store/properties", () => ({ default: h.properties }));
vi.mock("@/components/DockerImageSelect.vue", () => ({ default: {} }));
vi.mock("@/components/TagPicker.vue", () => ({ default: {} }));
vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({
  default: {},
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import PipelineStepEditor from "./PipelineStepEditor.vue";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";
import { AnnotationShape } from "@/store/model";

const workerInterface = {
  threshold: { type: "number", default: 3 },
  radius: { type: "number", default: 2 },
};

function annotationStep(workerInterfaceValues: any, extra: any = {}): any {
  return {
    id: "a",
    kind: "annotation",
    name: "a",
    image: "img/tool",
    workerInterfaceValues,
    enabled: true,
    annotation: {
      tags: [],
      shape: AnnotationShape.Polygon,
      coordinateAssignments: {
        layer: null,
        Z: { type: "layer", value: 1, max: 1 },
        Time: { type: "layer", value: 1, max: 1 },
      },
    },
    ...extra,
  };
}

const linked = { state: "linked", sourceKind: "tool", sourceName: "Tool" };

function mountStepEditor(step: any, linkState: any = { state: "unlinked" }) {
  return shallowMount(PipelineStepEditor, {
    props: { modelValue: step, linkState },
    global: { renderStubDefaultSlot: true },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.properties.getWorkerInterface.mockReturnValue(workerInterface);
});

describe("PipelineStepEditor linked steps", () => {
  it("shows a linked step's defaults without writing them on mount", async () => {
    const wrapper = mountStepEditor(
      annotationStep({}, { sourceToolId: "t1" }),
      linked,
    );
    await nextTick();
    await nextTick();

    expect(
      wrapper.findComponent(WorkerInterfaceValues).props("modelValue"),
    ).toEqual({ threshold: 3, radius: 2 });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("loads the worker interface when a linked step's image changes", async () => {
    const wrapper = mountStepEditor(
      annotationStep({}, { sourceToolId: "t1" }),
      linked,
    );
    await nextTick();
    await nextTick();
    // The linked tool's image changes in the Tools panel to one whose
    // interface is not cached yet.
    h.properties.getWorkerInterface.mockImplementation((image: string) =>
      image === "img/tool" ? workerInterface : null,
    );
    h.properties.fetchWorkerInterface.mockClear();

    await wrapper.setProps({
      modelValue: annotationStep(
        {},
        { sourceToolId: "t1", image: "img/new-tool" },
      ),
    });

    expect(h.properties.fetchWorkerInterface).toHaveBeenCalledWith({
      image: "img/new-tool",
    });
    // Shown, not written: a linked step's settings are its tool's.
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("does not seed a step with the first image's defaults after another image was picked", async () => {
    let finishFirstFetch!: () => void;
    const cached = new Set<string>();
    h.properties.getWorkerInterface.mockImplementation((image: string) =>
      cached.has(image) ? workerInterface : null,
    );
    h.properties.fetchWorkerInterface.mockImplementation(
      ({ image }: { image: string }) =>
        image === "img/tool"
          ? new Promise<void>((resolve) => {
              finishFirstFetch = () => {
                cached.add(image);
                resolve();
              };
            })
          : Promise.resolve(),
    );
    // A new, unlinked step: its first interface fetch is still running...
    const wrapper = mountStepEditor(annotationStep({}));
    await vi.waitFor(() =>
      expect(h.properties.fetchWorkerInterface).toHaveBeenCalledWith({
        image: "img/tool",
      }),
    );
    // ...when another image is picked (the parent passes the picked step).
    await wrapper.setProps({
      modelValue: annotationStep({ chosen: 1 }, { image: "img/other" }),
    });
    finishFirstFetch();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The first image's defaults are not written onto the picked step.
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("locks a linked step's settings and says where to edit them", async () => {
    const wrapper = mountStepEditor(
      annotationStep({ threshold: 1 }, { sourceToolId: "t1" }),
      linked,
    );
    await nextTick();

    const locked = wrapper.findAll("[inert]");
    expect(locked.length).toBe(2);
    expect(
      locked.some((section) =>
        section.findComponent(WorkerInterfaceValues).exists(),
      ),
    ).toBe(true);
    expect(wrapper.text()).toContain("Edit them in the Tools panel");
  });

  it("leaves an unlinked step's settings editable", async () => {
    const wrapper = mountStepEditor(annotationStep({ threshold: 1 }));
    await nextTick();

    expect(wrapper.findAll("[inert]").length).toBe(0);
  });

  it("keeps saved parameters the worker no longer declares on unlink", async () => {
    const wrapper = mountStepEditor(
      annotationStep({ threshold: 1, retired: 7 }, { sourceToolId: "t1" }),
      linked,
    );
    await nextTick();

    (wrapper.vm as any).unlink();

    const emitted = wrapper.emitted("update:modelValue") as any[];
    expect(emitted.at(-1)[0]).not.toHaveProperty("sourceToolId");
    expect(emitted.at(-1)[0].workerInterfaceValues).toEqual({
      threshold: 1,
      radius: 2,
      retired: 7,
    });
  });

  it("emits only name and enabled changes for a linked step", async () => {
    const wrapper = mountStepEditor(
      annotationStep({ threshold: 1 }, { sourceToolId: "t1" }),
      linked,
    );
    await nextTick();
    const vm = wrapper.vm as any;

    // What a locked child editor re-emitting would do.
    vm.image = "img/other";
    await nextTick();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();

    vm.name = "Renamed";
    const emitted = wrapper.emitted("update:modelValue") as any[];
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0].name).toBe("Renamed");
  });

  it("renames a property step on unlink so its own property is told apart", async () => {
    const wrapper = mountStepEditor(
      {
        id: "p",
        kind: "property",
        name: "Nucleus Area",
        image: "img/tool",
        workerInterfaceValues: {},
        enabled: true,
        shape: AnnotationShape.Polygon,
        inputTags: { tags: ["n"], exclusive: false },
        autoWired: false,
        sourcePropertyId: "user",
      },
      {
        state: "linked",
        sourceKind: "property",
        sourceName: "Nucleus Area",
      },
    );
    await nextTick();

    (wrapper.vm as any).unlink();

    const emitted = wrapper.emitted("update:modelValue") as any[];
    expect(emitted.at(-1)[0]).toMatchObject({
      name: "Nucleus Area (pipeline copy)",
      autoWired: false,
    });
    expect(emitted.at(-1)[0]).not.toHaveProperty("sourcePropertyId");
  });
});
