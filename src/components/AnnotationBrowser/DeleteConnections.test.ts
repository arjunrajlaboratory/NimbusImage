import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    currentLocation: { xy: 0, z: 0, time: 0 },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationConnections: [
      { id: "c1", childId: "a1", parentId: "a2" },
      { id: "c2", childId: "a3", parentId: "a4" },
    ],
    annotations: [
      { id: "a1", location: { XY: 0, Z: 0, Time: 0 } },
      { id: "a2", location: { XY: 0, Z: 0, Time: 0 } },
      { id: "a3", location: { XY: 1, Z: 0, Time: 0 } },
      { id: "a4", location: { XY: 1, Z: 0, Time: 0 } },
    ],
    selectedAnnotationIds: ["a1"],
    deleteConnections: vi.fn().mockResolvedValue(undefined),
  },
}));

import DeleteConnections from "./DeleteConnections.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return shallowMount(DeleteConnections, {
    vuetify: new Vuetify(),
  });
}

describe("DeleteConnections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("button disabled when not logged in", () => {
    (store as any).isLoggedIn = false;
    const wrapper = mountComponent();
    expect(wrapper.vm.isLoggedIn).toBe(false);
    (store as any).isLoggedIn = true;
  });

  it("cancel closes dialog", () => {
    const wrapper = mountComponent();
    wrapper.vm.dialog = true;
    wrapper.vm.cancel();
    expect(wrapper.vm.dialog).toBe(false);
  });

  it("submit with dataset calls delete with all connection IDs", async () => {
    const wrapper = mountComponent();
    wrapper.vm.selectedDeleteOption = "dataset";
    await wrapper.vm.submit();
    expect(annotationStore.deleteConnections).toHaveBeenCalledWith([
      "c1",
      "c2",
    ]);
  });

  it("submit with location filters by current location", async () => {
    const wrapper = mountComponent();
    wrapper.vm.selectedDeleteOption = "location";
    await wrapper.vm.submit();
    // Only a1 and a2 are at location XY:0, Z:0, Time:0
    expect(annotationStore.deleteConnections).toHaveBeenCalledWith(["c1"]);
  });

  it("submit with selected filters by selected annotations", async () => {
    const wrapper = mountComponent();
    wrapper.vm.selectedDeleteOption = "selected";
    await wrapper.vm.submit();
    // Only a1 is selected, connection c1 has a1 as childId
    expect(annotationStore.deleteConnections).toHaveBeenCalledWith(["c1"]);
  });

  it("resets state after submit", async () => {
    const wrapper = mountComponent();
    wrapper.vm.dialog = true;
    await wrapper.vm.submit();
    expect(wrapper.vm.dialog).toBe(false);
    expect(wrapper.vm.deleting).toBe(false);
    expect(wrapper.vm.selectedDeleteOption).toBe("dataset");
  });
});
