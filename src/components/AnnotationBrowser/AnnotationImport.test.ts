import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "TestDataset" },
    isLoggedIn: true,
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [{ id: "a1" }, { id: "a2" }],
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [{ id: "p1" }],
  },
}));

vi.mock("@/utils/annotationImport", () => ({
  importAnnotationsFromData: vi.fn().mockResolvedValue(undefined),
  ImportOptions: {},
}));

import AnnotationImport from "./AnnotationImport.vue";
import store from "@/store";
import { importAnnotationsFromData } from "@/utils/annotationImport";

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return shallowMount(AnnotationImport, {
    vuetify: new Vuetify(),
  });
}

describe("AnnotationImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("button disabled when not logged in", () => {
    (store as any).isLoggedIn = false;
    const wrapper = mountComponent();
    expect(wrapper.vm.isLoggedIn).toBe(false);
    (store as any).isLoggedIn = true;
  });

  it("canImport is true when dataset exists", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.canImport).toBe(true);
  });

  it("canImport is false when no dataset", () => {
    const prev = store.dataset;
    (store as any).dataset = null;
    const wrapper = mountComponent();
    expect(wrapper.vm.canImport).toBe(false);
    (store as any).dataset = prev;
  });

  it("initializes with default import options", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.importAnnotations).toBe(true);
    expect(wrapper.vm.importConnections).toBe(true);
    expect(wrapper.vm.importProperties).toBe(true);
    expect(wrapper.vm.importValues).toBe(true);
    expect(wrapper.vm.overwriteAnnotations).toBe(false);
    expect(wrapper.vm.overwriteProperties).toBe(false);
  });

  it("reset clears all state", () => {
    const wrapper = mountComponent();
    wrapper.vm.importDialog = true;
    wrapper.vm.isJsonLoaded = true;
    wrapper.vm.reset();
    expect(wrapper.vm.importDialog).toBe(false);
    expect(wrapper.vm.isJsonLoaded).toBe(false);
    expect(wrapper.vm.annotations).toEqual([]);
    expect(wrapper.vm.connections).toEqual([]);
  });

  it("submit calls importAnnotationsFromData", async () => {
    const wrapper = mountComponent();
    wrapper.vm.isJsonLoaded = true;
    wrapper.vm.annotations = [{ id: "a1" }] as any;
    wrapper.vm.connections = [];
    wrapper.vm.properties = [];
    wrapper.vm.values = {};
    await wrapper.vm.submit();
    expect(importAnnotationsFromData).toHaveBeenCalled();
  });

  it("submit does nothing when not json loaded", async () => {
    const wrapper = mountComponent();
    wrapper.vm.isJsonLoaded = false;
    await wrapper.vm.submit();
    expect(importAnnotationsFromData).not.toHaveBeenCalled();
  });
});
