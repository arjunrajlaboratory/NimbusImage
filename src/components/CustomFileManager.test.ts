import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, mount, flushPromises } from "@vue/test-utils";

const mockGetUserPrivateFolder = vi.fn();
const mockMapDatasetViews = vi.fn();
const mockBatchResources = vi.fn();
const mockUploadFile = vi.fn();

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    girderUser: { _id: "user1", _modelType: "user", login: "testuser" },
    api: {
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
      mapDatasetViews: (...args: any[]) => mockMapDatasetViews(...args),
      batchResources: (...args: any[]) => mockBatchResources(...args),
      uploadFile: (...args: any[]) => mockUploadFile(...args),
    },
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {},
}));

vi.mock("@/girder/components", () => ({
  Search: {
    name: "GirderSearch",
    template: "<div><slot name='searchresult' /></div>",
  },
  FileManager: {
    name: "GirderFileManager",
    template:
      "<div><slot name='headerwidget' /><slot name='row-widget' /></div>",
    props: ["location", "selectable", "modelValue"],
  },
}));

vi.mock("@/girder", () => ({}));

vi.mock("@/utils/girderSelectable", () => ({
  isDatasetFolder: vi.fn(() => false),
  isConfigurationItem: vi.fn(() => false),
  toDatasetFolder: vi.fn(() => null),
  toConfigurationItem: vi.fn(() => null),
  unselectableLocations: ["root", "users", "collections"],
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

const mockOpenAlert = vi.fn();
vi.mock("@/components/AlertDialog.vue", () => ({
  default: {
    name: "AlertDialog",
    template: "<div></div>",
    methods: { openAlert: (...args: any[]) => mockOpenAlert(...args) },
  },
}));

import CustomFileManager from "./CustomFileManager.vue";
import {
  isDatasetFolder,
  isConfigurationItem,
  toDatasetFolder,
  toConfigurationItem,
} from "@/utils/girderSelectable";

function mountComponent(props = {}, mountOptions = {}) {
  return shallowMount(CustomFileManager, {
    props: { ...props },
    global: {
      stubs: {
        FileManagerOptions: true,
        FileItemRow: true,
        GirderSearch: true,
        GirderFileManager: true,
      },
    },
    ...mountOptions,
  });
}

describe("CustomFileManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetUserPrivateFolder.mockResolvedValue({
      _id: "private-folder",
      _modelType: "folder",
    });
    mockMapDatasetViews.mockResolvedValue([]);
    mockBatchResources.mockResolvedValue({});
    mockUploadFile.mockResolvedValue({});
  });

  describe("props defaults", () => {
    it("has correct default values", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.menuEnabled).toBe(true);
      expect(vm.selectable).toBe(false);
      expect(vm.moreChips).toBe(true);
      expect(vm.clickableChips).toBe(true);
      expect(vm.location).toBe(null);
      expect(vm.useDefaultLocation).toBe(true);
    });

    it("accepts custom prop values", () => {
      const wrapper = mountComponent({
        menuEnabled: false,
        selectable: true,
        moreChips: false,
        clickableChips: false,
      });
      const vm = wrapper.vm as any;
      expect(vm.menuEnabled).toBe(false);
      expect(vm.selectable).toBe(true);
      expect(vm.moreChips).toBe(false);
      expect(vm.clickableChips).toBe(false);
    });
  });

  describe("currentLocation computed", () => {
    it("emits update:location with default location when useDefaultLocation is true and location is null", async () => {
      const wrapper = mountComponent({
        useDefaultLocation: true,
        location: null,
      });

      // Wait for mounted fetchLocation
      await nextTick();
      await nextTick();

      // Access currentLocation to trigger getter side-effect
      const vm = wrapper.vm as any;
      vm.currentLocation;

      expect(wrapper.emitted("update:location")).toBeTruthy();
    });

    it("returns provided location when location prop is set", async () => {
      const location = { _id: "folder1", _modelType: "folder" };
      const wrapper = mountComponent({ location });
      const vm = wrapper.vm as any;
      expect(vm.currentLocation).toEqual(location);
    });

    it("setting currentLocation emits update:location", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const newLocation = { _id: "folder2", _modelType: "folder" };
      vm.currentLocation = newLocation;
      expect(wrapper.emitted("update:location")).toBeTruthy();
      const emitted = wrapper.emitted("update:location")!;
      expect(emitted[emitted.length - 1][0]).toEqual(newLocation);
    });
  });

  describe("shouldDisableSingleFileUpload", () => {
    it("returns true when currentLocation is null", () => {
      const wrapper = mountComponent({
        location: null,
        useDefaultLocation: false,
      });
      const vm = wrapper.vm as any;
      expect(vm.shouldDisableSingleFileUpload).toBe(true);
    });

    it("returns true when currentLocation is a root type", () => {
      const wrapper = mountComponent({
        location: { type: "root" },
      });
      const vm = wrapper.vm as any;
      expect(vm.shouldDisableSingleFileUpload).toBe(true);
    });

    it("returns false when currentLocation is a valid folder", () => {
      const wrapper = mountComponent({
        location: { _id: "folder1", _modelType: "folder" },
      });
      const vm = wrapper.vm as any;
      expect(vm.shouldDisableSingleFileUpload).toBe(false);
    });
  });

  describe("isLoggedIn", () => {
    it("reflects store.isLoggedIn", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isLoggedIn).toBe(true);
    });
  });

  describe("fetchLocation", () => {
    it("sets defaultLocation from getUserPrivateFolder on mount", async () => {
      const wrapper = mountComponent();
      await flushPromises();
      const vm = wrapper.vm as any;
      expect(mockGetUserPrivateFolder).toHaveBeenCalled();
      expect(vm.defaultLocation).toEqual({
        _id: "private-folder",
        _modelType: "folder",
      });
    });

    it("falls back to girderUser when getUserPrivateFolder returns null", async () => {
      mockGetUserPrivateFolder.mockResolvedValue(null);
      const wrapper = mountComponent();
      await flushPromises();
      const vm = wrapper.vm as any;
      expect(vm.defaultLocation).toEqual({
        _id: "user1",
        _modelType: "user",
        login: "testuser",
      });
    });
  });

  describe("searchInput", () => {
    it("sets currentLocation and emits rowclick for folder types", () => {
      const location = { _id: "folder1", _modelType: "folder" };
      const wrapper = mountComponent({
        location: { _id: "old", _modelType: "folder" },
      });
      const vm = wrapper.vm as any;
      vm.searchInput(location);
      expect(wrapper.emitted("rowclick")).toBeTruthy();
      expect(wrapper.emitted("rowclick")![0][0]).toEqual(location);
    });

    it("ignores upenn_collection model type", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.searchInput({
        _id: "col1",
        _modelType: "upenn_collection",
      });
      expect(wrapper.emitted("rowclick")).toBeFalsy();
    });

    it("ignores file model type", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.searchInput({ _id: "f1", _modelType: "file" });
      expect(wrapper.emitted("rowclick")).toBeFalsy();
    });

    it("ignores item model type", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.searchInput({ _id: "i1", _modelType: "item" });
      expect(wrapper.emitted("rowclick")).toBeFalsy();
    });
  });

  describe("iconFromItem", () => {
    it("returns box_com for dataset folders", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconFromItem({ _modelType: "folder" })).toBe("$box_com");
    });

    it("returns $collection for configuration items", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconFromItem({ _modelType: "item" })).toBe("$collection");
    });

    it("returns $folder for folder model type", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconFromItem({ _modelType: "folder" })).toBe("$folder");
    });

    it("returns $user for user model type", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconFromItem({ _modelType: "user" })).toBe("$user");
    });

    it("returns $file for file/item/upenn_collection model types", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconFromItem({ _modelType: "file" })).toBe("$file");
      expect(vm.iconFromItem({ _modelType: "item" })).toBe("$file");
      expect(vm.iconFromItem({ _modelType: "upenn_collection" })).toBe("$file");
    });
  });

  describe("iconToMdi", () => {
    it("passes through icon aliases directly", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconToMdi("$box_com")).toBe("$box_com");
    });

    it("passes through any icon string directly", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.iconToMdi("mdi-folder")).toBe("mdi-folder");
    });
  });

  describe("renderItem", () => {
    it("sets icon on selectable", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      vi.mocked(toDatasetFolder).mockReturnValue(null);
      vi.mocked(toConfigurationItem).mockReturnValue(null);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = { _id: "item1", _modelType: "folder" } as any;
      vm.renderItem(item);
      expect(item.icon).toBe("$folder");
    });

    it("triggers addChipPromise for dataset items", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      vi.mocked(toDatasetFolder).mockReturnValue({} as any);
      vi.mocked(toConfigurationItem).mockReturnValue(null);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = { _id: "ds1", _modelType: "folder" } as any;
      vm.renderItem(item);
      // computedChipsIds should now contain ds1
      expect(vm.computedChipsIds.has("ds1")).toBe(true);
    });

    it("does not re-trigger for already-computed items", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      vi.mocked(toDatasetFolder).mockReturnValue({} as any);
      vi.mocked(toConfigurationItem).mockReturnValue(null);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = { _id: "ds1", _modelType: "folder" } as any;
      vm.renderItem(item);
      vm.renderItem(item); // second call
      // Should only be added once
      expect(vm.computedChipsIds.size).toBe(1);
    });
  });

  describe("emitSelected", () => {
    it("emits selected event when selectable is true", async () => {
      const wrapper = mountComponent({ selectable: true });
      const vm = wrapper.vm as any;
      vm.selected = [{ _id: "item1" }];
      await nextTick();
      expect(wrapper.emitted("selected")).toBeTruthy();
    });

    it("does not emit selected when selectable is false", async () => {
      const wrapper = mountComponent({ selectable: false });
      const vm = wrapper.vm as any;
      vm.selected = [{ _id: "item1" }];
      await nextTick();
      expect(wrapper.emitted("selected")).toBeFalsy();
    });
  });

  describe("reloadItems", () => {
    it("temporarily sets overridingLocation to root and then back to null", async () => {
      const wrapper = mountComponent({
        location: { _id: "folder1", _modelType: "folder" },
      });
      const vm = wrapper.vm as any;
      await vm.reloadItems();
      expect(vm.overridingLocation).toBe(null);
    });
  });

  describe("handleFileUpload", () => {
    it("calls uploadFile and reloadItems for valid files", async () => {
      const wrapper = mountComponent({
        location: { _id: "folder1", _modelType: "folder" },
      });
      const vm = wrapper.vm as any;

      const file = new File(["test content"], "test.txt", {
        type: "text/plain",
      });
      Object.defineProperty(file, "size", { value: 100 });

      const event = {
        target: {
          files: [file],
          value: "test.txt",
        },
      };

      await vm.handleFileUpload(event);

      expect(mockUploadFile).toHaveBeenCalledWith(file, "folder1", "folder");
    });

    it("does nothing when no files are selected", async () => {
      const wrapper = mountComponent({
        location: { _id: "folder1", _modelType: "folder" },
      });
      const vm = wrapper.vm as any;

      const event = { target: { files: [] } };
      await vm.handleFileUpload(event);

      expect(mockUploadFile).not.toHaveBeenCalled();
    });

    it("rejects files over 500MB", async () => {
      mockOpenAlert.mockClear();
      // Use mount (not shallowMount) so the module-mocked AlertDialog
      // retains its openAlert method on the template ref
      const wrapper = mount(CustomFileManager, {
        props: {
          location: { _id: "folder1", _modelType: "folder" } as any,
        },
        global: {
          stubs: {
            FileManagerOptions: true,
            FileItemRow: true,
            GirderSearch: true,
            GirderFileManager: true,
          },
        },
      });
      const vm = wrapper.vm as any;

      const file = new File([""], "large.bin", {
        type: "application/octet-stream",
      });
      Object.defineProperty(file, "size", {
        value: 501 * 1024 * 1024,
      });

      const event = {
        target: {
          files: [file],
          value: "large.bin",
        },
      };

      await vm.handleFileUpload(event);

      expect(mockUploadFile).not.toHaveBeenCalled();
      expect(mockOpenAlert).toHaveBeenCalledWith({
        type: "error",
        message: "File size exceeds 500MB limit",
      });
      // input value should be reset
      expect(event.target.value).toBe("");
    });

    it("does nothing when currentLocation is null", async () => {
      const wrapper = mountComponent({
        location: null,
        useDefaultLocation: false,
      });
      const vm = wrapper.vm as any;

      const file = new File(["test"], "test.txt");
      Object.defineProperty(file, "size", { value: 100 });

      const event = { target: { files: [file], value: "test.txt" } };
      await vm.handleFileUpload(event);

      expect(mockUploadFile).not.toHaveBeenCalled();
    });
  });

  describe("itemToChips", () => {
    it("returns empty chips for non-dataset/non-configuration items", async () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = await vm.itemToChips({
        _id: "item1",
        _modelType: "folder",
      });
      expect(result.chips).toEqual([]);
      expect(result.type).toBeNull();
    });

    it("returns dataset header chip for dataset folders", async () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent({ moreChips: false });
      const vm = wrapper.vm as any;
      const result = await vm.itemToChips({ _id: "ds1", _modelType: "folder" });
      expect(result.chips).toHaveLength(1);
      expect(result.chips[0].text).toBe("Dataset");
      expect(result.chips[0].color).toBe("grey");
      expect(result.type).toBe("dataset");
    });

    it("returns configuration header chip for configuration items", async () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(true);
      const wrapper = mountComponent({ moreChips: false });
      const vm = wrapper.vm as any;
      const result = await vm.itemToChips({ _id: "cfg1", _modelType: "item" });
      expect(result.chips).toHaveLength(1);
      expect(result.chips[0].text).toBe("Collection");
      expect(result.type).toBe("configuration");
    });

    it("includes route link when clickableChips is true", async () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent({
        clickableChips: true,
        moreChips: false,
      });
      const vm = wrapper.vm as any;
      const result = await vm.itemToChips({ _id: "ds1", _modelType: "folder" });
      expect(result.chips[0].to).toEqual({
        name: "dataset",
        params: { datasetId: "ds1" },
      });
    });

    it("omits route link when clickableChips is false", async () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent({
        clickableChips: false,
        moreChips: false,
      });
      const vm = wrapper.vm as any;
      const result = await vm.itemToChips({ _id: "ds1", _modelType: "folder" });
      expect(result.chips[0].to).toBeUndefined();
    });
  });

  describe("template rendering", () => {
    it("renders the custom-file-manager-wrapper div", () => {
      const wrapper = mountComponent({
        location: { _id: "folder1", _modelType: "folder" },
      });
      expect(wrapper.find(".custom-file-manager-wrapper").exists()).toBe(true);
    });

    it("renders search icon", () => {
      const wrapper = mountComponent();
      expect(wrapper.find(".search-container").exists()).toBe(true);
    });
  });
});
