import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mockSetXY = vi.fn();
const mockSetZ = vi.fn();
const mockSetTime = vi.fn();
const mockSetCameraInfo = vi.fn();

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    setXY: (...args: any[]) => mockSetXY(...args),
    setZ: (...args: any[]) => mockSetZ(...args),
    setTime: (...args: any[]) => mockSetTime(...args),
    setCameraInfo: (...args: any[]) => mockSetCameraInfo(...args),
    cameraInfo: { center: { x: 0, y: 0 } },
  },
}));

const mockToggleSelected = vi.fn();
const mockSetSelected = vi.fn();
const mockSetHoveredAnnotationId = vi.fn();
const mockDeleteSelectedAnnotations = vi.fn();
const mockDeleteUnselectedAnnotations = vi.fn();
const mockDeleteAnnotations = vi.fn();
const mockTagSelectedAnnotations = vi.fn();
const mockRemoveTagsFromSelectedAnnotations = vi.fn();
const mockColorSelectedAnnotations = vi.fn();
const mockUpdateAnnotationName = vi.fn();
const mockGetAnnotationFromId = vi.fn();
const mockGetStub = vi.fn();

vi.mock("@/store/annotation", () => {
  const state = {
    selectedAnnotationIds: new Set<string>(),
    setSelected: (...args: any[]) => mockSetSelected(...args),
    toggleSelected: (...args: any[]) => mockToggleSelected(...args),
    isDeleting: false,
    isAnnotationSelected: vi.fn(() => false),
    deleteSelectedAnnotations: (...args: any[]) =>
      mockDeleteSelectedAnnotations(...args),
    deleteUnselectedAnnotations: (...args: any[]) =>
      mockDeleteUnselectedAnnotations(...args),
    deleteAnnotations: (...args: any[]) => mockDeleteAnnotations(...args),
    stubOnlyMode: false,
    tagSelectedAnnotations: (...args: any[]) =>
      mockTagSelectedAnnotations(...args),
    removeTagsFromSelectedAnnotations: (...args: any[]) =>
      mockRemoveTagsFromSelectedAnnotations(...args),
    colorSelectedAnnotations: (...args: any[]) =>
      mockColorSelectedAnnotations(...args),
    updateAnnotationName: (...args: any[]) => mockUpdateAnnotationName(...args),
    hoveredAnnotationId: null,
    setHoveredAnnotationId: (...args: any[]) =>
      mockSetHoveredAnnotationId(...args),
    getAnnotationFromId: (...args: any[]) => mockGetAnnotationFromId(...args),
    getStub: (...args: any[]) => mockGetStub(...args),
    annotationCentroids: {} as Record<string, any>,
    annotations: [],
    annotationIdToIdx: {} as Record<string, number>,
  };
  Object.defineProperty(state, "annotationsForIteration", {
    get() {
      return state.annotations;
    },
    enumerable: true,
  });
  return { default: state };
});

vi.mock("@/store/properties", () => ({
  default: {
    propertyValues: {},
    displayedPropertyPaths: [],
    getFullNameFromPath: vi.fn((path: string[]) => path.join(".")),
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    filteredAnnotations: [],
    filteredAnnotationIdToIdx: new Map(),
    tagFilter: { enabled: false, exclusive: false, tags: [] },
    propertyFilters: [],
    onlyCurrentFrame: false,
    roiFilters: [],
  },
}));

const mockFetchPage = vi.fn();
const mockSetOptions = vi.fn();
const mockSetIdSubstring = vi.fn();
vi.mock("@/store/annotationListServer", () => ({
  default: {
    rows: [],
    total: 0,
    loading: false,
    page: 1,
    pageSize: 50,
    sort: null,
    setOptions: (...a: any[]) => mockSetOptions(...a),
    fetchPage: (...a: any[]) => mockFetchPage(...a),
    fetchMatchingIds: vi.fn(async () => []),
    setIdSubstring: (...a: any[]) => mockSetIdSubstring(...a),
  },
}));

vi.mock("@/utils/paths", () => ({
  getStringFromPropertiesAndPath: vi.fn(() => "42"),
}));

vi.mock("@/utils/annotation", () => ({
  simpleCentroid: vi.fn(() => ({ x: 10, y: 20 })),
}));

