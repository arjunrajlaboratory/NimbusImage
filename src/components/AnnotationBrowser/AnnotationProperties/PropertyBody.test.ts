import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/properties", () => ({
  default: {
    deleteProperty: vi.fn(),
    deletePropertyValues: vi.fn(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    jobIdForPropertyId: {},
    getJobLog: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import PropertyBody from "./PropertyBody.vue";
import propertyStore from "@/store/properties";
import jobsStore from "@/store/jobs";

Vue.use(Vuetify);

const baseProperty = {
  id: "prop-1",
  name: "Test Property",
  image: "test-image",
  tags: { tags: ["tag1"], exclusive: false },
  shape: "point",
  workerInterface: { param1: "value1" },
};

function mountComponent(props = {}) {
  const div = document.createElement("div");
  div.setAttribute("data-app", "true");
  document.body.appendChild(div);

  return mount(PropertyBody, {
    vuetify: new Vuetify(),
    attachTo: div,
    propsData: {
      property: baseProperty,
      ...props,
    },
  });
}

describe("PropertyBody", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (propertyStore.deleteProperty as any) = vi.fn();
    (propertyStore.deletePropertyValues as any) = vi.fn();
    (jobsStore as any).jobIdForPropertyId = {};
    (jobsStore.getJobLog as any) = vi.fn().mockReturnValue(null);
  });

  it("currentJobId returns null when no mapping exists for property", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBeUndefined();
    wrapper.destroy();
  });

  it("currentJobId returns jobId from store when property exists in mapping", () => {
    (jobsStore as any).jobIdForPropertyId = { "prop-1": "job-123" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBe("job-123");
    wrapper.destroy();
  });

  it("deleteProperty calls propertyStore.deleteProperty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.deleteComputedValues = false;
    vm.deleteProperty();
    expect(propertyStore.deleteProperty).toHaveBeenCalledWith("prop-1");
    expect(propertyStore.deletePropertyValues).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("deleteProperty with deleteComputedValues calls deletePropertyValues too", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.deleteComputedValues = true;
    vm.deleteProperty();
    expect(propertyStore.deleteProperty).toHaveBeenCalledWith("prop-1");
    expect(propertyStore.deletePropertyValues).toHaveBeenCalledWith("prop-1");
    wrapper.destroy();
  });

  it("copyLogToClipboard uses navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    (jobsStore as any).jobIdForPropertyId = { "prop-1": "job-123" };
    (jobsStore.getJobLog as any) = vi.fn().mockReturnValue("some log output");

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.copyLogToClipboard();
    expect(writeText).toHaveBeenCalledWith("some log output");
    wrapper.destroy();
  });
});
