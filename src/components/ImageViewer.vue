<template>
  <div
    class="image"
    v-mousetrap="mousetrapAnnotations"
    :style="{ '--scale-bar-color': scalebarColor }"
  >
    <progress-bar-group />
    <render-coverage-indicator />
    <v-dialog v-model="scaleDialog">
      <v-card>
        <v-card-title> Scale settings </v-card-title>
        <v-card-text>
          <scale-settings />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            variant="text"
            size="small"
            class="ma-2"
            @click="scaleDialog = false"
            >Close</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
    <annotation-viewer
      v-for="(mapentry, index) in annotationViewerMaps"
      :map="mapentry.map"
      :capturedMouseState="
        mouseState && mouseState.mapEntry === mapentry ? mouseState : null
      "
      :annotationLayer="mapentry.annotationLayer"
      :textLayer="mapentry.textLayer"
      :timelapseLayer="mapentry.timelapseLayer"
      :timelapseTextLayer="mapentry.timelapseTextLayer"
      :workerPreviewFeature="mapentry.workerPreviewFeature"
      :interactionLayer="mapentry.interactionLayer"
      :annotationOverviewLayer="mapentry.annotationOverviewLayer"
      :maps="maps"
      :unrollH="unrollH"
      :unrollW="unrollW"
      :tileWidth="tileWidth"
      :tileHeight="tileHeight"
      :lowestLayer="mapentry.lowestLayer || 0"
      :layerCount="(mapentry.imageLayers || []).length / 2"
      :allowSharedVisibilitySuppression="
        allAnnotationOverviewViewersRasterActive
      "
      :key="'annotation-viewer-' + index"
      @annotation-overview-visibility-change="
        _setAnnotationOverviewVisibility(mapentry, $event)
      "
    />
    <template v-if="transcriptsStore.hasTranscripts && transcriptImage">
      <transcript-overlay
        v-for="(mapentry, index) in annotationViewerMaps"
        :key="'transcript-overlay-' + index"
        :map="mapentry.map"
        :annotationLayer="mapentry.annotationLayer"
        :sizeX="transcriptImage.sizeX"
        :sizeY="transcriptImage.sizeY"
        :maxLevel="mapentry.params.layer.maxLevel ?? transcriptImage.levels - 1"
        :disabled="unrolling"
      />
    </template>
    <!-- Mounted ONCE, outside the per-map v-for above. In unroll layer mode
         ImageViewer renders one AnnotationViewer per layer group, so a panel
         living inside that loop appeared N times over and registered N global
         keydown listeners — a single Delete then fired N concurrent deletes
         and sent duplicate batch DELETEs for the same ids. This panel reads
         only store state, so it has no reason to be per-map. -->
    <connection-action-panel
      v-if="selectedExistingConnectionCount > 0"
      key="connection-action-panel"
      :stacked="selectedAnnotationCount > 0"
    />
    <div
      class="map-layout"
      ref="mapLayout"
      v-description="{
        section: 'Objects',
        title: 'Quick Lasso',
        description: 'Use shift-click-drag to select objects using a lasso',
      }"
      :map-count="mapLayerList.length"
    >
      <div
        v-for="(_, index) in mapLayerList"
        :ref="getMapRefSetter(index)"
        :key="`geojsmap-${index}`"
        @mousedown.capture="mouseDown($event, index)"
        @mousemove.capture="mouseMove($event, index)"
        @mouseup.capture="mouseUp"
        @mouseleave.capture="mouseLeave"
      ></div>
    </div>
    <image-overview
      v-if="overview && !unrolling"
      :parentCameraInfo="cameraInfo"
      @centerChange="setCenter"
      @cornersChange="setCorners"
    />
    <div v-if="samStatusAreaActive" class="sam-status-area">
      <div v-if="showSamToolHelpAlert && samToolActive" class="sam-help-banner">
        <span class="sam-help-label">SAM segmenter:</span>
        <div class="sam-help-text">
          <span><b>Shift + left click</b> positive point</span>
          <span class="sam-help-sep">|</span>
          <span><b>Shift + right click</b> negative point</span>
          <span class="sam-help-sep">|</span>
          <span><b>Shift + drag</b> box</span>
        </div>
        <button class="sam-help-close" @click="showSamToolHelpAlert = false">
          &times;
        </button>
      </div>
      <div v-if="samLoadingMessages.length > 0" class="sam-loading-overlay">
        <v-progress-circular indeterminate size="18" width="2" color="white" />
        <div class="sam-loading-messages">
          <span v-for="(msg, i) in samLoadingMessages" :key="i">{{ msg }}</span>
        </div>
      </div>
    </div>
    <line-scan-panel />
    <object-segmentation-panel />
    <div class="bottom-right-container">
      <v-btn
        v-if="submitPendingAnnotation"
        variant="text"
        size="small"
        @click.capture.stop="
          submitPendingAnnotation && submitPendingAnnotation(false)
        "
      >
        Cancel (ctrl-Z)
      </v-btn>
    </div>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="0"
      height="0"
      style="position: absolute; top: -1px; left: -1px"
    >
      <defs>
        <filter
          :id="'recolor-' + index"
          color-interpolation-filters="sRGB"
          v-for="(item, index) in layerStackImages"
          :key="'recolor-' + index"
        >
          <feComponentTransfer>
            <feFuncR class="func-r" type="linear" slope="0" intercept="0" />
            <feFuncG class="func-g" type="linear" slope="0" intercept="0" />
            <feFuncB class="func-b" type="linear" slope="0" intercept="0" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>

    <v-menu location="top" :close-on-content-click="false">
      <template #activator="{ props: activatorProps }">
        <v-btn
          :data-tour="TOUR_ANCHORS.layerInfo"
          variant="text"
          icon
          size="small"
          v-bind="activatorProps"
          class="layer-info-btn"
          color="primary"
          :disabled="store.layers.length === 0"
        >
          <v-icon size="24">mdi-palette</v-icon>
        </v-btn>
      </template>
      <layer-info-grid :layers="store.layers" />
    </v-menu>
    <v-btn
      :data-tour="TOUR_ANCHORS.lockView"
      variant="text"
      icon
      size="small"
      class="lock-view-btn"
      :color="isViewLocked ? 'error' : 'primary'"
      @click="toggleViewLock"
      v-description="{
        section: 'View',
        title: 'Lock View',
        description: 'Toggle pan and zoom lock (L)',
      }"
    >
      <v-icon size="24">{{
        isViewLocked ? "mdi-lock" : "mdi-lock-open"
      }}</v-icon>
    </v-btn>
    <v-btn
      :data-tour="TOUR_ANCHORS.resetView"
      variant="text"
      icon
      size="small"
      class="reset-view-btn"
      color="primary"
      @click="resetView"
      v-description="{
        section: 'View',
        title: 'Reset view',
        description: 'Recenter and fit the image to the window',
      }"
    >
      <v-icon size="24">mdi-fit-to-page-outline</v-icon>
    </v-btn>
    <v-btn
      :data-tour="TOUR_ANCHORS.resetRotation"
      variant="text"
      icon
      size="small"
      class="reset-rotation-btn"
      color="primary"
      @click="resetRotation"
      v-if="cameraInfo.rotate !== 0"
    >
      <v-icon size="24">mdi-rotate-left</v-icon>
    </v-btn>
  </div>
</template>
<script setup lang="ts">
// in cosole debugging, you can access the map via
//  $('.geojs-map').data('data-geojs-map')
import {
  ref,
  shallowRef,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
  markRaw,
  triggerRef,
  toRaw,
} from "vue";
import annotationStore from "@/store/annotation";
import transcriptsStore from "@/store/transcripts";
import TranscriptOverlay from "@/components/TranscriptOverlay.vue";
import connectionListStore from "@/store/connectionList";
import { TOUR_ANCHORS } from "@/tours/anchors";
import progressStore from "@/store/progress";
import store from "@/store";
import sync from "@/store/sync";
import girderResources from "@/store/girderResources";
import geojs from "geojs";

import {
  IGeoJSDomWidget,
  IGeoJSPosition,
  IGeoJSScaleWidget,
  IGeoJSTile,
  IGeoJSUiLayer,
  IImage,
  ILayerStackImage,
  IMapEntry,
  ICameraInfo,
  IGeoJSPoint2D,
  IMouseState,
  SamAnnotationToolStateSymbol,
  ObjectSegmentationToolStateSymbol,
  ISamAnnotationToolState,
  IObjectSegmentationToolState,
  IGeoJSMap,
  ProgressType,
  IGeoJSActionRecord,
  TToolState,
} from "../store/model";
import setFrameQuad, { ISetQuadStatus } from "@/utils/setFrameQuad";

import AnnotationViewer from "@/components/AnnotationViewer.vue";
import ConnectionActionPanel from "@/components/ConnectionActionPanel.vue";
import LineScanPanel from "@/components/LineScanPanel.vue";
import ObjectSegmentationPanel from "@/components/ObjectSegmentationPanel.vue";
import ImageOverview from "@/components/ImageOverview.vue";
import ScaleSettings from "@/components/ScaleSettings.vue";
import ProgressBarGroup from "@/components/ProgressBarGroup.vue";
import RenderCoverageIndicator from "@/components/RenderCoverageIndicator.vue";
import LayerInfoGrid from "./LayerInfoGrid.vue";
import { ITileHistogram } from "@/store/images";
import { convertLength } from "@/utils/conversion";
import { IHotkey } from "@/utils/v-mousetrap";
import { NoOutput } from "@/pipelines/computePipeline";
import { logWarning } from "@/utils/log";
import { getUnrollCells, IUnrollCell, unrollGridSize } from "@/utils/unroll";
import {
  annotationRasterSelectorsForLayers,
  annotationRasterSelectorsSupported,
} from "@/utils/annotationOverview";

