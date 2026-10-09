<template>
  <div class="analysis-plot">
    <div class="ap-header">
      <v-checkbox
        :model-value="plot.gateEnabled"
        density="compact"
        hide-details
        class="ap-enable"
        title="Enable or disable this plot's gate"
        @update:model-value="toggleGateEnabled"
      />
      <span class="ap-title">Plot {{ index + 1 }}</span>
      <v-chip
        v-if="plot.gate !== null"
        size="x-small"
        variant="flat"
        :color="plot.gateEnabled ? 'primary' : undefined"
        class="ml-2"
      >
        gate:
        {{ gateBadgeCount === null ? "…" : gateBadgeCount.toLocaleString() }}
      </v-chip>
      <v-spacer />
      <v-btn
        v-if="plot.gate !== null"
        variant="text"
        size="x-small"
        @click="clearGate"
      >
        Clear gate
      </v-btn>
      <v-btn
        variant="text"
        icon
        size="x-small"
        title="Remove plot"
        @click="removePlot"
      >
        <v-icon size="16">mdi-close</v-icon>
      </v-btn>
    </div>

    <div class="ap-axes">
      <v-select
        :model-value="encodeAxis(plot.xAxis)"
        :items="axisItems"
        item-title="text"
        item-value="value"
        label="X axis"
        density="compact"
        variant="outlined"
        hide-details
        @update:model-value="setAxis('x', $event)"
      />
      <v-select
        :model-value="encodeAxis(plot.yAxis)"
        :items="axisItems"
        item-title="text"
        item-value="value"
        label="Y axis"
        density="compact"
        variant="outlined"
        hide-details
        @update:model-value="setAxis('y', $event)"
      />
    </div>

    <div v-if="axesChosen" class="ap-display">
      <v-btn-toggle
        v-if="overCap"
        :model-value="display"
        density="compact"
        variant="outlined"
        divided
        mandatory
        class="ap-display-toggle"
        @update:model-value="setDisplay"
      >
        <v-btn value="density" size="x-small" title="Binned density heatmap">
          Density
        </v-btn>
        <v-btn
          value="dots"
          size="x-small"
          :title="`A random sample of ${ANALYSIS_SAMPLE_POINTS.toLocaleString()} objects as dots`"
        >
          Dots
        </v-btn>
      </v-btn-toggle>
      <v-select
        v-if="!overCap || dotsMode"
        :model-value="encodeAxis(plot.colorBy ?? null)"
        :items="axisItems"
        item-title="text"
        item-value="value"
        label="Color by"
        clearable
        density="compact"
        variant="outlined"
        hide-details
        class="ap-color"
        @update:model-value="setColorBy"
      />
    </div>

    <div v-if="!axesChosen" class="ap-hint">
      Pick X and Y to plot this population ({{ inputCount.toLocaleString() }}
      objects).
      <template v-if="overCap && !dotsMode">
        Then draw a closed shape around the objects to keep.
      </template>
      <template v-else> Then lasso-select points to keep them. </template>
    </div>
    <div v-else-if="!plotReady" class="ap-hint">Loading distribution…</div>
    <template v-else>
      <div ref="plotEl" class="ap-plot"></div>
      <div class="ap-footer">
        <span v-if="dotsMode && histogram?.sample">
          <template v-if="histogram.sample.x.length < histogram.sample.total">
            A random {{ histogram.sample.x.length.toLocaleString() }} of
            {{ histogram.sample.total.toLocaleString() }} objects
          </template>
          <template v-else>
            {{ histogram.sample.total.toLocaleString() }} objects
          </template>
          <template v-if="histogram.inputCount > histogram.sample.total">
            ({{
              (histogram.inputCount - histogram.sample.total).toLocaleString()
            }}
            without values)
          </template>
          — lasso to gate; a gate applies to every object, not only the dots.
        </span>
        <span v-else-if="overCap && histogram">
          {{ histogram.plottedCount.toLocaleString() }} of
          {{ histogram.inputCount.toLocaleString() }} objects binned
          <template v-if="histogram.inputCount > histogram.plottedCount">
            ({{
              (histogram.inputCount - histogram.plottedCount).toLocaleString()
            }}
            without values)
          </template>
        </span>
        <span v-else-if="series">
          {{ series.ids.length.toLocaleString() }} of
          {{ inputCount.toLocaleString() }} objects plotted
          <template v-if="series.skipped > 0">
            ({{ series.skipped.toLocaleString() }} without values)
          </template>
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useTheme } from "vuetify";
import filterStore from "@/store/filters";
import {
  IAnalysisHistogramDisplay,
  IAnalysisPlot,
  TAnalysisAxis,
} from "@/store/model";
import { logError } from "@/utils/log";
import { encodeAxis, decodeAxis, IAxisItem } from "@/utils/analysisAxes";
import {
  IAnalysisSeries,
  isPointInPolygon,
  selectionEventToGate,
  shapeToGate,
} from "@/utils/analysisGating";
import { ANALYSIS_SAMPLE_POINTS } from "@/store/constants";
import { categoricalColor } from "@/utils/categoricalPalette";

