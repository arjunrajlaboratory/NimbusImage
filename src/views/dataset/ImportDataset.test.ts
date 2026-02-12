import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    api: {
      getImages: vi.fn().mockResolvedValue([]),
    },
    importDataset: vi.fn().mockResolvedValue(null),
  },
}));

import store from "@/store";
import ImportDataset from "./ImportDataset.vue";

Vue.use(Vuetify);

function mountComponent() {
  return mount(ImportDataset, {
    vuetify: new Vuetify(),
    mocks: {
      $router: { push: vi.fn() },
    },
    stubs: {
      GirderLocationChooser: true,
    },
  });
}

describe("ImportDataset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pathName returns empty string when path is null", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).pathName).toBe("");
  });

  it("pathName returns name when path is set", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).path = {
      _id: "123",
      name: "My Folder",
      _modelType: "folder",
    };
    expect((wrapper.vm as any).pathName).toBe("My Folder");
  });

  it("rules require non-empty value", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).rules[0]("")).toBe("value is required");
    expect((wrapper.vm as any).rules[0]("test")).toBe(true);
  });

  it("submit calls importDataset and navigates on success", async () => {
    (store.importDataset as any).mockResolvedValue({
      id: "new-ds",
    });
    const wrapper = mountComponent();
    (wrapper.vm as any).valid = true;
    (wrapper.vm as any).path = {
      _id: "123",
      name: "Folder",
      _modelType: "folder",
    };
    await (wrapper.vm as any).submit();
    await wrapper.vm.$nextTick();
    expect(store.importDataset).toHaveBeenCalled();
  });

  it("submit does nothing when invalid", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).valid = false;
    await (wrapper.vm as any).submit();
    expect(store.importDataset).not.toHaveBeenCalled();
  });
});