function generateFilterURL(
  index: number,
  contrast: { whitePoint: number; blackPoint: number; mode: string },
  color: string,
  hist: ITileHistogram | null,
) {
  if (hist === null) {
    return;
  }
  // Tease out the RGB color levels.
  const toVal = (s: string) => parseInt(`0x${s}`) / 255;

  const red = toVal(color.slice(1, 3));
  const green = toVal(color.slice(3, 5));
  const blue = toVal(color.slice(5, 7));

  const setSlopeIntercept = (
    index: number,
    id: string,
    wp: number,
    bp: number,
    level: number,
  ) => {
    const el = document.querySelector(`#recolor-${index} .${id}`);
    if (!el) {
      return;
    }

    const range = wp - bp;
    if (range === 0) {
      return;
    }

    const slope = `${level / range}`;
    const intercept = `${-(level * bp) / range}`;
    if (slope != el.getAttribute("slope")) {
      el.setAttribute("slope", slope);
    }
    if (intercept != el.getAttribute("intercept")) {
      el.setAttribute("intercept", intercept);
    }
  };

  const scalePoint = (val: number, mode: string) =>
    mode === "absolute" ? (val - hist.min) / (hist.max - hist.min) : val / 100;

  const whitePoint = scalePoint(contrast.whitePoint, contrast.mode);
  const blackPoint = scalePoint(contrast.blackPoint, contrast.mode);

  setSlopeIntercept(index, "func-r", whitePoint, blackPoint, red);
  setSlopeIntercept(index, "func-g", whitePoint, blackPoint, green);
  setSlopeIntercept(index, "func-b", whitePoint, blackPoint, blue);
}

function isMouseStartEvent(evt: MouseEvent): boolean {
  return evt.shiftKey && evt.buttons !== 0;
}

// ---- Props & Emits ----

const props = withDefaults(
  defineProps<{
    shouldResetMaps?: boolean;
  }>(),
  {
    shouldResetMaps: false,
  },
);

const emit = defineEmits<{
  (e: "reset-complete"): void;
  // Fired when all image layers have finished loading (every layer idle).
  // Driven by the layers' onIdle callbacks via the layersReady computed.
  (e: "layers-ready"): void;
}>();

// ---- Template Refs ----

const mapLayout = ref<HTMLElement>();
const mapRefs = ref<Record<number, HTMLElement | undefined>>({});

function getMapRefSetter(index: number) {
  return (el: any) => {
    if (el) {
      mapRefs.value[index] = el as HTMLElement;
    } else {
      delete mapRefs.value[index];
    }
  };
}

// ---- Reactive State ----

const refsMounted = ref(false);
const readyLayers = ref<boolean[]>([]);
const resetMapsOnDraw = ref(false);
const isViewLocked = ref(false);
const scaleDialog = ref(false);
const defaultActions = ref<IGeoJSActionRecord[] | undefined>(undefined);
const tileWidth = ref(0);
const tileHeight = ref(0);
const unrollW = ref(1);

// Drive the single shared ConnectionActionPanel (see its mount in the template).
const selectedExistingConnectionCount = computed(
  () => connectionListStore.selectedExistingConnectionIds.length,
);
const selectedAnnotationCount = computed(
  () => annotationStore.selectedAnnotationIds.size,
);
const unrollH = ref(1);
const mapSynchronizationCallbacks = ref(new Map<IGeoJSMap, () => void>());
let scaleWidget: IGeoJSScaleWidget | null = null;
let scalePixelWidget: IGeoJSScaleWidget | null = null;
const showSamToolHelpAlert = ref(false);
const samToolActive = computed(
  () => selectedToolType.value === SamAnnotationToolStateSymbol,
);
const objectSegmentationToolActive = computed(
  () => selectedToolType.value === ObjectSegmentationToolStateSymbol,
);
// The status area hosts the loading overlay for both SAM-family tools (the
// SAM annotation tool and the unified object-segmentation tool); the help
// banner inside it is variant per tool.
const samStatusAreaActive = computed(
  () => samToolActive.value || objectSegmentationToolActive.value,
);
const samLoadingMessages = computed(() => {
  const state = selectedTool.value?.state;
  if (
    state?.type === SamAnnotationToolStateSymbol ||
    state?.type === ObjectSegmentationToolStateSymbol
  ) {
    return (state as { loadingMessages: string[] }).loadingMessages ?? [];
  }
  return [];
});
// IMapEntry contains heavy GeoJS map + layers — shallowRef tracks identity
// so the SAM watcher fires on swap, but skips deep-walking the GeoJS tree.
const samMapEntry = shallowRef<IMapEntry | null>(null);
const mouseState = ref<IMouseState | null>(null);
let synchronisationEnabled = true;

const blankUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIHWNgYAAAAAMAAU9ICq8AAAAASUVORK5CYII=";
const ANNOTATION_OVERVIEW_TILE_SIZE = 512;
const ANNOTATION_OVERVIEW_FALLBACK_COLOR = "#FFD700";
const ANNOTATION_OVERVIEW_PROGRESS_DELAY_MS = 300;
// A raster tile can fail transiently: the backend answers 503 + Retry-After: 1
// while another geometry key is still cold-building. The delay matches that
// Retry-After; the bound keeps a genuinely broken template from looping.
const ANNOTATION_OVERVIEW_RETRY_DELAY_MS = 1000;
const ANNOTATION_OVERVIEW_MAX_RETRIES = 3;

type AnnotationOverviewLayer = NonNullable<
  IMapEntry["annotationOverviewLayer"]
>;

interface IAnnotationOverviewLoadState {
  timer: ReturnType<typeof setTimeout> | null;
  progressId: string | null;
  finished: boolean;
}

const annotationOverviewLoadStates = new WeakMap<
  AnnotationOverviewLayer,
  IAnnotationOverviewLoadState
>();
const annotationOverviewTemplates = new WeakMap<
  AnnotationOverviewLayer,
  string
>();
const appliedAnnotationOverviewTemplates = new WeakMap<
  AnnotationOverviewLayer,
  string
>();
const trackedAnnotationOverviewLayers = new Set<AnnotationOverviewLayer>();
// Raster visibility is local to each GeoJS map, while annotation visibility is
// shared store state. Keep per-map activity weakly so layer-unroll maps can be
// added and removed without retaining exited GeoJS maps.
const annotationOverviewViewerActivity = shallowRef(
  new WeakMap<IGeoJSMap, boolean>(),
);

function setAnnotationOverviewViewerActivity(
  mapentry: IMapEntry,
  active: boolean,
) {
  const map = toRaw(mapentry.map);
  if (annotationOverviewViewerActivity.value.get(map) === active) {
    return;
  }
  annotationOverviewViewerActivity.value.set(map, active);
  triggerRef(annotationOverviewViewerActivity);
}

function finishAnnotationOverviewLoad(
  layer: AnnotationOverviewLayer,
  state: IAnnotationOverviewLoadState,
) {
  if (state.finished) {
    return;
  }
  state.finished = true;
  if (state.timer != null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.progressId) {
    void progressStore.complete(state.progressId);
    state.progressId = null;
  }
  if (annotationOverviewLoadStates.get(layer) === state) {
    annotationOverviewLoadStates.delete(layer);
  }
  trackedAnnotationOverviewLayers.delete(layer);
}

function cancelAnnotationOverviewLoad(layer?: AnnotationOverviewLayer) {
  if (!layer) {
    return;
  }
  const state = annotationOverviewLoadStates.get(layer);
  if (state) {
    finishAnnotationOverviewLoad(layer, state);
  }
}

function trackAnnotationOverviewLoad(layer: AnnotationOverviewLayer) {
  cancelAnnotationOverviewLoad(layer);
  const state: IAnnotationOverviewLoadState = {
    timer: null,
    progressId: null,
    finished: false,
  };
  annotationOverviewLoadStates.set(layer, state);
  trackedAnnotationOverviewLayers.add(layer);
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.finished || annotationOverviewLoadStates.get(layer) !== state) {
      return;
    }
    if (layer.idle) {
      finishAnnotationOverviewLoad(layer, state);
      return;
    }

    layer.onIdle(() => finishAnnotationOverviewLoad(layer, state));
    void (async () => {
      const progressId = await progressStore.create({
        type: ProgressType.ANNOTATION_RASTER,
      });
      if (state.finished || annotationOverviewLoadStates.get(layer) !== state) {
        void progressStore.complete(progressId);
        return;
      }
      state.progressId = progressId;
      if (layer.idle) {
        finishAnnotationOverviewLoad(layer, state);
      }
    })();
  }, ANNOTATION_OVERVIEW_PROGRESS_DELAY_MS);
}

function applyAnnotationOverviewTemplate(layer: AnnotationOverviewLayer) {
  const template = annotationOverviewTemplates.get(layer);
  if (!template || appliedAnnotationOverviewTemplates.get(layer) === template) {
    return false;
  }
  layer.url((x: number, y: number, level: number) =>
    template
      .replace("{z}", level.toString())
      .replace("{x}", x.toString())
      .replace("{y}", y.toString()),
  );
  appliedAnnotationOverviewTemplates.set(layer, template);
  // A new template is a new set of tile requests — restore the retry budget.
  cancelAnnotationOverviewRetry(layer, true);
  return true;
}

