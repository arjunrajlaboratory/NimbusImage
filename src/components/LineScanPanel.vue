<template>
  <v-card v-if="isVisible" class="line-scan-panel" elevation="8">
    <div class="panel-header">
      <v-icon size="16" class="mr-1">mdi-chart-bell-curve</v-icon>
      <span class="panel-title">Line scan</span>
      <v-progress-circular
        v-if="isLoading"
        indeterminate
        size="12"
        width="2"
        class="ml-2"
      />
      <v-spacer />
      <v-btn
        variant="text"
        icon
        size="x-small"
        title="Dismiss line scan"
        @click="dismiss"
      >
        <v-icon size="16">mdi-close</v-icon>
      </v-btn>
    </div>
    <div v-if="toolLayer" class="panel-controls">
      <v-btn-toggle
        v-model="channelMode"
        mandatory
        density="compact"
        class="channel-toggle"
      >
        <v-btn value="all" size="x-small">All channels</v-btn>
        <v-btn value="selected" size="x-small">{{ toolLayer.name }}</v-btn>
      </v-btn-toggle>
    </div>
    <div v-if="visibleSeries.length" class="panel-legend">
      <span
        v-for="serie in visibleSeries"
        :key="serie.layerId"
        class="legend-entry"
      >
        <span class="legend-dot" :style="{ background: serie.color }" />
        {{ serie.name }}
      </span>
    </div>
    <svg
      v-if="visibleSeries.length"
      class="panel-chart"
      :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
      :width="chartWidth"
      :height="chartHeight"
      @mousemove="onChartMouseMove"
      @mouseleave="hoverIndex = null"
    >
      <!-- grid and axes -->
      <g class="chart-grid">
        <line
          v-for="tick in yTicks"
          :key="`y-${tick}`"
          :x1="margin.left"
          :x2="chartWidth - margin.right"
          :y1="yScale(tick)"
          :y2="yScale(tick)"
        />
        <line
          v-for="tick in xTicks"
          :key="`x-${tick}`"
          :x1="xScale(tick)"
          :x2="xScale(tick)"
          :y1="margin.top"
          :y2="chartHeight - margin.bottom"
        />
      </g>
      <g class="chart-tick-labels">
        <text
          v-for="tick in yTicks"
          :key="`yl-${tick}`"
          :x="margin.left - 4"
          :y="yScale(tick) + 3"
          text-anchor="end"
        >
          {{ formatValue(tick) }}
        </text>
        <text
          v-for="tick in xTicks"
          :key="`xl-${tick}`"
          :x="xScale(tick)"
          :y="chartHeight - margin.bottom + 12"
          text-anchor="middle"
        >
          {{ formatValue(tick) }}
        </text>
        <text
          class="axis-title"
          :x="(margin.left + chartWidth - margin.right) / 2"
          :y="chartHeight - 2"
          text-anchor="middle"
        >
          Distance (px)
        </text>
      </g>
      <!-- intensity profiles -->
      <g class="chart-series">
        <path
          v-for="serie in visibleSeries"
          :key="serie.layerId"
          :d="seriePath(serie)"
          :stroke="serie.color"
          fill="none"
          stroke-width="2"
          stroke-linejoin="round"
        />
      </g>
      <!-- hover crosshair -->
      <line
        v-if="hoverIndex !== null"
        class="chart-crosshair"
        :x1="xScale(distances[hoverIndex])"
        :x2="xScale(distances[hoverIndex])"
        :y1="margin.top"
        :y2="chartHeight - margin.bottom"
      />
    </svg>
    <div v-else class="panel-hint">
      {{ hintText }}
    </div>
    <div v-if="visibleSeries.length" class="panel-readout">
      <template v-if="hoverIndex !== null">
        <span class="readout-entry">
          {{ formatValue(distances[hoverIndex]) }} px:
        </span>
        <span
          v-for="serie in visibleSeries"
          :key="serie.layerId"
          class="readout-entry"
        >
          <span class="legend-dot" :style="{ background: serie.color }" />
          {{
            serie.values[hoverIndex] === null
              ? "–"
              : formatValue(serie.values[hoverIndex]!)
          }}
        </span>
      </template>
      <template v-else>
        <span class="readout-entry">
          Length: {{ formatValue(totalLength) }} px{{
            physicalLengthText ? ` (${physicalLengthText})` : ""
          }}
        </span>
      </template>
    </div>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { debounce } from "lodash";
