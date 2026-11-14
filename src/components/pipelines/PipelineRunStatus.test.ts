import { ref } from "vue";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pipelinesStore: {
    getPipelineById: vi.fn(),
  },
}));

vi.mock("@/store/pipelines", () => ({ default: h.pipelinesStore }));

import PipelineRunStatus from "./PipelineRunStatus.vue";
import { PipelineRunControllerKey } from "./usePipelineRun";
import { AnnotationShape, IPipeline } from "@/store/model";

const pipeline: IPipeline = {
  id: "pipe1",
  name: "Test",
  steps: [
    {
      id: "step1",
      kind: "property",
      name: "Measure",
      image: "worker/image",
      workerInterfaceValues: {},
      enabled: true,
      shape: AnnotationShape.Polygon,
      inputTags: { tags: [], exclusive: false },
    },
  ],
};

const controller = {
  isRunning: ref(false),
  runningPipelineId: ref<string | null>(null),
  activePipelineId: ref<string | null>(null),
  batchProgress: ref<any>(null),
  result: ref<any>(null),
  lastRunWasBatch: ref(false),
  statusesFor: vi.fn(() => [
    { status: "pending", progress: {}, errors: { errors: [] } },
  ]),
  cancel: vi.fn(),
};

function mountStatus() {
  return shallowMount(PipelineRunStatus, {
    global: {
      provide: { [PipelineRunControllerKey as symbol]: controller },
    },
  });
}

// jsdom has no layout, so "same height" is asserted as "same rows": the strip,
// its detail line and its progress-bar slot exist in every state.
function rows(wrapper: ReturnType<typeof mountStatus>) {
  return {
    strip: wrapper.find(".pipeline-run-status").exists(),
    detail: wrapper.find(".pipeline-run-status__detail").exists(),
    bar: wrapper.find(".pipeline-run-status__bar").exists(),
  };
}

const allRows = { strip: true, detail: true, bar: true };

beforeEach(() => {
  controller.isRunning.value = false;
  controller.runningPipelineId.value = null;
  controller.activePipelineId.value = null;
  controller.batchProgress.value = null;
  controller.result.value = null;
  h.pipelinesStore.getPipelineById.mockReturnValue(pipeline);
});

describe("PipelineRunStatus", () => {
  it("reserves its place, hidden, before any run so a run does not shift the list", () => {
    const wrapper = mountStatus();
    expect(rows(wrapper)).toEqual(allRows);
    const strip = wrapper.find(".pipeline-run-status");
    expect(strip.classes()).toContain("pipeline-run-status--idle");
    expect(strip.attributes("aria-hidden")).toBe("true");
  });

  it("keeps every row while a run is in flight", () => {
    controller.isRunning.value = true;
    controller.runningPipelineId.value = "pipe1";
    const wrapper = mountStatus();
    expect(rows(wrapper)).toEqual(allRows);
    expect(wrapper.find(".pipeline-run-status").classes()).not.toContain(
      "pipeline-run-status--idle",
    );
  });

  it("keeps every row after a run finishes, though it has no detail or bar", () => {
    controller.activePipelineId.value = "pipe1";
    controller.result.value = {
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      failedStepIndex: null,
    };
    const wrapper = mountStatus();
    expect(rows(wrapper)).toEqual(allRows);
    expect(wrapper.text()).toContain("Test — Steps: 1 succeeded");
    expect(wrapper.find(".pipeline-run-status").classes()).not.toContain(
      "pipeline-run-status--idle",
    );
  });
});
