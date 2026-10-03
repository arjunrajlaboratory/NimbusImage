import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableAutoUnmount,
  flushPromises,
  shallowMount,
} from "@vue/test-utils";
import { Component, nextTick } from "vue";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  poll: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      dataset: { id: "d1", name: "one" },
      scales: { pixelSize: { value: 1, unit: "µm" } },
      spatialAPI: {
        recompute: mocks.start,
        computeNeighborhood: mocks.start,
        differential: mocks.start,
        materialize: mocks.start,
        score: mocks.start,
        fetchJob: mocks.poll,
        fetchNeighborhood: vi.fn().mockResolvedValue(null),
      },
    }),
  };
});
vi.mock("@/store/spatial", () => ({
  default: {
    hasTable: true,
    info: { nObs: 10, nVar: 2 },
    refreshInfo: mocks.refresh,
    ensureInfo: mocks.refresh,
  },
}));
vi.mock("@/store/properties", () => ({
  SPATIAL_PROPERTY_ID: "spatial",
  default: {
    fetchProperties: mocks.refresh,
    fetchPropertyPathsSample: mocks.refresh,
  },
}));
vi.mock("@/store/jobs", () => ({
  default: {
    fetchJobStatus: async (id: string) => (await mocks.poll(id)).status,
  },
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
import store from "@/store";
import Recompute from "./RecomputeTableDialog.vue";
import Neighborhood from "./AnnotationBrowser/NeighborhoodDialog.vue";
import Differential from "./AnnotationBrowser/DifferentialExpressionDialog.vue";
import Materialize from "./AnnotationBrowser/MaterializeGenesDialog.vue";

enableAutoUnmount(afterEach);
const cases: {
  name: string;
  component: Component;
  props: Record<string, unknown>;
}[] = [
  { name: "recompute", component: Recompute, props: { staleness: null } },
  { name: "neighborhood", component: Neighborhood, props: {} },
  {
    name: "differential",
    component: Differential,
    props: { filtersA: {}, groupALabel: "A" },
  },
  { name: "materialize", component: Materialize, props: {} },
];
const success = {
  status: 3,
  spatialResult: {
    nObs: 12,
    assigned: 34,
    seconds: 1,
    features: [],
    written: 12,
  },
};

describe.each(cases)("$name job lifecycle", ({ component, props }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    (store as any).dataset = { id: "d1", name: "one" };
    mocks.start.mockReset().mockResolvedValue({ jobId: "job" });
    mocks.poll.mockReset().mockResolvedValue({ status: 2 });
    mocks.refresh.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function open() {
    const wrapper = shallowMount(component, { props });
    const vm = wrapper.vm as any;
    vm.dialog = true;
    if (component === Materialize) {
      vm.mode = "copy";
      vm.symbols = ["CD3E"];
    }
    await nextTick();
    await flushPromises();
    return { wrapper, vm, run: () => (vm.run ?? vm.submit)() };
  }

  it("cancels scheduled polls on unmount", async () => {
    const { wrapper, run } = await open();
    await run();
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("ignores a submit response received after unmount", async () => {
    let finish!: (value: any) => void;
    mocks.start.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { wrapper, run } = await open();
    const pending = run();
    wrapper.unmount();
    finish({ jobId: "old" });
    await pending;
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("ignores an old poll after close and a newer run", async () => {
    let finish!: (value: any) => void;
    mocks.poll.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { vm, run } = await open();
    await run();
    await vi.advanceTimersByTimeAsync(2000);
    vm.dialog = false;
    await nextTick();
    vm.dialog = true;
    await nextTick();
    await run();
    finish(success);
    await flushPromises();
    expect(vm.running).toBe(true);
    expect(vm.done || vm.result).toBeFalsy();
  });

  it("ignores an in-flight poll after the dataset changes", async () => {
    let finish!: (value: any) => void;
    mocks.poll.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { vm, run } = await open();
    await run();
    await vi.advanceTimersByTimeAsync(2000);
    (store as any).dataset = { id: "d2", name: "two" };
    await nextTick();
    mocks.refresh.mockClear();
    finish(success);
    await flushPromises();
    expect(vm.done || vm.result).toBeFalsy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