interface IAnnotationOverviewRetryState {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const annotationOverviewRetryStates = new WeakMap<
  AnnotationOverviewLayer,
  IAnnotationOverviewRetryState
>();

// GeoJS exposes no tile-error event: a failed fetch logs a console warning,
// removes the tile, and leaves the REJECTED tile in the layer's cache, so
// later draws reuse the failure instead of refetching. The tile's documented
// promise interface (`tile.catch`) is the only failure signal. Attaching any
// handler (tile.catch → tile.then) queues the tile's fetch, and the fetch
// queue's `needed` predicate only accepts a tile that is already the cache's
// entry for its hash — `_getTile` runs BEFORE `cache.add` inside
// `_getTileCached`, so hooking `_getTile` rejects every tile at creation
// (zero requests, permanently blank raster). Wrap `_getTileCached` instead:
// it returns only after the tile is cached. Cache hits return the same tile,
// so hook each tile exactly once. Retry state itself stays out of the GeoJS
// object (WeakMaps above).
const hookedAnnotationOverviewTiles = new WeakSet<IGeoJSTile>();

function hookAnnotationOverviewTileErrors(layer: AnnotationOverviewLayer) {
  const originalGetTileCached = layer._getTileCached;
  if (typeof originalGetTileCached !== "function") {
    return;
  }
  layer._getTileCached = (...args: unknown[]) => {
    const tile = originalGetTileCached.apply(layer, args);
    if (!hookedAnnotationOverviewTiles.has(tile)) {
      hookedAnnotationOverviewTiles.add(tile);
      tile.catch(() => scheduleAnnotationOverviewRetry(layer));
    }
    return tile;
  };
}

function cancelAnnotationOverviewRetry(
  layer: AnnotationOverviewLayer,
  resetAttempts = false,
) {
  const state = annotationOverviewRetryStates.get(layer);
  if (!state) {
    return;
  }
  if (state.timer != null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (resetAttempts) {
    state.attempts = 0;
  }
}

function scheduleAnnotationOverviewRetry(layer: AnnotationOverviewLayer) {
  let state = annotationOverviewRetryStates.get(layer);
  if (!state) {
    state = { attempts: 0, timer: null };
    annotationOverviewRetryStates.set(layer, state);
  }
  // One pending retry covers every failed tile of the batch.
  if (
    state.timer != null ||
    state.attempts >= ANNOTATION_OVERVIEW_MAX_RETRIES
  ) {
    return;
  }
  state.attempts += 1;
  state.timer = setTimeout(() => {
    state.timer = null;
    // Only retry a layer that is still mounted, shown, and displaying the
    // same template — a template change redraws with a fresh budget anyway.
    if (
      !maps.value.some(
        (mountedMapentry) =>
          toRaw(mountedMapentry.annotationOverviewLayer) === toRaw(layer),
      ) ||
      !layer.visible() ||
      !annotationOverviewTemplates.has(layer)
    ) {
      return;
    }
    // reset() clears the tile cache — the only way to make GeoJS refetch a
    // tile whose previous fetch was rejected.
    layer.reset();
    layer.draw();
    trackAnnotationOverviewLoad(layer);
  }, ANNOTATION_OVERVIEW_RETRY_DELAY_MS);
}

function _setAnnotationOverviewVisibility(
  mapentry: IMapEntry,
  state: { visible: boolean; opacity: number },
) {
  setAnnotationOverviewViewerActivity(mapentry, state.visible);
  // Surplus layer-unroll maps are exited before Vue unmounts their child
  // AnnotationViewer. Its final inactive event must still update the aggregate
  // activity above, but the removed GeoJS layer no longer has a renderer.
  if (
    !maps.value.some(
      (mountedMapentry) => toRaw(mountedMapentry.map) === toRaw(mapentry.map),
    )
  ) {
    return;
  }
  const layer = mapentry.annotationOverviewLayer;
  if (!layer) {
    return;
  }
  const wasVisible = layer.visible();
  const shouldShow = state.visible && annotationOverviewTemplates.has(layer);
  const opacityChanged = layer.opacity() !== state.opacity;
  if (opacityChanged) {
    layer.opacity(state.opacity);
  }
  if (!shouldShow) {
    cancelAnnotationOverviewLoad(layer);
    cancelAnnotationOverviewRetry(layer);
    if (wasVisible) {
      layer.visible(false);
      layer.draw();
    }
    return;
  }

  const templateChanged = applyAnnotationOverviewTemplate(layer);
  if (!wasVisible) {
    layer.visible(true);
  }
  if (!wasVisible || opacityChanged || templateChanged) {
    layer.draw();
  }
  if (!wasVisible || templateChanged) {
    trackAnnotationOverviewLoad(layer);
  }
}

// ---- Computed Properties - Store Proxies ----

const maps = computed({
  get: () => store.maps,
  set: (value: IMapEntry[]) => store.setMaps(value),
});

// The image the transcript density pyramid is sized to: the same one the
// annotation overview uses.
const transcriptImage = computed(
  () => layerStackImages.value.find((lsi) => lsi.images[0])?.images[0] ?? null,
);

const annotationViewerMaps = computed(() =>
  maps.value.filter(
    (mapentry) =>
      mapentry.annotationLayer &&
      mapentry.lowestLayer !== undefined &&
      mapentry.imageLayers &&
      mapentry.imageLayers.length,
  ),
);

const allAnnotationOverviewViewersRasterActive = computed(() => {
  // An empty viewer set must never suppress shared visibility.
  return (
    annotationViewerMaps.value.length > 0 &&
    annotationViewerMaps.value.every((mapentry) =>
      annotationOverviewViewerActivity.value.get(toRaw(mapentry.map)),
    )
  );
});

watch(allAnnotationOverviewViewersRasterActive, (allActive) => {
  if (!allActive) {
    annotationStore.setVisibilitySuppressed(false);
  }
});

const cameraInfo = computed({
  get: (): ICameraInfo => store.cameraInfo,
  set: (info: ICameraInfo) => store.setCameraInfo(info),
});

// Incremented by `_setupMap` once it has (re)configured the primary map for
// a new dataset ID. The watcher below this declaration's use site then fits
// the image to the viewport. `lastFittedDatasetId` is a "last seen" sentinel
// guarding the bump — kept as a ref purely for symmetry with the bump ref.
const fitOnDatasetChange = ref(0);
const lastFittedDatasetId = ref<string | null>(null);

const overview = computed(() => store.overview);
const dataset = computed(() => store.dataset);
const unrolling = computed(() => store.unroll);
const width = computed(() => (store.dataset ? store.dataset.width : 1));
const height = computed(() => (store.dataset ? store.dataset.height : 1));
const compositionMode = computed(() => store.compositionMode);
const backgroundColor = computed(() => store.backgroundColor);
const pixelSize = computed(() => store.scales.pixelSize);
const showScalebar = computed(() => store.showScalebar);
const showPixelScalebar = computed(() => store.showPixelScalebar);
const scalebarColor = computed(() => store.scalebarColor);
const selectedTool = computed(() => store.selectedTool);

const layerStackImages = computed(() =>
  store.configuration ? store.layerStackImages : [],
);

const submitPendingAnnotation = computed(
  () => annotationStore.submitPendingAnnotation,
);

// ---- Computed Properties - Derived ----

const selectedToolType = computed(() => selectedTool.value?.state.type ?? null);

const readyLayersCount = computed(() =>
  readyLayers.value.reduce((count, ready) => (ready ? count + 1 : count), 0),
);

const readyLayersTotal = computed(() => readyLayers.value.length);

const layersReady = computed(
  () => readyLayersCount.value >= readyLayersTotal.value,
);

const mouseMap = computed<IMapEntry | null>(
  () => mouseState.value?.mapEntry ?? null,
);

const mapLayerList = computed<ILayerStackImage[][]>(() => {
  let llist = [layerStackImages.value];
  if (store.layerMode === "unroll") {
    // Bind each group id (not nullish) to a llist index
    const layerGroups: Map<string, number> = new Map();
    llist = [];
    layerStackImages.value.forEach((lsi) => {
      if (lsi.layer.visible) {
        const group = lsi.layer.layerGroup;
        if (group) {
          if (!layerGroups.has(group)) {
            layerGroups.set(group, llist.length);
            llist.push([]);
          }
          const groupIdx = layerGroups.get(group)!;
          llist[groupIdx].push(lsi);
        } else {
          llist.push([lsi]);
        }
      }
    });
  }
  return llist;
});

// ---- Computed Properties - Unroll Labels ----

// One entry per map, index-aligned with mapLayerList (and so with maps): each
// map draws its own layer group in the "unroll" layer mode, and a group can
// cover different frames than its neighbour, so cells are derived per map from
// the layer whose tiles that map shows.
const unrollCellsByMap = computed<IUnrollCell[][]>(() => {
  if (!unrolling.value) {
    return [];
  }
  const dataset = store.dataset;
  const flags = {
    unrollXY: store.unrollXY,
    unrollZ: store.unrollZ,
    unrollT: store.unrollT,
  };
  const showDimensionLabels = {
    xy: store.showXYLabels,
    z: store.showZLabels,
    time: store.showTimeLabels,
  };
  return mapLayerList.value.map((mll) => {
    const someImages = mll.find((lsi) => lsi.images[0]);
    if (!someImages) {
      return [];
    }
    return getUnrollCells({
      cellImages: someImages.images,
      flags,
      // Axis indices have to be ranked over every frame of the dataset, since
      // that is the set store.xy / .z / .time index into.
      axisImages: dataset?.allImages?.length
        ? dataset.allImages
        : someImages.images,
      dimensionLabels: dataset?.dimensionLabels,
      showDimensionLabels,
    });
  });
});

// ---- Mousetrap Bindings ----

const mousetrapAnnotations: IHotkey[] = [
  {
    bind: "a",
    handler: () => {
      store.setDrawAnnotations(!store.drawAnnotations);
    },
    data: {
      section: "Objects",
      description: "Show/hide objects",
    },
  },
  {
    bind: "t",
    handler: () => {
      store.setShowTooltips(!store.showTooltips);
    },
    data: {
      section: "Objects",
      description: "Show/hide object tooltips",
    },
  },
  {
    bind: "mod+backspace",
    handler: () => {
      annotationStore.deleteSelectedAnnotations();
    },
    data: {
      section: "Objects",
      description: "Delete selected objects",
    },
  },
  {
    bind: "mod+z",
    handler: () => {
      annotationStore.undoOrRedo(true);
    },
    data: {
      section: "Objects",
      description: "Undo last action",
    },
  },
  {
    bind: "mod+shift+z",
    handler: () => {
      annotationStore.undoOrRedo(false);
    },
    data: {
      section: "Objects",
      description: "Redo last action",
    },
  },
  {
    bind: "l",
    handler: () => {
      toggleViewLock();
    },
    data: {
      section: "View",
      description: "Lock/unlock view pan and zoom",
    },
  },
  {
    bind: "mod+c",
    handler: () => {
      // Check if text is selected - if so, let default behavior happen
      if (window.getSelection()?.toString()) {
        return; // Return false to allow the default browser behavior
      }
      // Otherwise, copy selected annotations
      annotationStore.copySelectedAnnotations();
    },
    data: {
      section: "Objects",
      description: "Copy selected objects",
    },
  },
  {
    bind: "mod+v",
    handler: () => {
      // Check if we're in an input or text area
      const activeElement = document.activeElement;
      const isEditableElement =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.hasAttribute("contenteditable");

      if (isEditableElement) {
        return; // Allow default paste behavior
      }

      // Otherwise paste annotations
      annotationStore.pasteAnnotations();
    },
    data: {
      section: "Objects",
      description: "Paste objects",
    },
  },
];

// ---- Methods ----

// TODO: This currently does nothing. However, this used to be where the
// histogram cache progress was reloaded based on the running jobs. We could
// implement something like that again if we want to show the progress bars for
// the various caching processes (histograms, annotations, quad frames, etc.).
async function datasetReset() {
  const datasetId = dataset.value?.id;
  if (!datasetId) {
    return;
  }
}

function mouseDown(evt: MouseEvent, mapIdx: number) {
  // Start selection on shift + mouseDown
  const mapEntry = maps.value?.[mapIdx];
  if (
    !mapEntry ||
    !isMouseStartEvent(evt) ||
    !(evt.target instanceof HTMLElement)
  ) {
    return;
  }

  // Setup initial mouse state
  mouseState.value = {
    isMouseMovePreviewState: false,
    mapEntry,
    target: evt.target,
    path: [],
    initialMouseEvent: evt,
  };

  // Will add the current point and capture mouse if needed
  mouseMove(evt, mapIdx);
}

function mouseLeave() {
  if (!mouseState.value || mouseState.value.isMouseMovePreviewState) {
    mouseState.value = null;
  }
}

function mouseMove(evt: MouseEvent, mapIdx: number) {
  if (!mouseState.value || mouseState.value.isMouseMovePreviewState) {
    // Create a preview mouse state
    const mapEntry = maps.value?.[mapIdx];
    const target = evt.target;
    if (!mapEntry || !(target instanceof HTMLElement)) {
      mouseState.value = null;
      return;
    }
    const rect = target.getBoundingClientRect();
    const displayPoint = { x: evt.x - rect.x, y: evt.y - rect.y };
    const gcsPoint = mapEntry.map.displayToGcs(displayPoint);
    mouseState.value = {
      isMouseMovePreviewState: true,
      mapEntry,
      target,
      path: [gcsPoint],
      initialMouseEvent: evt,
    };
    return;
  }
  evt.stopPropagation();
  const { target, mapEntry, path } = mouseState.value;
  const rect = target.getBoundingClientRect();
  const displayPoint = { x: evt.x - rect.x, y: evt.y - rect.y };
  const gcsPoint = mapEntry.map.displayToGcs(displayPoint);
  path.push(gcsPoint);
}

function mouseUp(evt: MouseEvent) {
  if (!mouseState.value || mouseState.value.isMouseMovePreviewState) {
    return;
  }
  evt.stopPropagation();
  mouseState.value = null;
}

function synchroniseCameraFromMap(map: IGeoJSMap) {
  const size = map.size();
  // Setting camera info will apply to all maps thanks to applyCameraInfo
  cameraInfo.value = {
    zoom: map.zoom(),
    rotate: map.rotation(),
    center: map.center(),
    gcsBounds: [
      map.displayToGcs({ x: 0, y: 0 }),
      map.displayToGcs({ x: size.width, y: 0 }),
      map.displayToGcs({ x: size.width, y: size.height }),
      map.displayToGcs({ x: 0, y: size.height }),
    ],
  };
}

function setCenter(center: IGeoJSPosition) {
  const map = maps.value[0]?.map;
  if (!map) {
    return;
  }
  map.center(center);
  synchroniseCameraFromMap(map);
}

function resetRotation() {
  const map = maps.value[0]?.map;
  if (!map) {
    return;
  }
  map.rotation(0);
}

// Recenter the image and fit it to the viewport by setting the view bounds to
// the full image bounds. Mirrors setCenter/setCorners: change map 0, then sync
// so unrolled (multi-map) views follow.
function resetView() {
  const map = maps.value[0]?.map;
  if (!map) {
    return;
  }
  map.bounds(map.maxBounds(undefined, null), null);
  synchroniseCameraFromMap(map);
}

function setCorners(evt: any) {
  const map = maps.value[0]?.map;
  if (!map) {
    return;
  }
  const mapsize = map.size();
  const lowerLeft = map.gcsToDisplay(evt.lowerLeftGcs);
  const upperRight = map.gcsToDisplay(evt.upperRightGcs);
  const scaling = {
    x: Math.abs((upperRight.x - lowerLeft.x) / mapsize.width),
    y: Math.abs((upperRight.y - lowerLeft.y) / mapsize.height),
  };
  const center = map.displayToGcs(
    {
      x: (lowerLeft.x + upperRight.x) / 2,
      y: (lowerLeft.y + upperRight.y) / 2,
    },
    null,
  );
  const zoom = map.zoom() - Math.log2(Math.max(scaling.x, scaling.y));
  map.zoom(zoom);
  map.center(center, null);
  synchroniseCameraFromMap(map);
}

function applyCameraInfo() {
  maps.value.forEach((mapentry) => {
    const map = mapentry.map;
    synchronisationEnabled = false;
    try {
      map.zoom(cameraInfo.value.zoom, undefined, true, true);
      map.rotation(cameraInfo.value.rotate, undefined, true);
      map.center(cameraInfo.value.center, undefined, true, true);
    } catch (err) {
      logWarning(err);
    } finally {
      synchronisationEnabled = true;
    }
  });
}

function updateCompositionMode() {
  for (const mapentry of maps.value) {
    for (const imageLayer of mapentry.imageLayers) {
      imageLayer.node().css({ "mix-blend-mode": compositionMode.value });
    }
  }
}

function updateBackgroundColor() {
  if (mapLayout.value) {
    mapLayout.value.style.background = backgroundColor.value;
  }
}

function updateScaleWidget() {
  const uiLayer = maps.value[0]?.uiLayer;
  if (!uiLayer) {
    return;
  }
  const pixelSizeScale = pixelSize.value;
  const pixelSizeM = convertLength(
    pixelSizeScale.value,
    pixelSizeScale.unit,
    "m",
  );
  const oldWidgetLayer = scaleWidget?.layer();
  if (
    scaleWidget &&
    (scaleWidget.options("scale") !== pixelSizeM || !showScalebar.value)
  ) {
    if (oldWidgetLayer && oldWidgetLayer === uiLayer) {
      oldWidgetLayer.deleteWidget(scaleWidget);
    }
    scaleWidget = null;
  }
  if (!scaleWidget && showScalebar.value && pixelSizeM > 0) {
    scaleWidget = uiLayer.createWidget("scale", {
      scale: pixelSizeM,
      strokeWidth: 5,
      tickLength: 2.5,
      position: { bottom: 20, right: 10 },
    });
    const svgElement = scaleWidget.canvas();
    svgElement.classList.add("scale-widget");
    svgElement.onclick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      scaleDialog.value = true;
    };
  }
}

function updateScalePixelWidget() {
  const uiLayer = maps.value[0]?.uiLayer;
  if (!uiLayer) {
    return;
  }
  const oldWidgetLayer = scaleWidget?.layer();
  if (scalePixelWidget && !showPixelScalebar.value) {
    if (oldWidgetLayer && oldWidgetLayer === uiLayer) {
      oldWidgetLayer.deleteWidget(scalePixelWidget);
    }
    scalePixelWidget = null;
  }
  if (!scalePixelWidget && showPixelScalebar.value) {
    scalePixelWidget = uiLayer.createWidget("scale", {
      strokeWidth: 5,
      maxWidth: 200,
      tickLength: 2.5,
      position: { bottom: 60, right: 10 },
      orientation: "top",
      units: [
        {
          unit: "pixels",
          scale: 1,
          multiples: [
            { multiple: 10, digit: 1 },
            { multiple: 1, digit: 1 },
          ],
        },
      ],
      distance: (pt1: IGeoJSPoint2D, pt2: IGeoJSPoint2D) =>
        Math.sqrt((pt1.x - pt2.x) ** 2 + (pt1.y - pt2.y) ** 2),
    });
    const svgElement = scalePixelWidget.canvas();
    svgElement.classList.add("scale-widget");
    svgElement.onclick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      scaleDialog.value = true;
    };
  }
}