const props = withDefaults(
  defineProps<{
    plot: IAnalysisPlot;
    index: number;
    // Built by the panel so drawing and gating share one coordinate function.
    // null until both axes are chosen (below the cap).
    series: IAnalysisSeries | null;
    // Ids inside this plot's gate, resolved by the store. null while
    // unresolved.
    gateIds: string[] | null;
    // Size of the population reaching this plot, for the "N of M" line.
    inputCount: number;
    axisItems: IAxisItem[];
    // Above the cap the plot renders server-binned counts instead of points
    // (SERVER_GATING.md, Phase 2), and gates are drawn as closed shapes.
    overCap?: boolean;
    histogram?: IAnalysisHistogramDisplay | null;
    // Above the cap: |gate ∩ this plot's input|, from the panel. null while
    // unknown (gate or an upstream gate not resolved yet).
    chainedGateCount?: number | null;
  }>(),
  { overCap: false, histogram: null, chainedGateCount: null },
);

const theme = useTheme();
// Most distinct integer values a numeric colorBy may have and still be
// colored as categories (cluster ids); more is a continuous ramp.
const MAX_CLUSTER_CATEGORIES = 30;
const CLUSTER_NAME = /clust|kmeans|leiden|louvain/i;
const plotEl = ref<HTMLElement>();

// Loaded lazily so plotly.js-dist-min never lands in the main bundle.
const plotly = shallowRef<any>(null);

const axesChosen = computed(
  () => props.plot.xAxis !== null && props.plot.yAxis !== null,
);
const display = computed(() => props.plot.display ?? "density");
// Dots: the server's display sample, at any population size (below the cap
// it is every point). Gates stay polygons in value space.
const dotsMode = computed(() => display.value === "dots");
// Dots and the heatmap both come from the histogram response.
const usesServerDisplay = computed(() => props.overCap || dotsMode.value);
const plotReady = computed(() =>
  usesServerDisplay.value ? props.histogram !== null : props.series !== null,
);
// Above the cap the resolved ids are the PURE polygon membership over the
// whole dataset; the badge shows the CHAINED count the panel computes from
// them (gate ∩ the population reaching this plot), matching the below-cap
// meaning of "objects this gate keeps here".
const gateBadgeCount = computed(() => {
  if (props.overCap) {
    // Never gateIds.length: the pure count over-states (it ignores the
    // filters and upstream gates), and a plausible wrong number is worse
    // than the "…" shown while the chained count is unknown.
    return props.chainedGateCount;
  }
  return props.gateIds === null ? null : props.gateIds.length;
});

function setAxis(which: "x" | "y", encoded: string | null) {
  const axis: TAnalysisAxis | null = decodeAxis(encoded);
  filterStore.setAnalysisPlotAxes(
    which === "x"
      ? { id: props.plot.id, xAxis: axis }
      : { id: props.plot.id, yAxis: axis },
  );
}

function setDisplay(value: "density" | "dots" | null) {
  if (value !== null) {
    filterStore.setAnalysisPlotDisplay({ id: props.plot.id, display: value });
  }
}

