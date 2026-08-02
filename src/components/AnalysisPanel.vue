<template>
  <div v-if="visible" class="analysis-panel">
    <div class="analysis-intro">
      Plot any two object properties against each other, then select the points
      to keep. Each plot shows the objects passing the previous plot's gate, so
      plots chain into a sequential gating strategy. Gates are saved with the
      configuration.
    </div>

    <div v-if="overCap" class="analysis-overcap">
      <v-icon size="16" class="mr-1">mdi-information-outline</v-icon>
      More than {{ MAX_ANALYSIS_PLOT_POINTS.toLocaleString() }} objects pass the
      current filters, so plots show binned distributions computed on the
      server. Draw a closed shape (or rectangle) around the objects to keep —
      gates stay exact at any size.
    </div>
    <div
      v-if="overCap && skippedHistogramFilters.length > 0"
      class="analysis-overcap analysis-skipped"
    >
      <v-icon size="16" class="mr-1">mdi-alert-outline</v-icon>
      The distributions ignore: {{ skippedHistogramFilters.join(", ") }}. The
      pictured population may include objects those filters hide — gating itself
      is unaffected.
    </div>

    <!-- Sticky: the palette body scrolls, so a notice in the content flow
         disappears as soon as the user scrolls to a plot — which is exactly
         when they are waiting on it. -->
    <div v-if="busy" class="analysis-busy">
      <v-progress-linear indeterminate color="primary" height="3" rounded />
      <span class="analysis-busy-text">{{ busyLabel }}</span>
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
      :over-cap="overCap"
      :histogram="histogramsByPlot[plot.id] ?? null"
    />

    <div class="analysis-actions">
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        prepend-icon="mdi-plus"
        :disabled="!canAddPlot"
        :title="
          canAddPlot
            ? undefined
            : `Maximum of ${MAX_ANALYSIS_PLOTS} plots reached`
        "
        @click="addPlot"
      >
        Add plot
      </v-btn>
    </div>

    <div class="analysis-footer">
      {{ passingCount.toLocaleString() }} of
      {{ baseCount.toLocaleString() }} filtered objects pass all gates
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { v4 as uuidv4 } from "uuid";
import store from "@/store";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import annotationStore from "@/store/annotation";
import {
  IAnalysisHistogramDisplay,
  IAnalysisHistogramRequest,
  TAnnotationOrStub,
} from "@/store/model";
import {
  ANALYSIS_HISTOGRAM_BINS,
  MAX_ANALYSIS_PLOTS,
  MAX_ANALYSIS_PLOT_POINTS,
} from "@/store/constants";
import AnalysisScatterPlot from "@/components/AnalysisScatterPlot.vue";
import { CATEGORICAL_AXES, encodeAxis, IAxisItem } from "@/utils/analysisAxes";
import {
  buildPlotSeries,
  chainPlotInputs,
  IAnalysisSeries,
  labelForCategoryKey,
} from "@/utils/analysisGating";
import { createSequenceGuard, ISequenceGuard } from "@/utils/sequenceGuard";
import { idListSignature } from "@/utils/signatures";

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
const overCap = computed(
  () => analysisPopulation.value.length > MAX_ANALYSIS_PLOT_POINTS,
);
// Above the cap the bounded walk stops at cap+1, which is not the real base
// count; the uncapped walk is what the viewer computes anyway.
const baseCount = computed(() =>
  overCap.value
    ? filterStore.annotationsPassingNonGateFilters.length
    : analysisPopulation.value.length,
);

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

// How many histogram requests are outstanding. Above the cap these are the
// slow part (seconds on a 700K dataset) and previously showed nothing at
// all, so the panel looked idle while it was working hardest.
const histogramsInFlight = shallowRef(0);

const busy = computed(
  () => loadingValues.value || histogramsInFlight.value > 0,
);
const busyLabel = computed(() =>
  histogramsInFlight.value > 0
    ? "Computing distributions…"
    : "Loading property values…",
);

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
//
// Above the cap the chain is never walked client-side — each plot's input
// count comes from its histogram response instead.
const plotInputs = shallowRef<TAnnotationOrStub[][]>([]);
const previousInputs = new Map<string, TAnnotationOrStub[]>();