// ---- Unroll Frame Labels ----
//
// One label per cell of the unrolled grid, anchored to the cell's upper-left
// corner in map coordinates. GeoJS repositions a widget given an { x, y }
// position on `geo_event.pan`, which its zoom() also fires, so the labels
// follow both panning and zooming. A dom widget stops mousedown from reaching
// the GeoJS interactor, so clicking a label never starts an annotation.

// Each label is its own element that GeoJS repositions on every pan, so very
// large grids would pay for labels too small to read at that density anyway.
const MAX_UNROLL_LABEL_CELLS = 400;

interface IUnrollLabelState {
  widgets: IGeoJSDomWidget[];
  // Identifies the labelled grid; a change means the widgets are rebuilt.
  signature: string;
}

const unrollLabelStates = new WeakMap<IGeoJSMap, IUnrollLabelState>();

// Cell count of the last grid that went unlabelled, so the warning is logged
// once per grid rather than on every draw.
let warnedUnrollLabelCells = 0;

// The cells of one map's grid that get a label: unlabelled ones (every unrolled
// dimension has a single value) and grids too dense to label are dropped.
function labelledUnrollCells(mapIndex: number): IUnrollCell[] {
  const cells = (unrollCellsByMap.value[mapIndex] ?? []).filter(
    (cell) => cell.label,
  );
  if (cells.length > MAX_UNROLL_LABEL_CELLS) {
    if (warnedUnrollLabelCells !== cells.length) {
      warnedUnrollLabelCells = cells.length;
      logWarning(
        `Unrolled grid of ${cells.length} frames exceeds the ` +
          `${MAX_UNROLL_LABEL_CELLS} frame label limit; labels are hidden`,
      );
    }
    return [];
  }
  return cells;
}

// Roll the grid back up at the clicked frame.
function navigateToUnrolledCell(cell: IUnrollCell) {
  const { xy, z, time } = cell.location;
  if (xy !== undefined) {
    store.setXY(xy);
  }
  if (z !== undefined) {
    store.setZ(z);
  }
  if (time !== undefined) {
    store.setTime(time);
  }
  // Clearing the flags is what rolls the grid up: NavigatorPanel watches all
  // three and refreshes the dataset, the same path snapshot restore and the AI
  // panel take. Refreshing here as well would load the dataset twice.
  if (store.unrollXY) {
    store.setUnrollXY(false);
  }
  if (store.unrollZ) {
    store.setUnrollZ(false);
  }
  if (store.unrollT) {
    store.setUnrollT(false);
  }
}

function createUnrollLabel(
  uiLayer: IGeoJSUiLayer,
  cell: IUnrollCell,
  someImage: IImage,
) {
  const widget = uiLayer.createWidget("dom", {
    // A real button, so the label is reachable by keyboard and reads as a
    // control; GeoJS creates whatever element `el` names.
    el: "button",
    position: {
      x: someImage.sizeX * (cell.index % unrollW.value),
      y: someImage.sizeY * Math.floor(cell.index / unrollW.value),
    },
  });
  const element = widget.canvas() as HTMLButtonElement;
  element.type = "button";
  element.classList.add("unroll-frame-label");
  element.textContent = cell.label;
  element.title = `Show ${cell.label} on its own`;
  element.setAttribute("aria-label", `Show ${cell.label} on its own`);
  element.onclick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    navigateToUnrolledCell(cell);
  };
  return widget;
}

