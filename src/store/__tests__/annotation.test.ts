/**
 * Unit tests for the annotation store
 *
 * Tests cover:
 * - Selection operations (setSelected, selectAnnotation, unselectAnnotation, toggleSelected)
 * - Copy/paste operations
 * - CRUD operations (create, delete)
 * - Tag operations (add, remove, replace)
 * - Fetch operations
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use vi.hoisted to define mock objects that will be available when vi.mock is hoisted
const { mockAnnotationsAPI, mockMainStore, mockSyncStore, mockProgressStore, mockJobsStore } = vi.hoisted(() => {
  const mockAnnotationsAPI = {
    createAnnotation: vi.fn().mockResolvedValue(null),
    createMultipleAnnotations: vi.fn().mockResolvedValue([]),
    deleteAnnotation: vi.fn().mockResolvedValue(undefined),
    deleteMultipleAnnotations: vi.fn().mockResolvedValue(undefined),
    updateAnnotations: vi.fn().mockResolvedValue(undefined),
    updateAnnotation: vi.fn().mockResolvedValue(undefined),
    getAnnotationsForDatasetId: vi.fn().mockResolvedValue([]),
    createConnection: vi.fn().mockResolvedValue(null),
    createConnections: vi.fn().mockResolvedValue([]),
    createMultipleConnections: vi.fn().mockResolvedValue([]),
    deleteMultipleConnections: vi.fn().mockResolvedValue(undefined),
    getConnectionsForDatasetId: vi.fn().mockResolvedValue([]),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    updateConnection: vi.fn().mockResolvedValue(undefined),
    computeAnnotationWithWorker: vi.fn().mockResolvedValue({ data: [] }),
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    toAnnotation: vi.fn((item: any) => item),
    toConnection: vi.fn((item: any) => item),
  };

  const mockMainStore = {
    dataset: null as any,
    configuration: null as any,
    isLoggedIn: true,
    xy: 0,
    z: 0,
    time: 0,
    layers: [] as any[],
    scales: {
      pixelSize: { value: 1, unit: "µm" },
      zStep: { value: 1, unit: "µm" },
      tStep: { value: 1, unit: "s" },
    },
    annotationsAPI: mockAnnotationsAPI,
    getLayerFromId: vi.fn().mockReturnValue(null),
    layerSliceIndexes: vi.fn().mockReturnValue({ xyIndex: 0, zIndex: 0, tIndex: 0 }),
    loadLargeImages: vi.fn().mockResolvedValue(false),
    scheduleTileFramesComputation: vi.fn(),
    scheduleMaxMergeCache: vi.fn(),
    scheduleHistogramCache: vi.fn(),
  };

  const mockSyncStore = {
    loading: false,
    saving: false,
    setSaving: vi.fn(),
    setLoading: vi.fn(),
  };

  const mockProgressStore = {
    create: vi.fn().mockResolvedValue("progress-id"),
    update: vi.fn(),
    complete: vi.fn(),
    handleJobProgress: vi.fn(),
  };

  const mockJobsStore = {
    addJob: vi.fn().mockResolvedValue(true),
  };

  return { mockAnnotationsAPI, mockMainStore, mockSyncStore, mockProgressStore, mockJobsStore };
});

// Mock the imported modules - these run after vi.hoisted
vi.mock("../index", () => ({
  default: mockMainStore,
}));

vi.mock("../sync", () => ({
  default: mockSyncStore,
}));

vi.mock("../progress", () => ({
  default: mockProgressStore,
}));

vi.mock("../jobs", () => ({
  default: mockJobsStore,
  createProgressEventCallback: vi.fn(() => vi.fn()),
  createErrorEventCallback: vi.fn(() => vi.fn()),
}));

// Mock the root store
vi.mock("../root", () => ({
  default: {
    state: {},
    getters: {},
    commit: vi.fn(),
    dispatch: vi.fn(),
  },
}));

// Mock vuex-module-decorators to avoid Vuex registration issues
vi.mock("vuex-module-decorators", () => ({
  Module: () => (target: any) => target,
  Mutation: () => (_target: any, _key: string) => {},
  Action: () => (_target: any, _key: string) => {},
  VuexModule: class VuexModule {
    context = {
      dispatch: vi.fn(),
    };
  },
  getModule: (ModuleClass: any) => new ModuleClass({}),
}));

// Mock Vue's set function
vi.mock("vue", () => ({
  default: {
    set: (obj: any, key: string, value: any) => {
      obj[key] = value;
    },
  },
  markRaw: (obj: any) => obj,
}));

// Mock the annotation utility
vi.mock("@/utils/annotation", () => ({
  simpleCentroid: vi.fn((coords) =>
    coords.length > 0 ? { x: coords[0].x, y: coords[0].y } : { x: 0, y: 0 },
  ),
}));

// Mock the log utility
vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

// Import test utilities after mocks
import {
  createMockAnnotation,
  createMockAnnotations,
  createMockAnnotationBase,
  createMockConnection,
  createMockConnections,
  createMockDataset,
  createMockConfiguration,
  resetIdCounter,
} from "./testUtils";

// Now import the Annotations class
import { Annotations } from "../annotation";

describe("annotation store", () => {
  let store: Annotations;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    resetIdCounter();

    // Reset mock store state
    mockMainStore.dataset = null;
    mockMainStore.configuration = null;
    mockMainStore.isLoggedIn = true;
    mockMainStore.xy = 0;
    mockMainStore.z = 0;
    mockMainStore.time = 0;

    // Create a fresh store instance
    store = new Annotations({});

    // Initialize the annotationsAPI
    store.annotationsAPI = mockAnnotationsAPI;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("selection", () => {
    // Note: With ID-based selection, annotations must be in the store
    // for selectedAnnotations getter to return them

    it("setSelected replaces selected annotations", () => {
      const annotations = createMockAnnotations(3);
      // First add annotations to store so selectedAnnotations getter can find them
      store.setAnnotations(annotations);

      store.setSelected(annotations);

      expect(store.selectedAnnotations).toEqual(annotations);
      expect(store.selectedAnnotations).toHaveLength(3);
    });

    it("setSelected replaces existing selection", () => {
      const initialAnnotations = createMockAnnotations(2);
      const newAnnotations = createMockAnnotations(3);
      // Add all annotations to the store
      store.setAnnotations([...initialAnnotations, ...newAnnotations]);

      store.setSelected(initialAnnotations);
      store.setSelected(newAnnotations);

      expect(store.selectedAnnotations).toEqual(newAnnotations);
      expect(store.selectedAnnotations).toHaveLength(3);
    });

    it("setSelected with empty array clears selection", () => {
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      store.setSelected([]);

      expect(store.selectedAnnotations).toEqual([]);
      expect(store.selectedAnnotations).toHaveLength(0);
    });

    it("selectAnnotation adds to selection if not present", () => {
      const annotation1 = createMockAnnotation({ id: "ann-1" });
      const annotation2 = createMockAnnotation({ id: "ann-2" });
      store.setAnnotations([annotation1, annotation2]);

      store.selectAnnotation(annotation1);
      expect(store.selectedAnnotations).toHaveLength(1);
      expect(store.selectedAnnotations[0].id).toBe("ann-1");

      store.selectAnnotation(annotation2);
      expect(store.selectedAnnotations).toHaveLength(2);
      expect(store.selectedAnnotations.map((a) => a.id)).toContain("ann-2");
    });

    it("selectAnnotation does nothing if already selected", () => {
      const annotation = createMockAnnotation({ id: "ann-1" });
      store.setAnnotations([annotation]);

      store.selectAnnotation(annotation);
      store.selectAnnotation(annotation);

      expect(store.selectedAnnotations).toHaveLength(1);
    });

    it("selectAnnotations adds multiple annotations without duplicates", () => {
      const annotation1 = createMockAnnotation({ id: "ann-1" });
      const annotation2 = createMockAnnotation({ id: "ann-2" });
      const annotation3 = createMockAnnotation({ id: "ann-3" });
      store.setAnnotations([annotation1, annotation2, annotation3]);

      store.selectAnnotation(annotation1);
      store.selectAnnotations([annotation1, annotation2, annotation3]);

      expect(store.selectedAnnotations).toHaveLength(3);
    });

    it("unselectAnnotation removes from selection", () => {
      const annotations = createMockAnnotations(3);
      const annotationToRemove = annotations[1];
      const annotationToRemoveId = annotationToRemove.id;
      store.setAnnotations(annotations);
      store.setSelected([...annotations]); // Use spread to avoid mutation issues

      store.unselectAnnotation(annotationToRemove);

      expect(store.selectedAnnotations).toHaveLength(2);
      expect(store.selectedAnnotations.map((a) => a.id)).not.toContain(
        annotationToRemoveId,
      );
    });

    it("unselectAnnotation does nothing if annotation not in selection", () => {
      const annotations = createMockAnnotations(2);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      const notSelected = createMockAnnotation({ id: "not-selected" });
      store.unselectAnnotation(notSelected);

      expect(store.selectedAnnotations).toHaveLength(2);
    });

    it("unselectAnnotations removes multiple annotations", () => {
      const annotations = createMockAnnotations(4);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      store.unselectAnnotations([annotations[1], annotations[3]]);

      expect(store.selectedAnnotations).toHaveLength(2);
      expect(store.selectedAnnotations.map((a) => a.id)).toContain(
        annotations[0].id,
      );
      expect(store.selectedAnnotations.map((a) => a.id)).toContain(
        annotations[2].id,
      );
    });

    it("toggleSelected toggles selection state", async () => {
      const annotation1 = createMockAnnotation({ id: "ann-1" });
      const annotation2 = createMockAnnotation({ id: "ann-2" });
      store.setAnnotations([annotation1, annotation2]);

      // Initially select annotation1
      store.selectAnnotation(annotation1);
      expect(store.selectedAnnotations).toHaveLength(1);

      // Toggle both - ann-1 should be unselected, ann-2 should be selected
      await store.toggleSelected([annotation1, annotation2]);

      expect(store.selectedAnnotations).toHaveLength(1);
      expect(store.selectedAnnotations[0].id).toBe("ann-2");
    });

    it("selectedAnnotationIds returns IDs of selected annotations", () => {
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      const ids = store.selectedAnnotationIds;

      expect(ids).toEqual(annotations.map((a) => a.id));
    });

    it("clearSelectedAnnotations clears selection", async () => {
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      await store.clearSelectedAnnotations();

      expect(store.selectedAnnotations).toHaveLength(0);
    });

    it("isAnnotationSelected getter works correctly", () => {
      const annotation1 = createMockAnnotation({ id: "ann-1" });
      const annotation2 = createMockAnnotation({ id: "ann-2" });
      store.setAnnotations([annotation1, annotation2]);
      store.setSelected([annotation1]);

      expect(store.isAnnotationSelected("ann-1")).toBe(true);
      expect(store.isAnnotationSelected("ann-2")).toBe(false);
    });

    it("setSelected accepts string array of IDs", () => {
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);

      store.setSelected(annotations.map((a) => a.id));

      expect(store.selectedAnnotationIds).toEqual(annotations.map((a) => a.id));
      expect(store.selectedAnnotations).toHaveLength(3);
    });

    it("selectAnnotation accepts string ID", () => {
      const annotation = createMockAnnotation({ id: "ann-1" });
      store.setAnnotations([annotation]);

      store.selectAnnotation("ann-1");

      expect(store.selectedAnnotationIds).toContain("ann-1");
      expect(store.selectedAnnotations).toHaveLength(1);
    });

    it("click/drag selection: rapid selection updates are reactive", () => {
      // Simulate drag selection behavior where annotations are selected rapidly
      const annotations = createMockAnnotations(10);
      store.setAnnotations(annotations);

      // Initially no selection
      expect(store.selectedAnnotationIds).toHaveLength(0);
      expect(store.isAnnotationSelected(annotations[0].id)).toBe(false);

      // Simulate drag selecting first 5 annotations one by one
      for (let i = 0; i < 5; i++) {
        store.selectAnnotation(annotations[i].id);
        // Verify selection state updates immediately after each selection
        expect(store.isAnnotationSelected(annotations[i].id)).toBe(true);
        expect(store.selectedAnnotationIds).toHaveLength(i + 1);
      }

      // Verify final state
      expect(store.selectedAnnotationIds).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(store.isAnnotationSelected(annotations[i].id)).toBe(true);
      }
      for (let i = 5; i < 10; i++) {
        expect(store.isAnnotationSelected(annotations[i].id)).toBe(false);
      }
    });

    it("click/drag selection: bulk selection via selectAnnotations", () => {
      // Simulate drag selection that selects multiple at once
      const annotations = createMockAnnotations(10);
      store.setAnnotations(annotations);

      // Select annotations 2-7 at once (like a drag box)
      const toSelect = annotations.slice(2, 8);
      store.selectAnnotations(toSelect.map((a) => a.id));

      // Verify selection
      expect(store.selectedAnnotationIds).toHaveLength(6);
      for (const ann of toSelect) {
        expect(store.isAnnotationSelected(ann.id)).toBe(true);
      }
    });

    it("click selection: single click toggles selection", async () => {
      // Simulate single-click selection behavior
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);

      // Click to select annotation 0
      store.selectAnnotation(annotations[0].id);
      expect(store.isAnnotationSelected(annotations[0].id)).toBe(true);

      // Click to select annotation 1 (adding to selection)
      store.selectAnnotation(annotations[1].id);
      expect(store.isAnnotationSelected(annotations[0].id)).toBe(true);
      expect(store.isAnnotationSelected(annotations[1].id)).toBe(true);

      // Click to unselect annotation 0
      store.unselectAnnotation(annotations[0].id);
      expect(store.isAnnotationSelected(annotations[0].id)).toBe(false);
      expect(store.isAnnotationSelected(annotations[1].id)).toBe(true);
    });
  });

  describe("copy/paste", () => {
    it("copySelectedAnnotations stores copies of selected", async () => {
      const annotations = createMockAnnotations(2);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      await store.copySelectedAnnotations();

      expect(store.copiedAnnotations).toHaveLength(2);
      expect(store.copiedAnnotations).toEqual(annotations);
    });

    it("copySelectedAnnotations with empty selection stores empty array", async () => {
      store.setSelected([]);

      await store.copySelectedAnnotations();

      expect(store.copiedAnnotations).toHaveLength(0);
    });

    it("pasteAnnotations does nothing when nothing copied", async () => {
      mockMainStore.dataset = createMockDataset();
      store.copiedAnnotations = [];

      await store.pasteAnnotations();

      expect(mockAnnotationsAPI.createMultipleAnnotations).not.toHaveBeenCalled();
    });

    it("pasteAnnotations does nothing without dataset", async () => {
      mockMainStore.dataset = null;
      const annotations = createMockAnnotations(2);
      store.copiedAnnotations = annotations;

      await store.pasteAnnotations();

      expect(mockAnnotationsAPI.createMultipleAnnotations).not.toHaveBeenCalled();
    });

    it("pasteAnnotations creates new annotations at current location", async () => {
      const dataset = createMockDataset();
      mockMainStore.dataset = dataset;
      mockMainStore.xy = 5;
      mockMainStore.z = 3;
      mockMainStore.time = 2;

      const originalAnnotations = [
        createMockAnnotation({
          id: "orig-1",
          tags: ["tag1"],
          location: { XY: 0, Z: 0, Time: 0 },
        }),
        createMockAnnotation({
          id: "orig-2",
          tags: ["tag2"],
          location: { XY: 1, Z: 1, Time: 1 },
        }),
      ];
      store.copiedAnnotations = originalAnnotations;

      const newAnnotations = [
        createMockAnnotation({ id: "new-1" }),
        createMockAnnotation({ id: "new-2" }),
      ];
      mockAnnotationsAPI.createMultipleAnnotations.mockResolvedValueOnce(
        newAnnotations,
      );

      await store.pasteAnnotations();

      expect(mockAnnotationsAPI.createMultipleAnnotations).toHaveBeenCalled();

      const calledWith =
        mockAnnotationsAPI.createMultipleAnnotations.mock.calls[0][0];
      expect(calledWith).toHaveLength(2);

      // All pasted annotations should have the current location
      calledWith.forEach((base: any) => {
        expect(base.location).toEqual({ XY: 5, Z: 3, Time: 2 });
        expect(base.datasetId).toBe(dataset.id);
      });
    });

    it("setCopiedAnnotations mutation works directly", () => {
      const annotations = createMockAnnotations(2);

      store.setCopiedAnnotations(annotations);

      expect(store.copiedAnnotations).toEqual(annotations);
    });
  });

  describe("CRUD operations", () => {
    describe("createMultipleAnnotations", () => {
      it("creates annotations and adds to store", async () => {
        mockMainStore.isLoggedIn = true;
        const bases = [
          createMockAnnotationBase({ tags: ["tag1"] }),
          createMockAnnotationBase({ tags: ["tag2"] }),
        ];
        const createdAnnotations = [
          createMockAnnotation({ id: "created-1", tags: ["tag1"] }),
          createMockAnnotation({ id: "created-2", tags: ["tag2"] }),
        ];
        mockAnnotationsAPI.createMultipleAnnotations.mockResolvedValueOnce(
          createdAnnotations,
        );

        const result = await store.createMultipleAnnotations(bases);

        expect(mockSyncStore.setSaving).toHaveBeenCalledWith(true);
        expect(mockAnnotationsAPI.createMultipleAnnotations).toHaveBeenCalledWith(
          bases,
        );
        expect(result).toEqual(createdAnnotations);
        expect(store.annotations).toContainEqual(createdAnnotations[0]);
        expect(store.annotations).toContainEqual(createdAnnotations[1]);
      });

      it("returns empty array when not logged in", async () => {
        mockMainStore.isLoggedIn = false;
        const bases = [createMockAnnotationBase()];

        const result = await store.createMultipleAnnotations(bases);

        expect(result).toEqual([]);
        expect(
          mockAnnotationsAPI.createMultipleAnnotations,
        ).not.toHaveBeenCalled();
      });

      it("returns empty array for empty input", async () => {
        mockMainStore.isLoggedIn = true;

        const result = await store.createMultipleAnnotations([]);

        expect(result).toEqual([]);
        expect(
          mockAnnotationsAPI.createMultipleAnnotations,
        ).not.toHaveBeenCalled();
      });

      it("handles API errors gracefully", async () => {
        mockMainStore.isLoggedIn = true;
        const bases = [createMockAnnotationBase()];
        mockAnnotationsAPI.createMultipleAnnotations.mockRejectedValueOnce(
          new Error("API error"),
        );

        const result = await store.createMultipleAnnotations(bases);

        expect(result).toEqual([]);
      });
    });

    describe("deleteAnnotations", () => {
      it("deletes annotations and removes from store", async () => {
        mockMainStore.isLoggedIn = true;
        const annotations = createMockAnnotations(3);
        store.setAnnotations(annotations);

        await store.deleteAnnotations([annotations[0].id, annotations[2].id]);

        expect(mockSyncStore.setSaving).toHaveBeenCalledWith(true);
        expect(mockAnnotationsAPI.deleteMultipleAnnotations).toHaveBeenCalledWith(
          [annotations[0].id, annotations[2].id],
        );
        expect(store.annotations).toHaveLength(1);
        expect(store.annotations[0].id).toBe(annotations[1].id);
        expect(mockProgressStore.create).toHaveBeenCalled();
        expect(mockProgressStore.complete).toHaveBeenCalled();
      });

      it("does nothing when not logged in", async () => {
        mockMainStore.isLoggedIn = false;
        const annotations = createMockAnnotations(2);
        store.setAnnotations(annotations);

        await store.deleteAnnotations([annotations[0].id]);

        expect(
          mockAnnotationsAPI.deleteMultipleAnnotations,
        ).not.toHaveBeenCalled();
      });

      it("does nothing for empty ids array", async () => {
        mockMainStore.isLoggedIn = true;

        await store.deleteAnnotations([]);

        expect(
          mockAnnotationsAPI.deleteMultipleAnnotations,
        ).not.toHaveBeenCalled();
      });

      it("sets and clears deleting state", async () => {
        mockMainStore.isLoggedIn = true;
        const annotations = createMockAnnotations(2);
        store.setAnnotations(annotations);

        expect(store.isDeletingAnnotations).toBe(false);

        const deletePromise = store.deleteAnnotations([annotations[0].id]);

        // State should be set during deletion
        expect(store.isDeletingAnnotations).toBe(true);

        await deletePromise;

        // State should be cleared after deletion
        expect(store.isDeletingAnnotations).toBe(false);
      });
    });

    describe("deleteSelectedAnnotations", () => {
      it("deletes selected and clears selection", async () => {
        mockMainStore.isLoggedIn = true;
        const annotations = createMockAnnotations(3);
        store.setAnnotations(annotations);
        store.setSelected([annotations[0], annotations[2]]);

        // Note: deleteSelectedAnnotations doesn't await deleteAnnotations internally,
        // so we need to call it and then wait for the underlying promise
        const selectedIds = store.selectedAnnotationIds;
        store.deleteSelectedAnnotations();

        // Wait for the async deleteAnnotations to complete
        // by awaiting the promise that was started
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockAnnotationsAPI.deleteMultipleAnnotations).toHaveBeenCalledWith(
          selectedIds,
        );
        expect(store.selectedAnnotations).toHaveLength(0);
      });
    });

    describe("deleteUnselectedAnnotations", () => {
      it("deletes unselected annotations", async () => {
        mockMainStore.isLoggedIn = true;
        const annotations = createMockAnnotations(4);
        store.setAnnotations(annotations);
        store.setSelected([annotations[1], annotations[3]]);

        await store.deleteUnselectedAnnotations();

        expect(mockAnnotationsAPI.deleteMultipleAnnotations).toHaveBeenCalledWith(
          expect.arrayContaining([annotations[0].id, annotations[2].id]),
        );
      });
    });
  });

  describe("tag operations", () => {
    beforeEach(() => {
      mockMainStore.isLoggedIn = true;
    });

    it("addTagsByAnnotationIds adds tags without duplicates", async () => {
      const annotations = [
        createMockAnnotation({ id: "ann-1", tags: ["existing"] }),
        createMockAnnotation({ id: "ann-2", tags: ["other"] }),
      ];
      store.setAnnotations(annotations);

      await store.addTagsByAnnotationIds({
        annotationIds: ["ann-1", "ann-2"],
        tags: ["new-tag", "existing"], // "existing" should not be duplicated
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];

      // Find the annotation that had "existing" tag
      const ann1 = updatedAnnotations.find((a: any) => a.id === "ann-1");
      expect(ann1.tags).toContain("existing");
      expect(ann1.tags).toContain("new-tag");
      // Should not have duplicates
      expect(ann1.tags.filter((t: string) => t === "existing")).toHaveLength(1);
    });

    it("removeTagsByAnnotationIds removes specified tags", async () => {
      const annotations = [
        createMockAnnotation({ id: "ann-1", tags: ["keep", "remove1", "remove2"] }),
        createMockAnnotation({ id: "ann-2", tags: ["keep", "remove1"] }),
      ];
      store.setAnnotations(annotations);

      await store.removeTagsByAnnotationIds({
        annotationIds: ["ann-1", "ann-2"],
        tags: ["remove1", "remove2"],
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];

      updatedAnnotations.forEach((ann: any) => {
        expect(ann.tags).toContain("keep");
        expect(ann.tags).not.toContain("remove1");
        expect(ann.tags).not.toContain("remove2");
      });
    });

    it("replaceTagsByAnnotationIds replaces all tags", async () => {
      const annotations = [
        createMockAnnotation({ id: "ann-1", tags: ["old1", "old2"] }),
        createMockAnnotation({ id: "ann-2", tags: ["old3"] }),
      ];
      store.setAnnotations(annotations);

      await store.replaceTagsByAnnotationIds({
        annotationIds: ["ann-1", "ann-2"],
        tags: ["new1", "new2"],
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];

      updatedAnnotations.forEach((ann: any) => {
        expect(ann.tags).toEqual(["new1", "new2"]);
      });
    });

    it("tagSelectedAnnotations adds tags when replace is false", async () => {
      const annotations = [
        createMockAnnotation({ id: "ann-1", tags: ["existing"] }),
      ];
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      await store.tagSelectedAnnotations({
        tags: ["new-tag"],
        replace: false,
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
    });

    it("tagSelectedAnnotations replaces tags when replace is true", async () => {
      const annotations = [
        createMockAnnotation({ id: "ann-1", tags: ["old-tag"] }),
      ];
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      await store.tagSelectedAnnotations({
        tags: ["new-tag"],
        replace: true,
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];
      expect(updatedAnnotations[0].tags).toEqual(["new-tag"]);
    });

    it("removeTagsFromSelectedAnnotations removes tags from selection", async () => {
      const annotations = [
        createMockAnnotation({ id: "ann-1", tags: ["keep", "remove"] }),
      ];
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      await store.removeTagsFromSelectedAnnotations(["remove"]);

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];
      expect(updatedAnnotations[0].tags).toEqual(["keep"]);
    });
  });

  describe("fetching", () => {
    it("fetchAnnotations populates annotations and connections", async () => {
      const dataset = createMockDataset();
      const configuration = createMockConfiguration();
      mockMainStore.dataset = dataset;
      mockMainStore.configuration = configuration;

      const annotations = createMockAnnotations(3);
      const connections = createMockConnections(2);

      mockAnnotationsAPI.getAnnotationsForDatasetId.mockResolvedValueOnce(
        annotations,
      );
      mockAnnotationsAPI.getConnectionsForDatasetId.mockResolvedValueOnce(
        connections,
      );

      await store.fetchAnnotations();

      expect(mockAnnotationsAPI.getAnnotationsForDatasetId).toHaveBeenCalledWith(
        dataset.id,
      );
      expect(mockAnnotationsAPI.getConnectionsForDatasetId).toHaveBeenCalledWith(
        dataset.id,
      );
      expect(store.annotations).toEqual(annotations);
      expect(store.annotationConnections).toEqual(connections);
    });

    it("fetchAnnotations clears state without dataset", async () => {
      mockMainStore.dataset = null;
      mockMainStore.configuration = createMockConfiguration();

      // Pre-populate some data
      store.setAnnotations(createMockAnnotations(2));
      store.setConnections(createMockConnections(1));

      await store.fetchAnnotations();

      expect(store.annotations).toEqual([]);
      expect(store.annotationConnections).toEqual([]);
      expect(
        mockAnnotationsAPI.getAnnotationsForDatasetId,
      ).not.toHaveBeenCalled();
    });

    it("fetchAnnotations clears state without configuration", async () => {
      mockMainStore.dataset = createMockDataset();
      mockMainStore.configuration = null;

      await store.fetchAnnotations();

      expect(store.annotations).toEqual([]);
      expect(store.annotationConnections).toEqual([]);
    });

    it("fetchAnnotations clears state on error", async () => {
      mockMainStore.dataset = createMockDataset();
      mockMainStore.configuration = createMockConfiguration();

      mockAnnotationsAPI.getAnnotationsForDatasetId.mockRejectedValueOnce(
        new Error("Network error"),
      );

      await store.fetchAnnotations();

      expect(store.annotations).toEqual([]);
      expect(store.annotationConnections).toEqual([]);
    });

    it("fetchAnnotations handles empty results", async () => {
      mockMainStore.dataset = createMockDataset();
      mockMainStore.configuration = createMockConfiguration();

      mockAnnotationsAPI.getAnnotationsForDatasetId.mockResolvedValueOnce([]);
      mockAnnotationsAPI.getConnectionsForDatasetId.mockResolvedValueOnce([]);

      await store.fetchAnnotations();

      expect(store.annotations).toEqual([]);
      expect(store.annotationConnections).toEqual([]);
    });
  });

  describe("setAnnotations", () => {
    it("sets annotations and builds centroids map", () => {
      const annotations = createMockAnnotations(3);

      store.setAnnotations(annotations);

      expect(store.annotations).toEqual(annotations);
      expect(Object.keys(store.annotationCentroids)).toHaveLength(3);
      annotations.forEach((ann) => {
        expect(store.annotationCentroids[ann.id]).toBeDefined();
      });
    });

    it("builds annotationIdToIdx map", () => {
      const annotations = createMockAnnotations(3);

      store.setAnnotations(annotations);

      annotations.forEach((ann, idx) => {
        expect(store.annotationIdToIdx[ann.id]).toBe(idx);
      });
    });

    it("skips update if annotations are identical by id", () => {
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);

      // Store original annotations reference
      const originalAnnotationsRef = store.annotations;

      // Set same annotations (same ids in same order)
      const sameAnnotations = annotations.map((a) => ({ ...a }));
      store.setAnnotations(sameAnnotations);

      // Due to the equality check in setAnnotations, the store should not rebuild
      // if the ids match in the same order
      expect(store.annotations).toBe(originalAnnotationsRef);
    });

    it("populates annotationStubs map for all annotations", () => {
      const annotations = createMockAnnotations(10);

      store.setAnnotations(annotations);

      expect(store.annotationStubs.size).toBe(10);
      annotations.forEach((ann) => {
        const stub = store.annotationStubs.get(ann.id);
        expect(stub).toBeDefined();
        expect(stub?.id).toBe(ann.id);
        expect(stub?.tags).toEqual(ann.tags);
        expect(stub?.shape).toBe(ann.shape);
        expect(stub?.channel).toBe(ann.channel);
        expect(stub?.centroid).toBeDefined();
      });
    });

    it("hydrates first 20% of annotations (mock data strategy)", () => {
      // Create 10 annotations - first 2 (20%) should be hydrated
      const annotations = createMockAnnotations(10);

      store.setAnnotations(annotations);

      // First 2 should be hydrated
      expect(store.hydratedAnnotations.size).toBe(2);
      expect(store.hydratedAnnotations.has(annotations[0].id)).toBe(true);
      expect(store.hydratedAnnotations.has(annotations[1].id)).toBe(true);
      // Rest should not be hydrated
      expect(store.hydratedAnnotations.has(annotations[2].id)).toBe(false);
      expect(store.hydratedAnnotations.has(annotations[9].id)).toBe(false);
    });

    it("isHydrated getter returns correct values", () => {
      const annotations = createMockAnnotations(10);
      store.setAnnotations(annotations);

      // First 2 (20%) should be hydrated
      expect(store.isHydrated(annotations[0].id)).toBe(true);
      expect(store.isHydrated(annotations[1].id)).toBe(true);
      // Rest should not be hydrated
      expect(store.isHydrated(annotations[2].id)).toBe(false);
      expect(store.isHydrated(annotations[9].id)).toBe(false);
    });

    it("getStub getter returns stubs for all annotations", () => {
      const annotations = createMockAnnotations(5);
      store.setAnnotations(annotations);

      annotations.forEach((ann) => {
        const stub = store.getStub(ann.id);
        expect(stub).toBeDefined();
        expect(stub?.id).toBe(ann.id);
        // Stub should have centroid instead of coordinates
        expect(stub?.centroid).toBeDefined();
      });
    });

    it("getAnnotationOrStub returns hydrated for hydrated annotations", () => {
      const annotations = createMockAnnotations(10);
      store.setAnnotations(annotations);

      // First annotation should be hydrated
      const result = store.getAnnotationOrStub(annotations[0].id);
      expect(result).toBeDefined();
      expect("coordinates" in result!).toBe(true);
    });

    it("getAnnotationOrStub returns stub for non-hydrated annotations", () => {
      const annotations = createMockAnnotations(10);
      store.setAnnotations(annotations);

      // Last annotation should be a stub
      const result = store.getAnnotationOrStub(annotations[9].id);
      expect(result).toBeDefined();
      expect("centroid" in result!).toBe(true);
      // Stubs don't have coordinates
      expect("coordinates" in result!).toBe(false);
    });

    it("memoryStats calculates memory usage statistics", () => {
      // Create annotations with varying coordinate counts
      const annotations = createMockAnnotations(100);
      store.setAnnotations(annotations);

      const stats = store.memoryStats;

      // Basic counts
      expect(stats.totalAnnotations).toBe(100);
      expect(stats.hydratedCount).toBe(20); // 20% of 100
      expect(stats.stubCount).toBe(80); // 80% of 100
      expect(stats.hydratedPercent).toBe(20);

      // Memory estimates should be positive
      expect(stats.totalCoordinateBytes).toBeGreaterThan(0);
      expect(stats.hydratedCoordinateBytes).toBeGreaterThan(0);
      expect(stats.stubCoordinateBytes).toBeGreaterThan(0);

      // Theoretical savings should show ~80% of coordinate memory saved
      expect(stats.theoreticalSavingsPercent).toBeGreaterThan(0);
      expect(stats.theoreticalSavingsBytes).toBeGreaterThan(0);
    });
  });

  describe("getAnnotationFromId", () => {
    it("returns annotation by id", () => {
      const annotations = createMockAnnotations(3);
      store.setAnnotations(annotations);

      const found = store.getAnnotationFromId(annotations[1].id);

      expect(found).toEqual(annotations[1]);
    });

    it("returns undefined for unknown id", () => {
      const annotations = createMockAnnotations(2);
      store.setAnnotations(annotations);

      const found = store.getAnnotationFromId("unknown-id");

      expect(found).toBeUndefined();
    });
  });

  describe("annotationTags getter", () => {
    it("returns unique tags from all annotations", () => {
      const annotations = [
        createMockAnnotation({ tags: ["tag1", "tag2"] }),
        createMockAnnotation({ tags: ["tag2", "tag3"] }),
        createMockAnnotation({ tags: ["tag1", "tag4"] }),
      ];
      store.setAnnotations(annotations);

      const tags = store.annotationTags;

      expect(tags.size).toBe(4);
      expect(tags.has("tag1")).toBe(true);
      expect(tags.has("tag2")).toBe(true);
      expect(tags.has("tag3")).toBe(true);
      expect(tags.has("tag4")).toBe(true);
    });

    it("returns empty set for no annotations", () => {
      store.setAnnotations([]);

      const tags = store.annotationTags;

      expect(tags.size).toBe(0);
    });
  });

  describe("connections", () => {
    it("setConnections sets connections", () => {
      const connections = createMockConnections(3);

      store.setConnections(connections);

      expect(store.annotationConnections).toEqual(connections);
    });

    it("addMultipleConnections appends connections", () => {
      const initialConnections = createMockConnections(2);
      store.setConnections(initialConnections);

      const newConnections = createMockConnections(2);
      store.addMultipleConnections(newConnections);

      expect(store.annotationConnections).toHaveLength(4);
    });
  });

  describe("active annotations", () => {
    it("activateAnnotations adds ids to active list", () => {
      store.activateAnnotations(["id1", "id2"]);

      expect(store.activeAnnotationIds).toContain("id1");
      expect(store.activeAnnotationIds).toContain("id2");
    });

    it("activateAnnotations does not add duplicates", () => {
      store.activateAnnotations(["id1"]);
      store.activateAnnotations(["id1", "id2"]);

      expect(store.activeAnnotationIds.filter((id) => id === "id1")).toHaveLength(
        1,
      );
    });

    it("deactivateAnnotations removes ids from active list", () => {
      store.activateAnnotations(["id1", "id2", "id3"]);

      store.deactivateAnnotations(["id1", "id3"]);

      expect(store.activeAnnotationIds).toEqual(["id2"]);
    });

    it("toggleActiveAnnotations toggles activation state", async () => {
      store.activateAnnotations(["id1"]);

      await store.toggleActiveAnnotations(["id1", "id2"]);

      expect(store.activeAnnotationIds).not.toContain("id1");
      expect(store.activeAnnotationIds).toContain("id2");
    });

    it("inactiveAnnotationIds returns non-active annotation ids", () => {
      const annotations = createMockAnnotations(4);
      store.setAnnotations(annotations);
      store.activateAnnotations([annotations[0].id, annotations[2].id]);

      const inactive = store.inactiveAnnotationIds;

      expect(inactive).toContain(annotations[1].id);
      expect(inactive).toContain(annotations[3].id);
      expect(inactive).not.toContain(annotations[0].id);
      expect(inactive).not.toContain(annotations[2].id);
    });
  });

  describe("hovered annotation", () => {
    it("setHoveredAnnotationId sets the hovered id", () => {
      store.setHoveredAnnotationId("hover-id");

      expect(store.hoveredAnnotationId).toBe("hover-id");
    });

    it("setHoveredAnnotationId can be set to null", () => {
      store.setHoveredAnnotationId("hover-id");
      store.setHoveredAnnotationId(null);

      expect(store.hoveredAnnotationId).toBeNull();
    });
  });

  describe("color operations", () => {
    beforeEach(() => {
      mockMainStore.isLoggedIn = true;
    });

    it("colorAnnotationIds sets color on annotations", async () => {
      const annotations = createMockAnnotations(2);
      store.setAnnotations(annotations);

      await store.colorAnnotationIds({
        color: "#FF0000",
        annotationIds: [annotations[0].id],
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];
      expect(updatedAnnotations[0].color).toBe("#FF0000");
    });

    it("colorAnnotationIds with null removes color", async () => {
      const annotations = [createMockAnnotation({ color: "#FF0000" })];
      store.setAnnotations(annotations);

      await store.colorAnnotationIds({
        color: null,
        annotationIds: [annotations[0].id],
      });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
      const updatedAnnotations =
        mockAnnotationsAPI.updateAnnotations.mock.calls[0][0];
      expect(updatedAnnotations[0].color).toBeNull();
    });

    it("colorSelectedAnnotations colors selected annotations", async () => {
      const annotations = createMockAnnotations(2);
      store.setAnnotations(annotations);
      store.setSelected(annotations);

      await store.colorSelectedAnnotations({ color: "#00FF00" });

      expect(mockAnnotationsAPI.updateAnnotations).toHaveBeenCalled();
    });
  });
});