function setColorBy(encoded: string | null) {
  const colorBy = decodeAxis(encoded);
  // Below the cap, coloring is what dots mode is for: picking a color turns
  // it on and clearing it returns to the plain scatter.
  filterStore.setAnalysisPlotDisplay({
    id: props.plot.id,
    colorBy,
    ...(props.overCap ? {} : { display: colorBy ? "dots" : "density" }),
  });
}

function toggleGateEnabled() {
  filterStore.toggleAnalysisPlotGateEnabled(props.plot.id);
}

function clearGate() {
  filterStore.setAnalysisPlotGate({ id: props.plot.id, gate: null });
}

function removePlot() {
  filterStore.removeAnalysisPlot(props.plot.id);
}

const isDark = computed(() => theme.current.value.dark);

function axisTitle(axis: TAnalysisAxis | null): string {
  const encoded = encodeAxis(axis);
  return props.axisItems.find((item) => item.value === encoded)?.text ?? "";
}

function axisLayout(
  axis: TAnalysisAxis | null,
  categoryLabels: string[] | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: { text: axisTitle(axis), font: { size: 11 } },
    gridcolor: isDark.value ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)",
    zeroline: false,
    automargin: true,
  };
  if (categoryLabels) {
    base.tickmode = "array";
    base.tickvals = categoryLabels.map((_, idx) => idx);
    base.ticktext = categoryLabels;
    base.range = [-0.6, categoryLabels.length - 0.4];
  }
  return base;
}

async function ensurePlotly(): Promise<boolean> {
  if (plotly.value) {
    return true;
  }
  try {
    const module = await import("plotly.js-dist-min");
    plotly.value = (module as any).default ?? module; // CJS interop
  } catch (error) {
    logError("Failed to load plotly:", error);
    return false;
  }
  // The element can unmount while the import is in flight.
  return plotEl.value !== undefined;
}

function baseLayout(): Record<string, unknown> {
  return {
    autosize: true,
    height: 300,
    margin: { l: 52, r: 10, t: 10, b: 40 },
    hovermode: "closest",
    showlegend: false,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: theme.current.value.colors["on-surface"], size: 10 },
  };
}

/** "M x,y L x,y … Z" for rendering the persisted gate as a layout shape. */
function gateShapePath(vertices: { x: number; y: number }[]): string {
  return (
    vertices.map(({ x, y }, i) => `${i === 0 ? "M" : "L"}${x},${y}`).join("") +
    "Z"
  );
}

