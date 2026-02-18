import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockMoveItems = vi.fn();
const mockRenameItem = vi.fn();
const mockDeleteItems = vi.fn();
const mockDownloadResource = vi.fn();
const mockMoveFolderToAssetstore = vi.fn();

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    assetstores: [
      { _id: "as1", name: "Default" },
      { _id: "as2", name: "S3" },
    ],
    api: {
      moveItems: (...args: any[]) => mockMoveItems(...args),
      renameItem: (...args: any[]) => mockRenameItem(...args),
      deleteItems: (...args: any[]) => mockDeleteItems(...args),
      downloadResource: (...args: any[]) => mockDownloadResource(...args),
      moveFolderToAssetstore: (...args: any[]) =>
        mockMoveFolderToAssetstore(...args),
    },
  },
}));

const mockRessourceChanged = vi.fn();
vi.mock("@/store/girderResources", () => ({
  default: {
    ressourceChanged: (...args: any[]) => mockRessourceChanged(...args),
  },
}));

vi.mock("@/utils/download", () => ({
  downloadToClient: vi.fn(),
}));

import FileManagerOptions from "./FileManagerOptions.vue";

Vue.use(Vuetify);

// Mock URL.createObjectURL for download tests
globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-url");

function makeItem(overrides: any = {}) {
  return {
    _id: "item1",
    _modelType: "folder",
    name: "TestFolder",
    ...overrides,
  };
}

function mountComponent(props: any = {}) {
  return shallowMount(FileManagerOptions, {
    vuetify: new Vuetify(),
    propsData: {
      items: [makeItem()],
      ...props,
    },
    stubs: {
      GirderLocationChooser: true,
      AddToProjectDialog: true,
    },
  });
}