function clearUnrollLabels() {
  for (const mapentry of maps.value) {
    const state = unrollLabelStates.get(mapentry.map);
    if (!state) {
      continue;
    }
    state.widgets.forEach((widget) => mapentry.uiLayer?.deleteWidget(widget));
    unrollLabelStates.delete(mapentry.map);
  }
}

function updateUnrollLabels() {
  // The same image draw() sizes the grid from, so a cell's corner is at a
  // multiple of this image's size.
  const someImage = layerStackImages.value.find((lsi) => lsi.images[0])
    ?.images[0];
  if (!someImage) {
    return;
  }
  maps.value.forEach((mapentry, mapIndex) => {
    const uiLayer = mapentry.uiLayer;
    if (!uiLayer) {
      return;
    }
    const cells = labelledUnrollCells(mapIndex);
    const signature = JSON.stringify([
      cells.map((cell) => [cell.index, cell.label]),
      unrollW.value,
      someImage.sizeX,
      someImage.sizeY,
    ]);
    const state = unrollLabelStates.get(mapentry.map);
    if (state?.signature === signature) {
      return;
    }
    state?.widgets.forEach((widget) => uiLayer.deleteWidget(widget));
    unrollLabelStates.set(mapentry.map, {
      widgets: cells.map((cell) => createUnrollLabel(uiLayer, cell, someImage)),
      signature,
    });
  });
}

function _setupMap(
  mllidx: number,
  someImage: IImage,
  forceReset: boolean = false,
) {
  const mapElement = mapRefs.value[mllidx];
  if (!mapElement) {
    return;
  }
  let mapWidth = unrollW.value * someImage.sizeX;
  let mapHeight = unrollH.value * someImage.sizeY;
  let params = geojs.util.pixelCoordinateParams(
    mapElement,
    someImage.sizeX,
    someImage.sizeY,
    tileWidth.value,
    tileHeight.value,
  );
  params.map.maxBounds!.right = mapWidth;
  params.map.maxBounds!.bottom = mapHeight;
  params.map.min! -= Math.ceil(
    Math.log(Math.max(unrollW.value, unrollH.value)) / Math.log(2),
  );
  params.map.zoom = params.map.min;
  params.map.center = { x: mapWidth / 2, y: mapHeight / 2 };
  // Unclamp pan + zoom so the user can move the image past the
  // viewport edges (necessary now that floating palettes can cover
  // parts of the canvas — pan the image to reveal what's hidden).
  (params.map as any).clampBoundsX = false;
  (params.map as any).clampBoundsY = false;
  (params.map as any).clampZoom = false;
  params.layer.crossDomain = "use-credentials";
  params.layer.autoshareRenderer = false;
  params.layer.nearestPixel = params.layer.maxLevel;
  delete params.layer.tilesMaxBounds;
  params.layer.url = blankUrl;
  params.map.max! += 5;

  let needReset = forceReset || (maps.value[mllidx] && !mapElement.firstChild);
  if (needReset) {
    maps.value[mllidx]?.map.exit();
  }

  if (maps.value.length <= mllidx || needReset) {
    const map = markRaw(geojs.map(params.map));
    const synchronizationCallback = () => {
      if (synchronisationEnabled) {
        synchroniseCameraFromMap(map);
      }
    };
    map.geoOn(geojs.event.pan, synchronizationCallback);
    map.geoOn(geojs.event.zoom, synchronizationCallback);

    const interactorOpts = map.interactor().options();
    const keyboardOpts = interactorOpts.keyboard;
    if (keyboardOpts?.actions) {
      /* remove default key bindings */
      const oldActions = keyboardOpts.actions;
      const newActions: typeof oldActions = {};
      /* We can keep some actions, if wanted */
      if ("rotate.0" in oldActions) {
        newActions["rotate.0"] = oldActions["rotate.0"];
      }
      keyboardOpts.actions = newActions;
    }
    map.interactor().options(interactorOpts);
    const annotationLayer = markRaw(
      map.createLayer("annotation", {
        annotations: geojs.listAnnotations(),
        autoshareRenderer: false,
        continuousCloseProximity: true,
        showLabels: false,
      }),
    );
    const workerPreviewLayer = markRaw(
      map.createLayer("feature", {
        renderer: mllidx ? "canvas" : undefined,
        features: ["quad", "quad.image"],
      }),
    );
    const workerPreviewFeature = markRaw(
      workerPreviewLayer.createFeature("quad"),
    );
    const textLayer = markRaw(
      map.createLayer("feature", { features: ["text"] }),
    );
    const timelapseLayer = markRaw(
      map.createLayer("annotation", {
        annotations: [],
        autoshareRenderer: false,
        continuousCloseProximity: true,
        showLabels: false,
      }),
    );
    const timelapseTextLayer = markRaw(
      map.createLayer("feature", {
        features: ["text"],
      }),
    );
    const interactionLayer = markRaw(
      map.createLayer("annotation", {
        annotations: [],
        autoshareRenderer: false,
        continuousCloseProximity: true,
        showLabels: false,
      }),
    );

    annotationLayer.node().css({ "mix-blend-mode": "unset" });
    workerPreviewLayer.node().css({ "mix-blend-mode": "unset" });
    textLayer.node().css({ "mix-blend-mode": "unset" });
    timelapseLayer.node().css({ "mix-blend-mode": "unset" });
    timelapseTextLayer.node().css({ "mix-blend-mode": "unset" });
    interactionLayer.node().css({ "mix-blend-mode": "unset" });

    const mapentry: IMapEntry = {
      map,
      imageLayers: markRaw([]),
      params: markRaw(params),
      baseLayerIndex: mllidx ? undefined : 0,
      annotationLayer,
      workerPreviewLayer,
      textLayer,
      timelapseLayer,
      timelapseTextLayer,
      workerPreviewFeature,
      interactionLayer,
    };
    store.setMapAt({ index: mllidx, mapEntry: mapentry });
  } else {
    const mapentry = maps.value[mllidx];
    mapentry.params = markRaw(params);
    const map = mapentry.map;
    const adjustLayers =
      Math.abs(map.maxBounds(undefined, null).right - mapWidth) >= 0.5 ||
      Math.abs(map.maxBounds(undefined, null).bottom - mapHeight) >= 0.5;
    if (adjustLayers) {
      map.maxBounds({
        left: 0,
        top: 0,
        right: params.map.maxBounds!.right,
        bottom: params.map.maxBounds!.bottom,
      });
      map.zoomRange(params.map);
      // Re-assert unclamped pan/zoom on map reconfigure — see comment
      // in the create branch above.
      (map as any).clampBoundsX(false);
      (map as any).clampBoundsY(false);
      (map as any).clampZoom(false);
    }
  }

  // Every map gets a ui layer to hold its unroll frame labels — the "unroll"
  // layer mode draws one grid per layer, and each grid labels its own cells.
  const mapentry = maps.value[mllidx];
  if (!mapentry.uiLayer) {
    mapentry.uiLayer = markRaw(mapentry.map.createLayer("ui"));
    mapentry.uiLayer.node().css({ "mix-blend-mode": "unset" });
  }
  _syncAnnotationOverviewLayer(mapentry, someImage, mapElement);

  // only have a scale widget on the first map
  if (mllidx === 0) {
    updateScaleWidget();
    updateScalePixelWidget();

    // Signal the "fit on dataset change" watcher: if the dataset ID has
    // changed since the last fit, the map's bounds now reflect the new
    // dataset and it's safe to fit the image to the viewport. Bump only
    // on dataset change so unroll / layer reconfigures don't yank the
    // user's zoom mid-interaction.
    const currentDatasetId = dataset.value?.id ?? null;
    if (currentDatasetId && currentDatasetId !== lastFittedDatasetId.value) {
      lastFittedDatasetId.value = currentDatasetId;
      fitOnDatasetChange.value++;
    }
  }
}

function _syncAnnotationOverviewLayer(
  mapentry: IMapEntry,
  someImage: IImage,
  mapElement: HTMLElement,
) {
  const config = annotationStore.overviewConfig;
  if (!config?.enabled) {
    cancelAnnotationOverviewLoad(mapentry.annotationOverviewLayer);
    if (mapentry.annotationOverviewLayer) {
      cancelAnnotationOverviewRetry(mapentry.annotationOverviewLayer, true);
    }
    mapentry.annotationOverviewLayer?.visible(false);
    if (mapentry.annotationOverviewLayer) {
      annotationOverviewTemplates.delete(mapentry.annotationOverviewLayer);
    }
    return;
  }
  // The map's units-per-pixel scale comes from the native image pyramid.
  // A 512 px overview tile would otherwise infer a pyramid one level shorter
  // than a 256 px image tile and rasterize every coordinate at half scale.
  const coordinateMaxLevel =
    mapentry.params.layer.maxLevel ?? someImage.levels - 1;
  if (!mapentry.annotationOverviewLayer) {
    const params = geojs.util.pixelCoordinateParams(
      mapElement,
      someImage.sizeX,
      someImage.sizeY,
      ANNOTATION_OVERVIEW_TILE_SIZE,
      ANNOTATION_OVERVIEW_TILE_SIZE,
    );
    params.layer.maxLevel = coordinateMaxLevel;
    params.layer.tilesAtZoom = (level: number) => {
      const scale = Math.pow(2, coordinateMaxLevel - level);
      return {
        x: Math.ceil(someImage.sizeX / ANNOTATION_OVERVIEW_TILE_SIZE / scale),
        y: Math.ceil(someImage.sizeY / ANNOTATION_OVERVIEW_TILE_SIZE / scale),
      };
    };
    params.layer.tilesMaxBounds = (level: number) => {
      const scale = Math.pow(2, coordinateMaxLevel - level);
      return {
        x: Math.floor(someImage.sizeX / scale),
        y: Math.floor(someImage.sizeY / scale),
      };
    };
    params.layer.crossDomain = "use-credentials";
    params.layer.autoshareRenderer = false;
    params.layer.nearestPixel = params.layer.maxLevel;
    params.layer.url = blankUrl;
    params.layer.visible = false;
    mapentry.annotationOverviewLayer = markRaw(
      mapentry.map.createLayer("osm", params.layer),
    );
    hookAnnotationOverviewTileErrors(mapentry.annotationOverviewLayer);
    mapentry.annotationOverviewLayer.node().css({ "mix-blend-mode": "unset" });
    const mapIndex = maps.value.indexOf(mapentry);
    if (mapIndex >= 0) {
      // IMapEntry is markRaw for GeoJS performance, so replace the reactive
      // outer array after lazily adding the layer. This delivers the new prop
      // to the already-mounted AnnotationViewer when overview is enabled later.
      store.setMapAt({ index: mapIndex, mapEntry: mapentry });
    }
  }

  const datasetId = dataset.value?.id;
  if (!datasetId || unrolling.value) {
    cancelAnnotationOverviewLoad(mapentry.annotationOverviewLayer);
    cancelAnnotationOverviewRetry(mapentry.annotationOverviewLayer, true);
    mapentry.annotationOverviewLayer.visible(false);
    annotationOverviewTemplates.delete(mapentry.annotationOverviewLayer);
    return;
  }
  const mapIndex = maps.value.indexOf(mapentry);
  const selectors = annotationRasterSelectorsForLayers({
    layers: (mapLayerList.value[mapIndex] ?? []).map(({ layer }) => layer),
    showHiddenLayers: store.showAnnotationsFromHiddenLayers,
    layerSliceIndexes: store.layerSliceIndexes,
  });
  if (!annotationRasterSelectorsSupported(selectors)) {
    cancelAnnotationOverviewLoad(mapentry.annotationOverviewLayer);
    cancelAnnotationOverviewRetry(mapentry.annotationOverviewLayer, true);
    mapentry.annotationOverviewLayer.visible(false);
    annotationOverviewTemplates.delete(mapentry.annotationOverviewLayer);
    return;
  }
  const template = annotationStore.annotationsAPI.annotationRasterTemplateUrl({
    datasetId,
    selectors,
    sizeX: someImage.sizeX,
    sizeY: someImage.sizeY,
    tileSize: ANNOTATION_OVERVIEW_TILE_SIZE,
    maxLevel: coordinateMaxLevel,
    mode: config.mode,
    color: ANNOTATION_OVERVIEW_FALLBACK_COLOR,
    version: annotationStore.mutationCounter,
  });
  annotationOverviewTemplates.set(mapentry.annotationOverviewLayer, template);
  if (
    mapentry.annotationOverviewLayer.visible() &&
    applyAnnotationOverviewTemplate(mapentry.annotationOverviewLayer)
  ) {
    trackAnnotationOverviewLoad(mapentry.annotationOverviewLayer);
  }
}

