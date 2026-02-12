import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    history: [
      { actionName: "Create", isUndone: false, actionDate: new Date() },
      { actionName: "Delete", isUndone: true, actionDate: new Date() },
    ],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    undoOrRedo: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [{ id: "p1" }],
    computedPropertyPaths: [{ path: "p1/subpath" }],
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    filteredAnnotations: [{ id: "a1" }, { id: "a2" }],
    selectionFilter: { enabled: false },
    clearSelection: vi.fn(),
    addSelectionAsFilter: vi.fn(),
  },
}));

import AnnotationActions from "./AnnotationActions.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(AnnotationActions, {
    vuetify: new Vuetify(),
    stubs: {
      AnnotationCsvDialog: true,
      AnnotationExport: true,
      AnnotationImport: true,
      DeleteConnections: true,
      IndexConversionDialog: true,
    },
  });
}

describe("AnnotationActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("undoEntry returns first non-undone history entry", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.undoEntry).toEqual(
      expect.objectContaining({ actionName: "Create", isUndone: false }),
    );
  });

  it("redoEntry returns last undone entry", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.redoEntry).toEqual(
      expect.objectContaining({ actionName: "Delete", isUndone: true }),
    );
  });

  it("undoEntry returns undefined when all entries are undone", () => {
    (store as any).history = [
      { actionName: "Delete", isUndone: true, actionDate: new Date() },
    ];
    const wrapper = mountComponent();
    expect(wrapper.vm.undoEntry).toBeUndefined();
    (store as any).history = [
      { actionName: "Create", isUndone: false, actionDate: new Date() },
      { actionName: "Delete", isUndone: true, actionDate: new Date() },
    ];
  });

  it("undo calls annotationStore.undoOrRedo(true)", async () => {
    const wrapper = mountComponent();
    await wrapper.vm.undo();
    expect(annotationStore.undoOrRedo).toHaveBeenCalledWith(true);
  });

  it("redo calls annotationStore.undoOrRedo(false)", async () => {
    const wrapper = mountComponent();
    await wrapper.vm.redo();
    expect(annotationStore.undoOrRedo).toHaveBeenCalledWith(false);
  });

  it("clearSelection calls filterStore.clearSelection()", () => {
    const wrapper = mountComponent();
    wrapper.vm.clearSelection();
    expect(filterStore.clearSelection).toHaveBeenCalled();
  });

  it("filterBySelection calls filterStore.addSelectionAsFilter()", () => {
    const wrapper = mountComponent();
    wrapper.vm.filterBySelection();
    expect(filterStore.addSelectionAsFilter).toHaveBeenCalled();
  });

  it("isDoing starts as false", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.isDoing).toBe(false);
  });

  it("filteredAnnotations reads from filterStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredAnnotations).toEqual(
      filterStore.filteredAnnotations,
    );
  });

  it("propertyPaths reads from propertyStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.propertyPaths).toEqual(
      propertyStore.computedPropertyPaths,
    );
  });
});
