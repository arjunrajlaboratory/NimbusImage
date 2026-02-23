import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test Dataset" },
    setSelectedDataset: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store/sync", () => ({
  default: {
    datasetLoading: false,
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import { routeProvider } from "@/test/helpers";
import store from "@/store";
import sync from "@/store/sync";
import Dataset from "./Dataset.vue";

function mountComponent(routeParams = { datasetId: "ds-1" }) {
  return mount(Dataset, {
    global: {
      provide: {
        ...routeProvider({ params: routeParams }),
      },
      stubs: {
        "router-view": true,
      },
    },
  });
}

describe("Dataset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store.setSelectedDataset as any).mockResolvedValue(undefined);
    (sync as any).datasetLoading = false;
  });

  it("isLoading is true when sync.datasetLoading is true", () => {
    (sync as any).datasetLoading = true;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isLoading).toBe(true);
  });

  it("datasetReady is true when store.dataset and isReady", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    expect((wrapper.vm as any).datasetReady).toBe(true);
  });

  it("loadDataset calls store.setSelectedDataset", async () => {
    const wrapper = mountComponent();
    await (wrapper.vm as any).loadDataset();
    expect(store.setSelectedDataset).toHaveBeenCalledWith("ds-1");
  });

  it("loadDataset sets isReady on success", async () => {
    const wrapper = mountComponent();
    await (wrapper.vm as any).loadDataset();
    expect((wrapper.vm as any).isReady).toBe(true);
  });

  it("loadDataset sets isReady false on failure", async () => {
    (store.setSelectedDataset as any).mockRejectedValue(new Error("fail"));
    const wrapper = mountComponent();
    await (wrapper.vm as any).loadDataset();
    expect((wrapper.vm as any).isReady).toBe(false);
  });
});