import { ticks } from "d3-array";
import store from "@/store";
import lineScanStore from "@/store/lineScan";
import { IDisplayLayer } from "@/store/model";
import { bilinearSample, resamplePolyline } from "@/utils/lineScan";
import { formatLength } from "@/utils/conversion";
import { logError } from "@/utils/log";

// At most one sample per pixel of line length, capped to keep updates cheap
const MAX_SAMPLES = 400;
// Regions larger than this are downsampled by the server before sampling
const MAX_REGION_DIM = 2048;

const chartWidth = 380;
const chartHeight = 170;
const margin = { left: 46, right: 10, top: 10, bottom: 30 };

interface ILineScanSeries {
  layerId: string;
  name: string;
  color: string;
  values: (number | null)[];
}

const series = ref<ILineScanSeries[]>([]);
const distances = ref<number[]>([]);
const isLoading = ref(false);
const hoverIndex = ref<number | null>(null);
const channelMode = ref<"all" | "selected">("all");
// Ignore responses of superseded scan requests
let scanRequestId = 0;

// Visible while a linescan tool is selected (showing drawing instructions
// before any line exists) or while a scanned line is displayed
const isVisible = computed(
  () => lineScanStore.toolLineType !== null || lineScanStore.isActive,
);

const toolLayer = computed(() =>
  lineScanStore.toolLayerId
    ? store.getLayerFromId(lineScanStore.toolLayerId) ?? null
    : null,
);

// Layers whose intensities are scanned: either the channel picked in the
// tool configuration, or all currently visible layers
const scanLayers = computed((): IDisplayLayer[] => {
  if (channelMode.value === "selected" && toolLayer.value) {
    return [toolLayer.value];
  }
  return store.layers.filter((layer) => layer.visible);
});

const visibleSeries = computed(() =>
  series.value.filter((serie) => serie.values.some((value) => value !== null)),
);

const hintText = computed(() => {
  if (isLoading.value) {
    return "Scanning…";
  }
  if (!scanLayers.value.length) {
    return "No visible layers to scan";
  }
  switch (lineScanStore.toolLineType) {
    case "freehand":
      return "Click and drag to draw a line";
    case "segment":
      return lineScanStore.segmentStartPlaced
        ? "Click again to finish the segment"
        : "Click once to start a segment";
    default:
      return "Draw a line on the image to scan intensities";
  }
});

const totalLength = computed(() =>
  distances.value.length ? distances.value[distances.value.length - 1] : 0,
);

// Physical length of the line, or null when the pixel size is unknown.
// A pixel size of exactly 1 m is the placeholder default of configurations
// whose physical scale was never set.
const physicalLengthText = computed(() => {
  const pixelSize = store.scales.pixelSize;
  if (
    !pixelSize ||
    pixelSize.value <= 0 ||
    (pixelSize.value === 1 && pixelSize.unit === "m")
  ) {
    return null;
  }
  return formatLength(totalLength.value * pixelSize.value, pixelSize.unit);
});

