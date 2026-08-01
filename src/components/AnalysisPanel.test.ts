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
  fetchAnalysisHistogram: vi.fn(async (...args: any[]): Promise<any> => {
    void args; // vi.fn needs the rest signature for typed spread calls
    return null;
  }),
  population: [] as any[],
  plots: [] as any[],
  gateIds: {} as { [plotId: string]: string[] },
  values: {} as Record<string, any>,
  histogramSpec: { filters: {} as any, skipped: [] as string[] },
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
    get analysisPopulation() {
      mocks.signal.tick;
      // The real Vuex getter rebuilds a bounded array when a dependency
      // changes. Return a fresh shallow array so the component's computed can
      // notify its watcher while keeping the 50k test stubs non-reactive.
      return mocks.population.slice(0, 50001);
    },
    get filteredAnnotations() {
      return mocks.population;
    },
    get analysisHistogramFilterSpec() {
      return mocks.histogramSpec;
    },
    setAnalysisPanelOpen: mocks.setAnalysisPanelOpen,
    addAnalysisPlot: mocks.addAnalysisPlot,
  },
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", channelNames: new Map([[0, "DAPI"]]) },
    annotationsAPI: {
      fetchAnalysisHistogram: (...args: any[]) =>
        mocks.fetchAnalysisHistogram(...args),
    },
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    computedPropertyPaths: [["p", "Area"]],
    getFullNameFromPath: () => "Prop / Area",
    propertyValuesRevision: 0,
  },
}));

vi.mock("@/store/annotation", () => ({
  default: { contentRevision: 0 },
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
    mocks.fetchAnalysisHistogram.mockClear();
    mocks.fetchAnalysisHistogram.mockResolvedValue(null);
    mocks.histogramSpec = { filters: {}, skipped: [] };
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

  it("switches to server-binned heatmaps above the point cap", async () => {
    // SERVER_GATING.md Phase 2: the cap no longer blanks the panel — plots
    // render as heatmaps from histogram2d, and no client series is built
    // (that would walk a 50k+ chain per touch).
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.vm.overCap).toBe(true);
    expect(wrapper.find(".analysis-overcap").exists()).toBe(true);
    expect(wrapper.vm.seriesByPlot).toEqual({});
    expect(
      wrapper.findComponent({ name: "AnalysisScatterPlot" }).exists(),
    ).toBe(true);
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
    const [datasetId, request] = mocks.fetchAnalysisHistogram.mock.calls[0] as [
      string,
      any,
    ];
    expect(datasetId).toBe("ds1");
    expect(request.xAxis).toEqual(AXIS);
    expect(request.bins).toEqual({ x: 128, y: 128 });
  });

  it("does not fetch histograms while hidden or below the cap", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    mountPanel({ visible: false });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).not.toHaveBeenCalled();
    setPopulation(3);
    mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).not.toHaveBeenCalled();
  });

  it("does not refetch an unchanged histogram on reopen", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    // A SUCCESSFUL response: a failed fetch deliberately forgets its
    // signature so the next open retries it.
    mocks.fetchAnalysisHistogram.mockResolvedValue({
      counts: [[1]],
      xEdges: [0, 1],
      yEdges: [0, 1],
      xCategories: null,
      yCategories: null,
      inputCount: 1,
      plottedCount: 1,
      gateCount: null,
    });
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ visible: false });
    await flushPromises();
    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
  });

  it("retries a failed histogram fetch on the next open", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(2);
  });

  it("names the filters the distributions cannot express", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    mocks.histogramSpec = {
      filters: {},
      skipped: ["region (ROI) filters"],
    };
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.find(".analysis-skipped").text()).toContain(
      "region (ROI) filters",
    );
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
