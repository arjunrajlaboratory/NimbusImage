<template>
  <!-- Renderless: draws into the GeoJS map it is given. -->
  <span class="transcript-overlay" hidden />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { debounce } from "lodash";
import geojs from "geojs";
import { isAxiosError } from "axios";
import store from "@/store";
import transcriptsStore from "@/store/transcripts";
import {
  IGeoJSAnnotationLayer,
  IGeoJSFeatureLayer,
  IGeoJSMap,
  IGeoJSOsmLayer,
  IGeoJSPointFeature,
  ISpatialTranscriptsSchema,
  ITranscriptOverlayStatus,
  ITranscriptPoints,
} from "@/store/model";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";
import { annotationIdAtPoint } from "@/utils/annotationAtPoint";
import {
  AUTO_DENSITY_LEVEL,
  planTranscriptLevel,
  viewToTranscriptMicrons,
} from "@/utils/transcriptTiles";

/**
 * The transcript overlay (SPATIAL_PLUGIN.md, Phase 3): molecules of the genes
 * picked in the Transcripts palette, drawn on one viewer's map either as
 * points (a GeoJS point feature fed straight from the binary response) or as
 * the server's density heat map (an OSM tile layer on the annotation
 * overview's pyramid).
 *
 * Level of detail is decided per view from the pyramid description alone
 * (`planTranscriptLevel`), then corrected by the server: a 413 steps one level
 * coarser. The molecules never enter the store; only the status does.
 */

const props = defineProps<{
  map: IGeoJSMap;
  annotationLayer: IGeoJSAnnotationLayer;
  sizeX: number;
  sizeY: number;
  maxLevel: number;
  // Unrolled views place frames on a grid the molecules know nothing about.
  disabled: boolean;
}>();

const DENSITY_TILE_SIZE = 512;
const PAN_DEBOUNCE_MS = 200;
// A GeoJS tile layer wants a URL from the start; this is a 1x1 transparent
// PNG, replaced by the density template before the layer is shown.
const BLANK_TILE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIHWNgYAAAAAMAAU9ICq8AAAAASUVORK5CYII=";

let pointLayer: IGeoJSFeatureLayer | null = null;
let pointFeature: IGeoJSPointFeature | null = null;
// One heat-map layer per gene, so a mix keeps each gene's color instead of
// summing into one white sheet. Keyed by symbol; unused layers are hidden.
const densityLayers = new Map<
  string,
  { layer: IGeoJSOsmLayer; template: string | null }
>();

// What the point feature currently draws.
let points: ITranscriptPoints | null = null;
let pointSymbols: string[] = [];
let pointColors: { r: number; g: number; b: number }[] = [];
let pointLevel = 0;
// Sequence guard: a refresh that finishes after a newer one started must not
// overwrite the newer one's result.
let refreshToken = 0;

function setStatus(status: ITranscriptOverlayStatus | null) {
  transcriptsStore.setStatus(status);
}

function geoColors() {
  return transcriptsStore.genes.map((gene) => ({
    ...geojs.util.convertColor(gene.color),
  }));
}

function ensurePointLayer(): IGeoJSPointFeature {
  if (pointFeature) {
    return pointFeature;
  }
  pointLayer = props.map.createLayer("feature", { features: ["point"] });
  pointFeature = pointLayer.createFeature("point", {
    style: {
      stroke: false,
      fill: true,
      fillOpacity: () => transcriptsStore.opacity,
      scaled: false,
      // Clustered points stand for many molecules; drawing them larger only
      // fuses them into a sheet, so coarser levels get the smaller dot.
      radius: () => (pointLevel === 0 ? 2.5 : 2),
      fillColor: (_datum: unknown, index: number) =>
        pointColors[points?.gene[index] ?? 0] ?? pointColors[0],
    },
  });
  pointFeature.position((_datum: unknown, index: number) => ({
    x: points!.x[index],
    y: points!.y[index],
  }));
  pointFeature.geoOn(geojs.event.feature.mouseclick, onPointClick);
  return pointFeature;
}

