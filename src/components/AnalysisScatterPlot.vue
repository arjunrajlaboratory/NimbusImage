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

    <div v-if="!axesChosen" class="ap-hint">
      Pick X and Y to plot this population ({{ inputCount.toLocaleString() }}
      objects).
      <template v-if="overCap">
        Then draw a closed shape around the objects to keep.
      </template>
      <template v-else> Then lasso-select points to keep them. </template>
    </div>
    <div v-else-if="!plotReady" class="ap-hint">Loading distribution…</div>
    <template v-else>
      <div ref="plotEl" class="ap-plot"></div>
      <div class="ap-footer">
        <span v-if="overCap && histogram">
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
  selectionEventToGate,
  shapeToGate,
} from "@/utils/analysisGating";

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
  }>(),
  { overCap: false, histogram: null },
);

const theme = useTheme();
const plotEl = ref<HTMLElement>();

// Loaded lazily so plotly.js-dist-min never lands in the main bundle.
const plotly = shallowRef<any>(null);

const axesChosen = computed(
  () => props.plot.xAxis !== null && props.plot.yAxis !== null,
);
const plotReady = computed(() =>
  props.overCap ? props.histogram !== null : props.series !== null,
);
// Above the cap the resolved ids are the PURE polygon membership over the
// whole dataset; the badge shows the chained count from the histogram
// instead, matching the below-cap meaning of "objects this gate keeps here".
const gateBadgeCount = computed(() => {
  if (props.overCap) {
    // Fall back to the resolved ids when the histogram is unavailable. It is
    // the wrong number in principle (pure rather than chained) but it is a
    // real one: a failed histogram fetch otherwise left the badge at "…"
    // indefinitely while the gate visibly thinned the viewer, so nothing on
    // screen accounted for the objects that had disappeared.
    return (
      props.histogram?.gateCount ??
      (props.gateIds === null ? null : props.gateIds.length)
    );
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

  if (props.overCap && props.histogram) {
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
    layout.shapes =
      props.plot.gate !== null
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

  await plotly.value.react(element, [trace], layout, config);
  if (firstRender) {
    element.on("plotly_selected", (event: any) => {
      // A gate is persisted as its polygon, not as the ids it happens to
      // contain: ids belong to one dataset while the configuration is shared by
      // all of them. selectionEventToGate returns null for a payload carrying
      // neither a lasso path nor a box range (Plotly emits a bare event during
      // some internal clears), in which case the existing gate is left alone —
      // the explicit clear is plotly_deselect.
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
      if (props.overCap) {
        return;
      }
      filterStore.setAnalysisPlotGate({ id: props.plot.id, gate: null });
    });
    element.on("plotly_relayout", (event: any) => {
      onShapesRelayout(event);
    });
  }
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
  if (!props.overCap) {
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
