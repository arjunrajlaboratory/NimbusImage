/**
 * The scatter's wiring to Plotly: the selection round-trip and the handler
 * lifecycle. The coordinate maths lives in analysisGating.test.ts; what is only
 * testable here is that a lasso reaches the store as a POLYGON (not as the ids
 * it happened to contain) and that the handlers are attached exactly once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const mocks = vi.hoisted(() => {
  const handlers: { [event: string]: ((payload: any) => void)[] } = {};
  return {
    handlers,
    react: vi.fn(async (element: any) => {
      // Mirror Plotly: the div becomes an event emitter once plotted.
      element.on = (event: string, handler: (payload: any) => void) => {
        (handlers[event] ??= []).push(handler);
      };
    }),
    purge: vi.fn(),
    setAnalysisPlotGate: vi.fn(),
    toggleAnalysisPlotGateEnabled: vi.fn(),
    removeAnalysisPlot: vi.fn(),
    setAnalysisPlotAxes: vi.fn(),
    setAnalysisPlotDisplay: vi.fn(),
  };
});

vi.mock("plotly.js-dist-min", () => ({
  default: { react: mocks.react, purge: mocks.purge },
}));

vi.mock("@/store/filters", () => ({
  default: {
    setAnalysisPlotGate: mocks.setAnalysisPlotGate,
    toggleAnalysisPlotGateEnabled: mocks.toggleAnalysisPlotGateEnabled,
    removeAnalysisPlot: mocks.removeAnalysisPlot,
    setAnalysisPlotAxes: mocks.setAnalysisPlotAxes,
    setAnalysisPlotDisplay: mocks.setAnalysisPlotDisplay,
  },
}));

vi.mock("vuetify", () => ({
  useTheme: () => ({
    current: { value: { dark: true, colors: { "on-surface": "#fff" } } },
  }),
}));

import AnalysisScatterPlot from "./AnalysisScatterPlot.vue";

const SERIES = {
  ids: ["a", "b", "c"],
  x: [1, 2, 3],
  y: [1, 2, 3],
  xCategories: null,
  yCategories: null,
  xCategoryLabels: null,
  yCategoryLabels: null,
  skipped: 1,
};

const PLOT = {
  id: "p1",
  xAxis: { type: "property" as const, path: ["prop", "Area"] },
  yAxis: { type: "property" as const, path: ["prop", "Mean"] },
  gate: null,
  gateEnabled: true,
};

function mountPlot(overrides: Record<string, unknown> = {}) {
  return shallowMount(AnalysisScatterPlot, {
    props: {
      plot: PLOT,
      index: 0,
      series: SERIES,
      gateIds: null,
      inputCount: 4,
      axisItems: [],
      ...overrides,
    },
    global: { stubs: { "v-checkbox": true, "v-chip": true, "v-btn": true } },
  });
}

let wrapper: ReturnType<typeof mountPlot> | null = null;

describe("AnalysisScatterPlot", () => {
  beforeEach(() => {
    Object.keys(mocks.handlers).forEach((key) => delete mocks.handlers[key]);
    mocks.react.mockClear();
    mocks.setAnalysisPlotGate.mockClear();
  });

  afterEach(() => {
    // Leaving a wrapper mounted would let its handlers fire in the next test.
    wrapper?.unmount();
    wrapper = null;
  });

  it("plots the series it is given", async () => {
    wrapper = mountPlot();
    await flushPromises();
    expect(mocks.react).toHaveBeenCalledTimes(1);
    const [, traces] = mocks.react.mock.calls[0] as unknown as any[];
    expect(traces[0].x).toEqual(SERIES.x);
    expect(traces[0].customdata).toEqual(SERIES.ids);
  });

  it("uses display labels rather than category identity keys for ticks", async () => {
    wrapper = mountPlot({
      plot: {
        ...PLOT,
        xAxis: { type: "categorical", key: "channel" },
      },
      series: {
        ...SERIES,
        xCategories: ["v1:0", "v1:1"],
        xCategoryLabels: ["DAPI", "DAPI"],
      },
    });
    await flushPromises();

    const [, , layout] = mocks.react.mock.calls[0] as unknown as any[];
    expect(layout.xaxis.ticktext).toEqual(["DAPI", "DAPI"]);
  });

  it("sends a lasso to the store as a polygon, not as ids", async () => {
    // The whole reason a gate is persistable: ids belong to one dataset, the
    // configuration is shared by all of them.
    wrapper = mountPlot();
    await flushPromises();
    mocks.handlers["plotly_selected"][0]({
      points: [{ customdata: "a" }],
      lassoPoints: { x: [0, 5, 5], y: [0, 0, 5] },
    });
    expect(mocks.setAnalysisPlotGate).toHaveBeenCalledWith({
      id: "p1",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
        ],
        xCategories: null,
        yCategories: null,
      },
    });
  });

  it("ignores a selection event carrying no lasso or range", async () => {
    // Plotly emits bare events during internal clears; wiping the gate there
    // would silently discard the user's work.
    wrapper = mountPlot();
    await flushPromises();
    mocks.handlers["plotly_selected"][0]({ points: [] });
    expect(mocks.setAnalysisPlotGate).not.toHaveBeenCalled();
  });

  it("clears the gate on deselect", async () => {
    wrapper = mountPlot();
    await flushPromises();
    mocks.handlers["plotly_deselect"][0]({});
    expect(mocks.setAnalysisPlotGate).toHaveBeenCalledWith({
      id: "p1",
      gate: null,
    });
  });

  it("attaches selection handlers exactly once across repeated renders", async () => {
    wrapper = mountPlot();
    await flushPromises();
    await wrapper.setProps({ series: { ...SERIES, x: [9, 9, 9] } });
    await flushPromises();
    await wrapper.setProps({ gateIds: ["a"] });
    await flushPromises();
    expect(mocks.react.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.handlers["plotly_selected"]).toHaveLength(1);
    expect(mocks.handlers["plotly_deselect"]).toHaveLength(1);
  });

  it("attaches selection handlers exactly once when two renders overlap", async () => {
    // The real path: the mount render is still awaiting Plotly while the
    // panel's value fetch resolves and re-triggers the watcher. Both renders
    // would see "first render" if the flag were only claimed after the await,
    // and a single lasso would then call setAnalysisPlotGate twice.
    const pending: (() => void)[] = [];
    mocks.react.mockImplementationOnce(
      (element: any) =>
        new Promise<void>((resolve) =>
          pending.push(() => {
            element.on = (event: string, handler: (payload: any) => void) => {
              (mocks.handlers[event] ??= []).push(handler);
            };
            resolve();
          }),
        ) as any,
    );
    wrapper = mountPlot();
    await flushPromises(); // first render is now parked inside react()
    await wrapper.setProps({ series: { ...SERIES, x: [9, 9, 9] } });
    await flushPromises(); // second render runs while the first is unfinished
    pending.forEach((resolve) => resolve());
    await flushPromises();

    expect(mocks.react.mock.calls.length).toBe(2);
    expect(mocks.handlers["plotly_selected"]).toHaveLength(1);
    mocks.handlers["plotly_selected"][0]({
      lassoPoints: { x: [0, 5, 5], y: [0, 0, 5] },
    });
    expect(mocks.setAnalysisPlotGate).toHaveBeenCalledTimes(1);
  });

  it("marks the gated points as selected in the trace", async () => {
    wrapper = mountPlot({ gateIds: ["a", "c"] });
    await flushPromises();
    const [, traces] = mocks.react.mock.calls[0] as unknown as any[];
    expect(traces[0].selectedpoints).toEqual([0, 2]);
  });

  it("leaves selectedpoints null when no gate has been resolved", async () => {
    wrapper = mountPlot({ gateIds: null });
    await flushPromises();
    const [, traces] = mocks.react.mock.calls[0] as unknown as any[];
    expect(traces[0].selectedpoints).toBeNull();
  });

  it("renders the pick-axes hint instead of a plot when series is null", async () => {
    wrapper = mountPlot({ series: null });
    await flushPromises();
    expect(mocks.react).not.toHaveBeenCalled();
    expect(wrapper.find(".ap-hint").exists()).toBe(true);
  });

  it("renders when axes are chosen after mount (series null -> set)", async () => {
    // The plot div is behind v-if="series", so a pre-flush watcher fires while
    // the ref is still undefined and renderPlot returns early. Property axes
    // masked this via a second update when their values arrived; a
    // categorical-only plot computes its series once and stayed blank forever.
    wrapper = mountPlot({ series: null });
    await flushPromises();
    expect(mocks.react).not.toHaveBeenCalled();

    await wrapper.setProps({ series: SERIES });
    await flushPromises();
    expect(mocks.react).toHaveBeenCalledTimes(1);
    const [, traces] = mocks.react.mock.calls[0] as unknown as any[];
    expect(traces[0].x).toEqual(SERIES.x);
  });

  it("purges the plot on unmount", async () => {
    wrapper = mountPlot();
    await flushPromises();
    mocks.purge.mockClear();
    wrapper.unmount();
    wrapper = null;
    expect(mocks.purge).toHaveBeenCalled();
  });
});

// Heatmap mode (SERVER_GATING.md, Phase 2): above the cap the plot renders
// server-binned counts, and gates arrive as drawn layout shapes instead of
// lasso selections.
describe("AnalysisScatterPlot heatmap mode", () => {
  const HISTOGRAM = {
    counts: [
      [1, 2],
      [3, 4],
    ],
    xEdges: [0, 5, 10],
    yEdges: [0, 5, 10],
    xCategories: null,
    yCategories: null,
    xCategoryLabels: null,
    yCategoryLabels: null,
    inputCount: 100000,
    plottedCount: 90000,
    gateCount: 4521,
  };

  beforeEach(() => {
    Object.keys(mocks.handlers).forEach((key) => delete mocks.handlers[key]);
    mocks.react.mockClear();
    mocks.setAnalysisPlotGate.mockClear();
  });

  function mountHeatmap(overrides: Record<string, unknown> = {}) {
    return mountPlot({
      series: null,
      overCap: true,
      histogram: HISTOGRAM,
      ...overrides,
    });
  }

  it("renders a heatmap trace with shape drawing enabled", async () => {
    wrapper = mountHeatmap();
    await flushPromises();
    const [, traces, layout] = mocks.react.mock.calls.at(-1)! as any[];
    expect(traces[0].type).toBe("heatmap");
    expect(traces[0].z).toEqual(HISTOGRAM.counts);
    // Bin centers from edges.
    expect(traces[0].x).toEqual([2.5, 7.5]);
    expect(layout.dragmode).toBe("drawclosedpath");
  });

  it("turns a drawn closed path into a gate", async () => {
    wrapper = mountHeatmap();
    await flushPromises();
    for (const handler of mocks.handlers["plotly_relayout"] ?? []) {
      handler({ shapes: [{ type: "path", path: "M1,2L3,4L5,0Z" }] });
    }
    expect(mocks.setAnalysisPlotGate).toHaveBeenCalledWith({
      id: "p1",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 0 },
        ],
        xCategories: null,
        yCategories: null,
      },
    });
  });

  it("pins the server-derived category order into a drawn gate", async () => {
    wrapper = mountHeatmap({
      histogram: {
        ...HISTOGRAM,
        xEdges: null,
        xCategories: ['v1:["a"]', 'v1:["b"]'],
        xCategoryLabels: ["a", "b"],
      },
    });
    await flushPromises();
    for (const handler of mocks.handlers["plotly_relayout"] ?? []) {
      handler({ shapes: [{ type: "rect", x0: 0, x1: 1, y0: 0, y1: 1 }] });
    }
    const gate = mocks.setAnalysisPlotGate.mock.calls.at(-1)![0].gate;
    expect(gate.xCategories).toEqual(['v1:["a"]', 'v1:["b"]']);
  });

  it("ignores non-shape relayouts and the persisted gate's own shape", async () => {
    const gate = {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      xCategories: null,
      yCategories: null,
    };
    wrapper = mountHeatmap({ plot: { ...PLOT, gate } });
    await flushPromises();
    for (const handler of mocks.handlers["plotly_relayout"] ?? []) {
      handler({ "xaxis.autorange": true });
      // Only the persisted shape present: nothing new was drawn.
      handler({ shapes: [{ type: "path", path: "M0,0L1,0L1,1Z" }] });
    }
    expect(mocks.setAnalysisPlotGate).not.toHaveBeenCalled();
  });

  it("shows the panel's chained badge count, not pure ids", async () => {
    wrapper = mountHeatmap({
      plot: {
        ...PLOT,
        gate: {
          categoryKeyVersion: 1 as const,
          vertices: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
          xCategories: null,
          yCategories: null,
        },
      },
      // Pure server ids over the whole dataset — NOT what the badge shows.
      gateIds: Array.from({ length: 70000 }, (_, i) => `id-${i}`),
      chainedGateCount: 4521,
    });
    await flushPromises();
    expect((wrapper.vm as any).gateBadgeCount).toBe(4521);
    // Unknown (a gate still resolving): the placeholder, never the pure count.
    await wrapper.setProps({ chainedGateCount: null });
    expect((wrapper.vm as any).gateBadgeCount).toBeNull();
  });

  it("ignores lasso selection events in heatmap mode", async () => {
    wrapper = mountHeatmap();
    await flushPromises();
    for (const handler of mocks.handlers["plotly_selected"] ?? []) {
      handler({
        lassoPoints: { x: [0, 1, 2], y: [0, 1, 0] },
      });
    }
    expect(mocks.setAnalysisPlotGate).not.toHaveBeenCalled();
  });
});

// Dots mode: a display sample from the server, colored, gated by lasso. The
// gate is still a polygon in value space, resolved over every object.
describe("AnalysisScatterPlot dots mode", () => {
  const TAGS = { type: "categorical" as const, key: "tags" as const };
  const SAMPLE_HISTOGRAM = {
    counts: [[4]],
    xEdges: [0, 10],
    yEdges: [0, 10],
    xCategories: null,
    yCategories: null,
    xCategoryLabels: null,
    yCategoryLabels: null,
    colorCategoryLabels: ["B Cell", "T Cell"],
    inputCount: 700000,
    plottedCount: 700000,
    gateCount: null,
    sample: {
      x: [1, 2, 8, 9],
      y: [1, 2, 8, 9],
      total: 700000,
      color: [0, 1, 0, null],
      colorCategories: ['v1:["B Cell"]', 'v1:["T Cell"]'],
    },
  };

  beforeEach(() => {
    Object.keys(mocks.handlers).forEach((key) => delete mocks.handlers[key]);
    mocks.react.mockClear();
    mocks.setAnalysisPlotGate.mockClear();
    mocks.setAnalysisPlotDisplay.mockClear();
  });

  function mountDots(
    overrides: Record<string, unknown> = {},
    plot: Record<string, unknown> = {},
  ) {
    return mountPlot({
      plot: { ...PLOT, display: "dots", colorBy: TAGS, ...plot },
      series: null,
      overCap: true,
      histogram: SAMPLE_HISTOGRAM,
      ...overrides,
    });
  }

  it("draws every dot in one trace colored per point, with a legend", async () => {
    wrapper = mountDots();
    await flushPromises();
    const [, traces, layout] = mocks.react.mock.calls.at(-1)! as any[];
    // One interleaved trace (so large categories cannot paint over small
    // ones), then one legend proxy per category present.
    expect(traces[0].x).toEqual([1, 2, 8, 9]);
    expect(traces[0].hovertext).toEqual(["B Cell", "T Cell", "B Cell", ""]);
    expect(new Set(traces[0].marker.color).size).toBe(3); // two + no value
    expect(traces.slice(1).map((trace: any) => trace.name)).toEqual([
      "B Cell",
      "T Cell",
    ]);
    expect(layout.showlegend).toBe(true);
    expect(layout.legend.itemclick).toBe(false);
    expect(layout.dragmode).toBe("lasso");
  });

  it("colors a clustering by category and anything else on a ramp", async () => {
    const values = { ...SAMPLE_HISTOGRAM.sample, color: [0, 3, 3, null] };
    const numeric = {
      ...SAMPLE_HISTOGRAM,
      colorCategoryLabels: null,
      sample: { ...values, colorCategories: null },
    };
    const cluster = { type: "property" as const, path: ["c", "kmeans"] };
    wrapper = mountDots(
      {
        histogram: numeric,
        axisItems: [{ text: "Clustering / kmeans", value: "prop.c.kmeans" }],
      },
      { colorBy: cluster },
    );
    await flushPromises();
    let [, traces] = mocks.react.mock.calls.at(-1)! as any[];
    expect(traces.slice(1).map((trace: any) => trace.name)).toEqual(["0", "3"]);
    wrapper.unmount();
    // A gene count is integer too, but not a clustering: a colorbar.
    wrapper = mountDots(
      {
        histogram: numeric,
        axisItems: [
          { text: "Spatial table / MS4A1", value: "prop.spatial.MS4A1" },
        ],
      },
      { colorBy: { type: "property", path: ["spatial", "MS4A1"] } },
    );
    await flushPromises();
    [, traces] = mocks.react.mock.calls.at(-1)! as any[];
    const ramp = traces.find((trace: any) => trace.marker?.showscale);
    expect(ramp.x).toEqual([1, 2, 8]);
    expect(ramp.marker.color).toEqual([0, 3, 3]);
    expect(traces.find((trace: any) => trace.name === "No value").x).toEqual([
      9,
    ]);
  });

  it("turns a lasso into a gate and dims the dots outside it", async () => {
    wrapper = mountDots();
    await flushPromises();
    for (const handler of mocks.handlers["plotly_selected"] ?? []) {
      handler({ lassoPoints: { x: [0, 5, 5, 0], y: [0, 0, 5, 5] } });
    }
    expect(mocks.setAnalysisPlotGate).toHaveBeenCalledWith({
      id: "p1",
      gate: expect.objectContaining({
        vertices: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
          { x: 0, y: 5 },
        ],
        xCategories: null,
        yCategories: null,
      }),
    });
    // With that gate drawn, only the dots inside it are selected.
    await wrapper.setProps({
      plot: {
        ...PLOT,
        display: "dots",
        colorBy: TAGS,
        gate: {
          categoryKeyVersion: 1,
          vertices: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            { x: 5, y: 5 },
            { x: 0, y: 5 },
          ],
          xCategories: null,
          yCategories: null,
        },
      },
    });
    await flushPromises();
    const [, traces, layout] = mocks.react.mock.calls.at(-1)! as any[];
    expect(traces[0].selectedpoints).toEqual([0, 1]);
    expect(layout.shapes).toHaveLength(1);
  });

  it("switches display, and below the cap coloring turns dots on", async () => {
    wrapper = mountDots();
    await flushPromises();
    (wrapper.vm as any).setDisplay("density");
    expect(mocks.setAnalysisPlotDisplay).toHaveBeenLastCalledWith({
      id: "p1",
      display: "density",
    });
    wrapper.unmount();
    wrapper = mountPlot();
    await flushPromises();
    (wrapper.vm as any).setColorBy("cat.tags");
    expect(mocks.setAnalysisPlotDisplay).toHaveBeenLastCalledWith({
      id: "p1",
      colorBy: TAGS,
      display: "dots",
    });
    (wrapper.vm as any).setColorBy(null);
    expect(mocks.setAnalysisPlotDisplay).toHaveBeenLastCalledWith({
      id: "p1",
      colorBy: null,
      display: "density",
    });
  });
});