describe("FileManagerOptions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockMoveItems.mockResolvedValue(undefined);
    mockRenameItem.mockResolvedValue(undefined);
    mockDeleteItems.mockResolvedValue(undefined);
    mockDownloadResource.mockResolvedValue(new Blob(["data"]));
    mockMoveFolderToAssetstore.mockResolvedValue(undefined);
  });

  it("initializes with disableOptions false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.disableOptions).toBe(false);
    wrapper.destroy();
  });

  it("initializes with isLoading false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isLoading).toBe(false);
    wrapper.destroy();
  });

  it("initializes dialogs as closed", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.moveDialog).toBe(false);
    expect(vm.renameDialog).toBe(false);
    expect(vm.deleteDialog).toBe(false);
    wrapper.destroy();
  });

  it("computes assetstores from store", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.assetstores).toHaveLength(2);
    expect(vm.assetstores[0].name).toBe("Default");
    wrapper.destroy();
  });

  it("isADialogOpen returns false when all dialogs are closed", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isADialogOpen).toBe(false);
    wrapper.destroy();
  });

  it("isADialogOpen returns true when moveDialog is open", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.moveDialog = true;
    expect(vm.isADialogOpen).toBe(true);
    wrapper.destroy();
  });

  it("isADialogOpen returns true when deleteDialog is open", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.deleteDialog = true;
    expect(vm.isADialogOpen).toBe(true);
    wrapper.destroy();
  });

  it("isADialogOpen returns true when renameDialog is open", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.renameDialog = true;
    expect(vm.isADialogOpen).toBe(true);
    wrapper.destroy();
  });

  it("sets newName from items on mount", () => {
    const wrapper = mountComponent({
      items: [makeItem({ name: "MyDataset" })],
    });
    const vm = wrapper.vm as any;
    expect(vm.newName).toBe("MyDataset");
    wrapper.destroy();
  });

  it("closeMenu emits closeMenu event", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.closeMenu();
    expect(wrapper.emitted("closeMenu")).toBeTruthy();
    wrapper.destroy();
  });

  it("move calls api.moveItems and emits itemsChanged", async () => {
    const items = [makeItem()];
    const wrapper = mountComponent({ items });
    const vm = wrapper.vm as any;
    const location = { _id: "target-folder" };
    await vm.move(location);
    expect(mockMoveItems).toHaveBeenCalledWith(items, "target-folder");
    expect(mockRessourceChanged).toHaveBeenCalledWith("item1");
    expect(wrapper.emitted("itemsChanged")).toBeTruthy();
    wrapper.destroy();
  });

  it("move does nothing when location is null", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.move(null);
    expect(mockMoveItems).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("rename calls api.renameItem and emits itemsChanged", async () => {
    const item = makeItem({ _modelType: "folder" });
    const wrapper = mountComponent({ items: [item] });
    const vm = wrapper.vm as any;
    vm.newName = "NewName";
    await vm.rename();
    expect(mockRenameItem).toHaveBeenCalledWith(item, "NewName");
    expect(wrapper.emitted("itemsChanged")).toBeTruthy();
    expect(vm.newName).toBe("");
    expect(vm.renameDialog).toBe(false);
    wrapper.destroy();
  });

  it("rename does nothing when items length is not 1", async () => {
    const wrapper = mountComponent({
      items: [makeItem({ _id: "a" }), makeItem({ _id: "b" })],
    });
    const vm = wrapper.vm as any;
    await vm.rename();
    expect(mockRenameItem).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("rename does nothing for unsupported model types", async () => {
    const wrapper = mountComponent({
      items: [makeItem({ _modelType: "file" })],
    });
    const vm = wrapper.vm as any;
    await vm.rename();
    expect(mockRenameItem).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("deleteItems calls api.deleteItems and emits itemsChanged", async () => {
    const items = [makeItem()];
    const wrapper = mountComponent({ items });
    const vm = wrapper.vm as any;
    vm.deleteDialog = true;
    await vm.deleteItems();
    expect(mockDeleteItems).toHaveBeenCalledWith(items);
    expect(vm.deleteDialog).toBe(false);
    expect(wrapper.emitted("itemsChanged")).toBeTruthy();
    wrapper.destroy();
  });

  it("downloadResource calls api.downloadResource for file items", async () => {
    const item = makeItem({ _modelType: "file", name: "test.csv" });
    const wrapper = mountComponent({ items: [item] });
    const vm = wrapper.vm as any;
    await vm.downloadResource();
    expect(mockDownloadResource).toHaveBeenCalledWith(item);
    expect(wrapper.emitted("closeMenu")).toBeTruthy();
    wrapper.destroy();
  });

  it("downloadResource calls api.downloadResource for item modelType", async () => {
    const item = makeItem({ _modelType: "item", name: "test.csv" });
    const wrapper = mountComponent({ items: [item] });
    const vm = wrapper.vm as any;
    await vm.downloadResource();
    expect(mockDownloadResource).toHaveBeenCalledWith(item);
    wrapper.destroy();
  });

  it("downloadResource does nothing when items length is not 1", async () => {
    const wrapper = mountComponent({
      items: [makeItem({ _id: "a" }), makeItem({ _id: "b" })],
    });
    const vm = wrapper.vm as any;
    await vm.downloadResource();
    expect(mockDownloadResource).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("downloadResource does nothing for folder modelType", async () => {
    const wrapper = mountComponent({
      items: [makeItem({ _modelType: "folder" })],
    });
    const vm = wrapper.vm as any;
    await vm.downloadResource();
    expect(mockDownloadResource).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("onAddedToProject closes dialog and emits closeMenu", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.onAddedToProject();
    expect(wrapper.emitted("closeMenu")).toBeTruthy();
    wrapper.destroy();
  });

  it("watcher updates newName when items change", async () => {
    const wrapper = mountComponent({
      items: [makeItem({ name: "Original" })],
    });
    const vm = wrapper.vm as any;
    expect(vm.newName).toBe("Original");

    wrapper.setProps({ items: [makeItem({ name: "Updated" })] });
    await Vue.nextTick();
    expect(vm.newName).toBe("Updated");
    wrapper.destroy();
  });
});