/**
 * Make sure a map has the appropriate tile layers.
 */
function _setupTileLayers(
  mll: ILayerStackImage[],
  mllidx: number,
  someImage: IImage,
  baseLayerIndex: number,
) {
  const mapentry = maps.value[mllidx];
  const map = mapentry.map;
  // adjust number of tile layers
  while (
    mapentry.imageLayers.length > mll.length * 2 ||
    (mapentry.baseLayerIndex !== baseLayerIndex && mapentry.imageLayers.length)
  ) {
    map.deleteLayer(mapentry.imageLayers.pop()!);
  }
  mapentry.baseLayerIndex = baseLayerIndex;
  while (mapentry.imageLayers.length < mll.length * 2) {
    mapentry.params.layer.tilesAtZoom = (level: number) => {
      const s = Math.pow(2, someImage.levels - 1 - level);
      const result = {
        x: Math.ceil(someImage.sizeX / s / someImage.tileWidth) * unrollW.value,
        y:
          Math.ceil(someImage.sizeY / s / someImage.tileHeight) * unrollH.value,
      };
      return result;
    };
    const currentImageLayers = maps.value.reduce(
      (acc, entry) => acc + (entry.imageLayers || []).length,
      0,
    );
    if (currentImageLayers + maps.value.length >= 11) {
      mapentry.params.layer.renderer = "canvas";
    } else {
      delete mapentry.params.layer.renderer;
    }
    if (mapentry.imageLayers.length) {
      mapentry.params.layer.queue = mapentry.imageLayers[0].queue;
    }
    const newMap = markRaw(map.createLayer("osm", mapentry.params.layer));
    newMap.node().css({ "mix-blend-mode": compositionMode.value });
    mapentry.imageLayers.push(newMap);
    let layer = mapentry.imageLayers[mapentry.imageLayers.length - 1];
    if (mapentry.imageLayers.length & 1) {
      const index = (mapentry.imageLayers.length - 1) / 2;
      layer.node().css("filter", `url(#recolor-${index + baseLayerIndex})`);
    }
    layer.url((x: number, y: number, level: number) => {
      const s = Math.pow(2, someImage.levels - 1 - level);
      const txy = {
        x: Math.ceil(someImage.sizeX / s / someImage.tileWidth),
        y: Math.ceil(someImage.sizeY / s / someImage.tileHeight),
      };
      const imageNum =
        Math.floor(x / txy.x) + Math.floor(y / txy.y) * unrollW.value;
      const url = layer._imageUrls?.[imageNum];
      if (!url) {
        return blankUrl;
      }
      const tx = x % txy.x;
      const ty = y % txy.y;
      const result = url
        .replace("{z}", level.toString())
        .replace("{x}", tx.toString())
        .replace("{y}", ty.toString());
      return result;
    });
    layer._tileBounds = (tile: IGeoJSTile) => {
      const s = Math.pow(
        2,
        someImage.levels - 1 - Math.max(tile.index.level || 0, 0),
      );
      const w = Math.ceil(someImage.sizeX / s),
        h = Math.ceil(someImage.sizeY / s);
      const txy = {
        x: Math.ceil(someImage.sizeX / s / someImage.tileWidth),
        y: Math.ceil(someImage.sizeY / s / someImage.tileHeight),
      };
      const imagexy = {
        x: Math.floor(tile.index.x / txy.x),
        y: Math.floor(tile.index.y / txy.y),
      };
      const tilexy = {
        x: tile.index.x % txy.x,
        y: tile.index.y % txy.y,
      };
      const result = {
        left: tilexy.x * tile.size.x + w * imagexy.x,
        top: tilexy.y * tile.size.y + h * imagexy.y,
        right: Math.min((tilexy.x + 1) * tile.size.x, w) + w * imagexy.x,
        bottom: Math.min((tilexy.y + 1) * tile.size.y, h) + h * imagexy.y,
      };
      return result;
    };
    layer.tileAtPoint = (point: IGeoJSPoint2D, level: number) => {
      point = layer.displayToLevel(
        layer.map().gcsToDisplay(point, null),
        someImage.levels - 1,
      );
      const s = Math.pow(2, someImage.levels - 1 - level);
      const x = point.x,
        y = point.y;
      const txy = {
        x: Math.ceil(someImage.sizeX / s / someImage.tileWidth),
        y: Math.ceil(someImage.sizeY / s / someImage.tileHeight),
      };
      const result = {
        x:
          Math.floor(x / someImage.sizeX) * txy.x +
          Math.floor(
            (x - Math.floor(x / someImage.sizeX) * someImage.sizeX) /
              someImage.tileWidth /
              s,
          ),
        y:
          Math.floor(y / someImage.sizeY) * txy.y +
          Math.floor(
            (y - Math.floor(y / someImage.sizeY) * someImage.sizeY) /
              someImage.tileHeight /
              s,
          ),
      };
      return result;
    };
  }
}

const pendingHistogramFetches = new Set<string>();

// Kick off a histogram fetch for a layer whose tiles can't render yet. We
// don't schedule a draw here: when the fetch resolves, GirderAPI bumps
// `histogramsLoaded`, which invalidates `layerStackImages` and fires the
// `watch(mapLayerList)` redraw. Dedupe by `layer.id` so repeated calls (and
// promise replacements inside `nextHistogram`) don't pile on .then handlers.
function requestLayerHistogram(layer: ILayerStackImage["layer"]) {
  if (pendingHistogramFetches.has(layer.id)) {
    return;
  }
  pendingHistogramFetches.add(layer.id);
  store.getLayerHistogram(layer).then(
    () => {
      pendingHistogramFetches.delete(layer.id);
    },
    (err) => {
      pendingHistogramFetches.delete(layer.id);
      logWarning("Layer histogram fetch failed", err);
    },
  );
}

/**
 * Set tile urls for all tile layers.
 */
function _setTileUrls(
  mll: ILayerStackImage[],
  mllidx: number,
  someImage: IImage,
  baseLayerIndex: number,
) {
  const mapentry = maps.value[mllidx];
  mll.forEach(
    (
      { layer, images, urls, fullUrls, hist, singleFrame, baseQuadOptions },
      layerIndex: number,
    ) => {
      const fullLayer = mapentry.imageLayers[layerIndex * 2];
      const adjLayer = mapentry.imageLayers[layerIndex * 2 + 1];
      mapentry.lowestLayer = baseLayerIndex;
      layerIndex += baseLayerIndex;
      fullLayer.node().css("filter", `url(#recolor-${layerIndex})`);
      adjLayer.node().css("filter", "none");
      if (!fullUrls[0] || !urls[0] || !baseQuadOptions) {
        if (!hist && images.length) {
          requestLayerHistogram(layer);
        }
        if (singleFrame !== null && fullLayer.setFrameQuad) {
          fullLayer.setFrameQuad(singleFrame);
          fullLayer.visible(true);
          fullLayer
            .node()
            .css("visibility", layer.visible ? "visible" : "hidden");
          adjLayer.node().css("visibility", "hidden");
        } else {
          fullLayer.visible(false);
        }
        adjLayer.visible(false);
        adjLayer.node().css("visibility", "hidden");
        return;
      }
      generateFilterURL(layerIndex, layer.contrast, layer.color, hist);
      fullLayer.visible(true);
      adjLayer.visible(true);
      // use css visibility so that geojs will still load tiles when not
      // visible.
      const layerImageUrls = fullLayer._imageUrls;
      if (
        !layerImageUrls ||
        fullUrls.length !== layerImageUrls.length ||
        fullUrls.some((url, idx) => url !== layerImageUrls[idx])
      ) {
        fullLayer._imageUrls = fullUrls;
        fullLayer.reset();
        // or max-merge
        if (fullUrls.length !== 1 || singleFrame === null) {
          fullLayer.baseQuad = null;
        } else {
          if (!fullLayer.setFrameQuad) {
            const progessObject = { progress: 0, total: 0 };
            setFrameQuad(someImage.tileinfo, fullLayer, baseQuadOptions, {
              progress: (status: ISetQuadStatus) => {
                progessObject.progress = status.loadedCount;
                progessObject.total = status.totalToLoad;
              },
            });
          }
          fullLayer.setFrameQuad!(singleFrame);
        }
      }
      const adjImageUrls = adjLayer._imageUrls;
      if (
        !adjImageUrls ||
        urls.length !== adjImageUrls.length ||
        urls.some((url, idx) => url !== adjImageUrls[idx])
      ) {
        adjLayer._imageUrls = urls;
        adjLayer.reset();
        adjLayer.map().draw();
        adjLayer.onIdle(() => {
          if (
            fullUrls.every((url, idx) => url === fullLayer._imageUrls?.[idx]) &&
            urls.every((url, idx) => url === adjLayer._imageUrls?.[idx])
          ) {
            fullLayer.node().css("visibility", "hidden");
            adjLayer
              .node()
              .css("visibility", layer.visible ? "visible" : "hidden");
          }
        });
      }
      const idle = adjLayer.idle;
      fullLayer
        .node()
        .css("visibility", !idle && layer.visible ? "visible" : "hidden");
      adjLayer
        .node()
        .css("visibility", idle && layer.visible ? "visible" : "hidden");
    },
  );
}

