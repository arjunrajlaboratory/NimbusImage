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
        gate: {{ gateIds === null ? "…" : gateIds.length.toLocaleString() }}
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

    <div v-if="!series" class="ap-hint">
      Pick X and Y to plot this population ({{ inputCount.toLocaleString() }}
      objects). Then lasso-select points to keep them.
    </div>
    <template v-else>
      <div ref="plotEl" class="ap-plot"></div>
      <div class="ap-footer">
        <span>
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
import { IAnalysisPlot, TAnalysisAxis } from "@/store/model";
import { logError } from "@/utils/log";
import { encodeAxis, decodeAxis, IAxisItem } from "@/utils/analysisAxes";
import { IAnalysisSeries, selectionEventToGate } from "@/utils/analysisGating";

const props = defineProps<{
  plot: IAnalysisPlot;
  index: number;
  // Built by the panel so drawing and gating share one coordinate function.
  // null until both axes are chosen.
  series: IAnalysisSeries | null;
  // Ids inside this plot's gate, resolved by the store. null while unresolved.
  gateIds: string[] | null;
  // Size of the population reaching this plot, for the "N of M plotted" line.
  inputCount: number;
  axisItems: IAxisItem[];
}>();

const theme = useTheme();
const plotEl = ref<HTMLElement>();

// Loaded lazily so plotly.js-dist-min never lands in the main bundle.
const plotly = shallowRef<any>(null);

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
  categories: string[] | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: { text: axisTitle(axis), font: { size: 11 } },
    gridcolor: isDark.value ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)",
    zeroline: false,
    automargin: true,
  };
  if (categories) {
    base.tickmode = "array";
    base.tickvals = categories.map((_, idx) => idx);
    base.ticktext = categories;
    base.range = [-0.6, categories.length - 0.4];
  }
  return base;
}

async function renderPlot() {
  const series = props.series;
  if (!series || !plotEl.value) {
    return;
  }
  if (!plotly.value) {
    try {
      const module = await import("plotly.js-dist-min");
      plotly.value = module.default ?? module; // CJS interop
    } catch (error) {
      logError("Failed to load plotly:", error);
      return;
    }
    // The element can unmount while the import is in flight.
    if (!plotEl.value) {
      return;
    }
  }

  const gateSet = props.gateIds === null ? null : new Set(props.gateIds);
  const selectedpoints = gateSet
    ? series.ids.reduce<number[]>((acc, id, idx) => {
        if (gateSet.has(id)) {
          acc.push(idx);
        }
        return acc;
      }, [])
    : null;

  const trace = {
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

  const layout = {
    autosize: true,
    height: 300,
    margin: { l: 52, r: 10, t: 10, b: 40 },
    dragmode: "lasso",
    hovermode: "closest",
    showlegend: false,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: theme.current.value.colors["on-surface"], size: 10 },
    xaxis: axisLayout(props.plot.xAxis, series.xCategories),
    yaxis: axisLayout(props.plot.yAxis, series.yCategories),
  };

  const element = plotEl.value as any;
  const firstRender = !element.__nimbusPlotted;
  // Claimed BEFORE awaiting: two renders can overlap (the mount render awaits
  // the plotly import while a values fetch resolves and re-triggers the
  // watcher), and both would otherwise see firstRender true and attach a second
  // copy of the selection handlers.
  element.__nimbusPlotted = true;
  await plotly.value.react(element, [trace], layout, {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["autoScale2d", "zoomIn2d", "zoomOut2d"],
  });
  if (firstRender) {
    element.on("plotly_selected", (event: any) => {
      // A gate is persisted as its polygon, not as the ids it happens to
      // contain: ids belong to one dataset while the configuration is shared by
      // all of them. selectionEventToGate returns null for a payload carrying
      // neither a lasso path nor a box range (Plotly emits a bare event during
      // some internal clears), in which case the existing gate is left alone —
      // the explicit clear is plotly_deselect.
      const gate = selectionEventToGate(event, props.series ?? series);
      if (gate === null) {
        return;
      }
      filterStore.setAnalysisPlotGate({ id: props.plot.id, gate });
    });
    element.on("plotly_deselect", () => {
      filterStore.setAnalysisPlotGate({ id: props.plot.id, gate: null });
    });
  }
}

// Watch the individual inputs rather than a computed that rebuilds an object:
// such a computed re-evaluates on every dependency touch, so watching it (or
// using deep: true) would re-render on unrelated store changes. The panel keeps
// `series` identity-stable when its content hasn't changed.
watch(
  [() => props.series, () => props.gateIds, () => props.plot, isDark],
  () => {
    renderPlot();
  },
  // flush: "post" so the callback runs AFTER the DOM updates. The plot div is
  // behind `v-if="series"`, so on the transition null -> series a default
  // pre-flush watcher fires while `plotEl` is still undefined, renderPlot
  // returns early, and nothing ever renders. Property axes masked this — their
  // values arrive in a second update that re-fires the watcher once the div
  // exists — but a categorical-only plot computes its series once and never
  // changes, so it stayed permanently blank.
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

defineExpose({ renderPlot, setAxis, clearGate, removePlot, toggleGateEnabled });
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