function createDensityLayer(): IGeoJSOsmLayer {
  const params = geojs.util.pixelCoordinateParams(
    props.map.node()[0],
    props.sizeX,
    props.sizeY,
    DENSITY_TILE_SIZE,
    DENSITY_TILE_SIZE,
  );
  const maxLevel = props.maxLevel;
  params.layer.maxLevel = maxLevel;
  params.layer.tilesAtZoom = (level: number) => {
    const scale = Math.pow(2, maxLevel - level);
    return {
      x: Math.ceil(props.sizeX / DENSITY_TILE_SIZE / scale),
      y: Math.ceil(props.sizeY / DENSITY_TILE_SIZE / scale),
    };
  };
  params.layer.tilesMaxBounds = (level: number) => {
    const scale = Math.pow(2, maxLevel - level);
    return {
      x: Math.floor(props.sizeX / scale),
      y: Math.floor(props.sizeY / scale),
    };
  };
  // Tiles arrive through <img> requests, which carry the auth cookie rather
  // than the Girder-Token header (same as the annotation overview).
  params.layer.crossDomain = "use-credentials";
  params.layer.autoshareRenderer = false;
  params.layer.nearestPixel = maxLevel;
  params.layer.url = BLANK_TILE_URL;
  params.layer.visible = false;
  const layer = props.map.createLayer("osm", params.layer);
  // Beneath the cell outlines, which stay legible over the heat map.
  layer.zIndex(props.annotationLayer.zIndex() as number);
  layer.node().css({ "mix-blend-mode": "unset" });
  layer.opacity(transcriptsStore.opacity);
  return layer;
}

function ensureDensityLayer(symbol: string) {
  let entry = densityLayers.get(symbol);
  if (!entry) {
    entry = { layer: createDensityLayer(), template: null };
    densityLayers.set(symbol, entry);
  }
  return entry;
}

function dropDensityLayers() {
  densityLayers.forEach(({ layer }) => props.map.deleteLayer(layer));
  densityLayers.clear();
}

function hidePoints() {
  if (pointFeature && points) {
    points = null;
    pointFeature.data([]);
    pointFeature.draw();
  }
}

function hideDensity(except: Set<string> = new Set()) {
  densityLayers.forEach(({ layer }, symbol) => {
    if (!except.has(symbol) && layer.visible()) {
      layer.visible(false);
    }
  });
}

/** Layers of genes no longer picked are deleted, not just hidden: a session
 * that cycles through many genes would otherwise keep one tile layer (DOM
 * canvas and tile cache) per symbol ever shown. */
function pruneDensityLayers() {
  const picked = new Set(transcriptsStore.symbols);
  densityLayers.forEach(({ layer }, symbol) => {
    if (!picked.has(symbol)) {
      props.map.deleteLayer(layer);
      densityLayers.delete(symbol);
    }
  });
}

function densityShown(): boolean {
  let shown = false;
  densityLayers.forEach(({ layer }) => {
    shown = shown || layer.visible() === true;
  });
  return shown;
}

function showPoints(
  fetched: ITranscriptPoints,
  symbols: string[],
  level: number,
) {
  const feature = ensurePointLayer();
  points = fetched;
  pointSymbols = symbols;
  pointColors = geoColors();
  pointLevel = level;
  feature.data(Array.from({ length: fetched.count }, (_, index) => index));
  feature.draw();
}

function restylePoints() {
  if (pointFeature && points) {
    pointColors = geoColors();
    pointFeature.draw();
  }
}

function showDensity(datasetId: string) {
  pruneDensityLayers();
  const shown = new Set<string>();
  for (const gene of transcriptsStore.genes) {
    const entry = ensureDensityLayer(gene.symbol);
    const template = store.spatialAPI.transcriptDensityTemplateUrl({
      datasetId,
      genes: [gene.symbol],
      sizeX: props.sizeX,
      sizeY: props.sizeY,
      tileSize: DENSITY_TILE_SIZE,
      maxLevel: props.maxLevel,
      color: gene.color,
    });
    if (template !== entry.template) {
      entry.template = template;
      entry.layer.url(template);
    }
    entry.layer.opacity(transcriptsStore.opacity);
    if (!entry.layer.visible()) {
      entry.layer.visible(true);
    }
    shown.add(gene.symbol);
  }
  hideDensity(shown);
}

function onPointClick(event: { index: number }) {
  if (!points || event.index >= points.count) {
    return;
  }
  const index = event.index;
  const point = { x: points.x[index], y: points.y[index] };
  transcriptsStore.setReadout({
    symbol: pointSymbols[points.gene[index]] ?? "?",
    x: point.x,
    y: point.y,
    quality: points.quality ? points.quality[index] : null,
    // The cell is whichever drawn outline contains the molecule.
    annotationId: annotationIdAtPoint(props.annotationLayer, point),
  });
}