async function renderPlot() {
  if (!plotReady.value || !plotEl.value || !(await ensurePlotly())) {
    return;
  }
  const element = plotEl.value as any;
  const firstRender = !element.__nimbusPlotted;
  // Claimed BEFORE awaiting: two renders can overlap (the mount render awaits
  // the plotly import while a values fetch resolves and re-triggers the
  // watcher), and both would otherwise see firstRender true and attach a
  // second copy of the event handlers.
  element.__nimbusPlotted = true;

  let trace: Record<string, unknown>;
  const layout = baseLayout();
  const config: Record<string, unknown> = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["autoScale2d", "zoomIn2d", "zoomOut2d"],
  };

  let traces: Record<string, unknown>[] | null = null;
  if (dotsMode.value && props.histogram?.sample) {
    traces = dotTraces(props.histogram);
    layout.xaxis = axisLayout(
      props.plot.xAxis,
      props.histogram.xCategoryLabels,
    );
    layout.yaxis = axisLayout(
      props.plot.yAxis,
      props.histogram.yCategoryLabels,
    );
    layout.dragmode = "lasso";
    layout.shapes = gateShapes();
    // Plotly lays the legend out in two columns at palette width; reserve
    // the rows below the axis title rather than letting it overlap.
    const legendRows = Math.ceil(
      traces.filter((entry) => entry.showlegend === true).length / 2,
    );
    if (legendRows > 0) {
      const rowHeight = 19;
      const bottom = 60 + legendRows * rowHeight;
      const height = 300 + legendRows * rowHeight;
      const plotAreaHeight = height - 10 - bottom;
      layout.showlegend = true;
      layout.legend = {
        orientation: "h",
        x: 0,
        // Just below the x-axis title, in plot-area fractions.
        y: -52 / plotAreaHeight,
        yanchor: "top",
        font: { size: 9 },
        itemsizing: "constant",
        // The entries are proxies (see dotTraces): clicking one would hide
        // only the proxy, not the category's dots.
        itemclick: false,
        itemdoubleclick: false,
      };
      layout.height = height;
      layout.margin = { l: 52, r: 10, t: 10, b: bottom };
    }
    trace = traces[0];
  } else if (props.overCap && props.histogram) {
    const histogram = props.histogram;
    trace = {
      type: "heatmap",
      x: histogram.xEdges
        ? binCenters(histogram.xEdges)
        : (histogram.xCategories ?? []).map((_, idx) => idx),
      y: histogram.yEdges
        ? binCenters(histogram.yEdges)
        : (histogram.yCategories ?? []).map((_, idx) => idx),
      z: histogram.counts,
      colorscale: "Viridis",
      showscale: false,
      hoverinfo: "x+y+z",
    };
    layout.xaxis = axisLayout(props.plot.xAxis, histogram.xCategoryLabels);
    layout.yaxis = axisLayout(props.plot.yAxis, histogram.yCategoryLabels);
    // Gates are drawn as closed shapes — a heatmap has no points to lasso.
    layout.dragmode = "drawclosedpath";
    layout.newshape = {
      line: { color: "#ffab40", width: 2 },
      fillcolor: "rgba(255, 171, 64, 0.15)",
    };
    // The persisted gate, re-rendered so it is visible on the heatmap. Not
    // editable: redrawing replaces it, and "Clear gate" removes it.
    layout.shapes = gateShapes();
    config.modeBarButtonsToAdd = ["drawclosedpath", "drawrect"];
  } else if (props.series) {
    const series = props.series;
    const gateSet = props.gateIds === null ? null : new Set(props.gateIds);
    const selectedpoints = gateSet
      ? series.ids.reduce<number[]>((acc, id, idx) => {
          if (gateSet.has(id)) {
            acc.push(idx);
          }
          return acc;
        }, [])
      : null;
    trace = {
      type: "scattergl",
      mode: "markers",
      x: series.x,
      y: series.y,
      customdata: series.ids,
      marker: { size: 5, color: "#4f8ef7", opacity: 0.75 },
      selected: { marker: { color: "#ffab40", opacity: 0.9 } },
      unselected: { marker: { opacity: 0.15 } },
      hoverinfo: "x+y",
      selectedpoints,
    };
    layout.dragmode = "lasso";
    layout.xaxis = axisLayout(props.plot.xAxis, series.xCategoryLabels);
    layout.yaxis = axisLayout(props.plot.yAxis, series.yCategoryLabels);
  } else {
    return;
  }

  await plotly.value.react(element, traces ?? [trace], layout, config);
  if (firstRender) {
    element.on("plotly_selected", (event: any) => {
      // A gate is persisted as its polygon, not as the ids it happens to
      // contain: ids belong to one dataset while the configuration is shared by
      // all of them. selectionEventToGate returns null for a payload carrying
      // neither a lasso path nor a box range (Plotly emits a bare event during
      // some internal clears), in which case the existing gate is left alone —
      // the explicit clear is plotly_deselect.
      if (dotsMode.value) {
        // A lasso over the sample is a polygon in value space, resolved
        // over every object — pin the server-derived category orders.
        const gate = selectionEventToGate(event, {
          xCategories: props.histogram?.xCategories ?? null,
          yCategories: props.histogram?.yCategories ?? null,
        });
        if (gate !== null) {
          filterStore.setAnalysisPlotGate({ id: props.plot.id, gate });
        }
        return;
      }
      const series = props.series;
      if (props.overCap || !series) {
        return;
      }
      const gate = selectionEventToGate(event, series);
      if (gate === null) {
        return;
      }
      filterStore.setAnalysisPlotGate({ id: props.plot.id, gate });
    });
    element.on("plotly_deselect", () => {
      if (props.overCap && !dotsMode.value) {
        return;
      }
      filterStore.setAnalysisPlotGate({ id: props.plot.id, gate: null });
    });
    element.on("plotly_relayout", (event: any) => {
      onShapesRelayout(event);
    });
  }
}