function draw() {
  // Prevent drawing during dataset transitions to avoid stale tile display.
  // When configuration loads before dataset, layerStackImages can generate
  // tile URLs pointing to the old dataset's images.
  if (sync.datasetLoading) {
    maps.value.forEach((mapentry) => {
      mapentry.imageLayers.forEach((layer) => {
        layer.node().css("visibility", "hidden");
      });
    });
    // The labels describe the grid that is being replaced, so drop them with
    // the tiles rather than leaving them over the loading overlay.
    clearUnrollLabels();
    return;
  }
  if ((width.value == height.value && width.value == 1) || !dataset.value) {
    return;
  }
  if (!layerStackImages.value.length) {
    return;
  }
  const someImages = layerStackImages.value.find((lsi) => lsi.images[0]);
  if (!someImages) {
    return;
  }
  const someImage = someImages.images[0];
  // Shared with `store.unrollGrid`, which navigation uses to find where an
  // annotation is drawn — same inputs, same helper, so the camera and the tiles
  // cannot disagree about the grid (issue #1280).
  const grid = unrollGridSize(
    someImages.images.length,
    someImage.sizeX,
    someImage.sizeY,
  );
  unrollW.value = grid.unrollW;
  unrollH.value = grid.unrollH;
  tileWidth.value = someImage.tileWidth;
  tileHeight.value = someImage.tileHeight;

  const currentMapLayerList = mapLayerList.value;
  while (maps.value.length > currentMapLayerList.length) {
    maps.value.at(-1)?.map.exit();
    store.popMap();
  }
  let baseLayerIndex = 0;
  const currentResetMaps = resetMapsOnDraw.value;
  resetMapsOnDraw.value = false;
  currentMapLayerList.forEach((mll, mllidx) => {
    _setupMap(mllidx, someImage, currentResetMaps);
    const mapentry = maps.value[mllidx];
    if (!mapentry) {
      return;
    }
    const map = mapentry.map;
    const mapnode = map.node();
    const nodeWidth = mapnode.width();
    const nodeHeight = mapnode.height();
    if (
      nodeWidth &&
      nodeHeight &&
      (nodeWidth != map.size().width || nodeHeight != map.size().height)
    ) {
      map.size({ width: nodeWidth, height: nodeHeight });
    }
    _setupTileLayers(mll, mllidx, someImage, baseLayerIndex);
    const overviewOffset = mapentry.annotationOverviewLayer ? 1 : 0;
    if (
      (mapentry.annotationOverviewLayer &&
        mapentry.annotationOverviewLayer.zIndex() !== mll.length * 2) ||
      mapentry.workerPreviewLayer.zIndex() !==
        mll.length * 2 + overviewOffset ||
      mapentry.annotationLayer.zIndex() !==
        mll.length * 2 + 1 + overviewOffset ||
      mapentry.textLayer.zIndex() !== mll.length * 2 + 2 + overviewOffset ||
      mapentry.timelapseLayer.zIndex() !==
        mll.length * 2 + 3 + overviewOffset ||
      mapentry.timelapseTextLayer.zIndex() !==
        mll.length * 2 + 4 + overviewOffset ||
      mapentry.interactionLayer.zIndex() !==
        mll.length * 2 + 5 + overviewOffset ||
      (mapentry.uiLayer &&
        mapentry.uiLayer.zIndex() !== mll.length * 2 + 6 + overviewOffset)
    ) {
      if (mapentry.annotationOverviewLayer) {
        mapentry.annotationOverviewLayer.moveToTop();
      }
      mapentry.workerPreviewLayer.moveToTop();
      mapentry.annotationLayer.moveToTop();
      mapentry.textLayer.moveToTop();
      mapentry.timelapseLayer.moveToTop();
      mapentry.timelapseTextLayer.moveToTop();
      mapentry.interactionLayer.moveToTop();
      if (mapentry.uiLayer) {
        mapentry.uiLayer.moveToTop();
      }
    }
    _setTileUrls(mll, mllidx, someImage, baseLayerIndex);
    baseLayerIndex += mll.length;
    map.draw();
  });

  updateUnrollLabels();

  // Track progress of layers.
  // Two-pass approach: first build the array and assign the ref, THEN register
  // onIdle callbacks. GeoJS fires onIdle synchronously when a layer is already
  // idle (e.g. tiles cached from a previous mode). If we register callbacks
  // before assigning readyLayers.value, the callbacks splice the old array and
  // the subsequent assignment overwrites the ref with all-false entries,
  // leaving the progress bar stuck.
  const localReadyLayers: boolean[] = [];
  const layerPairs: {
    fullLayer: any;
    adjLayer: any;
    capturedIdx: number;
  }[] = [];
  let readyLayersIdx = 0;
  for (let mllidx = 0; mllidx < currentMapLayerList.length; ++mllidx) {
    const mapentry = maps.value[mllidx];
    if (!mapentry) {
      continue;
    }
    for (
      let layerIdx = 0;
      layerIdx < currentMapLayerList[mllidx].length;
      ++layerIdx
    ) {
      const capturedIdx = readyLayersIdx++;
      const fullLayer = mapentry.imageLayers[2 * layerIdx];
      const adjLayer = mapentry.imageLayers[2 * layerIdx + 1];
      localReadyLayers[capturedIdx] = false;
      layerPairs.push({ fullLayer, adjLayer, capturedIdx });
    }
  }
  // Assign BEFORE registering callbacks so synchronous onIdle splices the
  // correct array.
  readyLayers.value = localReadyLayers;
  for (const { fullLayer, adjLayer, capturedIdx } of layerPairs) {
    const setReady = () => {
      if (fullLayer.idle && adjLayer.idle) {
        readyLayers.value.splice(capturedIdx, 1, true);
      }
    };
    fullLayer.onIdle(setReady);
    adjLayer.onIdle(setReady);
  }
}

function toggleViewLock() {
  isViewLocked.value = !isViewLocked.value;

  maps.value.forEach((mapentry) => {
    const interactor = mapentry.map.interactor();

    if (isViewLocked.value) {
      // Store the current actions before clearing them
      if (!defaultActions.value) {
        defaultActions.value = interactor.options().actions;
      }
      // Clear all actions to disable all navigation interactions
      interactor.options({
        actions: [],
      });
    } else {
      // Restore the default actions to reenable all navigation interactions
      interactor.options({
        actions: defaultActions.value,
      });
    }
  });
}

// The SAM annotation tool and the unified object-segmentation tool are both
// fed the current map through an input node named `geoJSMap` (samPipeline.ts /
// objectSegmentationPipeline.ts). Factored into one type guard so the
// map-feeding watcher below doesn't need to duplicate itself per tool type.
function hasGeoJSMapInput(
  toolState: TToolState | null | undefined,
): toolState is ISamAnnotationToolState | IObjectSegmentationToolState {
  return (
    toolState?.type === SamAnnotationToolStateSymbol ||
    toolState?.type === ObjectSegmentationToolStateSymbol
  );
}

// ---- Watchers ----

watch(
  () => props.shouldResetMaps,
  (newValue) => {
    if (newValue) {
      resetMapsOnDraw.value = true;
      draw();
      emit("reset-complete");
    }
  },
);

watch(selectedToolType, () => {
  showSamToolHelpAlert.value =
    selectedToolType.value === SamAnnotationToolStateSymbol;
});

watch([readyLayersCount, readyLayersTotal], () => {
  progressStore.updateReactiveProgress({
    type: ProgressType.LAYER_CACHE,
    progress: readyLayersCount.value,
    total: readyLayersTotal.value,
    title: "Preparing layers",
  });
});

// Emit once each time the layers finish loading (false -> true transition,
// and only when there is at least one layer — layersReady is trivially true
// with zero layers). Consumers use this to act on a fully rendered image
// (e.g. the tool-suggestion screenshot).
watch(layersReady, (ready, wasReady) => {
  if (ready && !wasReady && readyLayersTotal.value > 0) {
    emit("layers-ready");
  }
});

watch(mouseMap, () => {
  if (mouseMap.value) {
    samMapEntry.value = mouseMap.value;
  }
});

watch(maps, () => {
  samMapEntry.value = maps.value[0] ?? null;
});

watch([samMapEntry, layersReady, cameraInfo, selectedTool], () => {
  const toolState = selectedTool.value?.state;
  if (hasGeoJSMapInput(toolState) && layersReady.value) {
    toolState.nodes.input.geoJSMap.setValue(samMapEntry.value ?? NoOutput);
  }
});

watch(cameraInfo, applyCameraInfo);

watch(compositionMode, updateCompositionMode);

watch(backgroundColor, updateBackgroundColor);

watch(
  () => sync.datasetLoading,
  (loading) => {
    if (loading) {
      // Immediately hide old tiles when dataset transition starts
      maps.value.forEach((mapentry) => {
        mapentry.imageLayers.forEach((layer) => {
          layer.node().css("visibility", "hidden");
        });
      });
      clearUnrollLabels();
    } else {
      draw();
    }
  },
);

// Draw on every mapLayerList change. nextTick lets the v-for over
// mapLayerList settle so getMapRefSetter has populated mapRefs before draw()
// reads them. draw() itself is fast (~1-2ms) because the fullLayer
// setFrameQuad path swaps a pre-loaded quad texture instead of re-fetching
// tiles, so debouncing here would just drop intermediate frames and make
// scrubbing feel skippy.
watch(mapLayerList, () => {
  nextTick(() => {
    if (!refsMounted.value) {
      return;
    }
    draw();
  });
});