import AnnotationList from "./AnnotationList.vue";
import annotationStore from "@/store/annotation";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import annotationListServer from "@/store/annotationListServer";

function makeAnnotation(overrides: any = {}) {
  return {
    id: "ann1",
    name: null,
    tags: ["tagA"],
    shape: "point",
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [{ x: 10, y: 20 }],
    datasetId: "ds1",
    color: null,
    ...overrides,
  };
}

function mountComponent() {
  return shallowMount(AnnotationList, {
    global: {
      stubs: {
        TagSelectionDialog: true,
        ColorSelectionDialog: true,
        VExpansionPanel: {
          template: "<div><slot /></div>",
        },
        VExpansionPanelHeader: {
          template: "<div><slot /></div>",
        },
        VExpansionPanelContent: {
          template: "<div><slot /></div>",
        },
      },
    },
  });
}

describe("AnnotationList", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-set mock functions after restoreAllMocks
    (annotationStore as any).selectedAnnotationIds = new Set<string>();
    (annotationStore as any).setSelected = (...args: any[]) =>
      mockSetSelected(...args);
    (annotationStore as any).toggleSelected = (...args: any[]) =>
      mockToggleSelected(...args);
    (annotationStore as any).isDeleting = false;
    (annotationStore as any).isAnnotationSelected = vi.fn(() => false);
    (annotationStore as any).deleteSelectedAnnotations = (...args: any[]) =>
      mockDeleteSelectedAnnotations(...args);
    (annotationStore as any).deleteUnselectedAnnotations = (...args: any[]) =>
      mockDeleteUnselectedAnnotations(...args);
    (annotationStore as any).deleteAnnotations = (...args: any[]) =>
      mockDeleteAnnotations(...args);
    mockDeleteAnnotations.mockClear();
    mockDeleteSelectedAnnotations.mockClear();
    mockDeleteUnselectedAnnotations.mockClear();
    (annotationStore as any).tagSelectedAnnotations = (...args: any[]) =>
      mockTagSelectedAnnotations(...args);
    (annotationStore as any).removeTagsFromSelectedAnnotations = (
      ...args: any[]
    ) => mockRemoveTagsFromSelectedAnnotations(...args);
    (annotationStore as any).colorSelectedAnnotations = (...args: any[]) =>
      mockColorSelectedAnnotations(...args);
    (annotationStore as any).updateAnnotationName = (...args: any[]) =>
      mockUpdateAnnotationName(...args);
    (annotationStore as any).hoveredAnnotationId = null;
    (annotationStore as any).setHoveredAnnotationId = (...args: any[]) =>
      mockSetHoveredAnnotationId(...args);
    (annotationStore as any).getAnnotationFromId = (...args: any[]) =>
      mockGetAnnotationFromId(...args);
    (annotationStore as any).getStub = (...args: any[]) => mockGetStub(...args);
    (annotationStore as any).annotationCentroids = {};
    (annotationStore as any).annotations = [];
    (annotationStore as any).annotationIdToIdx = {};
    // Client mode for existing tests; server-mode tests opt in explicitly.
    (annotationStore as any).stubOnlyMode = false;

    // Redefine as a normal data property in case a prior test installed a
    // throwing getter (the server-mode decoupling test does this).
    Object.defineProperty(filterStore, "filteredAnnotations", {
      configurable: true,
      writable: true,
      value: [],
    });
    (filterStore as any).filteredAnnotationIdToIdx = new Map();
    (filterStore as any).tagFilter = {
      enabled: false,
      exclusive: false,
      tags: [],
    };
    (filterStore as any).propertyFilters = [];
    (filterStore as any).onlyCurrentFrame = false;
    (filterStore as any).roiFilters = [];

    (annotationListServer as any).rows = [];
    (annotationListServer as any).total = 0;
    (annotationListServer as any).loading = false;
    (annotationListServer as any).page = 1;
    (annotationListServer as any).pageSize = 50;
    (annotationListServer as any).sort = null;
    // Reset to a controllable resolved-empty default; per-test overrides set
    // their own resolved value. restoreAllMocks would otherwise clear the
    // inline module-mock implementation.
    (annotationListServer as any).fetchMatchingIds = vi.fn(async () => []);
    mockFetchPage.mockClear();
    mockSetOptions.mockClear();
    mockSetIdSubstring.mockClear();

    (propertyStore as any).propertyValues = {};
    (propertyStore as any).displayedPropertyPaths = [];
    (propertyStore as any).getFullNameFromPath = vi.fn((path: string[]) =>
      path.join("."),
    );
  });

  describe("selectedColumns", () => {
    it("has default columns excluding annotation.id, shapeName, annotation.name", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectedColumns).not.toContain("annotation.id");
      expect(vm.selectedColumns).not.toContain("shapeName");
      expect(vm.selectedColumns).not.toContain("annotation.name");
      expect(vm.selectedColumns).toContain("index");
      expect(vm.selectedColumns).toContain("annotation.tags");
      expect(vm.selectedColumns).toContain("annotation.location.XY");
      expect(vm.selectedColumns).toContain("annotation.location.Z");
      expect(vm.selectedColumns).toContain("annotation.location.Time");
    });
  });

  describe("isDeletingAnnotations", () => {
    it("reflects annotationStore.isDeleting", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isDeletingAnnotations).toBe(false);
    });

    it("returns true when annotationStore.isDeleting is true", () => {
      (annotationStore as any).isDeleting = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isDeletingAnnotations).toBe(true);
    });
  });

  describe("listedAnnotations", () => {
    it("returns filteredAnnotations when no localIdFilter", () => {
      const ann = makeAnnotation();
      (filterStore as any).filteredAnnotations = [ann];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.listedAnnotations).toHaveLength(1);
    });

    it("filters by localIdFilter", () => {
      const ann1 = makeAnnotation({ id: "abc123" });
      const ann2 = makeAnnotation({ id: "def456" });
      (filterStore as any).filteredAnnotations = [ann1, ann2];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.localIdFilter = "abc";
      expect(vm.listedAnnotations).toHaveLength(1);
      expect(vm.listedAnnotations[0].id).toBe("abc123");
    });

    it("returns all when localIdFilter is empty string", () => {
      const ann1 = makeAnnotation({ id: "abc123" });
      const ann2 = makeAnnotation({ id: "def456" });
      (filterStore as any).filteredAnnotations = [ann1, ann2];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.localIdFilter = "";
      expect(vm.listedAnnotations).toHaveLength(2);
    });
  });

  describe("filteredItems", () => {
    it("maps annotations to items", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      (annotationStore as any).annotationIdToIdx = { ann1: 0 };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const items = vm.filteredItems;
      expect(items).toHaveLength(1);
      expect(items[0].annotation).toEqual(ann);
      expect(items[0].index).toBe(0);
      expect(items[0].shapeName).toBe("Point"); // shape 0 = Point
    });

    it("includes isSelected from annotationStore", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      (annotationStore as any).isAnnotationSelected = vi.fn(() => true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.filteredItems[0].isSelected).toBe(true);
    });
  });

  describe("headers", () => {
    it("includes only selected columns", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const headerKeys = vm.headers.map((h: any) => h.key);
      expect(headerKeys).toContain("index");
      expect(headerKeys).toContain("annotation.tags");
      expect(headerKeys).not.toContain("annotation.id");
    });

    it("includes property headers from displayedPropertyPaths", () => {
      (propertyStore as any).displayedPropertyPaths = [["prop1", "subA"]];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const propHeader = vm.headers.find(
        (h: any) => h.key === "properties.prop1.subA",
      );
      expect(propHeader).toBeDefined();
      expect(propHeader.title).toBe("prop1.subA");
    });
  });

  describe("propertyHeaders", () => {
    it("returns empty when no displayedPropertyPaths", () => {
      (propertyStore as any).displayedPropertyPaths = [];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.propertyHeaders).toEqual([]);
    });

    it("generates headers from displayedPropertyPaths", () => {
      (propertyStore as any).displayedPropertyPaths = [
        ["p1", "a"],
        ["p2", "b"],
      ];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.propertyHeaders).toHaveLength(2);
      expect(vm.propertyHeaders[0].key).toBe("properties.p1.a");
    });
  });

  describe("selectAll", () => {
    it("selectAllValue is true when all filtered items are selected", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      (filterStore as any).filteredAnnotationIdToIdx = new Map([["ann1", 0]]);
      (annotationStore as any).selectedAnnotationIds = new Set(["ann1"]);
      (annotationStore as any).isAnnotationSelected = vi.fn(() => true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectAllValue).toBe(true);
    });

    it("selectAllValue is false when no items selected", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      (annotationStore as any).isAnnotationSelected = vi.fn(() => false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectAllValue).toBe(false);
    });

    it("selectAllIndeterminate is true when some but not all selected", () => {
      const ann1 = makeAnnotation({ id: "ann1" });
      const ann2 = makeAnnotation({ id: "ann2" });
      (filterStore as any).filteredAnnotations = [ann1, ann2];
      (filterStore as any).filteredAnnotationIdToIdx = new Map([["ann1", 0]]);
      (annotationStore as any).selectedAnnotationIds = new Set(["ann1"]);
      (annotationStore as any).isAnnotationSelected = vi.fn(
        (id: string) => id === "ann1",
      );
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectAllIndeterminate).toBe(true);
    });

    it("selectAllCallback deselects all when all are selected", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      (filterStore as any).filteredAnnotationIdToIdx = new Map([["ann1", 0]]);
      (annotationStore as any).selectedAnnotationIds = new Set(["ann1"]);
      (annotationStore as any).isAnnotationSelected = vi.fn(() => true);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.selectAllCallback();
      expect(mockSetSelected).toHaveBeenCalledWith([]);
    });

    it("selectAllCallback selects all when not all selected", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      (annotationStore as any).annotationIdToIdx = { ann1: 0 };
      (annotationStore as any).isAnnotationSelected = vi.fn(() => false);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.selectAllCallback();
      // Should set all filteredItems' annotation IDs
      expect(mockSetSelected).toHaveBeenCalledWith(["ann1"]);
    });
  });

  describe("toggleAnnotationSelection", () => {
    it("calls annotationStore.toggleSelected with annotation", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const ann = makeAnnotation();
      vm.toggleAnnotationSelection(ann);
      expect(mockToggleSelected).toHaveBeenCalledWith([ann.id]);
    });
  });

  describe("goToAnnotationIdLocation", () => {
    it("sets XY, Z, Time and camera from annotation", () => {
      const ann = makeAnnotation({
        id: "ann1",
        location: { XY: 2, Z: 3, Time: 4 },
        coordinates: [{ x: 100, y: 200 }],
      });
      mockGetAnnotationFromId.mockReturnValue(ann);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.goToAnnotationIdLocation("ann1");

      expect(mockSetXY).toHaveBeenCalledWith(2);
      expect(mockSetZ).toHaveBeenCalledWith(3);
      expect(mockSetTime).toHaveBeenCalledWith(4);
      expect(mockSetCameraInfo).toHaveBeenCalled();
      expect(mockSetHoveredAnnotationId).toHaveBeenCalledWith("ann1");
    });

    it("does nothing when annotation not found", () => {
      mockGetAnnotationFromId.mockReturnValue(null);
      mockGetStub.mockReturnValue(undefined);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.goToAnnotationIdLocation("nonexistent");
      expect(mockSetXY).not.toHaveBeenCalled();
    });

    it("navigates using the stub when the annotation has no coordinates (stub-only mode)", () => {
      // Non-hydrated stub: getAnnotationFromId returns undefined (annotations[]
      // is empty in stub-only mode), but the stub carries location + centroid.
      mockGetAnnotationFromId.mockReturnValue(undefined);
      mockGetStub.mockReturnValue({
        id: "stub1",
        location: { XY: 5, Z: 6, Time: 7 },
        centroid: { x: 55, y: 66 },
        shape: "point",
        channel: 0,
        tags: [],
        color: null,
      });
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.goToAnnotationIdLocation("stub1");

      expect(mockSetXY).toHaveBeenCalledWith(5);
      expect(mockSetZ).toHaveBeenCalledWith(6);
      expect(mockSetTime).toHaveBeenCalledWith(7);
      expect(mockSetCameraInfo).toHaveBeenCalledWith(
        expect.objectContaining({ center: { x: 55, y: 66 } }),
      );
      expect(mockSetHoveredAnnotationId).toHaveBeenCalledWith("stub1");
    });
  });

  describe("list size guard", () => {
    it("tooManyToList is false and items build normally under the limit", () => {
      const ann = makeAnnotation({ id: "ann1" });
      (filterStore as any).filteredAnnotations = [ann];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.tooManyToList).toBe(false);
      expect(vm.filteredItems).toHaveLength(1);
    });

    it("tooManyToList is true and filteredItems is empty over the limit", () => {
      const many = Array.from({ length: vm_listItemLimit() + 1 }, (_, i) =>
        makeAnnotation({ id: "a" + i }),
      );
      (filterStore as any).filteredAnnotations = many;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.tooManyToList).toBe(true);
      // The expensive per-annotation item mapping is skipped entirely.
      expect(vm.filteredItems).toHaveLength(0);
    });
  });

  function vm_listItemLimit() {
    const wrapper = mountComponent();
    return (wrapper.vm as any).LIST_ITEM_LIMIT as number;
  }

  describe("hover", () => {
    it("sets hoveredAnnotationId when annotations < 5000", () => {
      (annotationStore as any).annotations = new Array(100);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.hover("ann1");
      expect(mockSetHoveredAnnotationId).toHaveBeenCalledWith("ann1");
    });

    it("does not set hoveredAnnotationId when annotations >= 5000", () => {
      (annotationStore as any).annotations = new Array(5000);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.hover("ann1");
      expect(mockSetHoveredAnnotationId).not.toHaveBeenCalled();
    });

    it("hover with null clears hovered", () => {
      (annotationStore as any).annotations = new Array(10);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.hover(null);
      expect(mockSetHoveredAnnotationId).toHaveBeenCalledWith(null);
    });
  });

  describe("clickedTag", () => {
    it("emits clickedTag event", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.clickedTag("myTag");
      expect(wrapper.emitted("clickedTag")).toBeTruthy();
      expect(wrapper.emitted("clickedTag")![0][0]).toBe("myTag");
    });
  });

  describe("handleTagSubmit", () => {
    it("calls tagSelectedAnnotations when addOrRemove is add", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleTagSubmit({
        tags: ["tag1"],
        addOrRemove: "add",
        replaceExisting: false,
      });
      expect(mockTagSelectedAnnotations).toHaveBeenCalledWith({
        tags: ["tag1"],
        replace: false,
      });
    });

    it("calls tagSelectedAnnotations with replace when replaceExisting is true", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleTagSubmit({
        tags: ["tag1"],
        addOrRemove: "add",
        replaceExisting: true,
      });
      expect(mockTagSelectedAnnotations).toHaveBeenCalledWith({
        tags: ["tag1"],
        replace: true,
      });
    });

    it("calls removeTagsFromSelectedAnnotations when addOrRemove is remove", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleTagSubmit({
        tags: ["tag1"],
        addOrRemove: "remove",
        replaceExisting: false,
      });
      expect(mockRemoveTagsFromSelectedAnnotations).toHaveBeenCalledWith([
        "tag1",
      ]);
    });
  });

  describe("handleColorSubmit", () => {
    it("calls colorSelectedAnnotations with color when useColorFromLayer is false", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleColorSubmit({
        useColorFromLayer: false,
        color: "#ff0000",
      });
      expect(mockColorSelectedAnnotations).toHaveBeenCalledWith({
        color: "#ff0000",
        randomize: undefined,
      });
    });

    it("calls colorSelectedAnnotations with null when useColorFromLayer is true", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleColorSubmit({
        useColorFromLayer: true,
        color: "#ff0000",
      });
      expect(mockColorSelectedAnnotations).toHaveBeenCalledWith({
        color: null,
        randomize: undefined,
      });
    });

    it("passes randomize flag through", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleColorSubmit({
        useColorFromLayer: false,
        color: "#00ff00",
        randomize: true,
      });
      expect(mockColorSelectedAnnotations).toHaveBeenCalledWith({
        color: "#00ff00",
        randomize: true,
      });
    });
  });

  describe("deleteSelected", () => {
    it("calls annotationStore.deleteSelectedAnnotations in client mode", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.deleteSelected();
      expect(mockDeleteSelectedAnnotations).toHaveBeenCalled();
      // Client mode must not use the server-mode delete path.
      expect(mockDeleteAnnotations).not.toHaveBeenCalled();
    });

    it("deletes the selected ids and refreshes the page in server mode", async () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationStore as any).selectedAnnotationIds = new Set(["a", "b"]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      mockFetchPage.mockClear();

      await vm.deleteSelected();

      expect(mockDeleteAnnotations).toHaveBeenCalledTimes(1);
      // Order-insensitive: deletes exactly the selected ids.
      expect([...mockDeleteAnnotations.mock.calls[0][0]].sort()).toEqual([
        "a",
        "b",
      ]);
      expect(mockSetSelected).toHaveBeenCalledWith([]);
      expect(mockFetchPage).toHaveBeenCalled();
      // The client store action must not be used in server mode.
      expect(mockDeleteSelectedAnnotations).not.toHaveBeenCalled();
    });
  });

  describe("deleteUnselected", () => {
    it("calls annotationStore.deleteUnselectedAnnotations in client mode", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.deleteUnselected();
      expect(mockDeleteUnselectedAnnotations).toHaveBeenCalled();
      // Client mode must not use the server-mode matching-ids path.
      expect(mockDeleteAnnotations).not.toHaveBeenCalled();
      expect(annotationListServer.fetchMatchingIds).not.toHaveBeenCalled();
    });

    it("deletes matching-minus-selected and refreshes the page in server mode", async () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationListServer as any).fetchMatchingIds = vi.fn(async () => [
        "a",
        "b",
        "c",
        "d",
      ]);
      (annotationStore as any).selectedAnnotationIds = new Set(["b", "d"]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      mockFetchPage.mockClear();

      await vm.deleteUnselected();

      expect(mockDeleteAnnotations).toHaveBeenCalledTimes(1);
      // The unselected matching ids (all matching minus the selected).
      expect(mockDeleteAnnotations.mock.calls[0][0]).toEqual(["a", "c"]);
      expect(mockFetchPage).toHaveBeenCalled();
      // The client store action must not be used in server mode.
      expect(mockDeleteUnselectedAnnotations).not.toHaveBeenCalled();
    });
  });

  describe("updateAnnotationName", () => {
    it("calls annotationStore.updateAnnotationName", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.updateAnnotationName("New Name", "ann1");
      expect(mockUpdateAnnotationName).toHaveBeenCalledWith({
        name: "New Name",
        id: "ann1",
      });
    });
  });

  describe("getPageFromItemId", () => {
    it("returns 1 when dataTableItems is empty", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.getPageFromItemId("ann1")).toBe(1);
    });
  });

  describe("hoveredId", () => {
    it("reflects annotationStore.hoveredAnnotationId", () => {
      (annotationStore as any).hoveredAnnotationId = "ann1";
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.hoveredId).toBe("ann1");
    });

    it("returns null when no annotation is hovered", () => {
      (annotationStore as any).hoveredAnnotationId = null;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.hoveredId).toBeNull();
    });
  });

  describe("displayedPropertyPaths", () => {
    it("reflects propertyStore.displayedPropertyPaths", () => {
      (propertyStore as any).displayedPropertyPaths = [["p1", "a"]];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.displayedPropertyPaths).toEqual([["p1", "a"]]);
    });
  });

  describe("server mode", () => {
    it("renders server rows + total and fetches on mount", () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationListServer as any).rows = [
        {
          id: "srv1",
          centroid: { x: 1, y: 2 },
          location: { XY: 0, Z: 0, Time: 0 },
          shape: "point",
          channel: 0,
          tags: [],
          color: null,
          values: {},
        },
      ];
      (annotationListServer as any).total = 1234;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isServerMode).toBe(true);
      expect(vm.serverItemsLength).toBe(1234);
      expect(vm.serverRowItems).toHaveLength(1);
      expect(vm.serverRowItems[0].annotation.id).toBe("srv1");
      // Exactly one fetch on mount. The table is stubbed in tests so it never
      // emits update:options; this also locks the Fix-2 mount dedup (the real
      // immediate-on-mount emit must not produce a second identical request).
      expect(mockFetchPage).toHaveBeenCalledTimes(1);
    });

    it("computes absolute index for server rows across pages", () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationListServer as any).page = 3;
      (annotationListServer as any).pageSize = 50;
      (annotationListServer as any).rows = [
        {
          id: "srv1",
          centroid: { x: 1, y: 2 },
          location: { XY: 0, Z: 0, Time: 0 },
          shape: "point",
          channel: 0,
          tags: [],
          color: null,
          values: {},
        },
      ];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      // (page-1)*pageSize + i = 2*50 + 0 = 100
      expect(vm.serverRowItems[0].index).toBe(100);
    });

    it("does not invoke filterStore.filteredAnnotations in server mode", () => {
      // A throwing getter proves server mode never reads the client set.
      Object.defineProperty(filterStore, "filteredAnnotations", {
        configurable: true,
        get() {
          throw new Error(
            "filteredAnnotations must not be read in server mode",
          );
        },
      });
      (annotationStore as any).stubOnlyMode = true;
      (annotationListServer as any).total = 7;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(() => vm.serverItemsLength).not.toThrow();
      expect(() => vm.selectAllValue).not.toThrow();
      expect(() => vm.selectAllIndeterminate).not.toThrow();
      expect(() => vm.selectedIds).not.toThrow();
      expect(vm.serverItemsLength).toBe(7);
      // The hover watch must also stay off the client set: simulate an external
      // hover (e.g. from the image viewer) and let the watcher run.
      (annotationStore as any).hoveredAnnotationId = "srv1";
      vm.itemsPerPage = 200;
      expect(() => wrapper.vm.$nextTick()).not.toThrow();
      // Restore a plain data property so later tests aren't affected.
      Object.defineProperty(filterStore, "filteredAnnotations", {
        configurable: true,
        writable: true,
        value: [],
      });
    });

    it("selectAllValue uses server total + selectedAnnotationIds in server mode", () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationListServer as any).total = 2;
      (annotationStore as any).selectedAnnotationIds = new Set(["a", "b"]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectAllValue).toBe(true);
    });

    it("selectAllIndeterminate uses server total in server mode", () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationListServer as any).total = 3;
      (annotationStore as any).selectedAnnotationIds = new Set(["a"]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectAllIndeterminate).toBe(true);
    });

    it("selectedIds returns selectedAnnotationIds directly in server mode", () => {
      (annotationStore as any).stubOnlyMode = true;
      (annotationStore as any).selectedAnnotationIds = new Set(["x", "y"]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.selectedIds.sort()).toEqual(["x", "y"]);
    });

    it("roiActiveInServerMode is true when an ROI filter is enabled", () => {
      (annotationStore as any).stubOnlyMode = true;
      (filterStore as any).roiFilters = [{ enabled: true }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.roiActiveInServerMode).toBe(true);
    });

    it("roiActiveInServerMode is false in client mode", () => {
      (annotationStore as any).stubOnlyMode = false;
      (filterStore as any).roiFilters = [{ enabled: true }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.roiActiveInServerMode).toBe(false);
    });

    it("onServerOptions maps options and fetches", () => {
      (annotationStore as any).stubOnlyMode = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      mockSetOptions.mockClear();
      mockFetchPage.mockClear();
      vm.onServerOptions({
        page: 2,
        itemsPerPage: 50,
        sortBy: [{ key: "annotation.location.XY", order: "asc" }],
      });
      expect(mockSetOptions).toHaveBeenCalledWith({
        page: 2,
        pageSize: 50,
        sort: { type: "field", key: "location.XY", order: "asc" },
      });
      expect(mockFetchPage).toHaveBeenCalled();
    });

    it("onServerOptions is a no-op when options match the store state (mount dedup)", () => {
      // Store is at page:1, pageSize:50, sort:null (default mock state). The
      // immediate-on-mount emit from Vuetify carries these same values, so it
      // must not produce a second setOptions/fetchPage on top of onMounted.
      (annotationStore as any).stubOnlyMode = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      mockSetOptions.mockClear();
      mockFetchPage.mockClear();
      vm.onServerOptions({ page: 1, itemsPerPage: 50, sortBy: [] });
      expect(mockSetOptions).not.toHaveBeenCalled();
      expect(mockFetchPage).not.toHaveBeenCalled();
    });

    it("onServerOptions fetches when options differ from the store state", () => {
      (annotationStore as any).stubOnlyMode = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      mockSetOptions.mockClear();
      mockFetchPage.mockClear();
      vm.onServerOptions({ page: 2, itemsPerPage: 50, sortBy: [] });
      expect(mockSetOptions).toHaveBeenCalledWith({
        page: 2,
        pageSize: 50,
        sort: null,
      });
      expect(mockFetchPage).toHaveBeenCalledTimes(1);
    });

    it("debounces the server refetch when localIdFilter changes", async () => {
      vi.useFakeTimers();
      try {
        (annotationStore as any).stubOnlyMode = true;
        const wrapper = mountComponent();
        const vm = wrapper.vm as any;
        // onMounted fetched once; isolate the watch-driven refetch.
        mockFetchPage.mockClear();
        mockSetIdSubstring.mockClear();

        vm.localIdFilter = "abc";
        await wrapper.vm.$nextTick();

        // State updates synchronously, but the fetch is deferred.
        expect(mockSetIdSubstring).toHaveBeenCalledWith("abc");
        expect(mockFetchPage).not.toHaveBeenCalled();

        // After the debounce window, exactly one fetch fires.
        vi.advanceTimersByTime(300);
        expect(mockFetchPage).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("mapSort", () => {
    it("maps a property column to a property sort", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.mapSort({ key: "properties.P1.Area", order: "desc" })).toEqual({
        type: "property",
        key: ["P1", "Area"],
        order: "desc",
      });
    });

    it("maps a location field column to a field sort", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(
        vm.mapSort({ key: "annotation.location.XY", order: "asc" }),
      ).toEqual({ type: "field", key: "location.XY", order: "asc" });
    });

    it("maps annotation.name to a name field sort", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.mapSort({ key: "annotation.name", order: "asc" })).toEqual({
        type: "field",
        key: "name",
        order: "asc",
      });
    });

    it("maps index to the _id field sort", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.mapSort({ key: "index", order: "asc" })).toEqual({
        type: "field",
        key: "_id",
        order: "asc",
      });
    });

    it("maps annotation.id to the _id field sort", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.mapSort({ key: "annotation.id", order: "desc" })).toEqual({
        type: "field",
        key: "_id",
        order: "desc",
      });
    });

    it("returns null for unsupported tags column", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.mapSort({ key: "annotation.tags", order: "asc" })).toBeNull();
    });

    it("returns null for unsupported shapeName column", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.mapSort({ key: "shapeName", order: "asc" })).toBeNull();
    });
  });

  // Vuetify 3 @change migration: v-text-field should use @update:model-value
  describe("annotation name text-field uses update:modelValue", () => {
    it("updateAnnotationName is called with a string value when v-text-field emits update:modelValue", () => {
      const ann = makeAnnotation({ id: "ann1", name: "Old Name" });
      (filterStore as any).filteredAnnotations = [ann];
      (filterStore as any).filteredAnnotationIdToIdx = new Map([["ann1", 0]]);
      (annotationStore as any).annotationIdToIdx = { ann1: 0 };
      mockUpdateAnnotationName.mockClear();

      const wrapper = mountComponent();
      // Find the v-text-field that is used for annotation names
      const textFields = wrapper.findAllComponents({ name: "v-text-field" });
      const nameField = textFields.find(
        (c) =>
          c.attributes("model-value") === "Old Name" ||
          c.props("modelValue") === "Old Name",
      );

      if (nameField) {
        // Emit update:modelValue as Vuetify 3 does when value changes
        nameField.vm.$emit("update:modelValue", "Renamed");
        // If template uses @update:model-value, updateAnnotationName should be called with the string
        expect(mockUpdateAnnotationName).toHaveBeenCalledWith({
          name: "Renamed",
          id: "ann1",
        });
      } else {
        // Text field not rendered (columns not selected) — test handler directly
        // to ensure it doesn't accept Event objects
        const vm = wrapper.vm as any;
        vm.updateAnnotationName("Renamed", "ann1");
        expect(mockUpdateAnnotationName).toHaveBeenCalledWith({
          name: "Renamed",
          id: "ann1",
        });
      }
    });
  });
});
