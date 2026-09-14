import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  fetchVersions: vi.fn(),
  fetchStaleness: vi.fn(),
  activateVersion: vi.fn(),
  refreshInfo: vi.fn(),
  refreshVirtualPropertyValues: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    spatialAPI: {
      fetchVersions: mocks.fetchVersions,
      fetchStaleness: mocks.fetchStaleness,
      activateVersion: mocks.activateVersion,
    },
  },
}));

vi.mock("@/store/spatial", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({ hasTable: true, refreshInfo: mocks.refreshInfo }),
  };
});

vi.mock("@/store/properties", () => ({
  default: { refreshVirtualPropertyValues: mocks.refreshVirtualPropertyValues },
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));

import CellTableCard from "./CellTableCard.vue";
import spatialStore from "@/store/spatial";

const VERSIONS = {
  active: {
    itemId: "i2",
    label: "v2",
    nObs: 10,
    nVar: 3,
    created: null,
    provenance: {},
  },
  versions: [
    {
      itemId: "i1",
      label: "Imported table",
      nObs: 6,
      nVar: 4,
      created: null,
      provenance: {},
    },
  ],
};
const STALE = {
  added: 1,
  changed: 2,
  removed: 0,
  addedIds: ["a"],
  changedIds: ["b", "c"],
  removedIds: [],
  hasGeometryHashes: true,
  cells: 11,
  rows: 10,
  upToDate: false,
};

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe("CellTableCard", () => {
  beforeEach(() => {
    mocks.fetchVersions.mockReset().mockResolvedValue(VERSIONS);
    mocks.fetchStaleness.mockReset().mockResolvedValue(STALE);
    mocks.activateVersion.mockReset();
    mocks.refreshInfo.mockReset().mockResolvedValue(undefined);
    mocks.refreshVirtualPropertyValues.mockReset().mockResolvedValue(undefined);
    (spatialStore as any).hasTable = true;
  });

  it("reads versions and staleness only when shown", async () => {
    const wrapper = shallowMount(CellTableCard, { props: { visible: false } });
    await flush();
    expect(mocks.fetchVersions).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    await flush();
    expect(mocks.fetchVersions).toHaveBeenCalledWith("ds1");
    const vm = wrapper.vm as any;
    expect(vm.versionItems.map((i: any) => i.title)).toEqual([
      "v2 — 10 cells × 3 genes",
      "Imported table — 6 cells × 4 genes",
    ]);
    expect(vm.stalenessText).toBe(
      "1 cells added, 2 edited since this table was built.",
    );
  });

  it("explains that an imported table cannot report edits, and up to date", async () => {
    mocks.fetchStaleness.mockResolvedValue({
      ...STALE,
      changed: 0,
      hasGeometryHashes: false,
    });
    const wrapper = shallowMount(CellTableCard, { props: { visible: true } });
    await flush();
    expect((wrapper.vm as any).stalenessText).toContain(
      "recompute once to start tracking",
    );
    mocks.fetchStaleness.mockResolvedValue({ ...STALE, upToDate: true });
    await (wrapper.vm as any).refresh(true);
    expect((wrapper.vm as any).stalenessText).toBe(
      "Up to date with the cell polygons.",
    );
  });

  it("switching the version re-reads the table and the live gene columns", async () => {
    const swapped = {
      active: VERSIONS.versions[0],
      versions: [VERSIONS.active],
    };
    mocks.activateVersion.mockResolvedValue(swapped);
    const wrapper = shallowMount(CellTableCard, { props: { visible: true } });
    await flush();
    const vm = wrapper.vm as any;
    await vm.activate("i2"); // already active: no request
    expect(mocks.activateVersion).not.toHaveBeenCalled();
    // The registry answers with the swapped order from now on.
    mocks.fetchVersions.mockResolvedValue(swapped);
    await vm.activate("i1");
    expect(mocks.activateVersion).toHaveBeenCalledWith("ds1", "i1");
    expect(mocks.refreshInfo).toHaveBeenCalledTimes(1);
    expect(mocks.refreshVirtualPropertyValues).toHaveBeenCalledTimes(1);
    expect(mocks.fetchStaleness).toHaveBeenCalledTimes(2);
    expect(vm.versionItems[0].title).toContain("Imported table");
  });

  it("shows the error when the registry cannot be read", async () => {
    mocks.fetchVersions.mockRejectedValue(new Error("offline"));
    const wrapper = shallowMount(CellTableCard, { props: { visible: true } });
    await flush();
    expect((wrapper.vm as any).error).toBe("offline");
  });
});
