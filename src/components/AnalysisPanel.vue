<template>
  <div v-if="visible" class="analysis-panel">
    <div class="analysis-intro">
      Plot any two object properties against each other, then lasso-select the
      points to keep. Each plot shows the objects passing the previous plot's
      gate, so plots chain into a sequential gating strategy. Gates are saved
      with the configuration.
    </div>

    <div v-if="overCap" class="analysis-overcap">
      <v-icon size="16" class="mr-1">mdi-information-outline</v-icon>
      More than {{ MAX_ANALYSIS_PLOT_POINTS.toLocaleString() }} objects pass the
      current filters — too many for a scatter plot to gate exactly. Narrow the
      filters (by tag, property range, or region) and the plots will appear
      here.
    </div>

    <template v-else>
      <div v-if="loadingValues" class="analysis-loading">
        <v-progress-circular indeterminate size="18" width="2" class="mr-2" />
        Loading property values…
      </div>

      <analysis-scatter-plot
        v-for="(plot, index) in plots"
        :key="plot.id"
        :plot="plot"
        :index="index"
        :series="seriesByPlot[plot.id] ?? null"
        :gate-ids="gateIds[plot.id] ?? null"
        :input-count="plotInputs[index]?.length ?? 0"
        :axis-items="axisItems"
      />

      <div class="analysis-actions">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          prepend-icon="mdi-plus"
          @click="addPlot"
        >
          Add plot
        </v-btn>
      </div>

      <div class="analysis-footer">
        {{ passingCount.toLocaleString() }} of
        {{ baseCount.toLocaleString() }} filtered objects pass all gates
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { v4 as uuidv4 } from "uuid";
import store from "@/store";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import { TAnnotationOrStub } from "@/store/model";
import { MAX_ANALYSIS_PLOT_POINTS } from "@/store/constants";
import AnalysisScatterPlot from "@/components/AnalysisScatterPlot.vue";
import { CATEGORICAL_AXES, encodeAxis, IAxisItem } from "@/utils/analysisAxes";
import {
  buildPlotSeries,
  chainPlotInputs,
  IAnalysisSeries,
} from "@/utils/analysisGating";

// This panel's content stays MOUNTED while its palette is closed — the palette
// hides it with display:none — so nothing here may run on mount: it would fetch
// on every dataset open for users who never open the panel. `visible` is
// required rather than optional so a second mount site cannot reintroduce that
// by omission.
const props = defineProps<{ visible: boolean }>();

const plots = computed(() => filterStore.analysisPlots);
const gateIds = computed(() => filterStore.analysisGateIds);

// Bounded at cap + 1. The panel only needs to know whether the cap was crossed;
// collecting and retaining the remaining hundreds of thousands of rows would
// defeat the guard before any plot or gate has a chance to bail out.
const analysisPopulation = computed(() => filterStore.analysisPopulation);
const baseCount = computed(() => analysisPopulation.value.length);
const overCap = computed(() => baseCount.value > MAX_ANALYSIS_PLOT_POINTS);

// Values come from the store, which owns the single fetch: it must resolve
// gates whether or not this palette is open, so having the panel fetch its own
// copy meant two round trips over the same population — up to
// MAX_ANALYSIS_PLOT_POINTS ids — on exactly the path the feature exists for.
// Reading `propertyStore.propertyValues` instead is NOT an option: it is
// projected to the Annotation Browser's displayed columns, so an arbitrary axis
// is usually absent from it, and in lazy mode it holds only the viewport subset.
const values = computed(() => filterStore.analysisValues);
// Read from the store rather than inferred from `values` being empty: an empty
// result is a real outcome (a property computed for only some objects), and
// inferring left this spinning forever on it.
const loadingValues = computed(() => filterStore.analysisLoading);

// Tell the store whether anyone is looking. It fetches for plots WITHOUT a gate
// only while the panel is open — nothing else needs those values.
watch(
  () => props.visible,
  (visible) => filterStore.setAnalysisPanelOpen(visible),
  { immediate: true },
);
onBeforeUnmount(() => filterStore.setAnalysisPanelOpen(false));

const axisItems = computed<IAxisItem[]>(() => [
  ...CATEGORICAL_AXES.map(({ key, text }) => ({
    text,
    value: encodeAxis({ type: "categorical", key })!,
  })),
  ...propertyStore.computedPropertyPaths.map((path) => ({
    text: propertyStore.getFullNameFromPath(path) ?? path.join(" / "),
    value: encodeAxis({ type: "property", path })!,
  })),
]);

