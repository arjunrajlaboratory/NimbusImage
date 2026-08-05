import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, VueWrapper } from "@vue/test-utils";

const mockedStore = vi.hoisted(() => ({
  isLoggedIn: true,
  configuration: { colorByProperty: null } as any,
  annotationsAPI: {
    getColorByPropertyOptions: vi.fn(),
  },
}));

const mockedAnnotationStore = vi.hoisted(() => ({
  applyColorByProperty: vi.fn(),
  removeColorByProperty: vi.fn(),
}));

const mockedPropertyStore = vi.hoisted(() => ({
  computedPropertyPaths: [["prop1"], ["prop2", "Mean", "Ch1"]],
  getFullNameFromPath: (path: string[]) => ["Name", ...path].join(" / "),
}));

vi.mock("@/store", () => ({ default: mockedStore }));
vi.mock("@/store/annotation", () => ({ default: mockedAnnotationStore }));
vi.mock("@/store/properties", () => ({ default: mockedPropertyStore }));

import ColorByPropertyDialog from "./ColorByPropertyDialog.vue";

let wrapper: VueWrapper<any> | null = null;

function mountDialog(show = false) {
  wrapper = mount(ColorByPropertyDialog, { props: { show } });
  return wrapper;
}

describe("ColorByPropertyDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.isLoggedIn = true;
    mockedStore.configuration = { colorByProperty: null };
    mockedAnnotationStore.applyColorByProperty.mockResolvedValue({
      colored: 2,
      uncolored: 0,
      legend: { type: "continuous" },
    });
    mockedAnnotationStore.removeColorByProperty.mockResolvedValue(undefined);
    mockedStore.annotationsAPI.getColorByPropertyOptions.mockResolvedValue({
      colormaps: { viridis: ["#440154", "#fde725"] },
      default: "viridis",
      palette: ["#4e79a7"],
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("lists computed property paths with display names", () => {
    const wrapper = mountDialog();
    expect(wrapper.vm.propertyItems).toEqual([
      { title: "Name / prop1", value: "prop1" },
      { title: "Name / prop2 / Mean / Ch1", value: "prop2.Mean.Ch1" },
    ]);
  });

  it("fetches colormap options once when opened", async () => {
    const wrapper = mountDialog();
    await wrapper.setProps({ show: true });
    await wrapper.setProps({ show: false });
    await wrapper.setProps({ show: true });
    expect(
      mockedStore.annotationsAPI.getColorByPropertyOptions,
    ).toHaveBeenCalledTimes(1);
  });

  it("warns that applying replaces all colors and cannot be undone", async () => {
    mountDialog(false);
    await wrapper!.setProps({ show: true });
    // VDialog teleports its content to document.body.
    expect(document.body.textContent).toContain("cannot be undone");
  });

  it("apply delegates to the store action and closes", async () => {
    const wrapper = mountDialog(true);
    wrapper.vm.selectedPathKey = "prop2.Mean.Ch1";
    wrapper.vm.mode = "continuous";
    wrapper.vm.rangeMinText = "1";
    wrapper.vm.rangeMaxText = "";
    await wrapper.vm.apply();

    expect(mockedAnnotationStore.applyColorByProperty).toHaveBeenCalledWith({
      propertyPath: ["prop2", "Mean", "Ch1"],
      propertyName: "Name / prop2 / Mean / Ch1",
      mode: "continuous",
      colormap: "viridis",
      rangeMin: 1,
      rangeMax: undefined,
      // Blank percentile fields send undefined so the server applies its
      // own 1/99 defaults rather than the dialog hardcoding them.
      percentileLow: undefined,
      percentileHigh: undefined,
    });
    expect(wrapper.emitted("update:show")?.at(-1)).toEqual([false]);
  });

  it("omits colormap and range params in categorical mode", async () => {
    // Those fields are hidden for categorical and ignored by the backend, but
    // it still validates them — so a stale invalid pair from continuous mode
    // would 400 the apply about fields the user can no longer see.
    const wrapper = mountDialog(true);
    wrapper.vm.selectedPathKey = "prop1";
    wrapper.vm.mode = "categorical";
    wrapper.vm.rangeMinText = "100";
    wrapper.vm.rangeMaxText = "50";
    await wrapper.vm.apply();
    expect(mockedAnnotationStore.applyColorByProperty).toHaveBeenCalledWith({
      propertyPath: ["prop1"],
      propertyName: "Name / prop1",
      mode: "categorical",
    });
  });

  it("passes custom percentiles through when set", async () => {
    const wrapper = mountDialog(true);
    wrapper.vm.selectedPathKey = "prop1";
    wrapper.vm.percentileLowText = "5";
    wrapper.vm.percentileHighText = "95";
    await wrapper.vm.apply();
    expect(mockedAnnotationStore.applyColorByProperty).toHaveBeenCalledWith(
      expect.objectContaining({ percentileLow: 5, percentileHigh: 95 }),
    );
  });

  it("apply surfaces a backend 400 message without closing", async () => {
    mockedAnnotationStore.applyColorByProperty.mockRejectedValue({
      response: { data: { message: "Too many distinct values" } },
    });
    const wrapper = mountDialog(true);
    wrapper.vm.selectedPathKey = "prop1";
    await wrapper.vm.apply();
    expect(wrapper.vm.errorMessage).toBe("Too many distinct values");
    expect(wrapper.emitted("update:show")).toBeUndefined();
  });

  it("removeColoring delegates to the store action and closes", async () => {
    mockedStore.configuration = { colorByProperty: { propertyPath: ["p"] } };
    const wrapper = mountDialog(true);
    await wrapper.vm.removeColoring();
    expect(mockedAnnotationStore.removeColorByProperty).toHaveBeenCalled();
    expect(wrapper.emitted("update:show")?.at(-1)).toEqual([false]);
  });

  it("canApply requires the selected path to exist for the current dataset", () => {
    const wrapper = mountDialog();
    expect(wrapper.vm.canApply).toBe(false);
    wrapper.vm.selectedPathKey = "prop1";
    expect(wrapper.vm.canApply).toBe(true);
    // A key left over from another dataset/configuration no longer resolves;
    // Apply must disable instead of silently no-oping.
    wrapper.vm.selectedPathKey = "gone.property";
    expect(wrapper.vm.canApply).toBe(false);
  });
});
