import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

// The component reads the per-dataset getter, not the raw configuration key
// (colorByProperty is keyed by dataset id — a configuration can be shared
// across datasets while the legend describes one dataset's values).
const mockedStore = vi.hoisted(() => ({
  colorByPropertyForCurrentDataset: null as any,
  saveColorByProperty: vi.fn(),
}));

vi.mock("@/store", () => ({ default: mockedStore }));

import AnnotationColorLegend from "./AnnotationColorLegend.vue";
import { IColorByPropertyState } from "@/store/model";

const continuousLegend: IColorByPropertyState = {
  type: "continuous",
  propertyPath: ["prop1"],
  propertyName: "Nucleus / Mean / Ch1",
  colormap: "viridis",
  stops: ["#440154", "#21918c", "#fde725"],
  min: 0,
  max: 12.3456,
  showLegend: true,
};

const categoricalLegend: IColorByPropertyState = {
  type: "categorical",
  propertyPath: ["prop2"],
  propertyName: "Cell type",
  categories: [
    { value: "neuron", color: "#4e79a7", count: 12 },
    { value: "glia", color: "#f28e2b", count: 5 },
  ],
  showLegend: true,
};

describe("AnnotationColorLegend", () => {
  beforeEach(() => {
    mockedStore.colorByPropertyForCurrentDataset = null;
    mockedStore.saveColorByProperty.mockClear();
  });

  it("renders nothing without an active legend", () => {
    const wrapper = mount(AnnotationColorLegend);
    expect(wrapper.find(".color-legend-anchor").exists()).toBe(false);
  });

  it("renders a gradient with min/max labels for a continuous legend", () => {
    mockedStore.colorByPropertyForCurrentDataset = continuousLegend;
    const wrapper = mount(AnnotationColorLegend);
    expect(wrapper.find(".legend-title").text()).toBe("Nucleus / Mean / Ch1");
    expect(wrapper.find(".legend-gradient").exists()).toBe(true);
    // jsdom's CSS parser drops `background: linear-gradient(...)` from the
    // serialized style attribute, so assert the bound style object instead.
    expect(wrapper.vm.gradientStyle).toEqual({
      background: "linear-gradient(to right, #440154, #21918c, #fde725)",
    });
    const labels = wrapper
      .findAll(".legend-gradient-labels span")
      .map((label) => label.text());
    // Horizontal bar: min on the left, max on the right.
    expect(labels).toEqual(["0", "12.3"]);
  });

  it("marks clipped ends with ≥/≤ and shows the data extent on hover", () => {
    // The ramp defaults to the 1st..99th percentile, so its ends are not the
    // data's extremes — values beyond them are clamped to the end colors.
    mockedStore.colorByPropertyForCurrentDataset = {
      ...continuousLegend,
      min: 150,
      max: 1960,
      dataMin: 19.5,
      dataMax: 12792.5,
      clippedLow: true,
      clippedHigh: true,
    };
    const wrapper = mount(AnnotationColorLegend);
    const labels = wrapper
      .findAll(".legend-gradient-labels span")
      .map((label) => label.text());
    expect(labels).toEqual(["≤ 150", "≥ 1960"]);
    // 3 significant digits, grouped — not "1.28e+4".
    expect(wrapper.vm.extentTitle).toBe("Data range 19.5 – 12,800");
  });

  it("leaves unclipped ends unmarked", () => {
    mockedStore.colorByPropertyForCurrentDataset = {
      ...continuousLegend,
      min: 0,
      max: 10,
      dataMin: 0,
      dataMax: 10,
      clippedLow: false,
      clippedHigh: false,
    };
    const wrapper = mount(AnnotationColorLegend);
    const labels = wrapper
      .findAll(".legend-gradient-labels span")
      .map((label) => label.text());
    expect(labels).toEqual(["0", "10"]);
  });

  it("renders swatch rows for a categorical legend", () => {
    mockedStore.colorByPropertyForCurrentDataset = categoricalLegend;
    const wrapper = mount(AnnotationColorLegend);
    const rows = wrapper.findAll(".legend-category");
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".legend-category-label").text()).toBe("neuron");
    expect(rows[0].find(".legend-category-count").text()).toBe("12");
    expect(wrapper.find(".legend-more").exists()).toBe(false);
  });

  it("caps displayed categories and summarizes the rest", () => {
    mockedStore.colorByPropertyForCurrentDataset = {
      ...categoricalLegend,
      categories: Array.from({ length: 35 }, (_, i) => ({
        value: `cat${i}`,
        color: "#4e79a7",
        count: 1,
      })),
    };
    const wrapper = mount(AnnotationColorLegend);
    expect(wrapper.findAll(".legend-category")).toHaveLength(30);
    expect(wrapper.find(".legend-more").text()).toBe("+5 more");
  });

  it("collapse persists showLegend: false; the reopen chip restores it", async () => {
    mockedStore.colorByPropertyForCurrentDataset = continuousLegend;
    const wrapper = mount(AnnotationColorLegend);
    await wrapper.find(".legend-header button").trigger("click");
    expect(mockedStore.saveColorByProperty).toHaveBeenCalledWith({
      ...continuousLegend,
      showLegend: false,
    });

    mockedStore.colorByPropertyForCurrentDataset = {
      ...continuousLegend,
      showLegend: false,
    };
    const collapsed = mount(AnnotationColorLegend);
    expect(collapsed.find(".color-legend-panel").exists()).toBe(false);
    await collapsed.find(".legend-reopen").trigger("click");
    expect(mockedStore.saveColorByProperty).toHaveBeenCalledWith({
      ...continuousLegend,
      showLegend: true,
    });
  });
});