/** The persisted gate as a non-editable outline (heatmap and dots). */
function gateShapes(): Record<string, unknown>[] {
  return props.plot.gate !== null
    ? [
        {
          type: "path",
          path: gateShapePath(props.plot.gate.vertices),
          line: { color: "#ffab40", width: 2 },
          fillcolor: "rgba(255, 171, 64, 0.1)",
          editable: false,
        },
      ]
    : [];
}

/**
 * Scattergl traces for the display sample: every dot in one trace colored
 * per point, plus legend proxies, for a categorical colorBy; a colorbar trace
 * plus a grey "no value" trace for a numeric one; one plain trace otherwise.
 * With a gate, dots outside it are dimmed — computed on the drawn polygon,
 * as a picture of the gate; the gate itself resolves over every object.
 */
function dotTraces(
  histogram: IAnalysisHistogramDisplay,
): Record<string, unknown>[] {
  const sample = histogram.sample!;
  const gate = props.plot.gate;
  const inside = (i: number) =>
    gate === null || isPointInPolygon(sample.x[i], sample.y[i], gate.vertices);
  const marker = { size: 3, opacity: 0.8 };
  const base = {
    type: "scattergl",
    mode: "markers",
    selected: { marker: { opacity: 0.9 } },
    unselected: { marker: { opacity: 0.07 } },
  };
  const traceFor = (
    indices: number[],
    extra: Record<string, unknown>,
  ): Record<string, unknown> => {
    const selected =
      gate === null
        ? null
        : indices.reduce<number[]>((acc, index, local) => {
            if (inside(index)) {
              acc.push(local);
            }
            return acc;
          }, []);
    return {
      ...base,
      x: indices.map((i) => sample.x[i]),
      y: indices.map((i) => sample.y[i]),
      selectedpoints: selected,
      ...extra,
    };
  };
  const all = sample.x.map((_, i) => i);
  // A clustering (by its name — counts are integers too, so values alone
  // cannot tell a cluster id from a gene count) with a few integer values is
  // colored by category like tags rather than on a continuous ramp.
  let colorIndex = sample.color;
  let labels = histogram.colorCategoryLabels;
  if (
    colorIndex &&
    !labels &&
    CLUSTER_NAME.test(axisTitle(props.plot.colorBy ?? null))
  ) {
    const distinct = [
      ...new Set(colorIndex.filter((v): v is number => v !== null)),
    ];
    if (
      distinct.length > 0 &&
      distinct.length <= MAX_CLUSTER_CATEGORIES &&
      distinct.every(Number.isInteger)
    ) {
      distinct.sort((a, b) => a - b);
      const indexOf = new Map(distinct.map((value, i) => [value, i]));
      colorIndex = colorIndex.map((v) =>
        v === null ? null : (indexOf.get(v) as number),
      );
      labels = distinct.map((value) => String(value));
    }
  }
  if (colorIndex && labels) {
    const categoryLabels = labels;
    const present = [...new Set(colorIndex)]
      .filter((category): category is number => category !== null)
      .sort((a, b) => a - b);
    return [
      traceFor(all, {
        marker: {
          ...marker,
          color: all.map((i) =>
            colorIndex[i] === null
              ? "#777777"
              : categoricalColor(colorIndex[i] as number),
          ),
        },
        hovertext: all.map((i) =>
          colorIndex[i] === null ? "" : categoryLabels[colorIndex[i] as number],
        ),
        hovertemplate: "%{hovertext}<extra></extra>",
        showlegend: false,
      }),
      ...present.map((category) => ({
        type: "scattergl",
        mode: "markers",
        x: [null],
        y: [null],
        name: categoryLabels[category],
        marker: { size: 7, color: categoricalColor(category) },
        hoverinfo: "skip",
        showlegend: true,
      })),
    ];
  }
  if (sample.color) {
    const values = sample.color;
    const valued = all.filter((i) => values[i] !== null);
    const missing = all.filter((i) => values[i] === null);
    const sorted = valued.map((i) => values[i] as number).sort((a, b) => a - b);
    // Percentile range, so a few outliers cannot flatten the ramp.
    const at = (q: number) =>
      sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : 0;
    const colorTitle = axisTitle(props.plot.colorBy ?? null);
    return [
      traceFor(missing, {
        name: "No value",
        marker: { ...marker, color: "#777777" },
        hovertemplate: "No value<extra></extra>",
      }),
      traceFor(valued, {
        name: colorTitle,
        marker: {
          ...marker,
          color: valued.map((i) => values[i]),
          colorscale: "Viridis",
          cmin: at(0.01),
          cmax: at(0.99),
          showscale: true,
          colorbar: { thickness: 8, len: 0.8, tickfont: { size: 9 } },
        },
        hovertemplate: `${colorTitle}: %{marker.color}<extra></extra>`,
      }),
    ];
  }
  return [
    traceFor(all, {
      marker: { ...marker, color: "#4f8ef7" },
      hoverinfo: "skip",
    }),
  ];
}