watch([showScalebar, pixelSize], updateScaleWidget);

watch([showPixelScalebar, pixelSize], updateScalePixelWidget);

// Rebuild the labels whenever what they should say changes. Watching the cells
// rather than draw() matters for the inputs that never trigger a redraw — the
// "Show XY / Z / Time labels" viewer settings, which only change label text.
// Redundant calls are cheap: updateUnrollLabels no-ops on an unchanged
// signature.
watch(unrollCellsByMap, () => updateUnrollLabels());

watch(dataset, () => {
  resetMapsOnDraw.value = true;
  datasetReset();
});

// Frame changes already redraw through mapLayerList. Overview-only settings
// and client mutation versions do not, so explicitly refresh the lazy raster
// layer for those two inputs.
watch(
  [() => annotationStore.overviewConfig, () => annotationStore.mutationCounter],
  ([config], [previousConfig]) => {
    // Annotation edits can be frequent. When overview has never been enabled,
    // its cache-buster must remain truly zero-cost instead of redrawing every
    // image layer for a raster layer that does not exist. The previous value
    // keeps the disabling transition able to hide an existing layer.
    if (config.enabled || previousConfig?.enabled) {
      draw();
    }
  },
);

// Fit the image to the viewport on dataset load / transition so each dataset
// opens at a sensible zoom (Phase 2.3 unclamped clampZoom, removing GeoJS's
// auto-fit safety net). `_setupMap` bumps `fitOnDatasetChange` after it has
// (re)configured the primary map for a NEW dataset ID, and this watcher then
// calls `map.bounds(maxBounds)` — equivalent to clicking the canvas
// reset-view button. Driven by an actual signal instead of polling.
watch(fitOnDatasetChange, () => {
  const map = maps.value[0]?.map;
  if (!map) {
    return;
  }
  map.bounds(map.maxBounds(undefined, null), null);
});

// ---- Lifecycle ----

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  refsMounted.value = true;
  datasetReset();
  updateBackgroundColor();
  draw();
  // Trigger mapsChanged logic
  samMapEntry.value = maps.value[0] ?? null;

  // Watch for container resizes (e.g. navigation drawer open/close)
  // and update GeoJS map sizes accordingly
  if (mapLayout.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      for (const mapentry of maps.value) {
        const map = mapentry.map;
        const mapnode = map.node();
        const nodeWidth = mapnode.width();
        const nodeHeight = mapnode.height();
        if (
          nodeWidth &&
          nodeHeight &&
          (nodeWidth !== map.size().width || nodeHeight !== map.size().height)
        ) {
          map.size({ width: nodeWidth, height: nodeHeight });
        }
      }
    });
    resizeObserver.observe(mapLayout.value);
  }
});

onBeforeUnmount(() => {
  annotationStore.setVisibilitySuppressed(false);
  for (const layer of trackedAnnotationOverviewLayers) {
    cancelAnnotationOverviewLoad(layer);
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (maps.value) {
    maps.value.forEach((mapentry) => mapentry.map.exit());
    store.clearMaps();
  }
});

// ---- Expose ----

defineExpose({
  store,
  annotationStore,
  girderResources,
  sync,
  hasGeoJSMapInput,
  maps,
  annotationViewerMaps,
  allAnnotationOverviewViewersRasterActive,
  cameraInfo,
  overview,
  dataset,
  unrolling,
  width,
  height,
  compositionMode,
  backgroundColor,
  pixelSize,
  showScalebar,
  showPixelScalebar,
  scalebarColor,
  selectedTool,
  layerStackImages,
  submitPendingAnnotation,
  selectedToolType,
  readyLayersCount,
  readyLayersTotal,
  layersReady,
  mouseMap,
  mapLayerList,
  unrollCellsByMap,
  mousetrapAnnotations,
  refsMounted,
  readyLayers,
  resetMapsOnDraw,
  isViewLocked,
  scaleDialog,
  defaultActions,
  tileWidth,
  tileHeight,
  unrollW,
  unrollH,
  mapSynchronizationCallbacks,
  get scaleWidget() {
    return scaleWidget;
  },
  set scaleWidget(v) {
    scaleWidget = v;
  },
  get scalePixelWidget() {
    return scalePixelWidget;
  },
  set scalePixelWidget(v) {
    scalePixelWidget = v;
  },
  showSamToolHelpAlert,
  samToolActive,
  samLoadingMessages,
  samMapEntry,
  mouseState,
  get synchronisationEnabled() {
    return synchronisationEnabled;
  },
  set synchronisationEnabled(v) {
    synchronisationEnabled = v;
  },
  blankUrl,
  mouseDown,
  mouseLeave,
  mouseMove,
  mouseUp,
  setCenter,
  resetRotation,
  resetView,
  setCorners,
  draw,
  toggleViewLock,
  navigateToUnrolledCell,
  updateUnrollLabels,
  clearUnrollLabels,
  _setupMap,
  _setupTileLayers,
  _setTileUrls,
  _syncAnnotationOverviewLayer,
  _setAnnotationOverviewVisibility,
});
</script>

<style lang="scss">
.progress .v-progress-linear__content {
  position: relative;
}

.geojs-scale-widget-bar {
  stroke: var(--scale-bar-color) !important;
}

.geojs-scale-widget-text {
  fill: var(--scale-bar-color);
}

.scale-widget {
  overflow: visible;
}

.scale-widget:hover {
  cursor: pointer;
}

/* Frame labels on the unrolled grid. GeoJS positions the element at its cell's
   upper-left corner; the translate insets it into the cell. Unscoped because
   the element is created by GeoJS, not rendered by this component. */
.unroll-frame-label {
  appearance: none;
  transform: translate(5px, 5px);
  border: 0;
  padding: 0 6px;
  border-radius: 3px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font:
    500 12px/1.7 "Helvetica Neue",
    Arial,
    Helvetica,
    sans-serif;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
}

.unroll-frame-label:hover {
  background: rgb(0 0 0 / 85%);
  box-shadow: 0 0 0 1px rgb(255 255 255 / 65%);
}

.unroll-frame-label:focus-visible {
  background: rgb(0 0 0 / 85%);
  outline: 2px solid #fff;
  outline-offset: 1px;
}
</style>

<style lang="scss" scoped>
.image {
  position: relative;
  overflow: hidden;
}
.progress {
  color: white;
  font-size: 12px;
  margin-bottom: 2px;
  width: 200px;
  z-index: 200;
}
.sam-status-area {
  position: absolute;
  // Top-center, below the app bar / mode button group, matching the
  // notification toasts (ProgressBarGroup). Previously top:4px left:160px,
  // which tucked the help banner + "Encoding" spinner under the fixed toolbar
  // (higher z-index) and the left NAVIGATOR / LAYERS / TOOLS panel stack.
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  pointer-events: none;
}
.sam-help-banner {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: auto;
}
.sam-help-label {
  font-weight: 700;
  color: rgb(var(--v-theme-primary));
  margin-right: 10px;
  white-space: nowrap;
}
.sam-help-text {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sam-help-sep {
  opacity: 0.35;
  margin: 0 2px;
}
.sam-help-close {
  margin-left: 10px;
  font-size: 16px;
  line-height: 1;
  opacity: 0.6;
  cursor: pointer;
  background: none;
  border: none;
  color: white;
  padding: 0 2px;
}
.sam-help-close:hover {
  opacity: 1;
}
.sam-loading-overlay {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  width: fit-content;
}
.sam-loading-messages {
  display: flex;
  gap: 6px;
}
.bottom-right-container {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 200;
}
.map-layout {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  line-height: 0;
}
.geojs-map {
  width: 100%;
  height: 100%;
}
.map-layout[map-count="2"] .geojs-map {
  width: 50%;
  height: 100%;
  display: inline-block;
}
.map-layout[map-count="3"] .geojs-map,
.map-layout[map-count="4"] .geojs-map {
  width: 50%;
  height: 50%;
  display: inline-block;
}
.map-layout[map-count="5"] .geojs-map,
.map-layout[map-count="6"] .geojs-map {
  width: 33%;
  height: 50%;
  display: inline-block;
}
.map-layout[map-count="7"] .geojs-map,
.map-layout[map-count="8"] .geojs-map,
.map-layout[map-count="9"] .geojs-map {
  width: 33%;
  height: 33%;
  display: inline-block;
}
.map-layout[map-count="10"] .geojs-map,
.map-layout[map-count="11"] .geojs-map,
.map-layout[map-count="12"] .geojs-map {
  width: 25%;
  height: 33%;
  display: inline-block;
}
.map-layout[map-count="13"] .geojs-map,
.map-layout[map-count="14"] .geojs-map,
.map-layout[map-count="15"] .geojs-map,
.map-layout[map-count="16"] .geojs-map {
  width: 25%;
  height: 25%;
  display: inline-block;
}
.layer-info-btn {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 1000;
}
/* The bottom-left cluster slides right of the open left-palette column so it
   isn't covered. Shift = clear-x minus the leftmost button's base `left`
   (10 px), driven by `--nimbus-left-palette-clear-x` in style.scss so the
   gap stays in sync with the bulk-action panel. */
.left-palettes-open .layer-info-btn,
.left-palettes-open .lock-view-btn,
.left-palettes-open .reset-view-btn,
.left-palettes-open .reset-rotation-btn {
  transform: translateX(calc(var(--nimbus-left-palette-clear-x) - 10px));
}
.layer-info-container {
  position: absolute;
  left: 10px;
  bottom: 40px;
  z-index: 1000;
  max-height: calc(100% - 70px);
  max-width: stretch;
  margin: 16px;
  overflow-y: auto;
  background-color: rgba(0, 0, 0, 0.7);
  border-radius: 4px;
}
.lock-view-btn {
  position: absolute;
  left: 52px;
  bottom: 10px;
  z-index: 1001;
}
.reset-view-btn {
  position: absolute;
  left: 94px;
  bottom: 10px;
  z-index: 1001;
}
.reset-rotation-btn {
  position: absolute;
  left: 136px;
  bottom: 10px;
  z-index: 1001;
}
/* Smoothly slide the cluster when the left palettes open/close. */
.layer-info-btn,
.lock-view-btn,
.reset-view-btn,
.reset-rotation-btn {
  transition: transform 0.2s ease;
}
</style>
