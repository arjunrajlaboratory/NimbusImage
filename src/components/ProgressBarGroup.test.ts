import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/progress", () => ({
  default: {
    activeProgresses: [] as any[],
    activeNotifications: [] as any[],
    hasActiveProgresses: false,
    dismissNotification: vi.fn(),
  },
}));

import ProgressBarGroup from "./ProgressBarGroup.vue";
import progressStore from "@/store/progress";

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(ProgressBarGroup, {
    vuetify: new Vuetify(),
  });
}

describe("ProgressBarGroup", () => {
  it("renders nothing when no active progresses or notifications", () => {
    progressStore.hasActiveProgresses = false;
    progressStore.activeNotifications = [];
    const wrapper = mountComponent();
    expect(wrapper.find(".progress-container").exists()).toBe(false);
  });

  it("hasNotifications is true when activeNotifications is non-empty", () => {
    (progressStore as any).activeNotifications = [
      { id: "n1", type: "success", title: "Done", message: "Task done" },
    ];
    progressStore.hasActiveProgresses = false;
    const wrapper = mountComponent();
    expect(wrapper.vm.hasNotifications).toBe(true);
    // Reset
    (progressStore as any).activeNotifications = [];
  });

  it("dismissNotification delegates to store", () => {
    const wrapper = mountComponent();
    wrapper.vm.dismissNotification("n1");
    expect(progressStore.dismissNotification).toHaveBeenCalledWith("n1");
  });

  it("progressGroups groups active progresses by type", () => {
    (progressStore as any).activeProgresses = [
      {
        id: "p1",
        type: "annotation_fetch",
        progress: 5,
        total: 10,
        title: "Fetching",
      },
    ];
    progressStore.hasActiveProgresses = true;
    const wrapper = mountComponent();
    const groups = wrapper.vm.progressGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("annotation_fetch");
    expect(groups[0].display).toBe("single");
    // Reset
    (progressStore as any).activeProgresses = [];
    progressStore.hasActiveProgresses = false;
  });

  it("progressGroups shows stacked for multiple different progresses", () => {
    (progressStore as any).activeProgresses = [
      { id: "p1", type: "generic", progress: 3, total: 10, title: "Task A" },
      { id: "p2", type: "generic", progress: 7, total: 20, title: "Task B" },
    ];
    progressStore.hasActiveProgresses = true;
    const wrapper = mountComponent();
    const groups = wrapper.vm.progressGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0].display).toBe("stacked");
    expect(groups[0].items).toHaveLength(2);
    // Reset
    (progressStore as any).activeProgresses = [];
    progressStore.hasActiveProgresses = false;
  });

  it("progressGroups shows single for multiple indeterminate with same title", () => {
    (progressStore as any).activeProgresses = [
      { id: "p1", type: "generic", progress: 0, total: 0, title: "Loading" },
      { id: "p2", type: "generic", progress: 0, total: 0, title: "Loading" },
    ];
    progressStore.hasActiveProgresses = true;
    const wrapper = mountComponent();
    const groups = wrapper.vm.progressGroups;
    expect(groups).toHaveLength(1);
    expect(groups[0].display).toBe("single");
    expect(groups[0].indeterminate).toBe(true);
    expect(groups[0].count).toBe(2);
    // Reset
    (progressStore as any).activeProgresses = [];
    progressStore.hasActiveProgresses = false;
  });
});