function binCenters(edges: number[]): number[] {
  const centers: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    centers.push((edges[i] + edges[i + 1]) / 2);
  }
  return centers;
}

/**
 * A drawclosedpath/drawrect drawing lands in the relayout payload as a full
 * `shapes` array (our non-editable persisted-gate shape first, the new
 * drawing last). Anything beyond the expected persisted shape becomes the
 * new gate; every other relayout (zoom, autorange, keyed edits) is ignored.
 */
function onShapesRelayout(event: any) {
  if (!props.overCap || dotsMode.value) {
    return;
  }
  const shapes = event?.shapes;
  if (!Array.isArray(shapes)) {
    return;
  }
  const expected = props.plot.gate !== null ? 1 : 0;
  if (shapes.length <= expected) {
    return;
  }
  const gate = shapeToGate(shapes[shapes.length - 1], {
    // Pin the server-derived category order the shape was drawn against.
    xCategories: props.histogram?.xCategories ?? null,
    yCategories: props.histogram?.yCategories ?? null,
  });
  if (gate === null) {
    return;
  }
  filterStore.setAnalysisPlotGate({ id: props.plot.id, gate });
}

// Watch the individual inputs rather than a computed that rebuilds an object:
// such a computed re-evaluates on every dependency touch, so watching it (or
// using deep: true) would re-render on unrelated store changes. The panel keeps
// `series` and `histogram` identity-stable when their content hasn't changed.
watch(
  [
    () => props.series,
    () => props.gateIds,
    () => props.plot,
    () => props.histogram,
    () => props.overCap,
    isDark,
  ],
  () => {
    renderPlot();
  },
  // flush: "post" so the callback runs AFTER the DOM updates. The plot div is
  // behind `v-if`, so on the transition hidden -> shown a default pre-flush
  // watcher fires while `plotEl` is still undefined, renderPlot returns
  // early, and nothing ever renders (see the categorical-only blank-plot bug
  // this caught below the cap).
  { flush: "post" },
);

onMounted(() => {
  renderPlot();
});

onBeforeUnmount(() => {
  if (plotly.value && plotEl.value) {
    plotly.value.purge(plotEl.value);
  }
});

defineExpose({
  renderPlot,
  dotTraces,
  setDisplay,
  setColorBy,
  dotsMode,
  setAxis,
  clearGate,
  removePlot,
  toggleGateEnabled,
  onShapesRelayout,
  gateBadgeCount,
});
</script>

<style lang="scss" scoped>
.analysis-plot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  border-top: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));

  &:first-of-type {
    border-top: none;
    padding-top: 0;
  }
}

.ap-header {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ap-enable {
  flex: 0 0 auto;
}

.ap-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--nimbus-text-secondary, #d0d6e0);
}

.ap-axes {
  display: flex;
  gap: 8px;

  > .v-input {
    flex: 1 1 0;
    min-width: 0;
  }
}

.ap-display {
  display: flex;
  align-items: center;
  gap: 8px;

  > .ap-color {
    flex: 1 1 0;
    min-width: 0;
  }
}

.ap-display-toggle {
  flex: 0 0 auto;
}

.ap-hint {
  font-size: 12px;
  color: var(--nimbus-text-muted, #8a8f98);
  padding: 12px 4px;
}

.ap-plot {
  width: 100%;
  min-height: 300px;
}

.ap-footer {
  font-size: 11px;
  color: var(--nimbus-text-muted, #8a8f98);
}
</style>