const yDomain = computed((): [number, number] => {
  let min = Infinity;
  let max = -Infinity;
  for (const serie of visibleSeries.value) {
    for (const value of serie.values) {
      if (value === null) {
        continue;
      }
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  if (min > max) {
    return [0, 1];
  }
  if (min === max) {
    return [min - 1, max + 1];
  }
  // Pad the range so extrema don't sit on the chart border
  const pad = (max - min) * 0.05;
  return [min - pad, max + pad];
});

const xTicks = computed(() =>
  totalLength.value > 0 ? ticks(0, totalLength.value, 4) : [],
);
const yTicks = computed(() => ticks(yDomain.value[0], yDomain.value[1], 4));

function xScale(distance: number) {
  const [width, length] = [
    chartWidth - margin.left - margin.right,
    totalLength.value || 1,
  ];
  return margin.left + (distance / length) * width;
}

function yScale(value: number) {
  const [min, max] = yDomain.value;
  const height = chartHeight - margin.top - margin.bottom;
  return chartHeight - margin.bottom - ((value - min) / (max - min)) * height;
}

function seriePath(serie: ILineScanSeries) {
  let path = "";
  let previousWasNull = true;
  for (let i = 0; i < serie.values.length; i++) {
    const value = serie.values[i];
    if (value === null) {
      previousWasNull = true;
      continue;
    }
    const x = xScale(distances.value[i]).toFixed(1);
    const y = yScale(value).toFixed(1);
    path += `${previousWasNull ? "M" : "L"}${x},${y}`;
    previousWasNull = false;
  }
  return path;
}

function formatValue(value: number) {
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    return Math.round(value).toString();
  }
  return value.toPrecision(3);
}

function onChartMouseMove(event: MouseEvent) {
  if (!distances.value.length) {
    hoverIndex.value = null;
    return;
  }
  const svg = event.currentTarget as SVGSVGElement;
  const x =
    ((event.clientX - svg.getBoundingClientRect().left) /
      svg.getBoundingClientRect().width) *
    chartWidth;
  const distance =
    ((x - margin.left) / (chartWidth - margin.left - margin.right)) *
    totalLength.value;
  const index = Math.round(
    (distance / (totalLength.value || 1)) * (distances.value.length - 1),
  );
  hoverIndex.value = Math.max(0, Math.min(distances.value.length - 1, index));
}

function dismiss() {
  lineScanStore.clearLine();
}

async function updateScans() {
  const points = lineScanStore.points;
  const resampled = points && resamplePolyline(points, MAX_SAMPLES);
  const requestId = ++scanRequestId;
  if (!resampled) {
    series.value = [];
    distances.value = [];
    return;
  }
  const { samplePoints } = resampled;
  const xs = samplePoints.map(({ x }) => x);
  const ys = samplePoints.map(({ y }) => y);
  const bounds = {
    left: Math.floor(Math.min(...xs)) - 1,
    top: Math.floor(Math.min(...ys)) - 1,
    right: Math.ceil(Math.max(...xs)) + 2,
    bottom: Math.ceil(Math.max(...ys)) + 2,
  };
  isLoading.value = true;
  try {
    // One region request per layer: each layer displays a different frame,
    // and the region endpoint serves a single frame per request
    const results = await Promise.all(
      scanLayers.value.map(async (layer) => {
        const image = store.getImagesFromLayer(layer)[0];
        if (!image) {
          return null;
        }
        const region = await store.api.getRawRegion(
          image.item._id,
          image.frameIndex,
          {
            left: Math.max(0, bounds.left),
            top: Math.max(0, bounds.top),
            right: Math.min(image.sizeX, bounds.right),
            bottom: Math.min(image.sizeY, bounds.bottom),
          },
          MAX_REGION_DIM,
        );
        if (!region) {
          return null;
        }
        return {
          layerId: layer.id,
          name: layer.name,
          color: layer.color,
          values: samplePoints.map((point) =>
            bilinearSample(
              region.image,
              // Convert image coordinates to region pixel centers
              (point.x - region.left) * region.scaleX - 0.5,
              (point.y - region.top) * region.scaleY - 0.5,
            ),
          ),
        };
      }),
    );
    if (requestId !== scanRequestId) {
      // A newer scan superseded this one while it was in flight
      return;
    }
    series.value = results.filter(
      (result): result is ILineScanSeries => result !== null,
    );
    distances.value = resampled.distances;
    hoverIndex.value = null;
  } catch (error) {
    logError("Failed to compute line scan", error);
  } finally {
    if (requestId === scanRequestId) {
      isLoading.value = false;
    }
  }
}

// Live updates while drawing: debounced with maxWait so the graph keeps
// refreshing during a continuous drag
const updateScansDebounced = debounce(updateScans, 100, { maxWait: 250 });

watch(
  [
    () => lineScanStore.points,
    scanLayers,
    () => store.xy,
    () => store.z,
    () => store.time,
  ],
  () => {
    updateScansDebounced();
  },
);

// Default to the configured channel when one is set
watch(
  () => lineScanStore.toolLayerId,
  (layerId) => {
    channelMode.value = layerId ? "selected" : "all";
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.line-scan-panel {
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 200;
  width: 400px;
  padding: 8px 10px;
  background: rgba(var(--v-theme-surface), 0.95);
}

.panel-header {
  display: flex;
  align-items: center;
}

.panel-title {
  font-size: 13px;
  font-weight: 500;
}

.panel-controls {
  margin: 4px 0;
}

.channel-toggle {
  height: 24px;
}

.panel-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin: 2px 0;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 3px;
}

.panel-chart {
  display: block;

  .chart-grid line {
    stroke: rgba(var(--v-theme-on-surface), 0.12);
    stroke-width: 1;
  }

  .chart-tick-labels text {
    fill: rgba(var(--v-theme-on-surface), 0.65);
    font-size: 9px;
  }

  .axis-title {
    font-size: 10px;
  }

  .chart-crosshair {
    stroke: rgba(var(--v-theme-on-surface), 0.5);
    stroke-width: 1;
    stroke-dasharray: 3 2;
  }
}

.panel-hint {
  padding: 12px 4px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.65);
}

.panel-readout {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  min-height: 18px;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.readout-entry {
  white-space: nowrap;
}
</style>