async function refresh() {
  const token = ++refreshToken;
  const schema: ISpatialTranscriptsSchema | null = transcriptsStore.schema;
  const datasetId = store.dataset?.id;
  const symbols = transcriptsStore.symbols;
  if (
    props.disabled ||
    !transcriptsStore.enabled ||
    !transcriptsStore.hasTranscripts ||
    !schema ||
    !datasetId ||
    symbols.length === 0
  ) {
    hidePoints();
    hideDensity();
    setStatus(null);
    return;
  }
  const view = viewToTranscriptMicrons(
    props.map.bounds(),
    schema,
    props.sizeX,
    props.sizeY,
  );
  if (!view) {
    hidePoints();
    hideDensity();
    setStatus({ rendering: "none", level: 0, points: 0, note: null });
    return;
  }
  const plan = planTranscriptLevel(
    schema,
    view,
    symbols.length,
    transcriptsStore.pointBudget,
  );
  const mode = transcriptsStore.mode;
  const wantDensity =
    mode === "density" ||
    (mode === "auto" && (!plan.fits || plan.level >= AUTO_DENSITY_LEVEL));
  if (wantDensity) {
    hidePoints();
    showDensity(datasetId);
    setStatus({
      rendering: "density",
      level: plan.level,
      points: 0,
      note:
        mode === "auto"
          ? "Zoomed out: showing the density heat map instead of points."
          : null,
    });
    return;
  }
  hideDensity();
  const minQv = transcriptsStore.minQv;
  for (let level = plan.level; level < schema.levels; level++) {
    const tiles =
      level === plan.level
        ? plan.tiles
        : planTranscriptLevel(schema, view, symbols.length, Infinity).tiles;
    try {
      const fetched = await store.spatialAPI.fetchTranscriptPoints(
        datasetId,
        symbols,
        level,
        tiles,
        minQv,
      );
      if (token !== refreshToken) {
        return;
      }
      showPoints(fetched, symbols, level);
      setStatus({
        rendering: "points",
        level,
        points: fetched.count,
        note:
          level > 0 ? "Clustered molecules (no quality at this zoom)." : null,
      });
      return;
    } catch (error) {
      if (token !== refreshToken) {
        return;
      }
      if (
        isAxiosError(error) &&
        error.response?.status === 413 &&
        level + 1 < schema.levels
      ) {
        continue;
      }
      logError("Failed to fetch transcript points:", error);
      hidePoints();
      setStatus({
        rendering: "none",
        level,
        points: 0,
        note: extractErrorMessage(error),
      });
      return;
    }
  }
}

const scheduleRefresh = debounce(() => {
  refresh();
}, PAN_DEBOUNCE_MS);

function onPan() {
  if (transcriptsStore.enabled && transcriptsStore.genes.length > 0) {
    scheduleRefresh();
  }
}

watch(
  () => [transcriptsStore.requestSignature, props.disabled],
  () => scheduleRefresh(),
);

watch(
  () => transcriptsStore.genes.map((gene) => gene.color).join(","),
  () => {
    restylePoints();
    // A heat map's color is baked into its tiles: re-plan to refresh URLs.
    if (densityShown()) {
      scheduleRefresh();
    }
  },
);

watch(
  () => transcriptsStore.opacity,
  (opacity) => {
    restylePoints();
    densityLayers.forEach(({ layer }) => layer.opacity(opacity));
  },
);

// The density pyramid is sized to the image; a new image needs new layers.
watch(
  () => [props.sizeX, props.sizeY, props.maxLevel],
  () => {
    dropDensityLayers();
    scheduleRefresh();
  },
);

onMounted(() => {
  props.map.geoOn(geojs.event.pan, onPan);
  scheduleRefresh();
});

onBeforeUnmount(() => {
  scheduleRefresh.cancel();
  refreshToken++;
  props.map.geoOff(geojs.event.pan, onPan);
  if (pointFeature) {
    pointFeature.geoOff(geojs.event.feature.mouseclick, onPointClick);
  }
  if (pointLayer) {
    props.map.deleteLayer(pointLayer);
    pointLayer = null;
    pointFeature = null;
  }
  dropDensityLayers();
});

defineExpose({ refresh, scheduleRefresh });
</script>