watch(
  () =>
    props.visible && !overCap.value
      ? chainPlotInputs(plots.value, gateIds.value, analysisPopulation.value)
      : [],
  (next) => {
    const plotIds =
      props.visible && !overCap.value ? plots.value.map((plot) => plot.id) : [];
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
// store gates with. Above the cap there are no points to plot — the heatmaps
// below take over — so no series is built at all.
const seriesByPlot = computed(() => {
  const result: { [plotId: string]: IAnalysisSeries } = {};
  if (!props.visible || overCap.value) {
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

// ---- Over-cap heatmaps (SERVER_GATING.md, Phase 2) ----
//
// Display work only: fetched per plot while the panel is open, keyed by a
// signature over everything the server answer depends on, with a per-plot
// sequence guard. Gate RESOLUTION does not pass through here — the store owns
// it and it runs panel-open or not.

const histogramFilterSpec = computed(() =>
  props.visible && overCap.value
    ? filterStore.analysisHistogramFilterSpec
    : { filters: {}, skipped: [] },
);
const skippedHistogramFilters = computed(
  () => histogramFilterSpec.value.skipped,
);

const histogramsByPlot = shallowRef<{
  [plotId: string]: IAnalysisHistogramDisplay | null;
}>({});
const histogramSignatures = new Map<string, string>();
const histogramGuards = new Map<string, ISequenceGuard>();

interface IHistogramWork {
  plotId: string;
  request: IAnalysisHistogramRequest;
  signature: string;
}

// The id lists inside filter constraints can hold tens of thousands of ids;
// hash them for the signature instead of serializing (signatures.ts rule).
function requestSignature(request: IAnalysisHistogramRequest): string {
  const { filters, ...definition } = request;
  const { idConstraints, ...plainFilters } = filters;
  return [
    JSON.stringify(definition),
    JSON.stringify(plainFilters),
    (idConstraints ?? []).map((ids) => idListSignature(ids)).join(","),
    propertyStore.propertyValuesRevision,
    annotationStore.contentRevision,
  ].join("|");
}

const histogramWork = computed<IHistogramWork[]>(() => {
  if (!props.visible || !overCap.value) {
    return [];
  }
  const { filters } = histogramFilterSpec.value;
  const allPlots = plots.value;
  return allPlots
    .filter((plot) => plot.xAxis !== null && plot.yAxis !== null)
    .map((plot) => {
      const index = allPlots.indexOf(plot);
      const upstreamGates = allPlots
        .slice(0, index)
        .filter(
          (upstream) =>
            upstream.gateEnabled &&
            upstream.gate !== null &&
            upstream.xAxis !== null &&
            upstream.yAxis !== null,
        )
        .map((upstream) => ({
          xAxis: upstream.xAxis!,
          yAxis: upstream.yAxis!,
          gate: upstream.gate!,
        }));
      const request: IAnalysisHistogramRequest = {
        xAxis: plot.xAxis!,
        yAxis: plot.yAxis!,
        xCategories: plot.gate?.xCategories ?? null,
        yCategories: plot.gate?.yCategories ?? null,
        bins: { x: ANALYSIS_HISTOGRAM_BINS, y: ANALYSIS_HISTOGRAM_BINS },
        upstreamGates,
        filters,
        gate: plot.gate,
      };
      return { plotId: plot.id, request, signature: requestSignature(request) };
    });
});

function toDisplay(
  response: NonNullable<
    Awaited<ReturnType<typeof store.annotationsAPI.fetchAnalysisHistogram>>
  >,
  request: IAnalysisHistogramRequest,
): IAnalysisHistogramDisplay {
  const labels = (
    categories: string[] | null,
    axis: IAnalysisHistogramRequest["xAxis"],
  ) =>
    categories !== null && axis.type === "categorical"
      ? categories.map((key) => labelForCategoryKey(key, axis.key, channelName))
      : null;
  return {
    ...response,
    xCategoryLabels: labels(response.xCategories, request.xAxis),
    yCategoryLabels: labels(response.yCategories, request.yAxis),
  };
}

// Histogram requests run ONE AT A TIME. Each one independently re-scans the
// whole dataset and materializes the property values it needs server-side,
// so firing one per plot on panel open (or on any signature change that
// invalidates them all, like a property recompute) meant N concurrent
// full-dataset scans — 20 of them on the supported plot count. The busy bar
// covers the whole queue, so serializing costs visible latency but not
// clarity.
let histogramQueue: Promise<void> = Promise.resolve();

// Plots whose request is queued or in flight. The queue captures a guard
// OBJECT, so removing the plot's map entry does not stop its callback —
// the guard has to be ADVANCED to supersede the captured token. Signatures
// of invalidated work are forgotten too, so it refetches when relevant
// again; completed signatures are untouched, which is what keeps a reopen
// from refetching everything.
const pendingHistograms = new Set<string>();

function invalidatePendingHistograms(plotIds: Iterable<string>) {
  for (const plotId of plotIds) {
    if (!pendingHistograms.has(plotId)) {
      continue;
    }
    histogramGuards.get(plotId)?.next();
    histogramSignatures.delete(plotId);
    pendingHistograms.delete(plotId);
  }
}

function enqueueHistogram(
  plotId: string,
  request: IAnalysisHistogramRequest,
  guard: ISequenceGuard,
  token: number,
  datasetId: string,
) {
  histogramsInFlight.value += 1;
  pendingHistograms.add(plotId);
  histogramQueue = histogramQueue.then(async () => {
    try {
      // Superseded before it ever started: skip the round trip entirely.
      if (!guard.isCurrent(token)) {
        return;
      }
      const response = await store.annotationsAPI.fetchAnalysisHistogram(
        datasetId,
        request,
      );
      if (!guard.isCurrent(token)) {
        return;
      }
      if (response === null) {
        // Failure ≠ empty: keep whatever was displayed, and forget the
        // signature so the next input change (or panel reopen) retries.
        histogramSignatures.delete(plotId);
        return;
      }
      histogramsByPlot.value = {
        ...histogramsByPlot.value,
        [plotId]: toDisplay(response, request),
      };
    } finally {
      pendingHistograms.delete(plotId);
      histogramsInFlight.value -= 1;
    }
  });
}

watch(
  histogramWork,
  (work) => {
    const datasetId = store.dataset?.id;
    // Prune state for removed plots — but only while the work list is
    // authoritative. When the panel is hidden (or below the cap) the list is
    // empty by construction, and pruning then would defeat the reopen
    // behavior: signatures persist across panel closes on purpose, so
    // reopening with unchanged inputs refetches nothing.
    if (props.visible && overCap.value) {
      const live = new Set(work.map(({ plotId }) => plotId));
      const gone = [...pendingHistograms].filter((id) => !live.has(id));
      // Advance before forgetting the guard, or the queued callback still
      // holds a current token and repopulates the entry just pruned.
      invalidatePendingHistograms(gone);
      let pruned = false;
      const next = { ...histogramsByPlot.value };
      for (const plotId of Object.keys(next)) {
        if (!live.has(plotId)) {
          delete next[plotId];
          histogramSignatures.delete(plotId);
          histogramGuards.delete(plotId);
          pruned = true;
        }
      }
      for (const plotId of gone) {
        histogramGuards.delete(plotId);
      }
      if (pruned) {
        histogramsByPlot.value = next;
      }
    } else {
      // Hidden, or back below the cap: nothing queued has a reason to run.
      // Display work must not continue behind a closed palette.
      invalidatePendingHistograms([...pendingHistograms]);
    }
    if (!datasetId) {
      return;
    }
    for (const { plotId, request, signature } of work) {
      if (histogramSignatures.get(plotId) === signature) {
        continue;
      }
      histogramSignatures.set(plotId, signature);
      let guard = histogramGuards.get(plotId);
      if (!guard) {
        guard = createSequenceGuard();
        histogramGuards.set(plotId, guard);
      }
      const token = guard.next();
      enqueueHistogram(plotId, request, guard, token, datasetId);
    }
  },
  { immediate: true },
);

const passingCount = computed(() => filterStore.filteredAnnotations.length);

// Disabled rather than silently no-op: the store refuses past the cap
// because the backend rejects a larger request outright.
const canAddPlot = computed(() => filterStore.canAddAnalysisPlot);

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
  busy,
  busyLabel,
  canAddPlot,
  MAX_ANALYSIS_PLOTS,
  histogramsByPlot,
  histogramWork,
  skippedHistogramFilters,
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

.analysis-skipped {
  background: rgba(var(--v-theme-warning), 0.08);
  border-color: rgba(var(--v-theme-warning), 0.35);
}

.analysis-busy {
  /* Pinned to the top of the scrolling palette body so it stays visible
     while the user scrolls through plots. */
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0 8px;
  /* Opaque, so plot content scrolling underneath does not show through. */
  background: var(--nimbus-surface, #1e1e1e);
}

.analysis-busy-text {
  font-size: 12px;
  color: var(--nimbus-text-secondary, #d0d6e0);
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
