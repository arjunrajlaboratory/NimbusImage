import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("./Snapshots.vue", () => ({
  MovieFormat: {
    ZIP: "zip",
    GIF: "gif",
    MP4: "mp4",
    WEBM: "webm",
  },
}));

import MovieDialog from "./MovieDialog.vue";

const sampleDataset = {
  id: "ds1",
  name: "Test Dataset",
  description: "",
  creatorId: "u1",
  xy: [0],
  z: [0],
  time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  channels: [0],
  channelNames: new Map(),
  width: 512,
  height: 512,
  images: vi.fn(),
  anyImage: vi.fn(),
  allImages: [],
};

function mountComponent(props = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return mount(MovieDialog, {
    attachTo: app,
    props: {
      modelValue: false,
      currentTime: 3,
      dataset: sampleDataset,
      ...props,
    },
  });
}

// Use shallowMount to avoid rendering deep Vuetify internals
function mount(component: any, options: any) {
  return shallowMount(component, options);
}

describe("MovieDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dialog computed get returns prop value", () => {
    const wrapper = mountComponent({ modelValue: true });
    expect((wrapper.vm as any).dialog).toBe(true);
  });

  it("dialog computed get returns false when value is false", () => {
    const wrapper = mountComponent({ modelValue: false });
    expect((wrapper.vm as any).dialog).toBe(false);
  });

  it("dialog computed set emits input", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).dialog = true;
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0][0]).toBe(true);
  });

  it("displayStartTime is 1-indexed (startTime + 1)", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).startTime = 0;
    expect((wrapper.vm as any).displayStartTime).toBe(1);
    (wrapper.vm as any).startTime = 5;
    expect((wrapper.vm as any).displayStartTime).toBe(6);
  });

  it("displayEndTime is 1-indexed (endTime + 1)", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).endTime = 0;
    expect((wrapper.vm as any).displayEndTime).toBe(1);
    (wrapper.vm as any).endTime = 9;
    expect((wrapper.vm as any).displayEndTime).toBe(10);
  });

  it("displayStartTime setter converts back to 0-indexed", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).displayStartTime = 3;
    expect((wrapper.vm as any).startTime).toBe(2);
  });

  it("displayEndTime setter converts back to 0-indexed", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).displayEndTime = 7;
    expect((wrapper.vm as any).endTime).toBe(6);
  });

  it("warningText returns warning when startTime > endTime", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).startTime = 5;
    (wrapper.vm as any).endTime = 2;
    expect((wrapper.vm as any).warningText).toBe(
      "Start time must be less than or equal to end time",
    );
  });

  it("warningText returns empty string for valid range", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).startTime = 0;
    (wrapper.vm as any).endTime = 5;
    (wrapper.vm as any).fps = 10;
    expect((wrapper.vm as any).warningText).toBe("");
  });

  it("warningText warns when startTime is negative", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).startTime = -1;
    (wrapper.vm as any).endTime = 5;
    expect((wrapper.vm as any).warningText).toBe(
      "Start time must be greater than or equal to 1",
    );
  });

  it("warningText warns when endTime exceeds maxTimePoint", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).startTime = 0;
    (wrapper.vm as any).endTime = 100;
    expect((wrapper.vm as any).warningText).toBe(
      "End time must be less than or equal to the maximum time point",
    );
  });

  it("warningText warns when fps is out of range", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).startTime = 0;
    (wrapper.vm as any).endTime = 5;
    (wrapper.vm as any).fps = 0;
    expect((wrapper.vm as any).warningText).toBe(
      "Frames per second must be between 1 and 30",
    );
  });

  it("maxTimePoint returns max of dataset.time", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).maxTimePoint).toBe(9);
  });

  it("handleDownload emits download event with correct payload", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.startTime = 1;
    vm.endTime = 5;
    vm.fps = 10;
    vm.downloadFormat = "zip";
    vm.shouldAddTimeStamp = false;
    vm.initialTimeStampTime = 0;
    vm.timeStampStep = 1;
    vm.timeStampUnits = "hours";

    vm.handleDownload();

    expect(wrapper.emitted("download")).toBeTruthy();
    expect(wrapper.emitted("download")![0][0]).toEqual({
      startTime: 1,
      endTime: 5,
      fps: 10,
      format: "zip",
      shouldAddTimeStamp: false,
      initialTimeStampTime: 0,
      timeStampStep: 1,
      timeStampUnits: "hours",
    });
  });

  it("handleDownload closes dialog after emitting", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.startTime = 0;
    vm.endTime = 5;
    vm.fps = 10;

    vm.handleDownload();

    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0][0]).toBe(false);
  });

  it("handleDownload does nothing when warningText is non-empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.startTime = 8;
    vm.endTime = 2;

    vm.handleDownload();

    expect(wrapper.emitted("download")).toBeFalsy();
  });

  it("watch on value sets startTime and endTime when opened", async () => {
    const wrapper = mountComponent({ modelValue: false, currentTime: 3 });
    const vm = wrapper.vm as any;

    await wrapper.setProps({ modelValue: true });

    expect(vm.startTime).toBe(3);
    expect(vm.endTime).toBe(9);
  });

  it("watch on value does not reset when closed", async () => {
    const wrapper = mountComponent({ modelValue: true, currentTime: 3 });
    const vm = wrapper.vm as any;
    vm.startTime = 1;
    vm.endTime = 4;

    await wrapper.setProps({ modelValue: false });

    expect(vm.startTime).toBe(1);
    expect(vm.endTime).toBe(4);
  });
});
