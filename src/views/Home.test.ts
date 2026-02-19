import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

// --- Top-level mock fn handles (hoisted before vi.mock calls) ---
const mockSetFolderLocation = vi.fn();
const mockInitializeUploadWorkflow = vi.fn();
const mockFetchRecentDatasetViews = vi.fn().mockResolvedValue([]);
const mockCheckDatasetNameExists = vi.fn().mockResolvedValue(false);
const mockFetchProjects = vi.fn().mockResolvedValue([]);
const mockBatchFetchResources = vi.fn().mockResolvedValue(undefined);
const mockGetUser = vi.fn().mockResolvedValue(null);
const mockPersisterGet = vi.fn(
  (_key: string, defaultValue: any) => defaultValue,
);
const mockPersisterSet = vi.fn();

// --- Store mocks ---
vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    folderLocation: {
      _id: "folder1",
      _modelType: "folder",
      name: "My Folder",
    },
    recentDatasetViews: [],
    setFolderLocation: (...args: any[]) => mockSetFolderLocation(...args),
    initializeUploadWorkflow: (...args: any[]) =>
      mockInitializeUploadWorkflow(...args),
    fetchRecentDatasetViews: (...args: any[]) =>
      mockFetchRecentDatasetViews(...args),
    api: {
      checkDatasetNameExists: (...args: any[]) =>
        mockCheckDatasetNameExists(...args),
    },
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    watchFolder: vi.fn().mockReturnValue(null),
    watchCollection: vi.fn().mockReturnValue(null),
    watchUser: vi.fn().mockReturnValue(null),
    getUser: (...args: any[]) => mockGetUser(...args),
    batchFetchResources: (...args: any[]) => mockBatchFetchResources(...args),
    resources: {},
    resourcesLocks: {},
  },
}));

vi.mock("@/store/projects", () => ({
  default: {
    get recentProjects() {
      return [];
    },
    fetchProjects: (...args: any[]) => mockFetchProjects(...args),
  },
}));

vi.mock("@/store/Persister", () => ({
  default: {
    get: (...args: any[]) => mockPersisterGet(...args),
    set: (...args: any[]) => mockPersisterSet(...args),
  },
}));

// --- Utility mocks ---
vi.mock("@/utils/girderSelectable", () => ({
  isDatasetFolder: vi.fn(() => false),
  isConfigurationItem: vi.fn(() => false),
}));

vi.mock("@/utils/date", () => ({
  formatDateNumber: vi.fn((ts: number) => String(ts)),
  formatDate: vi.fn(() => "2026-01-01"),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/utils/parsing", () => ({
  triggersPerCategory: {},
}));

// --- Child component / girder mocks ---
vi.mock("@/girder/components", () => ({
  Upload: { name: "GirderUpload", template: "<div />" },
}));

// Import after mocks
import Home from "./Home.vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { isDatasetFolder, isConfigurationItem } from "@/utils/girderSelectable";

Vue.use(Vuetify);

// --- Helper ---
const mockRouter = { push: vi.fn() };
const mockStartTour = vi.fn();

function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return shallowMount(Home, {
    vuetify: new Vuetify(),
    attachTo: app,
    mocks: {
      $route: { name: "root", params: {} },
      $router: mockRouter,
      $startTour: mockStartTour,
    },
    stubs: {
      "custom-file-manager": true,
      "recent-datasets": true,
      "recent-projects": true,
      "collection-list": true,
      "project-list": true,
      "zenodo-importer": true,
      "zenodo-community-display": true,
      "girder-location-chooser": true,
      "girder-upload": true,
      "file-dropzone": true,
    },
  });
}

// --- Import standalone functions for direct testing ---
// They are not exported, so we test them via the component's computed/methods.

