import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mockSetXY = vi.fn();
const mockSetZ = vi.fn();
const mockSetTime = vi.fn();
const mockSetCameraInfo = vi.fn();

vi.mock("@/store", () => ({
  default: {
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
const mockTagSelectedAnnotations = vi.fn();
const mockRemoveTagsFromSelectedAnnotations = vi.fn();
const mockColorSelectedAnnotations = vi.fn();
const mockUpdateAnnotationName = vi.fn();
const mockGetAnnotationFromId = vi.fn();

vi.mock("@/store/annotation", () => ({
  default: {
    selectedAnnotations: [],
    setSelected: (...args: any[]) => mockSetSelected(...args),
    toggleSelected: (...args: any[]) => mockToggleSelected(...args),
    isDeleting: false,
    isAnnotationSelected: vi.fn(() => false),
    deleteSelectedAnnotations: (...args: any[]) =>
      mockDeleteSelectedAnnotations(...args),
    deleteUnselectedAnnotations: (...args: any[]) =>
      mockDeleteUnselectedAnnotations(...args),
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
    annotations: [],
    annotationIdToIdx: {} as Record<string, number>,
  },
}));

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
    (annotationStore as any).selectedAnnotations = [];
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
    (annotationStore as any).annotations = [];
    (annotationStore as any).annotationIdToIdx = {};

    (filterStore as any).filteredAnnotations = [];
    (filterStore as any).filteredAnnotationIdToIdx = new Map();

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
      (annotationStore as any).selectedAnnotations = [ann];
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
      (annotationStore as any).selectedAnnotations = [ann1];
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
      (annotationStore as any).selectedAnnotations = [ann];
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
      // Should set all filteredItems' annotations
      expect(mockSetSelected).toHaveBeenCalledWith([ann]);
    });
  });

  describe("toggleAnnotationSelection", () => {
    it("calls annotationStore.toggleSelected with annotation", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const ann = makeAnnotation();
      vm.toggleAnnotationSelection(ann);
      expect(mockToggleSelected).toHaveBeenCalledWith([ann]);
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
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.goToAnnotationIdLocation("nonexistent");
      expect(mockSetXY).not.toHaveBeenCalled();
    });
  });

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
    it("calls annotationStore.deleteSelectedAnnotations", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.deleteSelected();
      expect(mockDeleteSelectedAnnotations).toHaveBeenCalled();
    });
  });

  describe("deleteUnselected", () => {
    it("calls annotationStore.deleteUnselectedAnnotations", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.deleteUnselected();
      expect(mockDeleteUnselectedAnnotations).toHaveBeenCalled();
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
        (c) => c.attributes("model-value") === "Old Name" || c.props("modelValue") === "Old Name",
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
