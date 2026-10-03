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
  analysisLoading: false,
  // The panel renders a banner from this. Absent from the mock, no component
  // test could render it at all — so the checklist invariant about its
  // wording had nothing holding it.
  gateError: null as string | null,
  propertyValuesRevision: 0,
  // Behind the reactivity signal like its twin above. As a plain constant no
  // test could drive it, so the "an annotation edit refetches the histogram"
  // half of requestSignature was untestable — the two sit on adjacent lines
  // of the same signature and drifted anyway.
  contentRevision: 0,
  // Reactivity lives on this small holder, not on the population array: the cap
  // tests build 50k stubs and making those reactive proxies exhausts the heap.
  signal: { tick: 0 } as { tick: number },
}));

vi.mock("@/store/filters", () => ({
  default: {
    get analysisPlots() {
      // Subscribe to the reactivity signal: the real getter is reactive, and
      // a plain array here meant plot add/remove never re-ran the watchers
      // these tests exist to exercise.
      mocks.signal.tick;
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
    get analysisLoading() {
      return mocks.analysisLoading;
    },
    get analysisGateError() {
      mocks.signal.tick;
      return mocks.gateError;
    },
    get canAddAnalysisPlot() {
      return mocks.plots.length < 20;
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
    get propertyValuesRevision() {
      mocks.signal.tick;
      return mocks.propertyValuesRevision;
    },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    get contentRevision() {
      mocks.signal.tick;
      return mocks.contentRevision;
    },
  },
}));

import AnalysisPanel from "./AnalysisPanel.vue";

function setPlots(next: any[]) {
  // Replace the array wholesale, as the real store does
  // (applyAnalysisPlots builds a new array). Mutating in place kept the
  // same reference, so computeds downstream of `analysisPlots` never
  // invalidated and watchers under test silently never re-ran.
  mocks.plots = [...next];
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
    mocks.analysisLoading = false;
    mocks.gateError = null;
    setPlots([]);
    mocks.signal = reactive({ tick: 0 });
    mocks.gateIds = {};
    mocks.values = {};
    mocks.propertyValuesRevision = 0;
    mocks.contentRevision = 0;
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
  // -- Busy indicator --
  //
  // The palette body scrolls, so a notice in the content flow is invisible
  // once the user scrolls to a plot — exactly when they are waiting on it.
  // And above the cap the slow part is the per-plot histogram fetch
  // (seconds at 700K), which previously showed nothing at all.
  it("shows the busy bar while property values are loading", async () => {
    mocks.analysisLoading = true;
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.find(".analysis-busy").exists()).toBe(true);
  });

  it("shows the busy bar while a histogram request is in flight", async () => {
    setPlots([makePlot("p1")]);
    setPopulation(50001);
    let release: (v: any) => void = () => {};
    mocks.fetchAnalysisHistogram.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.find(".analysis-busy").exists()).toBe(true);
    release(null);
    await flushPromises();
    expect(wrapper.find(".analysis-busy").exists()).toBe(false);
  });

  it("hides the busy bar when nothing is in flight", async () => {
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.find(".analysis-busy").exists()).toBe(false);
  });

  it("disables Add plot at the cap", async () => {
    setPlots(Array.from({ length: 20 }, (_, i) => makePlot(`p${i}`)));
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(wrapper.vm.canAddPlot).toBe(false);
  });
  it("serializes histogram requests instead of firing one per plot", async () => {
    // Codex round 3: each histogram request independently re-scans the whole
    // dataset server-side, so N plots opening at once meant N concurrent
    // full-dataset scans. Requests are queued; only one is in flight.
    setPopulation(50001);
    setPlots([makePlot("p1"), makePlot("p2"), makePlot("p3")]);
    const releases: ((v: any) => void)[] = [];
    mocks.fetchAnalysisHistogram.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );
    mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
    releases[0](null);
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(2);
    releases[1](null);
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(3);
  });
  // Codex round 4: serializing the requests introduced a way for queued work
  // to outlive its reason. The queue captures a guard OBJECT, so deleting the
  // map entry (plot removed) or skipping the prune (panel closed) left the
  // captured guard current — the queued callback passed its pre-dispatch
  // check and ran a full-dataset scan for a plot nobody is looking at.
  it("drops queued histogram work when the panel closes", async () => {
    setPopulation(50001);
    setPlots([makePlot("p1"), makePlot("p2")]);
    const releases: ((v: any) => void)[] = [];
    mocks.fetchAnalysisHistogram.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ visible: false });
    await flushPromises();
    // Let the in-flight one finish; the queued second must NOT dispatch.
    releases[0](null);
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
  });

  it("drops queued histogram work for a removed plot", async () => {
    setPopulation(50001);
    setPlots([makePlot("p1"), makePlot("p2")]);
    const releases: ((v: any) => void)[] = [];
    mocks.fetchAnalysisHistogram.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);

    setPlots([makePlot("p1")]); // p2 removed while its work is queued
    mocks.signal.tick++;
    await flushPromises();
    releases[0](null);
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1);
    expect(Object.keys(wrapper.vm.histogramsByPlot)).not.toContain("p2");
  });
  it("still invalidates a requeued plot after an older generation finishes", async () => {
    // Codex round 5: pending state keyed by plot id collapses generations.
    // The OLD callback's cleanup deletes p1's entry, so a REPLACEMENT p1
    // request queued behind p2 becomes invisible to invalidation. The order
    // matters: the old generation must FINISH before the panel closes.
    setPopulation(50001);
    setPlots([makePlot("p1"), makePlot("p2")]);
    const releases: ((v: any) => void)[] = [];
    mocks.fetchAnalysisHistogram.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1); // p1

    // Supersede p1: a second p1 generation queues behind p2.
    mocks.propertyValuesRevision = 1;
    mocks.signal.tick++;
    await flushPromises();

    // Finish the OLD p1 — its cleanup runs, and p2 dispatches.
    releases[0](null);
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(2); // p2

    // Close the panel. The queued p1 replacement must be invalidated too.
    await wrapper.setProps({ visible: false });
    await flushPromises();

    releases[1](null); // finish p2; queue advances to the p1 replacement
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(2);
  });

  it("drops the displayed histogram as soon as its inputs change", async () => {
    // Only committing on success left the previous response on screen for the
    // seconds a whole-dataset request takes — and indefinitely if it failed,
    // since a failure deliberately preserves the display. Right for the same
    // inputs, wrong for new ones: the stale response describes the OLD axes,
    // and AnalysisScatterPlot's onShapesRelayout pins
    // `props.histogram.xCategories` into any gate drawn meanwhile, so a gate
    // could be saved carrying the previous axis's category order — silently
    // the wrong membership, not merely a stale picture.
    setPopulation(50001);
    setPlots([makePlot("p1")]);
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
    expect(wrapper.vm.histogramsByPlot.p1).toBeTruthy();

    // Change the axis, and hold the replacement in flight.
    const releases: ((v: any) => void)[] = [];
    mocks.fetchAnalysisHistogram.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );
    setPlots([makePlot("p1", { xAxis: { type: "categorical", key: "tags" } })]);
    mocks.signal.tick++;
    await flushPromises();
    // Nothing is displayed for the new axes yet, so nothing can be pinned
    // from the old ones.
    expect(wrapper.vm.histogramsByPlot.p1 ?? null).toBeNull();

    // ...and a FAILED replacement must not resurrect the old display either.
    releases[0](null);
    await flushPromises();
    expect(wrapper.vm.histogramsByPlot.p1 ?? null).toBeNull();
  });

  it("describes a gate refusal as partial, not as everything being unfiltered", async () => {
    // Resolution is per plot, so a refused batch leaves already-resolved
    // gates filtering. The banner used to say "the viewer and the Objects tab
    // show everything the other filters allow", which described the
    // all-or-nothing behaviour that preceded per-plot resolution and
    // misstated what is on screen. Asserted on rendered text because that is
    // the surface that was wrong — nothing typechecks a sentence.
    mocks.gateError = "gates resolve to more than the 2000000 ids";
    const wrapper = mountPanel({ visible: true });
    await flushPromises();

    const banner = wrapper.find(".analysis-gate-error");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("2000000");
    // Says the failure is partial...
    expect(banner.text()).toMatch(/some gates/i);
    expect(banner.text()).toMatch(/resolved earlier still is/i);
    // ...and never claims the whole gate set is off.
    expect(banner.text()).not.toMatch(/everything the other filters allow/i);

    mocks.gateError = null;
    mocks.signal.tick++;
    await flushPromises();
    expect(wrapper.find(".analysis-gate-error").exists()).toBe(false);
  });

  it("keeps invalidating after a close, reopen and close", async () => {
    // One layer under the round-5 bug. invalidatePendingHistograms used to
    // DELETE the pending entry while callbacks for that plot were still
    // queued. Those callbacks still run their `finally`, so a superseded
    // generation's decrement landed on a LATER generation's entry and removed
    // it — making that generation invisible to the next invalidation. The
    // count belongs to the outstanding callbacks; only they may clear it.
    setPopulation(50001);
    setPlots([makePlot("p1"), makePlot("p2")]);
    const releases: ((v: any) => void)[] = [];
    mocks.fetchAnalysisHistogram.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );
    const wrapper = mountPanel({ visible: true });
    await flushPromises();
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(1); // p1 gen A

    // Close, then reopen: both plots requeue while gen A is still in flight.
    await wrapper.setProps({ visible: false });
    await flushPromises();
    await wrapper.setProps({ visible: true });
    await flushPromises();

    // Gen A settles. Its cleanup must not consume the NEW p1 entry.
    releases[0](null);
    await flushPromises();
    const afterGenA = mocks.fetchAnalysisHistogram.mock.calls.length;

    // Close again. Everything still queued must be superseded.
    await wrapper.setProps({ visible: false });
    await flushPromises();
    for (const release of releases.slice(1)) {
      release(null);
      await flushPromises();
    }
    // No further dispatch: a full-dataset scan must never start after the
    // panel has closed.
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(afterGenA);
  });

  it("survives a throw while processing a response", async () => {
    // The queue chain had no catch, so one throw left `histogramQueue` in a
    // rejected state and every later `.then(cb)` skipped its callback — all
    // histogram fetching silently dead for the rest of the session. And
    // because histogramsInFlight is incremented BEFORE the .then, each
    // skipped generation leaked a count and pinned the busy bar on.
    setPopulation(50001);
    setPlots([makePlot("p1"), makePlot("p2")]);
    // A categorical axis whose response omits xCategories: `!== null` passes
    // for undefined, and the label mapping then throws on .map.
    mocks.fetchAnalysisHistogram.mockImplementation(async () => ({
      counts: [[1]],
      xEdges: null,
      yEdges: null,
      xCategories: undefined,
      yCategories: undefined,
      inputCount: 1,
      plottedCount: 1,
      gateCount: null,
    }));
    setPlots([
      makePlot("p1", { xAxis: { type: "categorical", key: "shape" } }),
      makePlot("p2"),
    ]);
    const wrapper = mountPanel({ visible: true });
    await flushPromises();

    // p2 still gets its turn, and the busy bar clears (nothing else is
    // loading, so `busy` is exactly "a histogram is outstanding").
    expect(mocks.fetchAnalysisHistogram).toHaveBeenCalledTimes(2);
    expect(wrapper.vm.busy).toBe(false);
  });
});
