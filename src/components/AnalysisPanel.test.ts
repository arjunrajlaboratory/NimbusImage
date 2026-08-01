/**
 * What the panel still owns after the fetch moved into the store: reporting
 * whether anyone is looking, the chained populations, and the drawn series.
 *
 * The fetch SCOPE (when a round trip happens at all) is pinned in
 * `src/store/__tests__/filters.test.ts` — it belongs to the store because a
 * gate must resolve whether or not this palette is open.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

const mocks = vi.hoisted(() => ({
  setAnalysisPanelOpen: vi.fn(),
  addAnalysisPlot: vi.fn(),
  population: [] as any[],
  plots: [] as any[],
  gateIds: {} as { [plotId: string]: string[] },
  values: {} as Record<string, any>,
  // Reactivity lives on this small holder, not on the population array: the cap
  // tests build 50k stubs and making those reactive proxies exhausts the heap.
  signal: { tick: 0 } as { tick: number },
}));

vi.mock("@/store/filters", () => ({
  default: {
    get analysisPlots() {
      return mocks.plots;
    },
    get analysisGateIds() {
      return mocks.gateIds;
    },
    get analysisValues() {
      return mocks.values;
    },
    get annotationsPassingNonGateFilters() {
      mocks.signal.tick; // subscribe, so a test can force a recompute
      return mocks.population;
    },
    get filteredAnnotations() {
      return mocks.population;
    },
    setAnalysisPanelOpen: mocks.setAnalysisPanelOpen,
    addAnalysisPlot: mocks.addAnalysisPlot,
  },
}));

vi.mock("@/store", () => ({
  default: { dataset: { id: "ds1", channelNames: new Map([[0, "DAPI"]]) } },
}));

vi.mock("@/store/properties", () => ({
  default: {
    computedPropertyPaths: [["p", "Area"]],
    getFullNameFromPath: () => "Prop / Area",
  },
}));

import AnalysisPanel from "./AnalysisPanel.vue";

function setPlots(next: any[]) {
  mocks.plots.length = 0;
  mocks.plots.push(...next);
}

function stub(id: string) {
  return {
    id,
    tags: [],
    shape: "point",
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
  };
}

function setPopulation(n: number) {
  mocks.population.length = 0;
  for (let i = 0; i < n; i++) {
    mocks.population.push(stub(`id-${i}`));
  }
  mocks.signal.tick++;
}

const AXIS = { type: "property" as const, path: ["p", "Area"] };

function makePlot(id: string, overrides: any = {}) {
  return {
    id,
    xAxis: AXIS,
    yAxis: AXIS,
    gate: null,
    gateEnabled: true,
    ...overrides,
  };
}

const GATE = {
  categoryKeyVersion: 1 as const,
  vertices: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ],
  xCategories: null,
  yCategories: null,
};

function mountPanel(props: { visible: boolean }) {
  return shallowMount(AnalysisPanel, { props });
}

describe("AnalysisPanel", () => {
  beforeEach(() => {
    mocks.setAnalysisPanelOpen.mockClear();
    setPlots([]);
    mocks.signal = reactive({ tick: 0 });
    mocks.gateIds = {};
    mocks.values = {};
    setPopulation(10);
  });

  it("reports its open state to the store, including on unmount", async () => {
    // The store fetches for ungated plots only while someone is looking, so a
    // panel that never reported closing would keep paying for a hidden palette.
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.setAnalysisPanelOpen).toHaveBeenLastCalledWith(true);

    await wrapper.setProps({ visible: false });
    expect(mocks.setAnalysisPanelOpen).toHaveBeenLastCalledWith(false);

    await wrapper.setProps({ visible: true });
    wrapper.unmount();
    expect(mocks.setAnalysisPanelOpen).toHaveBeenLastCalledWith(false);
  });

  it("does no display work and retains no plot populations while hidden", async () => {
    setPopulation(3);
    mocks.values = { "id-0": { p: { Area: 1 } } };
    setPlots([makePlot("p1")]);
    const wrapper = mountPanel({ visible: false });
    await flushPromises();

    expect(wrapper.vm.plotInputs).toEqual([]);
    expect(wrapper.vm.seriesByPlot).toEqual({});
    expect(
      wrapper.findComponent({ name: "AnalysisScatterPlot" }).exists(),
    ).toBe(false);

    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(wrapper.vm.plotInputs).toHaveLength(1);
    expect(Object.keys(wrapper.vm.seriesByPlot)).toEqual(["p1"]);
    expect(
      wrapper.findComponent({ name: "AnalysisScatterPlot" }).exists(),
    ).toBe(true);

    await wrapper.setProps({ visible: false });
    await flushPromises();
    expect(wrapper.vm.plotInputs).toEqual([]);
    expect(wrapper.vm.seriesByPlot).toEqual({});
  });

  it("refuses to plot above the point cap", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.vm.overCap).toBe(true);
    expect(wrapper.find(".analysis-overcap").exists()).toBe(true);
  });

  it("plots at exactly the cap", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50000);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.vm.overCap).toBe(false);
    expect(wrapper.find(".analysis-overcap").exists()).toBe(false);
  });

  it("feeds each plot the population passing the PRECEDING gates only", async () => {
    // Sequential gating: a plot must never filter its own scatter, or the
    // points just lassoed would vanish from the plot they were drawn on.
    setPopulation(4); // id-0..id-3
    setPlots([
      makePlot("p1", { gate: GATE }),
      makePlot("p2", { gate: GATE }),
      makePlot("p3"),
    ]);
    mocks.gateIds = { p1: ["id-0", "id-1", "id-2"], p2: ["id-0"] };
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    const inputs = wrapper.vm.plotInputs.map((rows: any[]) =>
      rows.map((r) => r.id),
    );
    expect(inputs[0]).toEqual(["id-0", "id-1", "id-2", "id-3"]);
    expect(inputs[1]).toEqual(["id-0", "id-1", "id-2"]);
    expect(inputs[2]).toEqual(["id-0"]);
  });

  it("keeps plot input arrays identity-stable when nothing changed", async () => {
    // Without this every Z-scrub hands the scatter a new array and re-renders
    // every plot, because the base getter rebuilds on any dependency touch.
    setPopulation(3);
    setPlots([makePlot("p1")]);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    const before = wrapper.vm.plotInputs[0];

    mocks.signal.tick++; // base getter re-evaluates, same contents
    await flushPromises();
    expect(wrapper.vm.plotInputs[0]).toBe(before);
  });

  it("drops memoised inputs for removed plots", async () => {
    // Each retained entry pins a population of up to MAX_ANALYSIS_PLOT_POINTS.
    setPopulation(3);
    setPlots([makePlot("p1"), makePlot("p2")]);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.vm.plotInputs).toHaveLength(2);

    setPlots([makePlot("p1")]);
    mocks.signal.tick++;
    await flushPromises();
    expect(wrapper.vm.plotInputs).toHaveLength(1);
  });

  it("builds a series per plot with both axes chosen, and none without", async () => {
    setPopulation(2);
    mocks.values = { "id-0": { p: { Area: 1 } } };
    setPlots([makePlot("p1"), makePlot("p2", { yAxis: null })]);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(Object.keys(wrapper.vm.seriesByPlot)).toEqual(["p1"]);
    expect(wrapper.vm.seriesByPlot.p1.ids).toEqual(["id-0"]);
    expect(wrapper.vm.seriesByPlot.p1.skipped).toBe(1); // id-1 has no value
  });

  it("offers every categorical axis plus each computed property path", async () => {
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    const items = wrapper.vm.axisItems.map((i: any) => i.text);
    expect(items).toContain("Tags");
    expect(items).toContain("Shape");
    expect(items).toContain("Channel");
    expect(items).toContain("Prop / Area");
  });
});
