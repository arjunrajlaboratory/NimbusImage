import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test Dataset" },
    api: {
      duplicateConfiguration: vi.fn().mockResolvedValue({ id: "config-new" }),
    },
    createDatasetView: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    getFolder: vi.fn().mockResolvedValue({
      _id: "parent-1",
      name: "Parent",
      parentId: "grandparent-1",
      _modelType: "folder",
    }),
  },
}));

import { routerProvider } from "@/test/helpers";
import store from "@/store";
import girderResources from "@/store/girderResources";
import DuplicateImportConfiguration from "./DuplicateImportConfiguration.vue";

const mockRouter = { back: vi.fn() };

function mountComponent() {
  return mount(DuplicateImportConfiguration, {
    global: {
      provide: {
        ...routerProvider(mockRouter),
      },
      stubs: {
        ConfigurationSelect: true,
        GirderLocationChooser: true,
      },
    },
  });
}

describe("DuplicateImportConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("datasetName returns dataset name", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).datasetName).toBe("Test Dataset");
  });

  it("datasetName returns empty string when no dataset", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).datasetName).toBe("");
    (store as any).dataset = { id: "ds-1", name: "Test Dataset" };
  });

  it("fetchParentFolder calls girderResources.getFolder", async () => {
    const wrapper = mountComponent();
    await (wrapper.vm as any).fetchParentFolder();
    expect(girderResources.getFolder).toHaveBeenCalledWith("ds-1");
  });

  it("cancel calls router.back", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).cancel();
    expect(mockRouter.back).toHaveBeenCalled();
  });
});
