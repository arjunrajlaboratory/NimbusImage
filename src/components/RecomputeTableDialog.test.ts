import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  recompute: vi.fn(),
  fetchJob: vi.fn(),
  refreshInfo: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    spatialAPI: { recompute: mocks.recompute, fetchJob: mocks.fetchJob },
  },
}));

vi.mock("@/store/spatial", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({ hasTable: true, refreshInfo: mocks.refreshInfo }),
  };
});

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) =>
    error?.response?.data?.message ?? error?.message ?? String(error),
}));

import RecomputeTableDialog from "./RecomputeTableDialog.vue";
import spatialStore from "@/store/spatial";

const STALE = {
  added: 3,
  changed: 1,
  removed: 0,
  addedIds: [],
  changedIds: [],
  removedIds: [],
  hasGeometryHashes: true,
  cells: 10,
  rows: 7,
  upToDate: false,
};

async function open(staleness: any = STALE) {
  const wrapper = shallowMount(RecomputeTableDialog, {
    props: { staleness },
  });
  (wrapper.vm as any).dialog = true;
  await nextTick();
  return wrapper;
}

describe("RecomputeTableDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.recompute.mockReset().mockResolvedValue({ jobId: "j1" });
    mocks.fetchJob.mockReset();
    mocks.refreshInfo.mockReset().mockResolvedValue(undefined);
    (spatialStore as any).hasTable = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers edited-only when something changed, full rebuild otherwise", async () => {
    const wrapper = await open();
    const vm = wrapper.vm as any;
    expect(vm.canDirty).toBe(true);
    expect(vm.dirtyHint).toBe("3 added, 1 edited");
    expect(vm.scope).toBe("dirty");
    await wrapper.setProps({ staleness: { ...STALE, upToDate: true } });
    await nextTick();
    expect(vm.canDirty).toBe(false);
    expect(vm.scope).toBe("all");
    expect(vm.dirtyHint).toBe("nothing has changed");
    (spatialStore as any).hasTable = false;
    await nextTick();
    expect(vm.dirtyHint).toBe("needs an existing table");
  });

  it("posts the request and polls the job, then re-reads the table", async () => {
    mocks.fetchJob
      .mockResolvedValueOnce({ _id: "j1", status: 2 })
      .mockResolvedValueOnce({
        _id: "j1",
        status: 3,
        spatialResult: { nObs: 10, assigned: 1234, seconds: 4.2 },
      });
    const wrapper = await open();
    const vm = wrapper.vm as any;
    vm.label = " v3 ";
    vm.tagsText = "cell, keep";
    vm.minQv = 25;
    await vm.run();
    expect(mocks.recompute).toHaveBeenCalledWith("ds1", {
      label: "v3",
      scope: "dirty",
      minQv: 25,
      tags: ["cell", "keep"],
      recomputeEmbeddings: false,
    });
    expect(vm.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.running).toBe(false);
    expect(vm.done).toContain("10 cells");
    expect(mocks.refreshInfo).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("recomputed")).toHaveLength(1);
    // Blank tags mean every polygon.
    vm.tagsText = " ";
    expect(vm.tags()).toBeNull();
  });

  it("reports a failed job and a rejected request, and stops polling on close", async () => {
    mocks.fetchJob.mockResolvedValue({ _id: "j1", status: 4 });
    const wrapper = await open();
    const vm = wrapper.vm as any;
    await vm.run();
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.error).toContain("job failed");
    mocks.recompute.mockRejectedValue({
      response: { data: { message: "dirty scope needs an active table" } },
    });
    await vm.run();
    expect(vm.error).toBe("dirty scope needs an active table");
    mocks.recompute.mockResolvedValue({ jobId: "j2" });
    mocks.fetchJob.mockClear();
    await vm.run();
    vm.dialog = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.fetchJob).not.toHaveBeenCalled();
    expect(vm.running).toBe(false);
  });
});