// Identity-stable view of each plot's input population. The base getter rebuilds
// a fresh array on every dependency touch (including frame changes it reads but
// doesn't use), so without this every Z-scrub would re-render every plot.
// Annotation objects are stable references, so an element-wise identity compare
// is enough to reuse the previous array.
//
// A watcher rather than a memo inside a computed: computeds may be evaluated
// more than once and in an order we don't control, and the pruning below is a
// state change driven by a read. Keeping the mutation here leaves the reactive
// graph pure.
const plotInputs = shallowRef<TAnnotationOrStub[][]>([]);
const previousInputs = new Map<string, TAnnotationOrStub[]>();

watch(
  () =>
    props.visible
      ? chainPlotInputs(plots.value, gateIds.value, analysisPopulation.value)
      : [],
  (next) => {
    const plotIds = props.visible ? plots.value.map((plot) => plot.id) : [];
    const reconciled = next.map((rows, i) => {
      const previous = previousInputs.get(plotIds[i]);
      if (
        previous &&
        previous.length === rows.length &&
        previous.every((annotation, j) => annotation === rows[j])
      ) {
        return previous;
      }
      previousInputs.set(plotIds[i], rows);
      return rows;
    });
    // Drop entries for removed plots: each pins a population of up to
    // MAX_ANALYSIS_PLOT_POINTS annotations.
    const live = new Set(plotIds);
    for (const key of [...previousInputs.keys()]) {
      if (!live.has(key)) {
        previousInputs.delete(key);
      }
    }
    // Only publish when something actually changed, so an unchanged chain
    // doesn't re-render the plots.
    const unchanged =
      reconciled.length === plotInputs.value.length &&
      reconciled.every((rows, i) => rows === plotInputs.value[i]);
    if (!unchanged) {
      plotInputs.value = reconciled;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => previousInputs.clear());

const channelName = (channel: number) =>
  store.dataset?.channelNames.get(channel) ?? `Channel ${channel}`;

// The plotted series per plot, built here so the scatter component is a pure
// renderer and so the coordinates it draws come from the same function the
// store gates with.
const seriesByPlot = computed(() => {
  const result: { [plotId: string]: IAnalysisSeries } = {};
  if (!props.visible) {
    return result;
  }
  plots.value.forEach((plot, index) => {
    if (!plot.xAxis || !plot.yAxis) {
      return;
    }
    result[plot.id] = buildPlotSeries({
      annotations: plotInputs.value[index] ?? [],
      values: values.value,
      xAxis: plot.xAxis,
      yAxis: plot.yAxis,
      channelName,
      // Pinned to the gate's ordering when one exists, so the picture matches
      // the gate rather than re-deriving indices from whatever categories are
      // currently present.
      xCategoryOrder: plot.gate?.xCategories ?? null,
      yCategoryOrder: plot.gate?.yCategories ?? null,
    });
  });
  return result;
});

const passingCount = computed(() => filterStore.filteredAnnotations.length);

function addPlot() {
  filterStore.addAnalysisPlot(uuidv4());
}

defineExpose({
  addPlot,
  plots,
  plotInputs,
  seriesByPlot,
  axisItems,
  passingCount,
  baseCount,
  overCap,
  MAX_ANALYSIS_PLOT_POINTS,
});
</script>

<style lang="scss" scoped>
.analysis-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
}

.analysis-intro {
  font-size: 12px;
  line-height: 1.5;
  color: var(--nimbus-text-muted, #8a8f98);
}

.analysis-overcap {
  font-size: 12px;
  line-height: 1.5;
  color: var(--nimbus-text-secondary, #d0d6e0);
  background: rgba(var(--v-theme-info), 0.1);
  border: 1px solid rgba(var(--v-theme-info), 0.3);
  border-radius: 6px;
  padding: 10px 12px;
}

.analysis-loading {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: var(--nimbus-text-muted, #8a8f98);
}

.analysis-actions {
  display: flex;
}

.analysis-footer {
  font-size: 12px;
  font-weight: 500;
  color: var(--nimbus-text-secondary, #d0d6e0);
  border-top: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
  padding-top: 10px;
}
</style>