describe("Home", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-wire mock fns after restoreAllMocks
    mockRouter.push = vi.fn();
    mockStartTour.mockReset();
    mockSetFolderLocation.mockReset();
    mockInitializeUploadWorkflow.mockReset();
    mockFetchRecentDatasetViews.mockResolvedValue([]);
    mockCheckDatasetNameExists.mockResolvedValue(false);
    mockFetchProjects.mockResolvedValue([]);
    mockBatchFetchResources.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue(null);
    mockPersisterGet.mockImplementation(
      (_key: string, defaultValue: any) => defaultValue,
    );
    mockPersisterSet.mockReset();

    // Reset store state
    (store as any).isLoggedIn = true;
    (store as any).folderLocation = {
      _id: "folder1",
      _modelType: "folder",
      name: "My Folder",
    };
    (store as any).recentDatasetViews = [];

    // Reset girderResources mocks
    vi.mocked(girderResources.watchFolder).mockReturnValue(null as any);
    vi.mocked(girderResources.watchCollection).mockReturnValue(null as any);
    (girderResources as any).resourcesLocks = {};
  });

  // =========================================================================
  // 1. Utility Functions (tested via component methods/computeds)
  // =========================================================================
  describe("basename (via recommendedName)", () => {
    it("strips extension from filename", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "file.tif")];
      expect(vm.recommendedName).toBe("file");
      wrapper.destroy();
    });

    it("handles filename with no extension", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "file")];
      expect(vm.recommendedName).toBe("file");
      wrapper.destroy();
    });

    it("handles filename with multiple dots", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "file.ome.tif")];
      expect(vm.recommendedName).toBe("file.ome");
      wrapper.destroy();
    });
  });

  describe("findCommonPrefix (via recommendedName)", () => {
    it("returns empty for empty array", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [];
      expect(vm.recommendedName).toBe("");
      wrapper.destroy();
    });

    it("returns single string for single file", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "abc.tif")];
      expect(vm.recommendedName).toBe("abc");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 2. Data Defaults
  // =========================================================================
  describe("data defaults", () => {
    it("has correct initial data values", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isNavigating).toBe(false);
      expect(vm.isDragging).toBe(false);
      expect(vm.browseMode).toBe("files");
      expect(vm.batchMode).toBe(false);
      expect(vm.showUploadDialog).toBe(false);
      expect(vm.showUploadInfo).toBe(false);
      expect(vm.datasetsTab).toBe(0);
      expect(vm.nameTaken).toBe(false);
      expect(vm.datasetName).toBe("");
      expect(vm.selectedLocation).toBe(null);
      wrapper.destroy();
    });

    it("has empty arrays for pending/batch state", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.pendingFiles).toEqual([]);
      expect(vm.datasetNames).toEqual([]);
      expect(vm.nameConflicts).toEqual([]);
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 3. Computed: location
  // =========================================================================
  describe("location", () => {
    it("getter returns store.folderLocation", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.location).toEqual(store.folderLocation);
      wrapper.destroy();
    });

    it("setter calls setFolderLocation", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const newLoc = { _id: "new1", _modelType: "folder" };
      vm.location = newLoc;
      expect(mockSetFolderLocation).toHaveBeenCalledWith(newLoc);
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 3b. Computed: locationName
  // =========================================================================
  describe("locationName", () => {
    it("returns name when available", () => {
      (store as any).folderLocation = { name: "TestFolder" };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.locationName).toBe("TestFolder");
      wrapper.destroy();
    });

    it("falls back to login when no name", () => {
      (store as any).folderLocation = { login: "jdoe" };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.locationName).toBe("jdoe");
      wrapper.destroy();
    });

    it("falls back to type capitalized when no name/login", () => {
      (store as any).folderLocation = { type: "root" };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.locationName).toBe("Root");
      wrapper.destroy();
    });

    it("falls back to _modelType capitalized", () => {
      (store as any).folderLocation = { _modelType: "folder" };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.locationName).toBe("Folder");
      wrapper.destroy();
    });

    it("returns fallback for empty location", () => {
      (store as any).folderLocation = {};
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.locationName).toBe("Unknown location name");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 4. Computed: recommendedName
  // =========================================================================
  describe("recommendedName", () => {
    it("returns empty when no files", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [];
      expect(vm.recommendedName).toBe("");
      wrapper.destroy();
    });

    it("strips extension for single file", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "img.tif")];
      expect(vm.recommendedName).toBe("img");
      wrapper.destroy();
    });

    it("uses first basename when no common prefix found", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      // With triggersPerCategory mocked as {}, allTriggers is empty.
      // The regex becomes (.*?)(?:_|-) so "abc" and "xyz" have no _/- → match fails.
      // findCommonPrefix will try the regex; if match fails, it returns "".
      // When prefix is empty, recommendedName falls back to basename(first).
      vm.pendingFiles = [new File([""], "abc.tif"), new File([""], "xyz.tif")];
      expect(vm.recommendedName).toBe("abc");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 5. Computed: fileGroups
  // =========================================================================
  describe("fileGroups", () => {
    it("wraps all files in single group when not batch mode", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const f1 = new File([""], "a.tif");
      const f2 = new File([""], "b.tif");
      vm.pendingFiles = [f1, f2];
      vm.batchMode = false;
      expect(vm.fileGroups).toEqual([[f1, f2]]);
      wrapper.destroy();
    });

    it("creates per-file groups in batch mode", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const f1 = new File([""], "a.tif");
      const f2 = new File([""], "b.tif");
      vm.pendingFiles = [f1, f2];
      vm.batchMode = true;
      expect(vm.fileGroups).toEqual([[f1], [f2]]);
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 6. Computed: isFormValid
  // =========================================================================
  describe("isFormValid", () => {
    it("returns true when name, location set, and no conflicts", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "My Dataset";
      vm.selectedLocation = { _id: "loc1" };
      vm.nameTaken = false;
      vm.checkingName = false;
      expect(vm.isFormValid).toBe(true);
      wrapper.destroy();
    });

    it("returns false when name is empty", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "  ";
      vm.selectedLocation = { _id: "loc1" };
      expect(vm.isFormValid).toBe(false);
      wrapper.destroy();
    });

    it("returns false when location is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "Dataset";
      vm.selectedLocation = null;
      expect(vm.isFormValid).toBe(false);
      wrapper.destroy();
    });

    it("returns false when nameTaken is true", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "Dataset";
      vm.selectedLocation = { _id: "loc1" };
      vm.nameTaken = true;
      expect(vm.isFormValid).toBe(false);
      wrapper.destroy();
    });

    it("returns false in batch mode with empty names", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "Collection";
      vm.selectedLocation = { _id: "loc1" };
      vm.batchMode = true;
      vm.datasetNames = ["good", ""];
      vm.nameConflicts = [];
      expect(vm.isFormValid).toBe(false);
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 7. Computed: datasetViews (deduplication)
  // =========================================================================
  describe("datasetViews", () => {
    it("deduplicates by id", () => {
      (store as any).recentDatasetViews = [
        { id: "dv1", datasetId: "d1", configurationId: "c1" },
        { id: "dv1", datasetId: "d1", configurationId: "c1" },
        { id: "dv2", datasetId: "d2", configurationId: "c2" },
      ];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.datasetViews).toHaveLength(2);
      expect(vm.datasetViews[0].id).toBe("dv1");
      expect(vm.datasetViews[1].id).toBe("dv2");
      wrapper.destroy();
    });

    it("preserves first occurrence order", () => {
      (store as any).recentDatasetViews = [
        { id: "dv2", datasetId: "d2", configurationId: "c2" },
        { id: "dv1", datasetId: "d1", configurationId: "c1" },
        { id: "dv2", datasetId: "d2", configurationId: "c2" },
      ];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.datasetViews[0].id).toBe("dv2");
      expect(vm.datasetViews[1].id).toBe("dv1");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 8. Computed: datasetViewItems
  // =========================================================================
  describe("datasetViewItems", () => {
    it("filters out entries with missing configInfo", () => {
      (store as any).recentDatasetViews = [
        { id: "dv1", datasetId: "d1", configurationId: "c1" },
      ];
      vi.mocked(girderResources.watchFolder).mockReturnValue({
        _id: "d1",
        name: "Dataset",
      } as any);
      vi.mocked(girderResources.watchCollection).mockReturnValue(null as any);

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.datasetViewItems).toHaveLength(0);
      wrapper.destroy();
    });

    it("includes entries when both configInfo and datasetInfo present", () => {
      (store as any).recentDatasetViews = [
        { id: "dv1", datasetId: "d1", configurationId: "c1" },
      ];
      vi.mocked(girderResources.watchFolder).mockReturnValue({
        _id: "d1",
        name: "Dataset",
      } as any);
      vi.mocked(girderResources.watchCollection).mockReturnValue({
        _id: "c1",
        name: "Config",
      } as any);

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.datasetViewItems).toHaveLength(1);
      expect(vm.datasetViewItems[0].datasetInfo.name).toBe("Dataset");
      expect(vm.datasetViewItems[0].configInfo.name).toBe("Config");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 9. Methods: Upload Dialog
  // =========================================================================
  describe("initializeUploadDialog", () => {
    it("sets name from recommendedName + date and location from current", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "sample.tif")];
      vm.initializeUploadDialog();
      // recommendedName → "sample", formatDate mocked → "2026-01-01"
      expect(vm.datasetName).toBe("sample - 2026-01-01");
      expect(vm.selectedLocation).toEqual(store.folderLocation);
      wrapper.destroy();
    });
  });

  describe("closeUploadDialog", () => {
    it("resets all upload state", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      // Set up some state
      vm.showUploadDialog = true;
      vm.showUploadInfo = true;
      vm.pendingFiles = [new File([""], "a.tif")];
      vm.datasetName = "test";
      vm.selectedLocation = { _id: "loc1" };
      vm.nameTaken = true;
      vm.nameError = "error";
      vm.checkingName = true;
      vm.batchMode = true;
      vm.datasetNames = ["name1"];
      vm.nameConflicts = [0];
      vm.validatingNames = true;

      vm.closeUploadDialog();

      expect(vm.showUploadDialog).toBe(false);
      expect(vm.showUploadInfo).toBe(false);
      expect(vm.pendingFiles).toEqual([]);
      expect(vm.datasetName).toBe("");
      expect(vm.selectedLocation).toBe(null);
      expect(vm.nameTaken).toBe(false);
      expect(vm.nameError).toBe("");
      expect(vm.checkingName).toBe(false);
      expect(vm.batchMode).toBe(false);
      expect(vm.datasetNames).toEqual([]);
      expect(vm.nameConflicts).toEqual([]);
      expect(vm.validatingNames).toBe(false);
      wrapper.destroy();
    });
  });

  describe("handleAcceptDefaults", () => {
    it("calls quickUpload and navigates when form is valid", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "test.tif")];
      vm.datasetName = "Test Dataset";
      vm.selectedLocation = { _id: "loc1" };
      vm.nameTaken = false;
      vm.checkingName = false;

      vm.handleAcceptDefaults();

      expect(mockInitializeUploadWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ quickupload: true }),
      );
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "newdataset" });
      wrapper.destroy();
    });

    it("does nothing when form is invalid", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "";
      vm.selectedLocation = null;

      vm.handleAcceptDefaults();

      expect(mockInitializeUploadWorkflow).not.toHaveBeenCalled();
      expect(mockRouter.push).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 10. Methods: Batch Naming
  // =========================================================================
  describe("initializeDatasetNames", () => {
    it("populates datasetNames from file basenames", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [
        new File([""], "img1.tif"),
        new File([""], "img2.nd2"),
      ];
      vm.initializeDatasetNames();
      expect(vm.datasetNames).toEqual(["img1", "img2"]);
      expect(vm.nameConflicts).toEqual([]);
      wrapper.destroy();
    });
  });

  describe("getNameError", () => {
    it("returns empty string when index not in conflicts", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.nameConflicts = [];
      vm.datasetNames = ["name1"];
      expect(vm.getNameError(0)).toBe("");
      wrapper.destroy();
    });

    it("returns duplicate message when same name appears twice", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetNames = ["same", "same"];
      vm.nameConflicts = [0, 1];
      expect(vm.getNameError(0)).toBe("Duplicate name in batch");
      wrapper.destroy();
    });

    it("returns exists message for single occurrence conflict", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetNames = ["unique"];
      vm.nameConflicts = [0];
      expect(vm.getNameError(0)).toBe(
        "Dataset already exists in this location",
      );
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 11. Methods: validateDatasetNames
  // =========================================================================
  describe("validateDatasetNames", () => {
    it("detects internal duplicates", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.batchMode = true;
      vm.selectedLocation = { _id: "loc1" };
      vm.datasetNames = ["name", "name"];
      vm.pendingFiles = [new File([""], "a.tif"), new File([""], "b.tif")];

      await vm.validateDatasetNames();

      expect(vm.nameConflicts).toContain(0);
      expect(vm.nameConflicts).toContain(1);
      wrapper.destroy();
    });

    it("detects API conflicts", async () => {
      mockCheckDatasetNameExists.mockResolvedValue(true);

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.batchMode = true;
      vm.selectedLocation = { _id: "loc1" };
      vm.datasetNames = ["exists"];
      vm.pendingFiles = [new File([""], "exists.tif")];

      await vm.validateDatasetNames();

      expect(vm.nameConflicts).toContain(0);
      wrapper.destroy();
    });

    it("skips when not batch mode", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.batchMode = false;
      vm.datasetNames = ["name"];

      await vm.validateDatasetNames();

      // No conflicts set, checkDatasetNameExists not called
      expect(mockCheckDatasetNameExists).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 12. Methods: Navigation
  // =========================================================================
  describe("navigateToDatasetView", () => {
    it("sets isNavigating and pushes route", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.navigateToDatasetView("dv123");
      expect(vm.isNavigating).toBe(true);
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "datasetview",
        params: { datasetViewId: "dv123" },
      });
      wrapper.destroy();
    });
  });

  describe("onLocationUpdate", () => {
    it("routes to dataset for dataset folders", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.onLocationUpdate({ _id: "ds1", _modelType: "folder" });
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds1" },
      });
      wrapper.destroy();
    });

    it("routes to configuration for configuration items", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.onLocationUpdate({ _id: "cfg1", _modelType: "item" });
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "configuration",
        params: { configurationId: "cfg1" },
      });
      wrapper.destroy();
    });

    it("sets location for plain folders", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const folder = { _id: "f1", _modelType: "folder" };
      vm.onLocationUpdate(folder);
      expect(mockSetFolderLocation).toHaveBeenCalledWith(folder);
      wrapper.destroy();
    });

    it("ignores file model types", () => {
      vi.mocked(isDatasetFolder).mockReturnValue(false);
      vi.mocked(isConfigurationItem).mockReturnValue(false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.onLocationUpdate({ _id: "f1", _modelType: "file" });
      expect(mockSetFolderLocation).not.toHaveBeenCalled();
      expect(mockRouter.push).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("ignores upenn_collection model type", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.onLocationUpdate({ _id: "uc1", _modelType: "upenn_collection" });
      expect(mockSetFolderLocation).not.toHaveBeenCalled();
      expect(mockRouter.push).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 13. Methods: getUserDisplayName
  // =========================================================================
  describe("getUserDisplayName", () => {
    it("returns Loading... on first call", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = vm.getUserDisplayName("user1");
      expect(result).toBe("Loading...");
      wrapper.destroy();
    });

    it("caches and returns name after fetch", async () => {
      mockGetUser.mockResolvedValue({
        firstName: "John",
        lastName: "Doe",
        email: "jdoe@test.com",
      });
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      // First call triggers async fetch
      vm.getUserDisplayName("user1");

      // Flush the microtask queue so the .then() callback runs
      await new Promise((r) => setTimeout(r, 0));
      await Vue.nextTick();

      expect(vm.userDisplayNames["user1"]).toBe("John Doe (jdoe@test.com)");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 14. Tour & Login
  // =========================================================================
  describe("initializeWelcomeTour", () => {
    it("starts tour when status is NOT_YET_RUN", async () => {
      mockPersisterGet.mockReturnValue("notYetRun");
      (store as any).isLoggedIn = true;

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.initializeWelcomeTour();

      expect(mockPersisterSet).toHaveBeenCalled();
      expect(mockStartTour).toHaveBeenCalledWith("WelcomeTourHome");
      wrapper.destroy();
    });

    it("skips when not logged in", async () => {
      (store as any).isLoggedIn = false;

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.initializeWelcomeTour();

      expect(mockStartTour).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("skips when tour already run", async () => {
      // Persister returns alreadyRun, so initializeWelcomeTour should skip
      mockPersisterGet.mockReturnValue("alreadyRun");
      (store as any).isLoggedIn = true;

      // mounted() calls initializeWelcomeTour, so we need to verify
      // that $startTour was NOT called even after mount
      const wrapper = mountComponent();
      await Vue.nextTick();

      expect(mockStartTour).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 15. quickUpload and comprehensiveUpload
  // =========================================================================
  describe("quickUpload", () => {
    it("calls initializeUploadWorkflow with quickupload:true and navigates", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const files = [new File([""], "test.tif")];
      vm.quickUpload(files, "Test", { _id: "loc1" });

      expect(mockInitializeUploadWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          quickupload: true,
          initialName: "Test",
          initialUploadLocation: { _id: "loc1" },
        }),
      );
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "newdataset" });
      wrapper.destroy();
    });
  });

  describe("comprehensiveUpload", () => {
    it("calls initializeUploadWorkflow with quickupload:false and navigates", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const files = [new File([""], "test.tif")];
      vm.comprehensiveUpload(files, "Test", { _id: "loc1" });

      expect(mockInitializeUploadWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          quickupload: false,
          initialName: "Test",
        }),
      );
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "newdataset" });
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 16. handleConfigureDataset
  // =========================================================================
  describe("handleConfigureDataset", () => {
    it("calls comprehensiveUpload when form is valid", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pendingFiles = [new File([""], "test.tif")];
      vm.datasetName = "Test Dataset";
      vm.selectedLocation = { _id: "loc1" };

      vm.handleConfigureDataset();

      expect(mockInitializeUploadWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ quickupload: false }),
      );
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "newdataset" });
      wrapper.destroy();
    });

    it("does nothing when form is invalid", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.datasetName = "";

      vm.handleConfigureDataset();

      expect(mockInitializeUploadWorkflow).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 17. handleProjectClicked
  // =========================================================================
  describe("handleProjectClicked", () => {
    it("switches browseMode to projects", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.browseMode).toBe("files");
      vm.handleProjectClicked();
      expect(vm.browseMode).toBe("projects");
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 18. handleDrop
  // =========================================================================
  describe("handleDrop", () => {
    it("sets pendingFiles and shows upload dialog from drop event", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isDragging = true;

      const file = new File(["content"], "dropped.tif");
      // DataTransfer not available in jsdom, use a plain object
      const event = {
        dataTransfer: { files: [file] },
      } as unknown as DragEvent;

      vm.handleDrop(event);

      expect(vm.isDragging).toBe(false);
      expect(vm.pendingFiles).toHaveLength(1);
      expect(vm.pendingFiles[0].name).toBe("dropped.tif");
      expect(vm.showUploadDialog).toBe(true);
      wrapper.destroy();
    });

    it("does nothing when no files in drop event", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isDragging = true;

      const event = { dataTransfer: { files: [] } } as any;
      vm.handleDrop(event);

      expect(vm.isDragging).toBe(false);
      expect(vm.showUploadDialog).toBe(false);
      wrapper.destroy();
    });
  });

  // =========================================================================
  // 19. mounted behavior
  // =========================================================================
  describe("mounted", () => {
    it("calls fetchRecentDatasetViews on mount", async () => {
      mountComponent().destroy();
      expect(mockFetchRecentDatasetViews).toHaveBeenCalled();
    });

    it("resets isNavigating on mount", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isNavigating).toBe(false);
      wrapper.destroy();
    });
  });
});
