<template>
  <div>
    <annotation-context-menu
      :show="showContextMenu"
      :x="contextMenuX"
      :y="contextMenuY"
      :annotation="rightClickedAnnotation"
      @save="handleContextMenuSave"
      @cancel="handleContextMenuCancel"
    />
    <annotation-action-panel
      v-if="selectedAnnotationIds.size > 0"
      :selected-count="selectedAnnotationIds.size"
      @delete-selected="annotationStore.deleteSelectedAnnotations"
      @delete-unselected="annotationStore.deleteUnselectedAnnotations"
      @tag-selected="showTagDialog = true"
      @color-selected="showColorDialog = true"
      @deselect-all="handleDeselectAll"
    />

    <tag-selection-dialog
      v-model:show="showTagDialog"
      @submit="handleTagSubmit"
    />

    <color-selection-dialog
      v-model:show="showColorDialog"
      @submit="handleColorSubmit"
    />

    <v-snackbar
      v-model="geometryNotLoadedSnackbar"
      :timeout="4000"
      color="info"
    >
      {{ GEOMETRY_NOT_LOADED_MESSAGE }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
  markRaw,
} from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import connectionListStore from "@/store/connectionList";
import timelapseStore from "@/store/timelapse";
import propertiesStore from "@/store/properties";
import filterStore from "@/store/filters";
import lineScanStore from "@/store/lineScan";

import geojs from "geojs";
import { snapCoordinates } from "@/utils/itk";

import { throttle, debounce } from "lodash";
const THROTTLE = 100;

// Highlight for the connection selected in the Connections tab / by clicking a
// line. Bright and distinct from both the per-track colors (hash-derived) and
// the red time-jump lines, so a selected link reads at a glance.
const CONNECTION_SELECTED_COLOR = "#00e5ff";
// Deliberately the same cyan: inside timelapse mode a selected dot and a
// selected track segment must read as one state, not two.
const TIMELAPSE_POINT_SELECTED_COLOR = CONNECTION_SELECTED_COLOR;

// The unselected appearance of a normal-mode connection line. These values
// reproduce GeoJS's own line-annotation defaults (blue, width 3), which is what
// connections rendered with before they became restyleable — so restyling an
// untouched line is a visual no-op.
// `stroke: true` is mandatory here. GeoJS supplies it via its own annotation
// defaults, but assigning `options("style", …)` REPLACES the style object
// rather than merging, so a style that omits it produces a line that is present
// in layer.annotations(), correctly positioned, and completely unpainted.
const CONNECTION_BASE_STYLE = {
  stroke: true,
  strokeColor: "#0000ff",
  strokeWidth: 3,
  strokeOpacity: 1,
};

// Incremental draw (clearOldAnnotations): GeoJS removeAnnotation is ~O(n) per
// call, so when more than this fraction of drawn features must be removed (e.g. a
// frame change, where the whole set turns over) a single bulk removeAllAnnotations
// is cheaper than N individual removals. Below it (the common pan/zoom case, where
// the visible set is largely stable) we keep survivors and remove only the rest.
const INCREMENTAL_BULK_CLEAR_FRACTION = 0.5;

import {
  AnnotationSelectionTypes,
  AnnotationShape,
  IAnnotation,
  ITimelapseAnnotation,
  IAnnotationConnection,
  IDisplayLayer,
  IGeoJSAnnotation,
  IGeoJSAnnotationLayer,
  IGeoJSFeature,
  IGeoJSFeatureLayer,
  IGeoJSLineFeatureStyle,
  IGeoJSMap,
  IGeoJSOsmLayer,
  IGeoJSPosition,
  IGeoJSPointFeatureStyle,
  IGeoJSPolygonFeatureStyle,
  IMapEntry,
  IMouseState,
  IRestrictTagsAndLayer,
  IROIAnnotationFilter,
  ISamAnnotationToolState,
  IToolConfiguration,
  SamAnnotationToolStateSymbol,
  TSamPrompt,
  TToolState,
  ConnectionToolStateSymbol,
  CombineToolStateSymbol,
  IGeoJSMouseState,
  TrackPositionType,
  ObjectSegmentationToolStateSymbol,
  IObjectSegmentationToolState,
  IObjectSegmentationExample,
  PromptType,
} from "../store/model";
import type { TAnnotationOrStub, IAnnotationStub } from "@/store/model";
import { isHydratedAnnotation } from "@/store/model";

import { logError, logWarning } from "@/utils/log";

import {
  pointDistance,
  getAnnotationStyleFromBaseStyle,
  geojsAnnotationFactory,
  tagFilterFunction,
  ellipseToPolygonCoordinates,
  getStubStyleFromBaseStyle,
  drawnFeatureUsesDotStyle,
  drawnFeatureUnchanged,
  geometryKeyForRender,
  shouldRetainFeature,
} from "@/utils/annotation";
import {
  IUnrollLayout,
  unrollLayoutFor,
  unrolledCoordinates,
} from "@/utils/unroll";
import { annotationSpatialIndex } from "@/utils/spatialIndex";
import {
  TRACK_UNIFORM_COLOR,
  findConnectedComponents,
  trackColor,
  trackKeyFromIndex,
} from "@/utils/connections";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import {
  mouseStateToSamPrompt,
  samPromptToAnnotation,
} from "@/pipelines/samPipeline";
import { NoOutput, readManualInputOr } from "@/pipelines/computePipeline";

import AnnotationContextMenu from "@/components/AnnotationContextMenu.vue";
import AnnotationActionPanel from "@/components/AnnotationActionPanel.vue";
import TagSelectionDialog from "@/components/TagSelectionDialog.vue";
import ColorSelectionDialog from "@/components/ColorSelectionDialog.vue";

import { editPolygonAnnotation as editPolygonAnnotationUtil } from "@/utils/polygonSlice";
import { stubPerf } from "@/utils/stubPerf";
import { visibilityBudgetForZoom } from "@/utils/visibilityBudget";
import { cameraRefreshNeeded } from "@/utils/camera";
import {
  annotationMatchesRasterSelector,
  annotationMatchesRasterSelectors,
  annotationOverviewRasterActive,
  annotationRasterSelectorForLayer,
  annotationRasterSelectorsForLayers,
  annotationRasterSelectorsSupported,
  stableRandomSampleById,
} from "@/utils/annotationOverview";
import RBush from "rbush";

// Module-level helpers

interface AnnotationBBoxItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  annotationId: string;
}

function buildAnnotationBBox(
  annotation: TAnnotationOrStub,
): AnnotationBBoxItem {
  if (isHydratedAnnotation(annotation)) {
    const coords = annotation.coordinates;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
    return { minX, minY, maxX, maxY, annotationId: annotation.id };
  }
  // Stub: use centroid as degenerate bbox
  const { x, y } = annotation.centroid;
  return { minX: x, minY: y, maxX: x, maxY: y, annotationId: annotation.id };
}

function filterAnnotations<T extends TAnnotationOrStub>(
  annotations: T[],
  { tags, tagsInclusive, layerId }: IRestrictTagsAndLayer,
): T[] {
  // Reads only tags/channel, which both full annotations and stubs carry, so
  // it is safe over TAnnotationOrStub and preserves the input element type.
  let output = annotations.filter((annotation) =>
    tagFilterFunction(annotation.tags, tags, !tagsInclusive),
  );
  // layerId === null <==> any layer
  if (layerId !== null) {
    const layer = store.getLayerFromId(layerId);
    if (layer) {
      const parentChannel = layer.channel;
      output = output.filter(
        (annotation) => annotation.channel === parentChannel,
      );
    }
  }
  return output;
}

// ---- Props ----

const props = withDefaults(
  defineProps<{
    map: IGeoJSMap;
    capturedMouseState: IMouseState | null;
    annotationLayer: IGeoJSAnnotationLayer;
    textLayer: IGeoJSFeatureLayer;
    workerPreviewFeature: IGeoJSFeature;
    timelapseLayer: IGeoJSAnnotationLayer;
    timelapseTextLayer: IGeoJSFeatureLayer;
    interactionLayer: IGeoJSAnnotationLayer;
    annotationOverviewLayer?: IGeoJSOsmLayer;
    unrollH: number;
    unrollW: number;
    maps: IMapEntry[];
    tileWidth: number;
    tileHeight: number;
    lowestLayer: number;
    layerCount: number;
    allowSharedVisibilitySuppression?: boolean;
  }>(),
  { maps: () => [], allowSharedVisibilitySuppression: true },
);
const emit = defineEmits<{
  (
    event: "annotation-overview-visibility-change",
    state: { visible: boolean; opacity: number },
  ): void;
}>();

// ---- Refs (data fields) ----

const isDragging = ref(false);
const rasterActive = ref(false);
const dragStartPosition = ref<IGeoJSPosition | null>(null);
const draggedAnnotation = ref<IAnnotation | null>(null);
// IGeoJSAnnotation instances are heavy native objects whose internals must
// not be Proxy-wrapped — shallowRef tracks identity (so swap/clear
// triggers reactivity) but skips deep-walking the object graph.
const dragGhostAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
const pendingAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
const selectionAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
const samPromptAnnotations = shallowRef<IGeoJSAnnotation[]>([]);
const samUnsubmittedAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
const samLivePreviewAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
// Unified "Segment similar objects" tool: resolved example outlines and
// putative proposal polygons, drawn the same way as SAM's prompt/output
// annotations above.
const objectSegmentationExampleAnnotations = shallowRef<IGeoJSAnnotation[]>([]);
const objectSegmentationProposalAnnotations = shallowRef<IGeoJSAnnotation[]>(
  [],
);
// Hover live-preview outline (SAM selection modes), rendered the same way as
// SAM's own samLivePreviewAnnotation above.
const objectSegmentationLivePreviewAnnotation =
  shallowRef<IGeoJSAnnotation | null>(null);
const cursorAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
// Line displayed on the interaction layer for the linescan tool (segment
// preview and completed scans)
const lineScanAnnotation = shallowRef<IGeoJSAnnotation | null>(null);
// First click of a segment linescan, waiting for the second click
const lineScanSegmentStart = ref<IGeoJSPosition | null>(null);
// Interaction layer option value to restore when the freehand linescan tool
// releases its continuousCloseProximity override (null = no override active)
const lineScanSavedCloseProximity = ref<number | boolean | null>(null);
// Plain coordinate array, fully replaced on each set — shallowRef purely
// because nothing reads its inner mutations, not because it's heavy.
const dragOriginalCoordinates = shallowRef<IGeoJSPosition[] | null>(null);
const lastCursorPosition = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const handlingPrimaryChange = ref(false);
const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);
const rightClickedAnnotation = ref<IAnnotation | null>(null);
const showTagDialog = ref(false);
const showColorDialog = ref(false);

// Toast shown when a geometry edit/combine targets a stub whose full
// coordinates aren't loaded yet (stub-only mode); the op is skipped rather than
// silently no-op'ing or failing.
const geometryNotLoadedSnackbar = ref(false);
const GEOMETRY_NOT_LOADED_MESSAGE =
  "Annotation not fully loaded — zoom in to fully load it, then try again.";

function notifyGeometryNotLoaded() {
  geometryNotLoadedSnackbar.value = true;
}

// ---- Computed properties ----

// Simple store proxies
const annotationSelectionType = computed(() => store.annotationSelectionType);
const roiFilter = computed(() => filterStore.emptyROIFilter);
const enabledRoiFilters = computed(() =>
  filterStore.roiFilters.filter(
    (filter: IROIAnnotationFilter) => filter.enabled,
  ),
);
const displayWorkerPreview = computed(
  () => propertiesStore.displayWorkerPreview,
);
const configuration = computed(() => store.configuration);
const layers = computed(() => store.layers);
const filteredAnnotations = computed(() => filterStore.filteredAnnotations);
const annotationConnections = computed(
  () => annotationStore.annotationConnections,
);
const unrolling = computed(() => store.unroll);
const xy = computed(() => store.xy);
const z = computed(() => store.z);
const time = computed(() => store.time);
const dataset = computed(() => store.dataset);
const valueOnHover = computed(() => store.valueOnHover);
const isAnnotationSelected = computed(
  () => annotationStore.isAnnotationSelected,
);
const showAnnotationsFromHiddenLayers = computed(
  (): boolean => store.showAnnotationsFromHiddenLayers,
);
const hoveredAnnotationId = computed(() => annotationStore.hoveredAnnotationId);
const selectedAnnotationIds = computed(
  () => annotationStore.selectedAnnotationIds,
);
const selectedConnectionIds = computed(
  () => connectionListStore.selectedConnectionIds,
);
const hoveredConnectionId = computed(
  () => connectionListStore.hoveredConnectionId,
);
// The list and both draw paths share this one predicate, so what the
// Connections tab hides under a track filter disappears from the canvas too.
// A stable always-true constant while no filter is active, so the common case
// adds no per-draw cost.
const connectionPassesTrackFilters = computed(
  () => connectionListStore.connectionPassesTrackFilters,
);
// The object half of the same lens. Consumed by BOTH display twins — the
// drawn set (displayableAnnotations) and the visibility refresh
// (updateVisibility's filteredIds), which drives the stub-mode budget,
// hydration, and the HUD's viewport counts. Narrowing one without the other
// spends budget on objects the draw path then discards.
const annotationPassesTrackFilters = computed(
  () => connectionListStore.annotationPassesTrackFilters,
);
const shouldDrawAnnotations = computed(
  (): boolean =>
    store.drawAnnotations &&
    (!rasterActive.value || selectedAnnotationIds.value.size > 0),
);
const shouldDrawConnections = computed(
  (): boolean => store.drawAnnotationConnections && !rasterActive.value,
);
const showTooltips = computed(
  (): boolean => store.showTooltips && !rasterActive.value,
);
const showTimelapseMode = computed((): boolean => timelapseStore.showMode);
const timelapseModeWindow = computed((): number => timelapseStore.modeWindow);
const showTimelapseLabels = computed((): boolean => timelapseStore.showLabels);
const filteredAnnotationTooltips = computed(
  (): boolean => store.filteredAnnotationTooltips,
);
const getAnnotationFromId = computed(() => annotationStore.getAnnotationFromId);
const displayedPropertyPaths = computed(
  () => propertiesStore.displayedPropertyPaths,
);
const properties = computed(() => propertiesStore.properties);
const propertyValues = computed(() => propertiesStore.propertyValues);
const pendingStoreAnnotation = computed(
  () => annotationStore.pendingAnnotation,
);

function updateAnnotationOverviewMode() {
  const layer = props.annotationOverviewLayer;
  const nextActive =
    layer && annotationRasterSelectorsSupported(rasterSelectors.value)
      ? annotationOverviewRasterActive({
          config: annotationStore.overviewConfig,
          unitsPerPixel: props.map.unitsPerPixel(props.map.zoom()),
          wasActive: rasterActive.value,
          unrolling: unrolling.value,
        })
      : false;
  if (nextActive !== rasterActive.value) {
    rasterActive.value = nextActive;
  }
  if (!layer) {
    return;
  }
  emit("annotation-overview-visibility-change", {
    visible: nextActive && store.drawAnnotations,
    opacity: annotationStore.overviewConfig.opacity,
  });
}

const selectedToolConfiguration = computed(
  (): IToolConfiguration | null => store.selectedTool?.configuration ?? null,
);

const selectedToolState = computed(
  (): TToolState | null => store.selectedTool?.state ?? null,
);

const samToolState = computed((): ISamAnnotationToolState | null => {
  const state = selectedToolState.value;
  if (!(state?.type === SamAnnotationToolStateSymbol)) {
    return null;
  }
  // Read from the reactive mapEntry property instead of the raw pipeline node
  // output. Pipeline nodes are markRaw'd so their outputs are not reactive.
  const samMapEntry = state.mapEntry;
  if (!samMapEntry || samMapEntry.map !== props.map) {
    return null;
  }
  return state;
});

const samPrompts = computed((): TSamPrompt[] => {
  const prompts = samToolState.value?.nodes.input.mainPrompt.output;
  return prompts === undefined || prompts === NoOutput ? [] : prompts;
});

const objectSegmentationToolState = computed(
  (): IObjectSegmentationToolState | null => {
    const state = selectedToolState.value;
    if (!(state?.type === ObjectSegmentationToolStateSymbol)) {
      return null;
    }
    // Read from the reactive mapEntry property instead of the raw pipeline
    // node output, same rationale as samToolState above.
    const mapEntry = state.mapEntry;
    if (!mapEntry || mapEntry.map !== props.map) {
      return null;
    }
    return state;
  },
);

const objectSegmentationExamples = computed(
  (): IObjectSegmentationExample[] =>
    objectSegmentationToolState.value?.examples ?? [],
);

const objectSegmentationProposals = computed(
  () => objectSegmentationToolState.value?.proposals ?? null,
);

// Reactive mirror of the hover live-preview outline (feature A). Gated on
// mapEntry.map === props.map transitively via objectSegmentationToolState (same
// rationale as samLivePreviewOutput below).
const objectSegmentationLivePreview = computed(
  () => objectSegmentationToolState.value?.livePreview ?? null,
);

const toolHighlightedAnnotationIds = computed((): Set<string> => {
  const state = selectedToolState.value;
  if (
    (state?.type === ConnectionToolStateSymbol ||
      state?.type === CombineToolStateSymbol) &&
    state.selectedAnnotationId
  ) {
    return new Set([state.selectedAnnotationId]);
  }
  return new Set();
});

const samMainOutput = computed(() => samToolState.value?.output ?? null);
const samLivePreviewOutput = computed(
  () => samToolState.value?.livePreview ?? null,
);

const workerImage = computed(
  () => selectedToolConfiguration.value?.values?.image?.image,
);

const workerPreview = computed(() =>
  workerImage.value
    ? propertiesStore.getWorkerPreview(workerImage.value)
    : { text: null, image: "" },
);

const baseStyle = computed(
  (): IGeoJSPointFeatureStyle &
    IGeoJSLineFeatureStyle &
    IGeoJSPolygonFeatureStyle => ({
    scaled: store.scaleAnnotationsWithZoom ? false : 1,
    radius: store.annotationsRadius,
    fillOpacity: store.annotationOpacity,
  }),
);

const displayableAnnotations = computed(() => {
  if (!props.annotationLayer || !shouldDrawAnnotations.value) {
    return [];
  }
  const base = store.filteredDraw
    ? filteredAnnotations.value
    : annotationStore.annotationsForIteration;
  // Opt-in track-filter object hiding. This is the single source every
  // display surface derives from — per-channel maps, layer maps, displayed
  // ids, the timelapse sets, connection gating AND retention — so filtering
  // here keeps draw and removal symmetric by construction. Off (the default)
  // returns the base array untouched; the predicate is then a stable
  // constant, so this adds no dependency on the track metrics.
  if (!connectionListStore.trackFilterHidesObjects) {
    return base;
  }
  const passesTrackFilters = annotationPassesTrackFilters.value;
  return base.filter(({ id }) => passesTrackFilters(id));
});

const displayableAnnotationsByChannel = computed(() => {
  const annotationsByChannel: Map<number, TAnnotationOrStub[]> = new Map();
  const annotations = displayableAnnotations.value;
  const len = annotations.length;

  for (let i = 0; i < len; i++) {
    const annotation = annotations[i];
    const channelAnnotations = annotationsByChannel.get(annotation.channel);
    if (channelAnnotations) {
      channelAnnotations.push(annotation);
    } else {
      annotationsByChannel.set(annotation.channel, [annotation]);
    }
  }

  return annotationsByChannel;
});

const validLayers = computed(() =>
  layers.value.slice(props.lowestLayer, props.lowestLayer + props.layerCount),
);

const rasterSelectors = computed(() =>
  annotationRasterSelectorsForLayers({
    layers: validLayers.value,
    showHiddenLayers: showAnnotationsFromHiddenLayers.value,
    layerSliceIndexes: store.layerSliceIndexes,
  }),
);

const isLayerIdValid = computed(() => {
  const validLayerIds: Set<string> = new Set();
  for (const layer of validLayers.value) {
    validLayerIds.add(layer.id);
  }
  return (id: string) => validLayerIds.has(id);
});

// Whether the raster overview can represent this configuration at all, i.e.
// whether hiding unhydrated stub dots is backed by a raster. Deliberately not
// rasterActive: the stub-free handoff must also hold while zoomed in (raster
// inactive but available), where stubs drive visibility and hydration without
// flashing approximate dots.
const stubFreeRasterHandoff = computed(
  () =>
    annotationStore.overviewConfig.enabled &&
    !unrolling.value &&
    annotationRasterSelectorsSupported(rasterSelectors.value),
);

// A map: map<layer id, map<annotation id, annotation or stub>>
const layerAnnotations = computed(() => {
  const layerIdToAnnotationIds: Map<
    string,
    Map<string, TAnnotationOrStub>
  > = new Map();
  for (const layer of validLayers.value) {
    layerIdToAnnotationIds.set(layer.id, new Map());
  }

  // While the raster represents the complete frame, draw only a bounded,
  // stable pseudo-random sample of selected stubs as interaction feedback.
  // Iterating selected ids instead of annotationsForIteration is important
  // here: the latter can contain hundreds of thousands of unselected stubs.
  // Prefer the stub even when geometry is hydrated so this overlay remains a
  // cheap centroid indicator rather than duplicating shapes already
  // represented by the raster.
  if (rasterActive.value) {
    const limit = Math.max(1, annotationStore.visibilityConfig.minimumVisible);
    type RasterSelectionCandidate = {
      annotationId: string;
      annotation: TAnnotationOrStub;
      layerIds: string[];
    };
    function* rasterSelectionCandidates(): Iterable<RasterSelectionCandidate> {
      for (const annotationId of selectedAnnotationIds.value) {
        const annotation =
          annotationStore.annotationStubs?.get(annotationId) ??
          annotationStore.getStub(annotationId) ??
          getAnnotationFromId.value(annotationId);
        if (!annotation) {
          continue;
        }
        const layerIds: string[] = [];
        for (const layer of validLayers.value) {
          const selector = annotationRasterSelectorForLayer({
            layer,
            showHiddenLayers: showAnnotationsFromHiddenLayers.value,
            layerSliceIndexes: store.layerSliceIndexes,
          });
          if (
            selector &&
            annotationMatchesRasterSelector(annotation, selector)
          ) {
            layerIds.push(layer.id);
          }
        }
        if (layerIds.length > 0) {
          yield { annotationId, annotation, layerIds };
        }
      }
    }

    for (const { annotationId, annotation, layerIds } of stableRandomSampleById(
      rasterSelectionCandidates(),
      limit,
      (candidate) => candidate.annotationId,
    )) {
      for (const layerId of layerIds) {
        layerIdToAnnotationIds.get(layerId)!.set(annotationId, annotation);
      }
    }
    return layerIdToAnnotationIds;
  }

  const stubsSize = annotationStore.annotationStubs?.size ?? 0;
  const { maxVisible, globalThreshold } = annotationStore.visibilityConfig;
  // Direct reads create reactive dependencies so layerAnnotations
  // recomputes when these change. The getter-returning-function pattern
  // (isVisible, getForRendering) defeats Vue's dependency tracking —
  // Vue tracks the getter reference, not the state the function reads.
  const hydratedAnnotations = annotationStore.hydratedAnnotations;
  const visibleAnnotationIds = annotationStore.visibleAnnotationIds;

  // First pass: collect frame annotations per layer
  const layerFrameAnnotations: Map<string, TAnnotationOrStub[]> = new Map();
  let totalFrameCount = 0;
  for (const layer of validLayers.value) {
    if (layer.visible || showAnnotationsFromHiddenLayers.value) {
      const layerChannelAnnotations =
        displayableAnnotationsByChannel.value.get(layer.channel) || [];
      const sliceIndexes = store.layerSliceIndexes(layer);
      const allXY = store.unrollXY || layer.xy.type === "max-merge";
      const allZ = store.unrollZ || layer.z.type === "max-merge";
      const allT = store.unrollT || layer.time.type === "max-merge";
      const frameAnnotations: TAnnotationOrStub[] = [];
      for (const annotation of layerChannelAnnotations) {
        if (
          (allXY || annotation.location.XY === sliceIndexes?.xyIndex) &&
          (allZ || annotation.location.Z === sliceIndexes?.zIndex) &&
          (allT || annotation.location.Time === sliceIndexes?.tIndex)
        ) {
          frameAnnotations.push(annotation);
        }
      }
      layerFrameAnnotations.set(layer.id, frameAnnotations);
      totalFrameCount += frameAnnotations.length;
    }
  }

  // Global mode: single threshold check across all layers
  const globalNeedsStubSystem = stubsSize > 0 && totalFrameCount > maxVisible;

  // Second pass: apply visibility filtering
  for (const layer of validLayers.value) {
    const frameAnnotations = layerFrameAnnotations.get(layer.id);
    if (!frameAnnotations) continue;
    const annotationIdsSet = layerIdToAnnotationIds.get(layer.id)!;
    const needsStubSystem =
      annotationStore.stubOnlyMode ||
      (globalThreshold
        ? globalNeedsStubSystem
        : stubsSize > 0 && frameAnnotations.length > maxVisible);
    for (const annotation of frameAnnotations) {
      if (needsStubSystem && !visibleAnnotationIds.has(annotation.id)) {
        continue;
      }
      const renderData: TAnnotationOrStub = needsStubSystem
        ? hydratedAnnotations.get(annotation.id) ??
          annotationStore.annotationStubs?.get(annotation.id) ??
          annotation
        : annotation;
      // The raster overview already represents every annotation while zoomed
      // out. During its vector handoff, keep stubs as the source of visibility
      // and hydration decisions but do not flash their approximate dots before
      // the full geometry arrives. When no raster is available — overview
      // disabled, unroll mode, or a selector set the raster contract rejects —
      // preserve normal stub rendering instead of hiding dots with nothing
      // behind them.
      if (stubFreeRasterHandoff.value && !isHydratedAnnotation(renderData)) {
        continue;
      }
      annotationIdsSet.set(annotation.id, renderData);
    }
  }
  return layerIdToAnnotationIds;
});

const layerDisplaysAnnotation = computed(
  () => (layerId: string, annotationId: string) =>
    !!layerAnnotations.value.get(layerId)?.has(annotationId),
);

const displayedAnnotationIds = computed(() => {
  const totalAnnotationIdsSet: Set<string> = new Set();
  for (const layerAnnotationIdsSet of layerAnnotations.value.values()) {
    for (const annotationId of layerAnnotationIdsSet.keys()) {
      totalAnnotationIdsSet.add(annotationId);
    }
  }
  return totalAnnotationIdsSet;
});

const displayedAnnotations = computed(() => {
  const annotationList: TAnnotationOrStub[] = [];
  for (const layerAnnotationIdsSet of layerAnnotations.value.values()) {
    for (const annotation of layerAnnotationIdsSet.values()) {
      annotationList.push(annotation);
    }
  }
  return annotationList;
});

const displayedAnnotationsSpatialIndex =
  shallowRef<RBush<AnnotationBBoxItem> | null>(null);
let spatialIndexRequestId: number | null = null;

function buildSpatialIndex(annotations: TAnnotationOrStub[]) {
  // Cancel any pending build
  if (spatialIndexRequestId !== null) {
    cancelIdleCallback(spatialIndexRequestId);
  }
  // Invalidate immediately so stale tree isn't used during rebuild
  displayedAnnotationsSpatialIndex.value = null;

  spatialIndexRequestId = requestIdleCallback(() => {
    spatialIndexRequestId = null;
    const tree = new RBush<AnnotationBBoxItem>();
    const items: AnnotationBBoxItem[] = new Array(annotations.length);
    for (let i = 0; i < annotations.length; i++) {
      items[i] = buildAnnotationBBox(annotations[i]);
    }
    tree.load(items);
    displayedAnnotationsSpatialIndex.value = tree;
  });
}

const connectionIdsSet = computed(() => {
  const result: Set<string> = new Set();
  const connections = annotationConnections.value;
  const len = connections.length;
  for (let i = 0; i < len; i++) {
    result.add(connections[i].id);
  }
  return result;
});

const selectedToolRadius = computed(
  (): number | undefined => selectedToolConfiguration.value?.values?.radius,
);

/**
 * How to place a frame-local point on the unrolled grid, for the DRAW path
 * (issue #1280). Navigation needs the same answer and builds its own from
 * `store.unrollGrid`; the geometry itself lives in `@/utils/unroll` so the two
 * cannot disagree.
 *
 * `unrollW` comes from the prop rather than `store.unrollGrid` — see
 * `unrollLayoutFor` for why.
 *
 * A computed, and NOT rebuilt inside the loops below: `unrolledCoordinates` runs
 * once per annotation per draw, so constructing a layout there would allocate two
 * objects per annotation — including on the un-unrolled path, which is supposed
 * to allocate nothing at all.
 */
const unrollLayout = computed<IUnrollLayout>(() =>
  unrollLayoutFor({
    flags: {
      unrollXY: store.unrollXY,
      unrollZ: store.unrollZ,
      unrollT: store.unrollT,
    },
    unrollW: props.unrollW,
    image: store.dataset?.anyImage(),
    dataset: store.dataset,
  }),
);

const unrolledCentroidCoordinates = computed(() => {
  const centroidMap: { [annotationId: string]: IGeoJSPosition } = {};
  const annotationCentroids = annotationStore.annotationCentroids;

  // No sized frame yet ⇒ nothing is drawable, so don't build a map for it.
  if (store.dataset?.anyImage()) {
    const layout = unrollLayout.value;
    for (const annotation of annotationStore.annotationsForIteration) {
      centroidMap[annotation.id] = unrolledCoordinates(
        [annotationCentroids[annotation.id]],
        annotation.location,
        layout,
      )[0];
    }
  }

  return centroidMap;
});

// ---- Functions ----

function getAnyLayerForChannel(channel: number) {
  return layers.value.find((layer: IDisplayLayer) => channel === layer.channel);
}

function getAnnotationStyle(
  annotationId: string,
  annotationColor: string | null,
  layerColor?: string,
) {
  const hovered =
    annotationId === hoveredAnnotationId.value ||
    toolHighlightedAnnotationIds.value.has(annotationId);
  const selected = isAnnotationSelected.value(annotationId);
  return getAnnotationStyleFromBaseStyle(
    baseStyle.value,
    annotationColor || layerColor,
    hovered,
    selected,
  );
}

// --- Retained-feature cache (frame-scrub optimization) -----------------------
// A frame change (Z / Time / XY) turns over the entire visible set, so
// clearOldAnnotations bulk-clears and drawNewAnnotations reconstructs every
// GeoJS feature via createGeoJSAnnotation. On large stub datasets that
// reconstruction is the dominant cost of the scrub freeze (measured ~50 ms of
// construction for ~8k features at low zoom, ~190 ms for ~26k zoomed in, on top
// of the ~25-110 ms GL draw). Instead we retain torn-down feature objects in an
// LRU keyed by (layer, annotation) and, when an annotation reappears (e.g. a
// scrub back to a recent frame), re-add the cached object — skipping
// reconstruction. Keying per annotation rather than per frame makes reuse robust
// to the two-phase frame update (a leading draw with the stale visible set, then
// the heavy draw once the set lands) and to throttle coalescing during fast
// scrubs: whatever was removed is reused whenever its id is drawn again. Each
// reused feature is still validated against the live render data
// (drawnFeatureUnchanged: layer existence, color, stub-ness, geometry) and
// restyled for hover/selection, so the rendered set is identical to a rebuild.
//
// Bound: we hold roughly the off-screen frames' worth of features on top of the
// live layer, so cap at a small multiple of the live visible-set cap. Deriving
// from visibilityConfig.maxVisible (rather than a fixed literal) keeps the bound
// consistent if that cap is reconfigured; the 1.2x multiple reproduces the
// previously-tuned 60k at the default 50k cap. Lower the multiple if memory is
// tighter than reuse value on very large (700k+) datasets.
const RETAINED_FEATURE_MULTIPLE = 1.2;
function retainedFeatureLimit(): number {
  return Math.ceil(
    annotationStore.visibilityConfig.maxVisible * RETAINED_FEATURE_MULTIPLE,
  );
}
// `layerId|girderId` -> feature. Map insertion order doubles as LRU recency.
const retainedFeatures = new Map<string, IGeoJSAnnotation>();
// Global style inputs that bake into a feature's appearance but that
// drawnFeatureUnchanged does NOT check; when they change every cached feature is
// stale, so the whole cache is dropped. Opacity is the only one that actually
// varies in practice and is ALSO covered by onRestyleNeeded (baseStyle watch) —
// the token is a defense-in-depth guard, not the sole path. getStubScaled() is
// included for completeness (it is the dot's baked `scaled` baseline), but note
// it reads unitsPerPixel at the FIXED zoom level 0, so it is constant across
// zoom: GeoJS rescales dots with zoom via the `scaled` style at render time, so
// reuse across zoom levels needs no re-bake and the token does not change on
// zoom. It only moves on a map/dataset re-init.
let retainedStyleToken = "";

function retainedFeatureKey(layerId: string, girderId: string): string {
  return `${layerId}|${girderId}`;
}

function currentStyleToken(): string {
  return `${getStubScaled()}|${store.annotationOpacity}`;
}

// Drop the cache when the global style token changes; returns nothing — callers
// run this before reuse so a stale-styled feature can never be re-added.
function syncRetainedStyleToken(): void {
  const token = currentStyleToken();
  if (token !== retainedStyleToken) {
    retainedFeatures.clear();
    retainedStyleToken = token;
  }
}

// The cache assumes each feature belongs to exactly one frame. Unroll genuinely
// breaks that (the unroll grid offset makes a feature's coordinates
// frame-dependent). For max-merge a single draw spans many frames so the visible
// set no longer turns over per frame; per-(layer, annotation) keying would still
// be sound there, but retention buys little and we disable it conservatively
// rather than reason about the merged-set bookkeeping.
function isFrameCacheEnabled(): boolean {
  if (unrolling.value) {
    return false;
  }
  for (const layer of validLayers.value) {
    if (
      layer.xy.type === "max-merge" ||
      layer.z.type === "max-merge" ||
      layer.time.type === "max-merge"
    ) {
      return false;
    }
  }
  return true;
}

function clearRetainedFeatureCache(): void {
  retainedFeatures.clear();
}

// Stash features removed from the layer (frame left / pan out) so a later redraw
// of the same annotation reuses them. The skip list (connections, special /
// in-progress features) lives in shouldRetainFeature; the current edit
// annotation is excluded here by object identity. Stale-but-cached features are
// harmless: the reuse validity check rejects them and the LRU evicts them.
//
// Reuse safety depends on a GeoJS contract: removeAnnotation() runs
// annotation._exit(), which for the base annotation type only detaches a cursor
// mousemove handler and leaves coordinates/options/state intact, so the object
// can be re-added later via addMultipleAnnotations. This is verified against
// geojs ^1.19.1 (see package.json). If a geojs upgrade makes _exit (or a feature
// subtype's override) free renderer state, reused features could render or
// hit-test wrong with no failing unit test — re-verify on upgrade.
function retainRemovedFeatures(removed: IGeoJSAnnotation[]): void {
  if (!isFrameCacheEnabled()) {
    return;
  }
  syncRetainedStyleToken();
  for (const feature of removed) {
    const options = feature.options();
    if (
      !shouldRetainFeature(options) ||
      feature === props.annotationLayer.currentAnnotation
    ) {
      continue;
    }
    const key = retainedFeatureKey(options.layerId, options.girderId);
    // Re-insert to refresh LRU recency.
    retainedFeatures.delete(key);
    retainedFeatures.set(key, feature);
  }
  // Trim oldest-first to the (cap-derived) limit. O(overflow), not O(size):
  // evict only the surplus rather than materializing the full key set.
  const limit = retainedFeatureLimit();
  while (retainedFeatures.size > limit) {
    const oldest = retainedFeatures.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    retainedFeatures.delete(oldest);
  }
}

// Pull a retained feature for (layerId, annotationId) if one exists and is still
// valid for the current render data; route it through the hover/selection
// restyle pass. Returns null when there is nothing reusable. Callers must have
// run syncRetainedStyleToken() for this draw first.
function takeRetainedFeature(
  layerId: string,
  annotationId: string,
  renderData: TAnnotationOrStub,
  drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]>,
): IGeoJSAnnotation | null {
  const key = retainedFeatureKey(layerId, annotationId);
  const cached = retainedFeatures.get(key);
  if (
    !cached ||
    !drawnFeatureUnchanged(
      true,
      renderData,
      cached.options("color"),
      cached.options("isStub"),
      cached.options("geometryKey"),
    )
  ) {
    return null;
  }
  retainedFeatures.delete(key);
  let list = drawnGeoJSAnnotations.get(annotationId);
  if (!list) {
    list = [];
    drawnGeoJSAnnotations.set(annotationId, list);
  }
  list.push(cached);
  return cached;
}

function drawAnnotationsAndTooltips() {
  drawAnnotations();
  drawTooltips();
  if (showTimelapseMode.value) {
    drawTimelapseThrottled();
  }
}

function drawAnnotationsNoThrottle() {
  if (!props.annotationLayer) {
    return;
  }

  if (!shouldDrawAnnotations.value) {
    clearOldAnnotations(true);
    return;
  }

  // Incremental: remove only the features whose annotation changed/left, keeping
  // the rest. drawNewAnnotations adds just the features not already present (the
  // snapshot below is taken AFTER the diff, so survivors are skipped via the
  // `excluded` check). clearOldAnnotations falls back to a bulk clear internally
  // when churn is high (e.g. a frame change), so this stays fast in both regimes.
  clearOldAnnotations(false, false);

  const drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]> = new Map();
  for (const geoJSAnnotation of props.annotationLayer.annotations()) {
    const id = geoJSAnnotation.options("girderId");
    if (id) {
      if (!drawnGeoJSAnnotations.has(id)) {
        drawnGeoJSAnnotations.set(id, []);
      }
      drawnGeoJSAnnotations.get(id)!.push(geoJSAnnotation);
    }
  }

  // Count features BEFORE adding. GeoJS gates the annotation layer's `_update`
  // (the WebGL feature-data rebuild) on a modified timestamp; addAnnotation /
  // addMultipleAnnotations called with update=false do NOT bump it, and
  // clearOldAnnotations marks the layer modified ONLY when it removes features.
  // So when a draw *adds* features to an otherwise-unchanged layer — e.g.
  // returning to an annotation frame while the layer was already empty after
  // scrubbing through blank Z slices — draw() alone renders nothing and the
  // annotations stay invisible until some later modification (or a reload).
  // Mark the layer modified whenever the feature count grew so the added
  // features actually paint. (Guarded so a pure pan with no add/remove still
  // skips the _update, preserving the incremental-draw optimization.)
  const featureCountBeforeAdd = props.annotationLayer.annotations().length;

  drawNewAnnotations(drawnGeoJSAnnotations);
  if (shouldDrawConnections.value) {
    drawNewConnections(drawnGeoJSAnnotations);
  }
  if (props.annotationLayer.annotations().length > featureCountBeforeAdd) {
    props.annotationLayer.modified();
  }
  props.annotationLayer.draw();
}

const drawAnnotations = throttle(drawAnnotationsNoThrottle, THROTTLE);

function drawTooltipsNoThrottle() {
  props.textLayer.clear();

  if (showTooltips.value) {
    const anyImage = store.dataset?.anyImage();
    if (!anyImage) {
      return;
    }
    const unrolledCoords = unrolledCentroidCoordinates.value;
    const annotations = displayedAnnotations.value;
    const propValues = propertyValues.value;
    const textBaseStyle = {
      fontSize: "12px",
      fontFamily: "sans-serif",
      textAlign: "center",
      textBaseline: "middle",
      color: "white",
      textStrokeColor: "black",
      textStrokeWidth: 2,
    };
    let yOffset = 0;
    props.textLayer
      .createFeature("text")
      .data(annotations)
      .position((annotation: IAnnotation) => {
        return unrolledCoords[annotation.id];
      })
      .style({
        text: (annotation: IAnnotation) => {
          const index = annotationStore.annotationIdToIdx[annotation.id];
          return index + ": " + annotation.tags.join(", ");
        },
        offset: { x: 0, y: yOffset },
        ...textBaseStyle,
      });
    yOffset += 12;
    for (const propertyPath of displayedPropertyPaths.value) {
      const fullName = propertiesStore.getSubIdsNameFromPath(propertyPath);
      if (fullName) {
        const propertyData: Map<string, string> = new Map();
        const filteredIds: string[] = [];
        const len = annotations.length;
        for (let i = 0; i < len; i++) {
          const annotation = annotations[i];
          const stringValue = getStringFromPropertiesAndPath(
            propValues[annotation.id],
            propertyPath,
          );
          if (stringValue) {
            propertyData.set(annotation.id, stringValue);
            filteredIds.push(annotation.id);
          }
        }
        props.textLayer
          .createFeature("text")
          .data(filteredIds)
          .position((annotationId: string) => unrolledCoords[annotationId])
          .style({
            text: (annotationId: string) =>
              `${fullName}=${propertyData.get(annotationId)}`,
            offset: { x: 0, y: yOffset },
            ...textBaseStyle,
          });
        yOffset += 12;
      }
    }
  }

  props.textLayer.draw();
}

const drawTooltips = throttle(drawTooltipsNoThrottle, THROTTLE);

function clearOldAnnotations(clearAll = false, redraw = true) {
  if (clearAll) {
    props.annotationLayer.removeAllAnnotations(undefined, undefined, false);
    props.annotationLayer.modified();
  } else {
    // Incremental diff: keep features whose annotation is unchanged (still
    // displayed on the same layer, same color, same dot/shape state) and remove
    // only the rest. drawNewAnnotations then re-creates just the features that
    // are new. At high zoom the visible set is largely stable across a pan, so
    // most features are reused instead of torn down and rebuilt every refresh.
    const features = props.annotationLayer.annotations();
    const toRemove: IGeoJSAnnotation[] = [];
    for (const geoJsAnnotation of features) {
      const {
        girderId,
        layerId,
        isConnection,
        childId,
        parentId,
        specialAnnotation,
        color,
      } = geoJsAnnotation.options();

      if (
        geoJsAnnotation === props.annotationLayer.currentAnnotation ||
        specialAnnotation ||
        !girderId
      ) {
        continue;
      }

      if (isConnection) {
        // Retention MUST use the same criteria as drawNewConnections. It used
        // to require getAnnotationFromId for both endpoints, which returns
        // undefined for unhydrated annotations in stub-only mode — so on a
        // lazily-loaded dataset every draw pass removed the very lines the draw
        // path had just created (measured: 10 of 11 removed at 4/12 endpoints
        // hydrated), churning GeoJS features on every pan.
        const centroids = unrolledCentroidCoordinates.value;
        if (
          !connectionIdsSet.value.has(girderId) ||
          !shouldDrawConnections.value ||
          !displayedAnnotationIds.value.has(parentId) ||
          !displayedAnnotationIds.value.has(childId) ||
          !centroids[parentId] ||
          !centroids[childId] ||
          !connectionPassesTrackFilters.value({ parentId })
        ) {
          toRemove.push(geoJsAnnotation);
        }
        continue;
      }

      const layerData = layerAnnotations.value.get(layerId)?.get(girderId);
      const unchanged = drawnFeatureUnchanged(
        !!store.getLayerFromId(layerId),
        layerData,
        color,
        geoJsAnnotation.options("isStub"),
        geoJsAnnotation.options("geometryKey"),
      );
      if (!unchanged) {
        toRemove.push(geoJsAnnotation);
      }
    }

    // Hybrid: when most features must be removed (e.g. a frame change), a single
    // bulk clear is cheaper than N individual O(n) removals; below the threshold
    // keep the survivors and remove only the changed ones.
    if (toRemove.length > features.length * INCREMENTAL_BULK_CLEAR_FRACTION) {
      // High churn (e.g. a frame change): retain the about-to-be-removed
      // features so a scrub back reuses them instead of reconstructing the
      // whole visible set. removeAllAnnotations removes every feature, so retain
      // all of them.
      retainRemovedFeatures(features);
      props.annotationLayer.removeAllAnnotations(undefined, undefined, false);
      props.annotationLayer.modified();
    } else if (toRemove.length > 0) {
      retainRemovedFeatures(toRemove);
      for (const geoJsAnnotation of toRemove) {
        props.annotationLayer.removeAnnotation(geoJsAnnotation, false);
      }
      props.annotationLayer.modified();
    }
  }
  if (redraw) {
    props.annotationLayer.draw();
  }
}

function drawNewAnnotations(
  drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]>,
) {
  // Reuse retained features when available — re-adding a cached GeoJS object
  // skips the costly createGeoJSAnnotation reconstruction when an annotation
  // reappears (e.g. a scrub back to a recently visited frame).
  const reuseEnabled = isFrameCacheEnabled();
  if (reuseEnabled) {
    syncRetainedStyleToken();
  }
  for (const [layerId, annotationMap] of layerAnnotations.value) {
    const layer = store.getLayerFromId(layerId);
    if (layer) {
      // Freshly-created features hold ingcs (image-pixel) coordinates; reused
      // features were already converted to the map gcs on their first add.
      // addAnnotation() converts ingcs -> gcs on EVERY add, so the two must be
      // added in separate batches with different gcs args — re-adding a reused
      // feature with the default (ingcs) would convert its already-gcs
      // coordinates a second time and drift it off the image (worsening on each
      // zoom-out that re-adds it).
      const freshAnnotations: IGeoJSAnnotation[] = [];
      const reusedAnnotations: IGeoJSAnnotation[] = [];
      for (const [annotationId, annotation] of annotationMap) {
        const excluded = drawnGeoJSAnnotations
          .get(annotationId)
          ?.some(
            (geoJSAnnotation) =>
              geoJSAnnotation.options("layerId") === layer.id,
          );
        if (!excluded) {
          const reused = reuseEnabled
            ? takeRetainedFeature(
                layerId,
                annotationId,
                annotation,
                drawnGeoJSAnnotations,
              )
            : null;
          if (reused) {
            reusedAnnotations.push(reused);
          } else {
            const created = createGeoJSAnnotation(annotation, layerId);
            if (created) {
              freshAnnotations.push(created);
            }
          }
        }
      }
      if (freshAnnotations.length > 0) {
        // gcs undefined -> ingcs: addAnnotation converts pixel coords to gcs.
        props.annotationLayer.addMultipleAnnotations(
          freshAnnotations,
          undefined,
          false,
        );
      }
      if (reusedAnnotations.length > 0) {
        // gcs null -> map gcs: addAnnotation skips conversion (coords already
        // in gcs), so a reused feature renders at its original position.
        props.annotationLayer.addMultipleAnnotations(
          reusedAnnotations,
          null,
          false,
        );
      }
    }
  }
  const stubScaled = getStubScaled();
  for (const [annotationId, geoJSAnnotationList] of drawnGeoJSAnnotations) {
    const isHoveredGT = annotationId === hoveredAnnotationId.value;
    const isSelectedGT = isAnnotationSelected.value(annotationId);
    for (const geoJSAnnotation of geoJSAnnotationList) {
      const {
        layerId,
        isHovered,
        isSelected,
        style,
        customColor,
        isStub,
        annotationShape,
        stubRadius,
        isConnection,
      } = geoJSAnnotation.options();
      // Connection lines also carry a girderId, so they land in this map — but
      // they are object-annotation logic from here down. They never set
      // isHovered/isSelected, and `undefined != false` is true, so without this
      // guard every redraw would fire the branch below and overwrite a selected
      // connection's cyan with getAnnotationStyle(connectionId, …). Connections
      // are styled at construction and by restyleAnnotations' own branch.
      if (isConnection) {
        continue;
      }
      if (isHovered != isHoveredGT || isSelected != isSelectedGT) {
        const layer = store.getLayerFromId(layerId);
        const newStyle = drawnFeatureUsesDotStyle(isStub, annotationShape)
          ? getStubStyleFromBaseStyle(
              customColor || layer?.color,
              isHoveredGT,
              isSelectedGT,
              stubRadius,
              stubScaled,
              store.annotationOpacity,
            )
          : getAnnotationStyle(annotationId, customColor, layer?.color);
        geoJSAnnotation.options("style", { ...style, ...newStyle });
        geoJSAnnotation.options("isHovered", isHoveredGT);
        geoJSAnnotation.options("isSelected", isSelectedGT);
      }
    }
  }
}

function drawNewConnections(
  drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]>,
) {
  const dispAnnotationIds = displayedAnnotationIds.value;
  const unrolledCentroids = unrolledCentroidCoordinates.value;
  const passesTrackFilters = connectionPassesTrackFilters.value;
  const connections = annotationConnections.value;
  const len = connections.length;
  for (let i = 0; i < len; i++) {
    const connection = connections[i];
    if (
      drawnGeoJSAnnotations.has(connection.id) ||
      !dispAnnotationIds.has(connection.parentId) ||
      !dispAnnotationIds.has(connection.childId) ||
      !passesTrackFilters(connection)
    ) {
      continue;
    }
    // Gate on the centroids this actually draws from, NOT on
    // getAnnotationFromId. In stub-only mode that getter returns undefined for
    // every unhydrated non-point annotation, so on a lazily-loaded dataset it
    // silently dropped nearly every connection: measured on the 709K-object
    // Xenium dataset, only 4 of 12 endpoints resolved and just 1 of 11 lines
    // was drawn, even though all 12 centroids were present.
    const parentCentroid = unrolledCentroids[connection.parentId];
    const childCentroid = unrolledCentroids[connection.childId];
    if (!parentCentroid || !childCentroid) {
      continue;
    }
    drawGeoJSAnnotationFromConnection(
      connection,
      parentCentroid,
      childCentroid,
    );
  }
}

function getDisplayedAnnotationIdsAcrossTime(): Set<string> {
  const totalAnnotationIdsSet: Set<string> = new Set();
  // Hoisted out of the per-annotation loop: layerSliceIndexes computes a fresh
  // result on every call and is invariant per layer, and the unroll flags are
  // invariant for the whole pass. Calling the getter per annotation measured
  // ~67 ms of a ~490 ms timelapse rebuild at 45K annotations.
  const showHidden = showAnnotationsFromHiddenLayers.value;
  const unrollXY = store.unrollXY;
  const unrollZ = store.unrollZ;
  for (const layer of validLayers.value) {
    if (layer.visible || showHidden) {
      const sliceIndexes = store.layerSliceIndexes(layer);
      const xyIndex = sliceIndexes?.xyIndex;
      const zIndex = sliceIndexes?.zIndex;
      const channelAnnotations =
        displayableAnnotationsByChannel.value.get(layer.channel) || [];
      for (const annotation of channelAnnotations) {
        if (annotation.channel === layer.channel) {
          if (
            (unrollXY || annotation.location.XY === xyIndex) &&
            (unrollZ || annotation.location.Z === zIndex)
          ) {
            totalAnnotationIdsSet.add(annotation.id);
          }
        }
      }
    }
  }
  return totalAnnotationIdsSet;
}

// One timelapse rebuild pass. Features are keyed (`tlKey`) by what they
// represent — `c|<pairId>` for a track segment, `p|<annotationId>` for a
// centroid dot — and carry their raw (ingcs) geometry as `tlGeom` so a kept
// feature is provably drawing the same thing. Anything on the layer that this
// pass does not re-claim is removed at the end.
interface ITimelapseDiff {
  existingByKey: Map<string, IGeoJSAnnotation>;
  staleFeatures: IGeoJSAnnotation[];
  newFeatures: IGeoJSAnnotation[];
}

// Counts mode-on rebuild passes. Rebuilds used to be observable through
// removeAllAnnotations, which the diff-based pass no longer calls; tests that
// assert "rebuilt exactly once" / "hover never rebuilds" read this instead.
// A pass skipped by the input snapshot below does NOT count — nothing ran.
const timelapseRebuildCount = ref(0);

// EVERY input the rebuild pass reads, snapshotted after each successful pass.
// The two-phase visibility update re-fires the displayedAnnotations watcher
// ~250 ms after a frame change with nothing the timelapse pass reads having
// changed, and that zero-churn second pass still cost the full desired-set
// computation (~500 ms at 100K connections). When every field matches, the
// pass is skipped outright — the layer already shows exactly this state.
//
// THE INVARIANT THIS ENCODES: a new input read by the pass (or by
// drawTimelapseTrack / drawTimelapseAnnotationCentroidsAndLabels) must be
// added here AND to timelapsePassInputsEqual, or a stale skip silently freezes
// the overlay. Same discipline as the timelapse watch list — see the
// regression checklist's "identical-pass skip" row. Comparisons are by
// identity/value only (all these are replaced on change, and mutationCounter
// covers in-place annotation edits); displayedIds is compared by content
// because the second wave replaces the array identity without changing it.
interface ITimelapsePassInputs {
  // The OUTPUT layers, not just inputs: recreating a GeoJS map at an existing
  // v-for index reuses this component instance with fresh, EMPTY layers, and a
  // skip against those would leave the overlay blank until some other input
  // changed (Codex round 4 on PR #1341).
  layer: IGeoJSAnnotationLayer;
  textLayer: IGeoJSFeatureLayer;
  displayedIds: Set<string>;
  connections: IAnnotationConnection[];
  mutationCounter: number;
  currentTime: number;
  modeWindow: number;
  tags: string[];
  coloring: string;
  colorSeed: number;
  passesTrackFilters: (connection: IAnnotationConnection) => boolean;
  resolveAnnotation: (id: string) => IAnnotation | undefined;
  unrolledCentroids: { [annotationId: string]: IGeoJSPosition };
  selectedConnections: Set<string>;
  // Hover and object selection are usually reflected between passes by
  // restyleTimelapseFeatures in place, so a change since the last pass defeats
  // the skip even though the layer's PAINT already shows it. Deliberate: the
  // extra pass is merely conservative, the cost only bites in the rare case of
  // paint state changing between the two visibility waves of one frame change,
  // and connection hover genuinely affects materialization (it picks the
  // representative duplicate). Do not "optimize" these out of the snapshot.
  hoveredConnectionId: string | null;
  selectedObjects: Set<string>;
  hoveredObjectId: string | null;
  showLabels: boolean;
}
let lastTimelapsePassInputs: ITimelapsePassInputs | null = null;

function timelapsePassInputsEqual(
  a: ITimelapsePassInputs,
  b: ITimelapsePassInputs,
): boolean {
  if (
    a.layer !== b.layer ||
    a.textLayer !== b.textLayer ||
    a.connections !== b.connections ||
    a.mutationCounter !== b.mutationCounter ||
    a.currentTime !== b.currentTime ||
    a.modeWindow !== b.modeWindow ||
    a.tags !== b.tags ||
    a.coloring !== b.coloring ||
    a.colorSeed !== b.colorSeed ||
    a.passesTrackFilters !== b.passesTrackFilters ||
    a.resolveAnnotation !== b.resolveAnnotation ||
    a.unrolledCentroids !== b.unrolledCentroids ||
    a.selectedConnections !== b.selectedConnections ||
    a.hoveredConnectionId !== b.hoveredConnectionId ||
    a.selectedObjects !== b.selectedObjects ||
    a.hoveredObjectId !== b.hoveredObjectId ||
    a.showLabels !== b.showLabels ||
    a.displayedIds.size !== b.displayedIds.size
  ) {
    return false;
  }
  for (const id of b.displayedIds) {
    if (!a.displayedIds.has(id)) {
      return false;
    }
  }
  return true;
}

// Shallow structural equality for option values: scalars, arrays of scalars,
// and flat objects (whose values may be scalars or arrays). Exactly the shapes
// the timelapse features store: connectionIds, tlGeom, the two base-style
// bags, and style fields including lineDash.
function timelapseValueEquals(a: any, b: any): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) {
      return false;
    }
    for (const key of aKeys) {
      if (!timelapseValueEquals(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// The complete option bags a timelapse feature carries. These interfaces ARE
// the enforcement of the diff's core invariant: any new option baked into a
// segment or dot must be declared here, so the materializer's compare-and-
// update loop (which iterates these keys) keeps it fresh on kept features. An
// option set on a feature some other way goes stale the first time the
// feature is reused.
interface ITimelapseSegmentOptions {
  style: ReturnType<typeof getTimelapseSegmentStyle>;
  isConnection: true;
  girderId: string;
  timelapseBaseStyle: ITimelapseSegmentBaseStyle;
  connectionIds: string[];
}
interface ITimelapsePointOptions {
  style: ReturnType<typeof getTimelapsePointStyle>;
  time: number;
  girderId: string;
  isTimelapsePoint: true;
  timelapsePointBaseStyle: ITimelapsePointBaseStyle;
}
type TTimelapseFeatureOptions =
  | ITimelapseSegmentOptions
  | ITimelapsePointOptions;

// Claim the feature for `key` if a matching one is already on the layer,
// updating only the options that changed (options() marks the layer modified,
// so an unchanged feature must not be touched at all); otherwise construct a
// fresh feature and queue it for a single batched add. The desired `style` is
// merged over the feature's current style so GeoJS's own defaults
// (stroke/fill flags) survive — options("style", …) replaces, never merges.
function materializeTimelapseFeature(
  diff: ITimelapseDiff,
  key: string,
  shape: AnnotationShape,
  coordinates: IGeoJSPosition[],
  geometry: number[],
  typedOptions: TTimelapseFeatureOptions,
) {
  const options = typedOptions as Record<string, any>;
  const existing = diff.existingByKey.get(key);
  if (existing && timelapseValueEquals(existing.options("tlGeom"), geometry)) {
    diff.existingByKey.delete(key);
    const current = existing.options();
    for (const optionKey of Object.keys(options)) {
      const desired = options[optionKey];
      if (optionKey === "style") {
        const currentStyle = current.style;
        let covered = currentStyle != null;
        if (covered) {
          for (const styleKey of Object.keys(desired)) {
            if (
              !timelapseValueEquals(currentStyle[styleKey], desired[styleKey])
            ) {
              covered = false;
              break;
            }
          }
        }
        if (!covered) {
          existing.options("style", Object.assign({}, currentStyle, desired));
        }
      } else if (!timelapseValueEquals(current[optionKey], desired)) {
        existing.options(optionKey, desired);
      }
    }
    return;
  }
  // Style goes through the factory so GeoJS merges it over its own defaults
  // at construction; the other options are set explicitly on the feature,
  // matching how the pre-diff code tagged segments.
  const feature = geojsAnnotationFactory(shape, coordinates, {
    style: options.style,
  });
  if (feature) {
    for (const optionKey of Object.keys(options)) {
      if (optionKey !== "style") {
        feature.options(optionKey, options[optionKey]);
      }
    }
    feature.options("tlKey", key);
    feature.options("tlGeom", geometry);
    diff.newFeatures.push(feature);
  }
}

function drawTimelapseConnectionsAndCentroids() {
  if (!showTimelapseMode.value) {
    lastTimelapsePassInputs = null;
    props.timelapseTextLayer.features([]);
    props.timelapseLayer.removeAllAnnotations(undefined, undefined, false);
    props.timelapseLayer.draw();
    props.timelapseTextLayer.draw();
    return;
  }

  // Gather every input the pass reads (see ITimelapsePassInputs). The pass
  // destructures its working values FROM this object so the snapshot cannot
  // drift from what was actually consumed.
  const inputs: ITimelapsePassInputs = {
    layer: props.timelapseLayer,
    textLayer: props.timelapseTextLayer,
    displayedIds: getDisplayedAnnotationIdsAcrossTime(),
    connections: annotationConnections.value,
    mutationCounter: annotationStore.mutationCounter,
    currentTime: time.value,
    modeWindow: timelapseModeWindow.value,
    tags: timelapseStore.tags,
    coloring: timelapseStore.trackColoring,
    colorSeed: timelapseStore.colorSeed,
    passesTrackFilters: connectionPassesTrackFilters.value,
    resolveAnnotation: getAnnotationFromId.value,
    unrolledCentroids: unrolledCentroidCoordinates.value,
    selectedConnections: selectedConnectionIds.value,
    hoveredConnectionId: hoveredConnectionId.value,
    selectedObjects: selectedAnnotationIds.value,
    hoveredObjectId: hoveredAnnotationId.value,
    showLabels: showTimelapseLabels.value,
  };
  // Identical inputs ⇒ the layer already shows exactly this state: skip the
  // whole pass. The displayedAnnotations watcher re-fires ~250 ms after each
  // frame change (two-phase visibility update) with nothing this pass reads
  // having changed, and the zero-churn pass still cost the full desired-set
  // computation (~500 ms at 100K connections).
  if (
    lastTimelapsePassInputs !== null &&
    timelapsePassInputsEqual(lastTimelapsePassInputs, inputs)
  ) {
    return;
  }
  timelapseRebuildCount.value++;
  props.timelapseTextLayer.features([]);

  // Diff-based rebuild: tearing the layer down and reconstructing every
  // feature cost ~250 ms per time-scrub step at Gia-scale connection counts
  // (51,665 connections → ~10K features), and a scrub step actually changes
  // only the features entering/leaving the mode window plus the ones whose
  // time-relative styling flips. Keep every feature whose key and geometry
  // still match, restyle the changed ones in place (options() marks the layer
  // modified), and add/remove only the churn.
  const diff: ITimelapseDiff = {
    existingByKey: new Map(),
    staleFeatures: [],
    newFeatures: [],
  };
  for (const feature of props.timelapseLayer.annotations()) {
    const key = feature.options("tlKey");
    if (key !== undefined && !diff.existingByKey.has(key)) {
      diff.existingByKey.set(key, feature);
    } else {
      diff.staleFeatures.push(feature);
    }
  }

  const tlModeWindow = inputs.modeWindow;
  const currentTime = inputs.currentTime;
  const timelapseTags = inputs.tags;
  const displayedIds = inputs.displayedIds;

  const connections = inputs.connections;
  const connectionsLength = connections.length;
  const filteredConnections: IAnnotationConnection[] = [];
  for (let i = 0; i < connectionsLength; i++) {
    const conn = connections[i];
    if (displayedIds.has(conn.parentId) && displayedIds.has(conn.childId)) {
      filteredConnections.push(conn);
    }
  }
  const components = findConnectedComponents(filteredConnections);

  const coloring = inputs.coloring;
  const colorSeed = inputs.colorSeed;
  // Vuex caches this global analysis against `annotationConnections`. Reads
  // during scope changes and time scrubs reuse it; only connection CRUD
  // invalidates it. Uniform coloring does not need the index at all.
  const trackKeyByAnnotationId =
    coloring === "track"
      ? connectionListStore.trackAnalysis.trackKeyByAnnotationId
      : undefined;

  const passesTrackFilters = inputs.passesTrackFilters;
  const resolveAnnotation = inputs.resolveAnnotation;

  components.forEach((component) => {
    // A displayed fragment's connections all belong to one dataset-wide
    // track, so its first connection decides for the whole component. A
    // filtered-out track is skipped here but its members stay in
    // `connectedIds` below: they must vanish from the overlay entirely, not
    // be recast as orphan dots — the graph didn't change, the view did.
    if (!passesTrackFilters(component.connections[0])) {
      return;
    }
    const componentAnnotations: ITimelapseAnnotation[] = [];
    // Resolve the displayed fragment through the complete connection graph.
    // A hidden endpoint must not make the same track change color.
    const color =
      coloring === "uniform"
        ? TRACK_UNIFORM_COLOR
        : trackColor(
            trackKeyFromIndex(component.annotations, trackKeyByAnnotationId),
            colorSeed,
          );

    // Check the window BEFORE cloning: members outside it are dropped anyway,
    // and spread-cloning every member of every track measured as a main cost
    // of the rebuild at 42K tracked annotations per pass.
    for (const id of component.annotations) {
      const annotation = resolveAnnotation(id);
      if (!annotation) {
        continue;
      }
      if (
        annotation.location.Time < currentTime - tlModeWindow ||
        annotation.location.Time > currentTime + tlModeWindow
      ) {
        continue;
      }
      if (
        timelapseTags.length > 0 &&
        !annotation.tags.some((tag: string) => timelapseTags.includes(tag))
      ) {
        continue;
      }
      componentAnnotations.push({
        ...(annotation as IAnnotation),
        trackPositionType: TrackPositionType.INTERIOR,
      });
    }

    if (componentAnnotations.length === 0) {
      return;
    }

    // One pass over the component's connections instead of two .some() scans
    // per member (O(members × connections) — 1.75M comparisons per rebuild on
    // the Gia-scale fixture). Self-connections don't count for either side.
    const membersWithEarlier = new Set<string>();
    const membersWithLater = new Set<string>();
    for (const conn of component.connections) {
      if (conn.parentId !== conn.childId) {
        membersWithEarlier.add(conn.childId);
        membersWithLater.add(conn.parentId);
      }
    }
    for (const annotation of componentAnnotations) {
      if (annotation.location.Time === currentTime) {
        annotation.trackPositionType = TrackPositionType.CURRENT;
      } else if (!membersWithEarlier.has(annotation.id)) {
        annotation.trackPositionType = TrackPositionType.START;
      } else if (!membersWithLater.has(annotation.id)) {
        annotation.trackPositionType = TrackPositionType.END;
      }
    }

    drawTimelapseTrack(
      diff,
      componentAnnotations,
      component.connections,
      color,
    );
    drawTimelapseAnnotationCentroidsAndLabels(diff, componentAnnotations);
  });

  const orphanAnnotations: ITimelapseAnnotation[] = [];
  const connectedIds = new Set<string>();
  for (const component of components) {
    for (const id of component.annotations) {
      connectedIds.add(id);
    }
  }

  // Orphans are the displayed ids WITHOUT a connection. Reuse the id set
  // computed above rather than re-scanning every annotation (the scan is the
  // most expensive step of this rebuild), and resolve only the unconnected
  // ids — on a heavily-tracked dataset that is a small fraction of the total.
  for (const id of displayedIds) {
    if (connectedIds.has(id)) {
      continue;
    }
    const annotation = resolveAnnotation(id);
    if (
      annotation &&
      annotation.location.Time >= currentTime - tlModeWindow &&
      annotation.location.Time <= currentTime + tlModeWindow &&
      (timelapseTags.length === 0 ||
        annotation.tags.some((tag: string) => timelapseTags.includes(tag)))
    ) {
      orphanAnnotations.push({
        ...(annotation as IAnnotation),
        trackPositionType: TrackPositionType.ORPHAN,
      });
    }
  }

  if (orphanAnnotations.length > 0) {
    drawTimelapseAnnotationCentroidsAndLabels(diff, orphanAnnotations);
  }

  // Sweep: whatever was on the layer and was not re-claimed by this pass is
  // stale. Adds and removals with update=false do not bump the layer's
  // modified timestamp, so mark it ourselves when the feature set changed —
  // in-place restyles already marked it through options().
  let removedCount = 0;
  for (const staleFeature of diff.staleFeatures) {
    props.timelapseLayer.removeAnnotation(staleFeature, false);
    removedCount++;
  }
  for (const staleFeature of diff.existingByKey.values()) {
    props.timelapseLayer.removeAnnotation(staleFeature, false);
    removedCount++;
  }
  if (diff.newFeatures.length > 0) {
    props.timelapseLayer.addMultipleAnnotations(
      diff.newFeatures,
      undefined,
      false,
    );
  }
  if (removedCount > 0 || diff.newFeatures.length > 0) {
    props.timelapseLayer.modified();
  }

  props.timelapseLayer.draw();
  props.timelapseTextLayer.draw();
  // Snapshot only after a completed pass, so an exception can never leave a
  // half-updated layer marked as current.
  lastTimelapsePassInputs = inputs;
}

// The displayedAnnotations watcher fires 2-3 times per frame change (the
// two-phase visibility update), and each fire reached the timelapse rebuild
// directly while drawAnnotations right beside it was throttled — bundling 2-3
// full layer rebuilds into ONE long main-thread task per time-scrub step
// (measured 157 ms at 9,965 connections; a single rebuild is ~57 ms).
// Trailing-only: every fire inside the window coalesces into one rebuild
// against the FINAL state. A leading call would run against the mid-update
// visible set and still pay a second rebuild at the trailing edge.
const drawTimelapseThrottled = throttle(
  drawTimelapseConnectionsAndCentroids,
  THROTTLE,
  { leading: false },
);

function drawTimelapseTrack(
  diff: ITimelapseDiff,
  annotations: ITimelapseAnnotation[],
  connections: IAnnotationConnection[],
  color?: string,
) {
  annotations.sort((a, b) => b.location.Time - a.location.Time);

  const currentTime = time.value;
  const drawnLines = new Set<string>();
  const unrolledCentroids = unrolledCentroidCoordinates.value;
  // Hoisted: these are Vuex getter reads, paid per segment otherwise (several
  // per segment across ~5K segments per rebuild at Gia scale).
  const isConnectionSelected = connectionListStore.isConnectionSelected;
  const hoveredConnectionId = connectionListStore.hoveredConnectionId;
  const annotationsById = new Map<string, ITimelapseAnnotation>();
  const connectionsByAnnotationId = new Map<string, IAnnotationConnection[]>();

  for (const annotation of annotations) {
    annotationsById.set(annotation.id, annotation);
  }

  const connectionsLen = connections.length;
  for (let i = 0; i < connectionsLen; i++) {
    const connection = connections[i];
    const parentConnections =
      connectionsByAnnotationId.get(connection.parentId) || [];
    parentConnections.push(connection);
    connectionsByAnnotationId.set(connection.parentId, parentConnections);

    const childConnections =
      connectionsByAnnotationId.get(connection.childId) || [];
    childConnections.push(connection);
    connectionsByAnnotationId.set(connection.childId, childConnections);
  }

  for (const annotation of annotations) {
    const relevantConnections =
      connectionsByAnnotationId.get(annotation.id) || [];

    for (const connection of relevantConnections) {
      const otherId =
        connection.parentId === annotation.id
          ? connection.childId
          : connection.parentId;

      const otherAnnotation = annotationsById.get(otherId);
      if (!otherAnnotation) {
        continue;
      }
      // Each undirected segment is drawn from exactly one of its two endpoints:
      // normally the later one. Equal-time links — which "Connect selected"
      // creates for same-frame pairs — used to be skipped from BOTH sides and
      // so never appeared in timelapse mode at all, despite the UI advertising
      // tie handling. Break the tie on id so exactly one traversal draws them.
      const otherTime = otherAnnotation.location.Time;
      const thisTime = annotation.location.Time;
      if (
        otherTime > thisTime ||
        (otherTime === thisTime && otherId >= annotation.id)
      ) {
        continue;
      }

      const lineId = [annotation.id, otherId].sort().join("-");
      if (drawnLines.has(lineId)) continue;
      drawnLines.add(lineId);

      // One segment is drawn per endpoint PAIR, but the schema allows several
      // connection documents for the same pair (this repo's own datasets have
      // them). Whichever record the segment carries is the only one that can be
      // highlighted or resolved by a click, so prefer a selected duplicate as
      // the representative — otherwise selecting the second of two identical
      // links could never turn its segment cyan.
      const pairConnections = relevantConnections.filter(
        (candidate) =>
          (candidate.parentId === annotation.id
            ? candidate.childId
            : candidate.parentId) === otherId,
      );
      // Selected wins, then hovered, then the first. Without the hovered
      // branch, hovering a later duplicate's row triggered a full redraw whose
      // segment neither widened nor carried that connection's id.
      const representative =
        pairConnections.find(({ id }) => isConnectionSelected(id)) ??
        pairConnections.find(({ id }) => id === hoveredConnectionId) ??
        connection;

      const pointA = unrolledCentroids[annotation.id];
      const pointB = unrolledCentroids[otherId];
      if (!pointA || !pointB) {
        continue;
      }

      const timeDiff = annotation.location.Time - otherAnnotation.location.Time;
      const isTimeJump = timeDiff > 1;

      const isBeforeCurrent = annotation.location.Time <= currentTime;
      // Everything that depends on the track rather than on the user's
      // selection or hover. Kept on the feature so the segment can be restyled
      // in place later without knowing which track it came from — a hover
      // change must not have to rebuild the layer to be visible.
      // A time jump keeps the track's colour. It used to be forced to #ff6b6b,
      // which broke both colouring controls: "uniform" left those segments red
      // among white ones, so it was not uniform, and under per-track colouring a
      // track whose drawn segments are all jumps showed a hue swatch against red
      // lines. The jump is still unmistakable — the dash and the reduced opacity
      // below are two independent cues that no other segment has — so the colour
      // was a third, redundant signal that happened to be the one contradicting
      // the swatch. Dropping it makes the swatch match the line unconditionally,
      // which is a claim the UI now makes in both modes.
      const baseStyle: ITimelapseSegmentBaseStyle = {
        strokeColor: color,
        strokeWidth: isBeforeCurrent ? 3 : 6,
        strokeOpacity: isTimeJump ? 0.7 : 1,
        lineDash: isTimeJump ? [5, 5] : undefined,
      };
      const pairIds = pairConnections.map(({ id }) => id);
      // Options a kept segment must stay in sync on:
      // - isConnection + girderId tag the segment with its representative so a
      //   click resolves to exactly that link (the layer draws one line per
      //   connection, not one polyline per track);
      // - timelapseBaseStyle and connectionIds let a hover/selection change be
      //   restyled in place — the base to rebuild the unhighlighted appearance
      //   from, and EVERY id sharing this pair, so a duplicate that is not the
      //   representative still lights its segment up.
      materializeTimelapseFeature(
        diff,
        "c|" + lineId,
        AnnotationShape.Line,
        [pointA, pointB],
        [pointA.x, pointA.y, pointB.x, pointB.y],
        {
          style: getTimelapseSegmentStyle(
            baseStyle,
            pairIds.some(isConnectionSelected),
            pairIds.includes(hoveredConnectionId ?? ""),
          ),
          isConnection: true,
          girderId: representative.id,
          timelapseBaseStyle: baseStyle,
          connectionIds: pairIds,
        },
      );
    }
  }
}

function drawTimelapseAnnotationCentroidsAndLabels(
  diff: ITimelapseDiff,
  annotations: ITimelapseAnnotation[],
) {
  const currentTime = time.value;

  const hoveredId = hoveredAnnotationId.value;
  const isSelected = isAnnotationSelected.value;
  // Mutated and re-read each iteration; safe because the factory copies the
  // options it is handed (verified: 1,425 points hold 1,425 distinct style
  // objects), so later iterations can't retroactively restyle earlier points.
  const baseStyle: ITimelapsePointBaseStyle = {
    fillColor: "white",
    fillOpacity: 1,
    strokeOpacity: 1,
    radius: 0.09,
  };
  const unrolledCentroids = unrolledCentroidCoordinates.value;
  const len = annotations.length;
  for (let i = 0; i < len; i++) {
    const annotation = annotations[i];
    const locationTime = annotation.location.Time;

    baseStyle.fillColor =
      annotation.trackPositionType === TrackPositionType.ORPHAN
        ? "gray"
        : "white";
    baseStyle.fillOpacity = locationTime < currentTime ? 0.5 : 1;
    baseStyle.strokeOpacity = locationTime < currentTime ? 0.5 : 1;
    baseStyle.radius = locationTime === currentTime ? 0.16 : 0.09;

    const centroid = unrolledCentroids[annotation.id];
    if (!centroid) {
      continue;
    }
    materializeTimelapseFeature(
      diff,
      "p|" + annotation.id,
      AnnotationShape.Point,
      [centroid],
      [centroid.x, centroid.y],
      {
        time: annotation.location.Time,
        girderId: annotation.id,
        isTimelapsePoint: true,
        // Kept on the feature for the same reason as timelapseBaseStyle on a
        // segment: the unhighlighted appearance has to be recoverable so a
        // selection change can be repainted without rebuilding the layer.
        timelapsePointBaseStyle: { ...baseStyle },
        style: getTimelapsePointStyle(
          baseStyle,
          isSelected(annotation.id),
          annotation.id === hoveredId,
        ),
      },
    );
  }

  if (showTimelapseLabels.value) {
    const textPoints: IGeoJSPosition[] = [];
    const textLabels: string[] = [];
    const textStyles: { fontSize?: string }[] = [];
    const textColors: string[] = [];

    const orphanLen = annotations.length;
    const orphanAnnotations: ITimelapseAnnotation[] = [];
    for (let i = 0; i < orphanLen; i++) {
      const a = annotations[i];
      if (a.trackPositionType === TrackPositionType.ORPHAN) {
        orphanAnnotations.push(a);
      }
    }
    for (const orphanAnnotation of orphanAnnotations) {
      textPoints.push(unrolledCentroidCoordinates.value[orphanAnnotation.id]);
      textLabels.push(`t=${orphanAnnotation.location.Time + 1}`);
      textStyles.push({});
      textColors.push("gray");
    }

    const startAnnotationsLength = annotations.length;
    const startAnnotations: ITimelapseAnnotation[] = [];
    for (let i = 0; i < startAnnotationsLength; i++) {
      const a = annotations[i];
      if (a.trackPositionType === TrackPositionType.START) {
        startAnnotations.push(a);
      }
    }
    for (const startAnnotation of startAnnotations) {
      if (startAnnotation.location.Time !== currentTime) {
        textPoints.push(unrolledCentroidCoordinates.value[startAnnotation.id]);
        textLabels.push(`T=${startAnnotation.location.Time + 1}`);
        textStyles.push({});
        textColors.push("white");
      }
    }

    const endAnnotationsLength = annotations.length;
    const endAnnotations: ITimelapseAnnotation[] = [];
    for (let i = 0; i < endAnnotationsLength; i++) {
      const a = annotations[i];
      if (a.trackPositionType === TrackPositionType.END) {
        endAnnotations.push(a);
      }
    }
    for (const endAnnotation of endAnnotations) {
      if (endAnnotation.location.Time !== currentTime) {
        textPoints.push(unrolledCentroidCoordinates.value[endAnnotation.id]);
        textLabels.push(`T=${endAnnotation.location.Time + 1}`);
        textStyles.push({});
        textColors.push("white");
      }
    }

    const currentAnnotationsLength = annotations.length;
    const currentAnnotations: ITimelapseAnnotation[] = [];
    for (let i = 0; i < currentAnnotationsLength; i++) {
      const a = annotations[i];
      if (a.trackPositionType === TrackPositionType.CURRENT) {
        currentAnnotations.push(a);
      }
    }
    for (const currentAnnotationItem of currentAnnotations) {
      textPoints.push(
        unrolledCentroidCoordinates.value[currentAnnotationItem.id],
      );
      textLabels.push(`Curr T=${currentTime + 1}`);
      textStyles.push({ fontSize: "16px" });
      textColors.push("white");
    }

    props.timelapseTextLayer
      .createFeature("text")
      .data(textPoints)
      .position((d: IGeoJSPosition) => d)
      .style({
        text: (_: IGeoJSPosition, i: number) => textLabels[i],
        fontSize: (_: IGeoJSPosition, i: number) =>
          textStyles[i].fontSize || "12px",
        fontFamily: "sans-serif",
        textAlign: "center",
        textBaseline: "bottom",
        color: (_: IGeoJSPosition, i: number) => textColors[i],
        textStrokeColor: "black",
        textStrokeWidth: 2,
        offset: { x: 0, y: -10 },
      });
  }
}

function createGeoJSAnnotation(
  annotation: TAnnotationOrStub,
  layerId?: string,
) {
  // No sized frame ⇒ no tile size to place the shape against.
  if (!store.dataset?.anyImage()) {
    return null;
  }

  const isStub = !isHydratedAnnotation(annotation);
  let coordinates: IGeoJSPosition[];
  let renderShape: AnnotationShape;

  if (isHydratedAnnotation(annotation)) {
    coordinates = unrolledCoordinates(
      annotation.coordinates,
      annotation.location,
      unrollLayout.value,
    );
    renderShape = annotation.shape;
  } else {
    coordinates = unrolledCoordinates(
      [annotation.centroid],
      annotation.location,
      unrollLayout.value,
    );
    renderShape = AnnotationShape.Point;
  }

  const layer = store.getLayerFromId(layerId);
  const customColor = annotation.color;
  // Only meaningful for stubs (dots); for full annotations it stays the default
  // 5 and is never read on the shape path (Finding 18/20). The
  // !isHydratedAnnotation narrow is what lets TS reach `.estimatedRadius`.
  const stubRadius = !isHydratedAnnotation(annotation)
    ? annotation.estimatedRadius ?? 5
    : 5;
  const style = drawnFeatureUsesDotStyle(isStub, annotation.shape)
    ? getStubStyleFromBaseStyle(
        customColor || layer?.color,
        annotation.id === hoveredAnnotationId.value,
        isAnnotationSelected.value(annotation.id),
        stubRadius,
        getStubScaled(),
        store.annotationOpacity,
      )
    : getAnnotationStyle(annotation.id, customColor, layer?.color);

  const options = {
    girderId: annotation.id,
    isHovered: annotation.id === hoveredAnnotationId.value,
    isSelected: isAnnotationSelected.value(annotation.id),
    location: annotation.location,
    channel: annotation.channel,
    color: annotation.color,
    layerId,
    customColor,
    style,
    isStub,
    annotationShape: annotation.shape,
    stubRadius,
    // Geometry fingerprint (Finding 1): lets clearOldAnnotations detect an
    // in-place coordinate edit and redraw the feature instead of keeping the
    // stale shape.
    geometryKey: geometryKeyForRender(annotation),
  };

  return geojsAnnotationFactory(renderShape, coordinates, options);
}

function drawGeoJSAnnotationFromConnection(
  connection: IAnnotationConnection,
  parentCentroid: IGeoJSPosition,
  childCentroid: IGeoJSPosition,
) {
  // Takes centroids rather than annotations: the line only ever needed the two
  // positions, and looking annotations up here coupled drawing to hydration.
  const pA = { ...childCentroid };
  delete pA.z;
  const pB = { ...parentCentroid };
  delete pB.z;
  const line = geojs.annotation.lineAnnotation();
  line.options("vertices", [pA, pB]);
  // Style at construction, not only via restyleAnnotations: a selected
  // connection that gets torn down and rebuilt (panning away and back, or
  // toggling connection rendering) would otherwise come back default-blue and
  // stay that way until the next selection or hover change.
  line.options("style", {
    ...line.options("style"),
    ...getConnectionStyle(
      connectionListStore.isConnectionSelected(connection.id),
      connection.id === connectionListStore.hoveredConnectionId,
    ),
  });
  line.options("isConnection", true);
  line.options("childId", connection.childId);
  line.options("parentId", connection.parentId);
  line.options("girderId", connection.id);
  props.annotationLayer.addAnnotation(line, undefined, false);
}

async function createAnnotationFromTool(
  coordinates: IGeoJSPosition[],
  tool: IToolConfiguration,
) {
  if (!coordinates || !coordinates.length || !dataset.value) {
    return null;
  }
  const annotation = await annotationStore.addAnnotationFromTool({
    coordinates,
    toolConfiguration: tool,
    datasetId: dataset.value.id,
  });
  drawAnnotationsAndTooltips();
  return annotation;
}

function restyleAnnotations() {
  const annotations = props.annotationLayer.annotations();
  const len = annotations.length;
  const stubScaled = getStubScaled();
  for (let i = 0; i < len; i++) {
    const geoJSAnnotation = annotations[i];
    const {
      girderId,
      layerId,
      style,
      customColor,
      isConnection,
      isStub,
      annotationShape,
      stubRadius,
    } = geoJSAnnotation.options();
    if (girderId && !isConnection) {
      const layer = store.getLayerFromId(layerId);
      const newStyle = drawnFeatureUsesDotStyle(isStub, annotationShape)
        ? getStubStyleFromBaseStyle(
            customColor || layer?.color,
            girderId === hoveredAnnotationId.value,
            isAnnotationSelected.value(girderId),
            stubRadius,
            stubScaled,
            store.annotationOpacity,
          )
        : getAnnotationStyle(girderId, customColor, layer?.color);
      geoJSAnnotation.options("style", Object.assign({}, style, newStyle));
    } else if (girderId && isConnection) {
      // Normal-mode connection lines are restyled in place. (Timelapse track
      // lines are rebuilt on every draw instead, so they pick up the selection
      // at build time in drawTimelapseTrack.)
      geoJSAnnotation.options(
        "style",
        Object.assign(
          {},
          style,
          getConnectionStyle(
            connectionListStore.isConnectionSelected(girderId),
            girderId === connectionListStore.hoveredConnectionId,
          ),
        ),
      );
    }
  }
  props.annotationLayer.draw();
}

function getConnectionStyle(isSelected: boolean, isHovered: boolean) {
  if (isSelected) {
    return {
      stroke: true,
      strokeColor: CONNECTION_SELECTED_COLOR,
      strokeWidth: 6,
      strokeOpacity: 1,
    };
  }
  // Every branch must set strokeColor AND strokeWidth: restyle merges over the
  // feature's existing style, so a branch that omits strokeColor would leave a
  // deselected line stuck on the selection highlight.
  return {
    ...CONNECTION_BASE_STYLE,
    strokeWidth: isHovered ? 5 : CONNECTION_BASE_STYLE.strokeWidth,
  };
}

// C4: restyle iterates every drawn feature and redraws the layer, so rapid
// restyle triggers (opacity-slider drag, fast selection/hover changes over a
// dense field) can briefly lock the UI. Throttle it like the draw path — the
// leading edge keeps the first change instant, the trailing edge coalesces a
// burst into one final restyle with the latest state.
const restyleAnnotationsThrottled = throttle(restyleAnnotations, THROTTLE);

// A timelapse track segment's appearance minus the highlight: colour from its
// connected component (or the red of a skipped frame), width from whether its
// frame is before or after the current one. Stored on the feature so a
// selection or hover change can repaint it without knowing its track.
interface ITimelapseSegmentBaseStyle {
  strokeColor?: string;
  strokeWidth: number;
  strokeOpacity: number;
  lineDash?: number[];
}

// A timelapse centroid dot's appearance minus the highlight: fill from its
// track position (orphan vs member), opacity and radius from its timepoint
// relative to the current one.
interface ITimelapsePointBaseStyle {
  fillColor: string;
  fillOpacity: number;
  strokeOpacity: number;
  radius: number;
}

/**
 * Style for a timelapse centroid dot.
 *
 * The dots had NO selection or hover branch at all, so selecting a track's
 * objects — which is exactly what the Connections tab's per-track Select
 * action does — produced no visible change anywhere in timelapse mode. Only
 * connections reacted to selection there, which made a working object
 * selection read as "it selected the links instead". Selected dots take the
 * same cyan as selected segments so one colour means "selected" throughout the
 * mode.
 *
 * Every branch sets every key: this object REPLACES the feature's style rather
 * than merging, so an omitted key strands the previous highlight.
 */
function getTimelapsePointStyle(
  base: ITimelapsePointBaseStyle,
  isSelected: boolean,
  isHovered: boolean,
) {
  return {
    scaled: 1,
    fill: true,
    fillColor: base.fillColor,
    // A selected dot is fully opaque even in the past, or the highlight fades
    // out on exactly the frames a track is being reviewed on.
    fillOpacity: isSelected || isHovered ? 1 : base.fillOpacity,
    stroke: true,
    strokeColor: isSelected
      ? TIMELAPSE_POINT_SELECTED_COLOR
      : isHovered
        ? "white"
        : "black",
    strokeWidth: isSelected ? 3 : isHovered ? 2 : 1,
    strokeOpacity: isSelected || isHovered ? 1 : base.strokeOpacity,
    // Grown so the ring reads at the 0.09 radius the non-current frames use.
    radius: isSelected ? base.radius + 0.05 : base.radius,
  };
}

function getTimelapseSegmentStyle(
  base: ITimelapseSegmentBaseStyle,
  isSelected: boolean,
  isHovered: boolean,
) {
  // Every branch sets every key, for the same reason as getConnectionStyle:
  // this object replaces the feature's style rather than merging into it, so an
  // omitted key strands the previous highlight — and an omitted `stroke` leaves
  // the segment present, correctly positioned and completely unpainted.
  return {
    stroke: true,
    strokeColor: isSelected ? CONNECTION_SELECTED_COLOR : base.strokeColor,
    strokeWidth: base.strokeWidth + (isSelected ? 3 : isHovered ? 2 : 0),
    strokeOpacity: isSelected || isHovered ? 1 : base.strokeOpacity,
    lineDash: base.lineDash,
  };
}

// The timelapse counterpart of restyleAnnotations, covering BOTH kinds of
// feature the layer holds: track segments and centroid dots.
//
// Connection selection additionally runs the diff-based rebuild pass (it
// decides which duplicate represents a pair, a materialization-time choice),
// but hover changes continuously as the pointer runs down the connection list,
// and running the full desired-set computation per row made the list feel
// sluggish — so hover repaints in place. Not a cosmetic nicety: clicking a row
// HIGHLIGHTS rather than selects, so without it the main way of finding a
// connection has no visible effect at all in timelapse mode.
//
// Dots go through the same in-place path. `restyleAnnotations` only ever
// touches `annotationLayer`, so before this the timelapse dots had no restyle
// route of any kind and object selection was invisible in the mode.
function restyleTimelapseFeatures() {
  const annotations = props.timelapseLayer.annotations();
  const len = annotations.length;
  const hoveredConnectionId = connectionListStore.hoveredConnectionId;
  const isConnectionSelected = connectionListStore.isConnectionSelected;
  const hoveredObjectId = hoveredAnnotationId.value;
  const isObjectSelected = isAnnotationSelected.value;
  let restyled = false;
  for (let i = 0; i < len; i++) {
    const geoJSAnnotation = annotations[i];
    const {
      isConnection,
      connectionIds,
      timelapseBaseStyle,
      isTimelapsePoint,
      timelapsePointBaseStyle,
      girderId,
      style,
    } = geoJSAnnotation.options();

    // Assigning a style marks the layer modified, which makes GeoJS rebuild
    // every feature's render data on the next draw. Usually only a handful of
    // features change, so each branch compares exactly the keys IT sets and
    // leaves the rest untouched — the draw is skipped entirely when nothing
    // changed.
    let newStyle;
    if (isConnection && connectionIds && timelapseBaseStyle) {
      const segmentStyle = getTimelapseSegmentStyle(
        timelapseBaseStyle,
        connectionIds.some((id: string) => isConnectionSelected(id)),
        hoveredConnectionId !== null &&
          connectionIds.includes(hoveredConnectionId),
      );
      if (
        style?.strokeColor === segmentStyle.strokeColor &&
        style?.strokeWidth === segmentStyle.strokeWidth &&
        style?.strokeOpacity === segmentStyle.strokeOpacity
      ) {
        continue;
      }
      newStyle = segmentStyle;
    } else if (isTimelapsePoint && timelapsePointBaseStyle && girderId) {
      const pointStyle = getTimelapsePointStyle(
        timelapsePointBaseStyle,
        isObjectSelected(girderId),
        girderId === hoveredObjectId,
      );
      if (
        style?.strokeColor === pointStyle.strokeColor &&
        style?.strokeWidth === pointStyle.strokeWidth &&
        style?.strokeOpacity === pointStyle.strokeOpacity &&
        style?.fillOpacity === pointStyle.fillOpacity &&
        style?.radius === pointStyle.radius
      ) {
        continue;
      }
      newStyle = pointStyle;
    } else {
      continue;
    }

    geoJSAnnotation.options("style", Object.assign({}, style, newStyle));
    restyled = true;
  }
  if (restyled) {
    props.timelapseLayer.draw();
  }
}

const restyleTimelapseFeaturesThrottled = throttle(
  restyleTimelapseFeatures,
  THROTTLE,
);

function pointNearPoint(
  selectionPosition: IGeoJSPosition,
  annotationPosition: IGeoJSPosition,
  radius: number,
  strokeWidth: number,
  unitsPerPixel: number,
): boolean {
  const annotationRadius =
    ((radius as number) + (strokeWidth as number)) * unitsPerPixel;
  return (
    pointDistance(selectionPosition, annotationPosition) < annotationRadius
  );
}

// Click tolerance for connection lines, in display pixels. Deliberately not
// routed through pointNearLine: that helper compares a *squared* distance
// against an unsquared width, so its effective tolerance shrinks as you zoom
// out and connection lines become unclickable. Existing callers depend on that
// behavior, so connections get their own correct comparison instead.
const CONNECTION_CLICK_TOLERANCE_PX = 6;

/**
 * Squared distance from `position` to the nearest segment of `linePoints`, or
 * `null` when every segment is outside the click tolerance.
 *
 * Returns the distance rather than a boolean so callers can pick the CLOSEST
 * line among several within tolerance — with parallel or dense tracks, taking
 * the first match selects whichever happened to be drawn earlier and leaves
 * some links unreachable from the canvas entirely.
 */
function connectionLineHitDistance(
  position: IGeoJSPosition,
  linePoints: IGeoJSPosition[],
  unitsPerPixel: number,
): number | null {
  const tolerance = CONNECTION_CLICK_TOLERANCE_PX * unitsPerPixel;
  const toleranceSquared = tolerance * tolerance;
  let best: number | null = null;
  for (let i = 0; i < linePoints.length - 1; i++) {
    const distanceSquared = geojs.util.distance2dToLineSquared(
      position,
      linePoints[i],
      linePoints[i + 1],
    );
    if (distanceSquared < toleranceSquared) {
      best = best === null ? distanceSquared : Math.min(best, distanceSquared);
    }
  }
  return best;
}

/**
 * The connection whose drawn line is under `position`, or null.
 *
 * Timelapse mode draws its own connection lines on a separate layer; when it is
 * on, those are what the user sees, so search it first.
 */
function findConnectionIdAtPoint(position: IGeoJSPosition): string | null {
  const unitsPerPixel = getMapUnitsPerPixel();
  const layers = showTimelapseMode.value
    ? [props.timelapseLayer, props.annotationLayer]
    : [props.annotationLayer];
  for (const layer of layers) {
    const geoAnnotations = layer.annotations();
    // Closest wins WITHIN a layer; layer order still decides between layers,
    // because in timelapse mode the track lines are what the user can see.
    let closestId: string | null = null;
    let closestDistance = Infinity;
    for (let i = 0; i < geoAnnotations.length; i++) {
      const geoJSAnnotation = geoAnnotations[i];
      const { girderId, isConnection } = geoJSAnnotation.options();
      if (!isConnection || !girderId) {
        continue;
      }
      const distance = connectionLineHitDistance(
        position,
        geoJSAnnotation.coordinates(),
        unitsPerPixel,
      );
      if (distance !== null && distance < closestDistance) {
        closestDistance = distance;
        closestId = girderId;
      }
    }
    if (closestId) {
      return closestId;
    }
  }
  return null;
}

function pointNearLine(
  selectionPosition: IGeoJSPosition,
  linePoints: IGeoJSPosition[],
  strokeWidth: number,
  unitsPerPixel: number,
): boolean {
  const width = (strokeWidth as number) * unitsPerPixel;
  return linePoints.reduce(
    (isIn: boolean, point: IGeoJSPosition, index: number) => {
      if (index === linePoints.length - 1) {
        return isIn || pointDistance(point, selectionPosition) < width;
      }
      return (
        isIn ||
        geojs.util.distance2dToLineSquared(
          selectionPosition,
          point,
          linePoints[index + 1],
        ) < width
      );
    },
    false,
  );
}

function shouldSelectAnnotation(
  selectionAnnotationType: AnnotationShape,
  selectionAnnotationCoordinates: IGeoJSPosition[],
  annotation: IAnnotation,
  annotationStyle: IGeoJSPointFeatureStyle &
    IGeoJSLineFeatureStyle &
    IGeoJSPolygonFeatureStyle,
  unitsPerPixel: number,
) {
  const annotationCoordinates = annotation.coordinates;

  if (selectionAnnotationType === AnnotationShape.Point) {
    const selectionPosition = selectionAnnotationCoordinates[0];
    const { radius, strokeWidth } = annotationStyle;

    if (annotation.shape === AnnotationShape.Point) {
      return pointNearPoint(
        selectionPosition,
        annotationCoordinates[0],
        radius as number,
        strokeWidth as number,
        unitsPerPixel,
      );
    } else if (annotation.shape === AnnotationShape.Line) {
      return pointNearLine(
        selectionPosition,
        annotationCoordinates,
        strokeWidth as number,
        unitsPerPixel,
      );
    } else {
      return geojs.util.pointInPolygon(
        selectionPosition,
        annotationCoordinates,
      );
    }
  } else {
    return annotation.coordinates.some((point: IGeoJSPosition) => {
      return geojs.util.pointInPolygon(point, selectionAnnotationCoordinates);
    });
  }
}

// Resolve a selection candidate id to its hydrated/full annotation, or its stub
// when unhydrated. In stub-only mode most displayed annotations are unhydrated;
// getAnnotationFromId materializes point stubs but returns undefined for
// non-point stubs, which would silently drop them from selection — so fall back
// to the stub.
function resolveSelectionCandidate(id: string): TAnnotationOrStub | undefined {
  return getAnnotationFromId.value(id) ?? annotationStore.getStub(id);
}

// Drag-select containment: hydrated annotations test their full coordinates
// (precise); unhydrated stubs fall back to their centroid (they render as a dot
// there). Geometry-dependent operations refine after hydrate-on-selection.
function selectionCandidateInPolygon(
  candidate: TAnnotationOrStub,
  polygon: IGeoJSPosition[],
): boolean {
  if (isHydratedAnnotation(candidate)) {
    return candidate.coordinates.some((point: IGeoJSPosition) =>
      geojs.util.pointInPolygon(point, polygon),
    );
  }
  return geojs.util.pointInPolygon(candidate.centroid, polygon);
}

// Click hit-test for an unhydrated stub: it renders as a dot at its centroid,
// so test proximity to that dot using the rendered style.
function shouldSelectStub(
  clickPosition: IGeoJSPosition,
  stub: IAnnotationStub,
  annotationStyle: IGeoJSPointFeatureStyle,
  unitsPerPixel: number,
): boolean {
  // Unlike a normal point feature (whose radius is in display pixels), the stub
  // dot renders world-locked: its style.radius is estimatedRadius in world
  // (image-pixel) units, via `scaled` (getStubStyleFromBaseStyle). clickPosition
  // and stub.centroid are also world units, so compare directly — do NOT route
  // through pointNearPoint, which multiplies the radius by unitsPerPixel and
  // would shrink/expand the hit area relative to the rendered dot at any zoom
  // where unitsPerPixel !== 1. Only strokeWidth is in display pixels, so convert
  // just that term.
  const radius = (annotationStyle.radius as number) ?? 0;
  const strokeWidth = (annotationStyle.strokeWidth as number) ?? 0;
  const hitRadius = radius + strokeWidth * unitsPerPixel;
  return pointDistance(clickPosition, stub.centroid) < hitRadius;
}

function getSelectedAnnotationsFromAnnotation(
  selectAnnotation: IGeoJSAnnotation,
) {
  if (!store.drawAnnotations) {
    return [];
  }
  const coordinates = selectAnnotation.coordinates();
  const type = selectAnnotation.type();

  const unitsPerPixel = getMapUnitsPerPixel();
  const selectedAnns: TAnnotationOrStub[] = [];
  const selectedIds = new Set<string>();

  // For drag-select (non-point selection), use spatial index if available
  if (type !== AnnotationShape.Point) {
    const spatialIndex = displayedAnnotationsSpatialIndex.value;

    // Compute bounding box of selection region
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < coordinates.length; i++) {
      const c = coordinates[i];
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }

    if (spatialIndex) {
      // Query displayed annotations spatial index (bbox-based, precise)
      const candidates = spatialIndex.search({ minX, minY, maxX, maxY });
      for (let i = 0; i < candidates.length; i++) {
        const { annotationId } = candidates[i];
        if (selectedIds.has(annotationId)) {
          continue;
        }
        const candidate = resolveSelectionCandidate(annotationId);
        if (
          !candidate ||
          !selectionCandidateInPolygon(candidate, coordinates)
        ) {
          continue;
        }
        selectedIds.add(annotationId);
        selectedAnns.push(candidate);
      }
    } else {
      // Fallback: linear scan over GeoJS annotations (tree not yet built)
      const geoAnnotations = props.annotationLayer.annotations();
      for (let i = 0; i < geoAnnotations.length; i++) {
        const geoJSannotation = geoAnnotations[i];
        const { girderId, isConnection } = geoJSannotation.options();
        if (!girderId || isConnection || selectedIds.has(girderId)) {
          continue;
        }
        const candidate = resolveSelectionCandidate(girderId);
        if (
          !candidate ||
          !selectionCandidateInPolygon(candidate, coordinates)
        ) {
          continue;
        }
        selectedIds.add(girderId);
        selectedAnns.push(candidate);
      }
    }

    // Also select non-visible annotations via global centroid spatial index.
    // This catches annotations outside the visibility budget but in the
    // selection region on the current frame.
    const globalCandidateIds = annotationSpatialIndex.queryBox(
      minX,
      minY,
      maxX,
      maxY,
    );
    for (const annotationId of globalCandidateIds) {
      if (selectedIds.has(annotationId)) {
        continue;
      }
      // These are non-visible annotations — in stub-only mode almost always
      // unhydrated — so resolve to the stub and gate/contain on its
      // location/centroid, or they are all silently skipped.
      const candidate = resolveSelectionCandidate(annotationId);
      if (!candidate) {
        continue;
      }
      if (!annotationMatchesRasterSelectors(candidate, rasterSelectors.value)) {
        continue;
      }
      if (!selectionCandidateInPolygon(candidate, coordinates)) {
        continue;
      }
      selectedIds.add(annotationId);
      selectedAnns.push(candidate);
    }

    return selectedAnns;
  }

  // Point selection (click): iterate GeoJS annotations for style-aware hit testing
  const geoAnnotations = props.annotationLayer.annotations();
  const len = geoAnnotations.length;

  for (let i = 0; i < len; i++) {
    const geoJSannotation = geoAnnotations[i];
    const { girderId, isConnection } = geoJSannotation.options();
    if (!girderId || isConnection || selectedIds.has(girderId)) {
      continue;
    }

    const candidate = resolveSelectionCandidate(girderId);
    if (!candidate) {
      continue;
    }
    const hit = isHydratedAnnotation(candidate)
      ? shouldSelectAnnotation(
          type,
          coordinates,
          candidate,
          geoJSannotation.style(),
          unitsPerPixel,
        )
      : shouldSelectStub(
          coordinates[0],
          candidate,
          geoJSannotation.style(),
          unitsPerPixel,
        );
    if (!hit) {
      continue;
    }

    selectedIds.add(girderId);
    selectedAnns.push(candidate);
  }

  return selectedAnns;
}

function shouldSelectGeoJSAnnotation(
  selectionAnnotationType: AnnotationShape,
  selectionAnnotationCoordinates: IGeoJSPosition[],
  geoJSAnnotation: IGeoJSAnnotation,
  unitsPerPixel: number,
  radius?: number,
) {
  const annotationCoordinates = geoJSAnnotation.coordinates();
  const annotationStyle = geoJSAnnotation.style();

  if (selectionAnnotationType === AnnotationShape.Point) {
    const selectionPosition = selectionAnnotationCoordinates[0];
    if (!radius) {
      radius = annotationStyle.radius;
    }
    const strokeWidth = annotationStyle.strokeWidth;

    if (geoJSAnnotation.type() === AnnotationShape.Point) {
      return pointNearPoint(
        selectionPosition,
        annotationCoordinates[0],
        radius as number,
        strokeWidth as number,
        unitsPerPixel,
      );
    } else if (geoJSAnnotation.type() === AnnotationShape.Line) {
      return pointNearLine(
        selectionPosition,
        annotationCoordinates,
        strokeWidth as number,
        unitsPerPixel,
      );
    } else {
      return geojs.util.pointInPolygon(
        selectionPosition,
        annotationCoordinates,
      );
    }
  } else {
    return annotationCoordinates.some((point: IGeoJSPosition) => {
      return geojs.util.pointInPolygon(point, selectionAnnotationCoordinates);
    });
  }
}

function getTimelapseAnnotationsFromAnnotation(
  selectAnnotation: IGeoJSAnnotation,
) {
  const coordinates = selectAnnotation.coordinates();
  const type = selectAnnotation.type();

  const unitsPerPixel = getMapUnitsPerPixel();
  const selectedAnns: IGeoJSAnnotation[] = [];
  const annotations = props.timelapseLayer.annotations();
  const len = annotations.length;

  for (let i = 0; i < len; i++) {
    const geoJSAnnotation = annotations[i];
    const { isTimelapsePoint } = geoJSAnnotation.options();
    if (!isTimelapsePoint) {
      continue;
    }

    if (
      !shouldSelectGeoJSAnnotation(
        type,
        coordinates,
        geoJSAnnotation,
        unitsPerPixel,
        5,
      )
    ) {
      continue;
    }

    selectedAnns.push(geoJSAnnotation);
  }

  return selectedAnns;
}

function selectAnnotations(selectAnnotation: IGeoJSAnnotation) {
  if (!selectAnnotation) {
    return;
  }
  const selected = getSelectedAnnotationsFromAnnotation(selectAnnotation);
  const selectedIds = selected.map((a) => a.id);

  // Connections are only selectable by CLICK — drag/lasso never selects them,
  // because a box select is for objects and letting it grab lines would make
  // every one of them ambiguous.
  if (selectAnnotation.type() === AnnotationShape.Point) {
    const clickPosition = selectAnnotation.coordinates()[0];
    const connectionId = clickPosition
      ? findConnectionIdAtPoint(clickPosition)
      : null;
    // Objects normally win, so a line crossing an object never steals its
    // click. Timelapse mode inverts that for the same reason the hover path
    // does: the track segments are the visual and the annotation dots sit
    // underneath, so a segment almost always overlaps one and object-first
    // would make most track links unselectable. Keep the two paths in step —
    // this rule has to hold for shift+click and the select tool, not just for
    // plain-click highlighting.
    const connectionWins =
      connectionId && (selectedIds.length === 0 || showTimelapseMode.value);
    if (connectionWins) {
      connectionListStore.setSelectedConnectionIds([connectionId]);
      props.interactionLayer.removeAnnotation(selectAnnotation);
      return;
    }
    // Clicking empty space clears the connection selection, matching how
    // clicking away deselects annotations.
    if (
      selectedIds.length === 0 &&
      connectionListStore.selectedConnectionIds.size > 0
    ) {
      connectionListStore.setSelectedConnectionIds([]);
    }
  }

  switch (annotationSelectionType.value) {
    case AnnotationSelectionTypes.ADD:
      annotationStore.selectAnnotations(selectedIds);
      break;
    case AnnotationSelectionTypes.REMOVE:
      annotationStore.unselectAnnotations(selectedIds);
      break;
    case AnnotationSelectionTypes.TOGGLE:
      annotationStore.toggleSelected(selectedIds);
  }

  props.interactionLayer.removeAnnotation(selectAnnotation);
}

async function handleAnnotationConnections(selectAnnotation: IGeoJSAnnotation) {
  const datasetId = dataset.value?.id;
  if (!selectAnnotation || !datasetId || !selectedToolConfiguration.value) {
    return;
  }

  let selectedAnns: TAnnotationOrStub[];
  if (showTimelapseMode.value) {
    const selectedGeoJSAnnotations =
      getTimelapseAnnotationsFromAnnotation(selectAnnotation);
    selectedAnns = selectedGeoJSAnnotations
      .map((a) => getAnnotationFromId.value(a.options().girderId))
      .filter((a): a is IAnnotation => a !== undefined);
  } else {
    selectedAnns = getSelectedAnnotationsFromAnnotation(selectAnnotation);
  }

  const parentTemplate = selectedToolConfiguration.value.values
    ?.parentAnnotation as IRestrictTagsAndLayer;
  const childTemplate = selectedToolConfiguration.value.values
    ?.childAnnotation as IRestrictTagsAndLayer;
  if (!parentTemplate || !childTemplate) {
    return;
  }
  const parents = filterAnnotations(selectedAnns, parentTemplate);
  const children = filterAnnotations(selectedAnns, childTemplate);
  const parentIds = parents.map((a) => a.id);
  const childIds = children.map((a) => a.id);

  const action = selectedToolConfiguration.value.values.action.value;
  const addAction = action.startsWith("add");
  const clickAction = action.endsWith("click");
  const clickedAnnotation = selectedAnns[0];

  if (addAction) {
    if (clickAction) {
      if (
        clickedAnnotation &&
        selectedToolState.value?.type === ConnectionToolStateSymbol &&
        (selectedToolState.value as any).selectedAnnotationId
      ) {
        if (showTimelapseMode.value) {
          annotationStore.createTimelapseConnection({
            parentId: (selectedToolState.value as any).selectedAnnotationId,
            childId: clickedAnnotation.id,
            datasetId,
            label: selectedToolConfiguration.value.name,
            tags: ["Time lapse connection"],
          });
        } else {
          annotationStore.createConnection({
            parentId: (selectedToolState.value as any).selectedAnnotationId,
            childId: clickedAnnotation.id,
            datasetId,
            label: selectedToolConfiguration.value.name,
            tags: [...parentTemplate.tags, ...childTemplate.tags],
          });
        }
      }
    } else {
      if (showTimelapseMode.value) {
        await annotationStore.createAllTimelapseConnections({
          parentIds,
          childIds,
          label: selectedToolConfiguration.value.name,
          tags: ["Time lapse connection"],
        });
      } else {
        await annotationStore.createAllConnections({
          parentIds,
          childIds,
          label: selectedToolConfiguration.value.name,
          tags: [...parentTemplate.tags, ...childTemplate.tags],
        });
      }
    }
  } else {
    if (clickAction) {
      if (
        clickedAnnotation &&
        selectedToolState.value?.type === ConnectionToolStateSymbol &&
        (selectedToolState.value as any).selectedAnnotationId
      ) {
        const firstId = (selectedToolState.value as any).selectedAnnotationId;
        const secondId = clickedAnnotation.id;
        annotationStore.deleteAllConnections({
          childIds: [firstId, secondId],
          parentIds: [firstId, secondId],
        });
      }
    } else {
      await annotationStore.deleteAllConnections({
        parentIds,
        childIds,
      });
    }
  }

  if (
    clickAction &&
    selectedToolState.value?.type === ConnectionToolStateSymbol
  ) {
    const selectedId = (selectedToolState.value as any).selectedAnnotationId;
    (selectedToolState.value as any).selectedAnnotationId =
      selectedId || !clickedAnnotation ? null : clickedAnnotation.id;
  }

  props.interactionLayer.removeAnnotation(selectAnnotation);
}

async function handleAnnotationCombine(selectAnnotation: IGeoJSAnnotation) {
  if (!selectAnnotation || !selectedToolConfiguration.value) {
    return;
  }

  const selectedAnns = getSelectedAnnotationsFromAnnotation(selectAnnotation);

  const annotationTemplate = selectedToolConfiguration.value.values
    ?.annotation as IRestrictTagsAndLayer;
  const filteredAnns = annotationTemplate
    ? filterAnnotations(selectedAnns, annotationTemplate)
    : selectedAnns;

  const polygonAnnotations = filteredAnns.filter(
    (a) => a.shape === AnnotationShape.Polygon,
  );

  const clickedAnnotation = polygonAnnotations[0];

  // Combine needs real geometry. If the clicked polygon's coordinates aren't
  // loaded yet (stub-only mode), tell the user to zoom in rather than storing a
  // half-selection or failing the union silently (combineAnnotations would
  // not find the full annotation).
  if (clickedAnnotation && !isHydratedAnnotation(clickedAnnotation)) {
    notifyGeometryNotLoaded();
    props.interactionLayer.removeAnnotation(selectAnnotation);
    return;
  }

  if (
    clickedAnnotation &&
    selectedToolState.value?.type === CombineToolStateSymbol &&
    (selectedToolState.value as any).selectedAnnotationId
  ) {
    const firstAnnotationId = (selectedToolState.value as any)
      .selectedAnnotationId;
    const secondAnnotationId = clickedAnnotation.id;

    if (firstAnnotationId !== secondAnnotationId) {
      // The first-clicked annotation may have been dehydrated (LRU-evicted)
      // between the two clicks; combine still needs its geometry.
      if (!annotationStore.getHydratedAnnotation(firstAnnotationId)) {
        notifyGeometryNotLoaded();
        (selectedToolState.value as any).selectedAnnotationId = null;
        props.interactionLayer.removeAnnotation(selectAnnotation);
        return;
      }
      const tolerance = parseFloat(
        selectedToolConfiguration.value.values?.tolerance ?? "2",
      );

      const success = await annotationStore.combineAnnotations({
        firstAnnotationId,
        secondAnnotationId,
        tolerance: isNaN(tolerance) ? 2 : tolerance,
      });

      if (!success) {
        logWarning("Failed to combine annotations");
      }
    }

    (selectedToolState.value as any).selectedAnnotationId = null;
  } else if (
    clickedAnnotation &&
    selectedToolState.value?.type === CombineToolStateSymbol
  ) {
    (selectedToolState.value as any).selectedAnnotationId =
      clickedAnnotation.id;
  }

  props.interactionLayer.removeAnnotation(selectAnnotation);
}

async function addAnnotationFromGeoJsAnnotation(annotation: IGeoJSAnnotation) {
  if (!annotation || !selectedToolConfiguration.value) {
    return;
  }

  let coordinates = annotation.coordinates();
  props.interactionLayer.removeAnnotation(annotation);

  let toolConfiguration = selectedToolConfiguration.value;
  const shape = toolConfiguration.values.annotation?.shape;
  if (shape === AnnotationShape.Circle || shape === AnnotationShape.Ellipse) {
    if (shape === AnnotationShape.Circle) {
      const xs = coordinates.map((c) => c.x);
      const ys = coordinates.map((c) => c.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const r = Math.min(maxX - minX, maxY - minY) / 2;
      coordinates = [
        { x: cx - r, y: cy - r },
        { x: cx + r, y: cy - r },
        { x: cx + r, y: cy + r },
        { x: cx - r, y: cy + r },
      ];
    }
    coordinates = ellipseToPolygonCoordinates(coordinates);
    toolConfiguration = {
      ...toolConfiguration,
      values: {
        ...toolConfiguration.values,
        annotation: {
          ...toolConfiguration.values.annotation,
          shape: AnnotationShape.Polygon,
        },
      },
    };
  }

  await createAnnotationFromTool(coordinates, toolConfiguration);
}

async function addAnnotationFromSnapping(annotation: IGeoJSAnnotation) {
  if (!annotation || props.maps.length !== 1) {
    return;
  }
  const mapentry = props.maps[0];
  const coordinates = annotation.coordinates();
  props.interactionLayer.removeAnnotation(annotation);
  if (!selectedToolConfiguration.value) {
    return;
  }
  const location =
    selectedToolConfiguration.value.values.annotation.coordinateAssignments;
  if (!location) {
    logError("Invalid snapping tool, annotation was not configured properly");
    return;
  }
  const layerId = location.layer;
  const layerIndex = store.getLayerIndexFromId(layerId);
  if (layerIndex === null) {
    return;
  }
  const layerImage = mapentry.imageLayers[layerIndex * 2];
  if (!layerImage) {
    return;
  }
  const canvas = await mapentry.map.screenshot(layerImage, "canvas");
  const blob: Blob | null = await new Promise((r) => canvas.toBlob(r));
  if (!blob) {
    return;
  }
  const array = new Uint8Array(await blob.arrayBuffer());
  const snappedCoordinates = await snapCoordinates(
    coordinates,
    array,
    selectedToolConfiguration.value,
    mapentry.map,
  );
  if (!snappedCoordinates || !snappedCoordinates.length) {
    logError("Failed to compute new coordinates for the snapping tool");
    return;
  }
  await createAnnotationFromTool(
    snappedCoordinates,
    selectedToolConfiguration.value,
  );
}

// SAM-prompt example capture (samClick / samBox selection modes): called
// from consumeMouseState (the shift-gated custom mouse-capture path, same as
// SAM's own prompt flow), since the unified tool leaves the interaction layer
// in mode(null) for every selection mode (see setNewAnnotationMode's
// "objectSegmentation" case). A drag becomes a box prompt in either SAM mode.
function addObjectSegmentationExample(mouseState: IMouseState) {
  const state = objectSegmentationToolState.value;
  // Not in circle mode: there the captured path is the polygon example, not
  // a SAM prompt (see addObjectSegmentationCircleExample).
  if (!state || state.selectionMode === "circle") {
    return;
  }
  const newPrompt = mouseStateToSamPrompt(mouseState);
  if (!newPrompt) {
    return;
  }
  let polarity = state.nextPolarity;
  let prompt = newPrompt;
  if (prompt.type === PromptType.backgroundPoint) {
    // Right-click (or any non-primary button) is a quick negative example:
    // treat it as a foreground point at the same coordinates (SAM decodes
    // foreground and background points differently) but force background
    // polarity so it still counts as a negative example.
    prompt = { type: PromptType.foregroundPoint, point: prompt.point };
    polarity = "background";
  }
  const currentExamples = readManualInputOr(state.nodes.input.examples, []);
  // ManualInputNode-style: push a new array rather than mutating in place.
  state.nodes.input.examples.setValue([
    ...currentExamples,
    { polarity, prompt },
  ]);
  // The example just committed supersedes whatever the hover/drag preview
  // was showing under the cursor.
  state.nodes.input.previewPrompt.setValue(NoOutput, true);
}

// Freehand-lasso example capture (circle selection mode): the captured
// shift-drag path IS the example polygon (authoritative GCS coords, no
// decoder prompt). Also called from consumeMouseState - circle mode no longer
// uses a GeoJS polygon-draw interaction (so plain drag still pans).
function addObjectSegmentationCircleExample(mouseState: IMouseState) {
  const state = objectSegmentationToolState.value;
  if (!state || state.selectionMode !== "circle") {
    return;
  }
  const polygon = mouseState.path;
  if (polygon.length < 3) {
    return;
  }
  const currentExamples = readManualInputOr(state.nodes.input.examples, []);
  // ManualInputNode-style: push a new array rather than mutating in place.
  state.nodes.input.examples.setValue([
    ...currentExamples,
    { polarity: state.nextPolarity, prompt: null, polygon: [...polygon] },
  ]);
}

// ---- Linescan tool ----

const isLineScanSegmentTool = computed(
  () =>
    selectedToolConfiguration.value?.type === "linescan" &&
    selectedToolConfiguration.value.values.lineType?.value === "segment",
);

const lineScanDisplayStyle = {
  strokeColor: "white",
  strokeWidth: 2,
  strokeOpacity: 0.9,
  fill: false,
};

function removeLineScanAnnotation() {
  if (lineScanAnnotation.value) {
    props.interactionLayer.removeAnnotation(lineScanAnnotation.value);
    lineScanAnnotation.value = null;
  }
}

function clearLineScanState() {
  removeLineScanAnnotation();
  lineScanSegmentStart.value = null;
  lineScanStore.setSegmentStartPlaced(false);
}

// Display the scanned line on the interaction layer and publish it to the
// linescan store, where LineScanPanel picks it up to plot the intensities.
// The display annotation is recreated on every update: addAnnotation converts
// the image coordinates to map coordinates exactly once per added annotation,
// so mutating an already-added annotation's coordinates in place would leave
// them in the wrong coordinate space (drawn mirrored off-image).
function updateLineScanLine(
  coordinates: IGeoJSPosition[],
  isComplete: boolean,
) {
  removeLineScanAnnotation();
  const annotation = geojsAnnotationFactory(AnnotationShape.Line, coordinates, {
    style: { ...lineScanDisplayStyle },
  });
  if (annotation) {
    annotation.options("specialAnnotation", true);
    lineScanAnnotation.value = markRaw(annotation);
    props.interactionLayer.addAnnotation(annotation);
  }
  lineScanStore.setLine({
    points: coordinates.map(({ x, y }) => ({ x, y })),
    isComplete,
  });
}

// Live updates while the line is being drawn: segment previews between the
// two clicks, and freehand lines while the mouse button is held down.
// Bound to both mousemove (segment previews) and actionmove (freehand drags:
// geojs suppresses mousemove events while a drag action is active).
const handleLineScanMouseMove = throttle(
  (evt: { geo?: IGeoJSPosition; mouse?: IGeoJSMouseState }) => {
    const geo = evt?.geo ?? evt?.mouse?.geo;
    if (selectedToolConfiguration.value?.type !== "linescan" || !geo) {
      return;
    }
    if (isLineScanSegmentTool.value) {
      if (lineScanSegmentStart.value) {
        updateLineScanLine([lineScanSegmentStart.value, geo], false);
      }
    } else {
      // The layer always holds an empty in-create annotation while the tool
      // is armed; fewer than 2 coordinates means no drag is in progress and
      // the previously scanned line stays displayed
      const coordinates =
        props.interactionLayer.currentAnnotation?.coordinates() ?? [];
      if (coordinates.length < 2) {
        return;
      }
      // A new line is being drawn: geojs displays it while the drag is in
      // progress, so only replace the previous scan display and plot data
      removeLineScanAnnotation();
      lineScanStore.setLine({
        points: coordinates.map(({ x, y }) => ({ x, y })),
        isComplete: false,
      });
    }
  },
  THROTTLE,
);

// Freehand only: pressing to start a new drag clears the previously completed
// scan the moment the gesture begins, so the next line starts fresh without
// first pressing Clear. Segment (point) mode is excluded on purpose — there a
// left-drag pans the map, so clearing on mousedown would wipe the scan every
// time the user pans. Segment restarts are cleared on the first click instead
// (see handleLineScanAnnotationDone). Guarded on isComplete so it never fires
// while a freehand drag is still in progress.
function handleLineScanMouseDown() {
  if (
    selectedToolConfiguration.value?.type === "linescan" &&
    !isLineScanSegmentTool.value &&
    lineScanStore.isComplete
  ) {
    lineScanStore.clearLine();
  }
}

function handleLineScanAnnotationDone(annotation: IGeoJSAnnotation) {
  const coordinates = annotation.coordinates().map(({ x, y }) => ({ x, y }));
  props.interactionLayer.removeAnnotation(annotation);
  if (isLineScanSegmentTool.value) {
    // Two-click segment: first click starts the line, second click ends it
    if (lineScanSegmentStart.value === null) {
      removeLineScanAnnotation();
      lineScanSegmentStart.value = coordinates[0];
      lineScanStore.setSegmentStartPlaced(true);
      // Placing the first point of a new segment clears any previously
      // completed scan so its graph doesn't linger. Keep a single-point line
      // (not null) so the points watcher doesn't reset the segment start we
      // just set.
      lineScanStore.setLine({ points: [coordinates[0]], isComplete: false });
    } else {
      updateLineScanLine([lineScanSegmentStart.value, coordinates[0]], true);
      lineScanSegmentStart.value = null;
      lineScanStore.setSegmentStartPlaced(false);
    }
  } else if (coordinates.length >= 2) {
    removeLineScanAnnotation();
    updateLineScanLine(coordinates, true);
  }
}

async function handleAnnotationEdits(selectAnnotation: IGeoJSAnnotation) {
  const selectedAnns = getSelectedAnnotationsFromAnnotation(selectAnnotation);

  if (selectedAnns.length === 0) {
    props.interactionLayer.removeAnnotation(selectAnnotation);
    return;
  }

  // Polygon edits need real geometry, so restrict to hydrated polygons.
  const polygonAnns = selectedAnns.filter(
    (annotation): annotation is IAnnotation =>
      isHydratedAnnotation(annotation) &&
      annotation.shape === AnnotationShape.Polygon,
  );

  if (polygonAnns.length === 0) {
    // Distinguish "no polygon selected at all" (silent no-op, as before) from
    // "a polygon IS selected but its coordinates aren't loaded yet" (stub-only
    // mode) — the latter would otherwise silently do nothing, so tell the user
    // to zoom in to load it rather than dropping the edit.
    const hasUnhydratedPolygon = selectedAnns.some(
      (a) => !isHydratedAnnotation(a) && a.shape === AnnotationShape.Polygon,
    );
    if (hasUnhydratedPolygon) {
      notifyGeometryNotLoaded();
    }
    props.interactionLayer.removeAnnotation(selectAnnotation);
    return;
  }

  const annotationTemplate = selectedToolConfiguration.value?.values
    ?.annotation as IRestrictTagsAndLayer;
  const filteredAnns: IAnnotation[] = annotationTemplate
    ? filterAnnotations(polygonAnns, annotationTemplate)
    : polygonAnns;

  if (filteredAnns.length === 0) {
    props.interactionLayer.removeAnnotation(selectAnnotation);
    return;
  }

  const annotationToEdit = filteredAnns[0];

  await annotationStore.updateAnnotationsPerId({
    annotationIds: [annotationToEdit.id],
    editFunction: (ann: IAnnotation) => {
      const newAnnotation = editPolygonAnnotation(
        ann,
        selectAnnotation.coordinates(),
      );
      ann.coordinates = newAnnotation.coordinates;
    },
  });

  props.interactionLayer.removeAnnotation(selectAnnotation);
}

function editPolygonAnnotation(
  annotation: IAnnotation,
  newLine: IGeoJSPosition[],
): IAnnotation {
  return {
    ...annotation,
    coordinates: editPolygonAnnotationUtil(annotation, newLine),
  };
}

function handleNewROIFilter(geojsAnnotation: IGeoJSAnnotation) {
  if (!roiFilter.value) {
    return;
  }
  filterStore.validateNewROIFilter(geojsAnnotation.coordinates());
  props.interactionLayer.removeAnnotation(geojsAnnotation);
}

function updateCursorAnnotation(evt?: any) {
  if (
    !selectedToolConfiguration.value ||
    !cursorAnnotation.value ||
    !selectedToolRadius.value ||
    !props.maps
  ) {
    return false;
  }
  const map = props.map;
  const basePositionGCS = evt?.mapgcs ? evt.mapgcs : lastCursorPosition.value;
  lastCursorPosition.value = basePositionGCS;
  const basePositionDisplay = map.gcsToDisplay(basePositionGCS);
  cursorAnnotation.value._coordinates(
    [
      {
        x: basePositionDisplay.x - selectedToolRadius.value,
        y: basePositionDisplay.y - selectedToolRadius.value,
      },
      {
        x: basePositionDisplay.x + selectedToolRadius.value,
        y: basePositionDisplay.y - selectedToolRadius.value,
      },
      {
        x: basePositionDisplay.x + selectedToolRadius.value,
        y: basePositionDisplay.y + selectedToolRadius.value,
      },
      {
        x: basePositionDisplay.x - selectedToolRadius.value,
        y: basePositionDisplay.y + selectedToolRadius.value,
      },
    ].map((point) => map.displayToGcs(point)),
  );
  cursorAnnotation.value.draw();
  return true;
}

function addCursorAnnotation() {
  if (cursorAnnotation.value) {
    return;
  }
  cursorAnnotation.value = markRaw(geojs.createAnnotation("circle"));
  cursorAnnotation.value.layer(props.interactionLayer);
  props.interactionLayer.addAnnotation(cursorAnnotation.value);
  props.interactionLayer.geoOn(geojs.event.mousemove, updateCursorAnnotation);
  props.interactionLayer.geoOn(geojs.event.zoom, updateCursorAnnotation);
  cursorAnnotation.value.style({
    fill: true,
    fillColor: "white",
    fillOpacity: 0.2,
    strokeWidth: 3,
    strokeColor: "black",
  });
  updateCursorAnnotation();
}

function refreshAnnotationMode() {
  clearAnnotationMode();
  setNewAnnotationMode();
}

function clearAnnotationMode() {
  if (cursorAnnotation.value) {
    props.interactionLayer.removeAnnotation(cursorAnnotation.value);
    props.interactionLayer.geoOff(
      geojs.event.mousemove,
      updateCursorAnnotation,
    );
    props.interactionLayer.geoOff(geojs.event.zoom, updateCursorAnnotation);
    cursorAnnotation.value = null;
  }
  props.interactionLayer.geoOff(geojs.event.mousemove, handleLineScanMouseMove);
  props.interactionLayer.geoOff(
    geojs.event.actionmove,
    handleLineScanMouseMove,
  );
  props.interactionLayer.geoOff(geojs.event.mousedown, handleLineScanMouseDown);
  // Restore the layer option overridden by the freehand linescan mode; the
  // layer is created with its own value (see ImageViewer), so put back what
  // was there rather than the geojs default
  if (lineScanSavedCloseProximity.value !== null) {
    props.interactionLayer.options(
      "continuousCloseProximity",
      lineScanSavedCloseProximity.value,
    );
    lineScanSavedCloseProximity.value = null;
  }
}

function setupCircleDrawingMode() {
  if (!props.interactionLayer) {
    return;
  }
  props.interactionLayer.mode("ellipse");
}

function setNewAnnotationMode() {
  if (unrolling.value) {
    props.interactionLayer.mode(null);
    return;
  }

  if (roiFilter.value) {
    if (selectedToolConfiguration.value) {
      store.setSelectedToolId(null);
    }
    props.interactionLayer.mode("polygon");
    return;
  }

  switch (selectedToolConfiguration.value?.type) {
    case "create":
      const annotation = selectedToolConfiguration.value.values.annotation;
      if (
        annotation?.shape === AnnotationShape.Circle ||
        annotation?.shape === AnnotationShape.Ellipse
      ) {
        setupCircleDrawingMode();
      } else {
        props.interactionLayer.mode(annotation?.shape);
      }
      break;
    case "tagging":
      if (
        ["tag_click", "untag_click"].includes(
          selectedToolConfiguration.value.values.action.value,
        )
      ) {
        props.interactionLayer.mode("point");
      } else {
        props.interactionLayer.mode("polygon");
      }
      break;
    case "snap":
      if (
        selectedToolConfiguration.value.values.snapTo.value === "circleToDot"
      ) {
        addCursorAnnotation();
        props.interactionLayer.mode("point");
      } else {
        props.interactionLayer.mode("polygon");
      }
      break;
    case "segmentation":
      props.interactionLayer.mode(null);
      break;
    case "connection":
      if (
        selectedToolConfiguration.value.values.action.value.endsWith("click")
      ) {
        props.interactionLayer.mode("point");
      } else {
        props.interactionLayer.mode("polygon");
      }
      break;
    case "select":
      const selectionType =
        selectedToolConfiguration.value.values.selectionType.value === "pointer"
          ? "point"
          : "polygon";
      props.interactionLayer.mode(selectionType);
      break;
    case "edit":
      if (
        selectedToolConfiguration.value?.values?.action?.value ===
        "combine_click"
      ) {
        props.interactionLayer.mode("point");
      } else {
        props.interactionLayer.mode("line");
      }
      break;
    case "linescan":
      if (isLineScanSegmentTool.value) {
        props.interactionLayer.mode("point");
      } else {
        // Complete freehand lines as soon as the mouse is released instead
        // of requiring a double click, whatever the layer is configured with
        if (lineScanSavedCloseProximity.value === null) {
          lineScanSavedCloseProximity.value =
            props.interactionLayer.options("continuousCloseProximity") ?? null;
        }
        props.interactionLayer.options("continuousCloseProximity", true);
        props.interactionLayer.mode("line");
      }
      props.interactionLayer.geoOn(
        geojs.event.mousemove,
        handleLineScanMouseMove,
      );
      props.interactionLayer.geoOn(
        geojs.event.actionmove,
        handleLineScanMouseMove,
      );
      props.interactionLayer.geoOn(
        geojs.event.mousedown,
        handleLineScanMouseDown,
      );
      break;
    case "samAnnotation":
      // Custom mouse capture, same as SAM's prompt flow above (points/boxes
      // via captured-mouse-state, not a GeoJS interaction annotation mode).
      props.interactionLayer.mode(null);
      break;
    case "objectSegmentation":
      // Every selection mode (samClick, samBox, circle) uses the shift-gated
      // custom mouse capture with mode(null), same as samAnnotation. GeoJS
      // polygon-draw mode is deliberately NOT used even for circle: it would
      // consume plain drags and break panning. The freehand lasso is captured
      // as the shift-drag path in consumeMouseState instead, and the hover
      // live-preview reaches previewMouseState's objectSegmentation branch.
      props.interactionLayer.mode(null);
      break;
    case null:
    case undefined:
      props.interactionLayer.mode(null);
      break;
    default:
      logWarning(
        `${selectedToolConfiguration.value?.type} tools are not supported yet`,
      );
      props.interactionLayer.mode(null);
  }
}

function handleModeChange(evt: any) {
  if (evt.mode === null) {
    refreshAnnotationMode();
  }
}

function handleInteractionModeChange(evt: any) {
  if (evt.mode === null) {
    refreshAnnotationMode();
  }
}

function setHoveredAnnotationFromCoordinates(gcsCoordinates: IGeoJSPosition) {
  const geoAnnotations: IGeoJSAnnotation[] =
    props.annotationLayer.annotations();
  let annotationToToggle: TAnnotationOrStub | null = null;
  const unitsPerPixel = getMapUnitsPerPixel();
  for (let i = 0; i < geoAnnotations.length; ++i) {
    const geoAnnotation = geoAnnotations[i];
    const { girderId, isConnection } = geoAnnotation.options();
    if (!girderId || isConnection) {
      continue;
    }
    // Mirror the point-click selection path: unhydrated annotations render as
    // stub dots, so resolve to the stub and hit-test the dot — otherwise every
    // stub-rendered annotation is silently unclickable.
    const candidate = resolveSelectionCandidate(girderId);
    if (!candidate) {
      continue;
    }
    const hit = isHydratedAnnotation(candidate)
      ? shouldSelectAnnotation(
          AnnotationShape.Point,
          [gcsCoordinates],
          candidate,
          geoAnnotation.style(),
          unitsPerPixel,
        )
      : shouldSelectStub(
          gcsCoordinates,
          candidate,
          geoAnnotation.style(),
          unitsPerPixel,
        );
    if (hit) {
      annotationToToggle = candidate;
      break;
    }
  }
  if (
    !annotationToToggle ||
    annotationStore.hoveredAnnotationId === annotationToToggle.id
  ) {
    annotationStore.setHoveredAnnotationId(null);
  } else {
    annotationStore.setHoveredAnnotationId(annotationToToggle.id);
  }

  // Connections get the same plain-click affordance as objects. Without this a
  // plain click highlights an object but does nothing whatsoever on a
  // connection line — the line is skipped above — which reads as the feature
  // being broken. Objects still win: connections are only considered when the
  // click hit no object.
  // Objects normally win, so a line crossing an object never steals its click.
  // TIMELAPSE MODE INVERTS THAT: there the track segments are the thing being
  // looked at and the annotation-layer dots sit underneath them, so a segment
  // almost always crosses a dot and clicking a track did nothing at all for the
  // connection. Prefer the connection there, and only fall back to the object.
  const connectionId = findConnectionIdAtPoint(gcsCoordinates);
  if (annotationToToggle && !(showTimelapseMode.value && connectionId)) {
    connectionListStore.setHoveredConnectionId(null);
    return;
  }
  if (annotationToToggle) {
    // The connection won: undo the object hover set above.
    annotationStore.setHoveredAnnotationId(null);
  }
  connectionListStore.setHoveredConnectionId(
    connectionId && connectionId !== connectionListStore.hoveredConnectionId
      ? connectionId
      : null,
  );
}

function getMapUnitsPerPixel(): number {
  const map = props.annotationLayer.map();
  return map.unitsPerPixel(map.zoom());
}

// Stub radii (estimatedRadius) are in world (image-pixel) units. GeoJS point
// features size their radius in display pixels unless `scaled` is set; with
// `scaled = log2(unitsPerPixel(0))` the radius is interpreted in world units and
// the stub circle tracks the annotation's true footprint at every zoom level.
// unitsPerPixel(0) is the tile pyramid's zoom-0 resolution (a power of two), so
// this is the level at which one world unit equals one display pixel.
function getStubScaled(): number {
  const map = props.annotationLayer.map();
  return Math.log2(map.unitsPerPixel(0));
}

function handleInteractionAnnotationChange(evt: any) {
  if (!selectedToolConfiguration.value && !roiFilter.value) {
    return;
  }

  if (
    evt.event === "geo_annotation_state" &&
    evt.annotation?.layer() === props.interactionLayer
  ) {
    if (selectedToolConfiguration.value) {
      switch (selectedToolConfiguration.value.type) {
        case "create":
          addAnnotationFromGeoJsAnnotation(evt.annotation);
          break;
        case "tagging":
          handleAnnotationTagging(evt.annotation);
          break;
        case "snap":
          addAnnotationFromSnapping(evt.annotation);
          break;
        // objectSegmentation is intentionally absent: it uses mode(null) for
        // every selection mode, so it never produces interaction-layer
        // annotation events - all its example capture goes through
        // consumeMouseState (the shift-gated custom mouse path).
        case "linescan":
          handleLineScanAnnotationDone(evt.annotation);
          break;
        case "select":
          selectAnnotations(evt.annotation);
          break;
        case "connection":
          handleAnnotationConnections(evt.annotation);
          break;
        case "edit":
          if (
            selectedToolConfiguration.value?.values?.action?.value ===
            "combine_click"
          ) {
            handleAnnotationCombine(evt.annotation);
          } else {
            handleAnnotationEdits(evt.annotation);
          }
          break;
      }
    } else {
      handleNewROIFilter(evt.annotation);
    }
  }
}

function handleTimelapseAnnotationClick(evt: IGeoJSMouseState) {
  if (!evt?.geo) {
    return;
  }

  let timeToSet: number | null = null;

  const clickAnnotation = {
    type: () => AnnotationShape.Point,
    coordinates: () => [evt.geo],
    style: () => ({
      radius: 10,
    }),
  } as IGeoJSAnnotation;

  const selectedTimelapseAnnotations =
    getTimelapseAnnotationsFromAnnotation(clickAnnotation);

  if (selectedTimelapseAnnotations.length > 0) {
    timeToSet = selectedTimelapseAnnotations[0].options("time");

    if (timeToSet !== null && time.value !== timeToSet) {
      store.setTime(timeToSet);
    }
  }
}

function previewMouseState(mouseState: IMouseState | null) {
  if (selectionAnnotation.value) {
    props.interactionLayer.removeAnnotation(selectionAnnotation.value);
  }

  const previewBaseStyle = {
    fillOpacity: 0,
    strokeColor: "white",
    strokeOpacity: 0.5,
    strokeWidth: 2,
    closed: true,
  };

  // Unified tool preview: SAM selection modes (samClick/samBox) feed the
  // debounced preview-decode node so the object under the cursor / box is
  // outlined; circle mode draws the freehand lasso path as a polyline (the
  // path itself becomes the example on release).
  const objSegState = objectSegmentationToolState.value;
  if (objSegState) {
    selectionAnnotation.value = null;
    if (objSegState.selectionMode === "circle") {
      const vertices = mouseState?.path ?? [];
      if (vertices.length > 1) {
        selectionAnnotation.value = markRaw(
          geojs.annotation.lineAnnotation({
            style: previewBaseStyle,
            vertices,
          }),
        );
      }
      objSegState.nodes.input.previewPrompt.setValue(NoOutput);
    } else {
      const dragPrompt = mouseState && mouseStateToSamPrompt(mouseState);
      if (dragPrompt) {
        const previewPrompt: TSamPrompt =
          dragPrompt.type === PromptType.backgroundPoint
            ? { type: PromptType.foregroundPoint, point: dragPrompt.point }
            : dragPrompt;
        objSegState.nodes.input.previewPrompt.setValue(previewPrompt);
      } else {
        objSegState.nodes.input.previewPrompt.setValue(NoOutput);
      }
    }
    if (selectionAnnotation.value) {
      selectionAnnotation.value.options("specialAnnotation", true);
      props.interactionLayer.addAnnotation(selectionAnnotation.value);
    }
    return;
  }

  if (samToolState.value) {
    const previewPrompt = mouseState && mouseStateToSamPrompt(mouseState);
    const previewPromptNode = samToolState.value.nodes.input.previewPrompt;
    if (previewPrompt) {
      selectionAnnotation.value = markRaw(
        samPromptToAnnotation(previewPrompt, previewBaseStyle),
      );
      const currentPrompts = samPrompts.value;
      const previewPrompts = [...currentPrompts, previewPrompt];
      previewPromptNode.setValue(previewPrompts);
    } else {
      selectionAnnotation.value = null;
      previewPromptNode.setValue(NoOutput);
    }
  } else {
    const vertices = mouseState?.path ?? [];
    if (vertices.length > 1) {
      selectionAnnotation.value = markRaw(
        geojs.annotation.lineAnnotation({
          style: previewBaseStyle,
          vertices,
        }),
      );
    } else {
      selectionAnnotation.value = null;
    }
  }

  if (selectionAnnotation.value) {
    selectionAnnotation.value.options("specialAnnotation", true);
    props.interactionLayer.addAnnotation(selectionAnnotation.value);
  }
}

function consumeMouseState(mouseState: IMouseState) {
  if (selectionAnnotation.value) {
    props.interactionLayer.removeAnnotation(selectionAnnotation.value);
    selectionAnnotation.value = null;
  }
  const mousePath = mouseState.path;
  if (mousePath.length <= 0) {
    return;
  }
  if (samToolState.value) {
    const newPrompt = mouseStateToSamPrompt(mouseState);
    if (newPrompt) {
      const promptNode = samToolState.value.nodes.input.mainPrompt;
      const currentPrompts = promptNode.output;
      const newPrompts =
        currentPrompts === NoOutput
          ? [newPrompt]
          : [...currentPrompts, newPrompt];
      promptNode.setValue(newPrompts);
    }
  } else if (objectSegmentationToolState.value) {
    // Route the captured shift-gesture by selection mode: circle mode commits
    // the freehand path as a polygon example; SAM modes decode a point/box
    // prompt. (Both leave mode(null), so plain drag still pans.)
    if (objectSegmentationToolState.value.selectionMode === "circle") {
      addObjectSegmentationCircleExample(mouseState);
    } else {
      addObjectSegmentationExample(mouseState);
    }
  } else {
    let annotation;
    if (
      mousePath.every(
        (point) => point.x === mousePath[0].x && point.y === mousePath[0].y,
      )
    ) {
      annotation = geojs.annotation.pointAnnotation();
      annotation!.options("position", mousePath[0]);
    } else {
      annotation = geojs.annotation.polygonAnnotation();
      annotation!.options("vertices", mousePath);
    }
    selectAnnotations(annotation);
  }
}

// Watcher handler functions (named for test access)

function onPrimaryChange() {
  handlingPrimaryChange.value = true;
  drawAnnotationsAndTooltips();
  nextTick(() => {
    handlingPrimaryChange.value = false;
  });
}

function onAnnotationStateChanged() {
  restyleAnnotationsThrottled();
}

function onTimelapseModeChanged() {
  // A watcher-driven trailing rebuild may still be queued (e.g. changing a
  // track filter both fires the primary watcher AND clears a non-empty
  // selection, which lands here). This direct pass renders the same final
  // state now, so drop the queued one — otherwise the ~100 ms pass runs twice.
  drawTimelapseThrottled.cancel();
  drawTimelapseConnectionsAndCentroids();
}

function onDisplayedAnnotationsChange() {
  if (!handlingPrimaryChange.value) {
    drawAnnotationsAndTooltips();
  }
}

function onRestyleNeeded() {
  // baseStyle / layer color / tool-highlight changes alter a feature's baked
  // appearance in ways the per-feature reuse check doesn't cover, so drop the
  // retained cache and let the next frame reconstruct.
  clearRetainedFeatureCache();
  restyleAnnotationsThrottled();
}

function onUnrollChanged() {
  // Unroll changes which frames a single draw spans, invalidating frame-keyed
  // retention.
  clearRetainedFeatureCache();
  clearOldAnnotations(true);
  drawAnnotationsAndTooltips();
}

function onDrawTooltipsChanged() {
  drawTooltips();
}

function watchTool() {
  refreshAnnotationMode();
}

function watchFilter() {
  if (roiFilter.value) {
    refreshAnnotationMode();
  }
}

function pendingAnnotationChanged() {
  if (pendingAnnotation.value) {
    props.interactionLayer.removeAnnotation(pendingAnnotation.value);
    pendingAnnotation.value = null;
  }
  if (pendingStoreAnnotation.value) {
    const created = createGeoJSAnnotation(pendingStoreAnnotation.value);
    pendingAnnotation.value = created ? markRaw(created) : null;
  }
  if (pendingAnnotation.value) {
    pendingAnnotation.value.options("specialAnnotation", true);
    props.interactionLayer.addAnnotation(pendingAnnotation.value);
  }
}

function onSamMainOutputChanged() {
  if (samUnsubmittedAnnotation.value) {
    props.annotationLayer.removeAnnotation(samUnsubmittedAnnotation.value);
    samUnsubmittedAnnotation.value = null;
  }

  const vertices = samMainOutput.value;
  if (!vertices) {
    return;
  }
  const style = {
    fillOpacity: 0.2,
    fillColor: "blue",
    strokeColor: "white",
    strokeOpacity: 1,
    strokeWidth: 1,
  };
  const geoJsAnnotation = geojs.annotation.polygonAnnotation({
    style,
    vertices,
  });
  geoJsAnnotation.options("specialAnnotation", true);

  samUnsubmittedAnnotation.value = markRaw(geoJsAnnotation);
  props.annotationLayer.addAnnotation(samUnsubmittedAnnotation.value);
}

function onSamLivePreviewOutputChanged() {
  if (samLivePreviewAnnotation.value) {
    props.annotationLayer.removeAnnotation(samLivePreviewAnnotation.value);
    samLivePreviewAnnotation.value = null;
  }

  const vertices = samLivePreviewOutput.value;
  if (!vertices) {
    return;
  }

  const viewBounds = props.map.bounds();
  const srcWidth = viewBounds.right - viewBounds.left;
  const srcHeight = viewBounds.bottom - viewBounds.top;

  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  if (width > srcWidth * 0.7 || height > srcHeight * 0.7) {
    return;
  }

  const style = {
    fillOpacity: 0.1,
    fillColor: "blue",
    strokeColor: "white",
    strokeOpacity: 0.5,
    strokeWidth: 1,
  };
  const geoJsAnnotation = geojs.annotation.polygonAnnotation({
    style,
    vertices,
  });
  geoJsAnnotation.options("specialAnnotation", true);

  samLivePreviewAnnotation.value = markRaw(geoJsAnnotation);
  props.annotationLayer.addAnnotation(samLivePreviewAnnotation.value);
}

// Shared renderer for the example-based segmentation tools' transient
// geometry (training-example outlines and putative proposals): removes the
// previous batch from the annotation layer and draws one specialAnnotation
// polygon per entry, returning the new batch.
function replacePreviewPolygons(
  previousAnnotations: IGeoJSAnnotation[],
  polygons: { vertices: IGeoJSPosition[]; style: Record<string, unknown> }[],
): IGeoJSAnnotation[] {
  for (const annotation of previousAnnotations) {
    props.annotationLayer.removeAnnotation(annotation);
  }
  const newAnnotations: IGeoJSAnnotation[] = [];
  for (const { vertices, style } of polygons) {
    const geoJsAnnotation = geojs.annotation.polygonAnnotation({
      style,
      vertices,
    });
    geoJsAnnotation.options("specialAnnotation", true);
    const markedAnnotation = markRaw(geoJsAnnotation);
    props.annotationLayer.addAnnotation(markedAnnotation);
    newAnnotations.push(markedAnnotation);
  }
  // add/removeAnnotation don't reliably force a render on their own (GeoJS
  // gates draws on modified()); without this, re-added example/proposal
  // outlines can sit in the layer invisibly until some other interaction
  // triggers a draw (the "reappear after clicking around" symptom).
  props.annotationLayer.modified();
  props.annotationLayer.draw();
  return newAnnotations;
}

// Training-example outlines: green for foreground (object) examples, red for
// background examples, no fill.
function exampleOutlineStyle(polarity: "foreground" | "background") {
  return {
    fillOpacity: 0,
    strokeOpacity: 1,
    strokeWidth: 2,
    closed: true,
    strokeColor: polarity === "foreground" ? "#00FF00" : "#FF0000",
  };
}

// Putative proposals: low-opacity preview polygons in the tool's configured
// color, visually distinct from committed annotations.
function proposalPreviewStyle() {
  const color =
    selectedToolConfiguration.value?.values?.annotation?.color ?? "blue";
  return {
    fillOpacity: 0.15,
    fillColor: color,
    strokeColor: color,
    strokeOpacity: 0.8,
    strokeWidth: 1,
  };
}

// Examples without a decoded polygon yet (decode still in flight) are skipped.
function onObjectSegmentationExamplesChanged() {
  objectSegmentationExampleAnnotations.value = replacePreviewPolygons(
    objectSegmentationExampleAnnotations.value,
    objectSegmentationExamples.value.flatMap((example) =>
      example.polygon
        ? [
            {
              vertices: example.polygon,
              style: exampleOutlineStyle(example.polarity),
            },
          ]
        : [],
    ),
  );
}

function onObjectSegmentationProposalsChanged() {
  const style = proposalPreviewStyle();
  objectSegmentationProposalAnnotations.value = replacePreviewPolygons(
    objectSegmentationProposalAnnotations.value,
    (objectSegmentationProposals.value ?? []).map((proposal) => ({
      vertices: proposal,
      style,
    })),
  );
}

// SimSAM hover live-preview outline (feature A): rendered EXACTLY like
// onSamLivePreviewOutputChanged (same style, same >70%-of-view skip guard),
// so hovering feels consistent between the two SAM-based tools. Also clears
// itself when objectSegmentationLivePreview goes null - including on tool
// deselect/switch, since objectSegmentationToolState (and therefore this
// computed) becomes null then too.
function onObjectSegmentationLivePreviewChanged() {
  if (objectSegmentationLivePreviewAnnotation.value) {
    props.annotationLayer.removeAnnotation(
      objectSegmentationLivePreviewAnnotation.value,
    );
    objectSegmentationLivePreviewAnnotation.value = null;
  }

  const vertices = objectSegmentationLivePreview.value;
  if (!vertices) {
    return;
  }

  const viewBounds = props.map.bounds();
  const srcWidth = viewBounds.right - viewBounds.left;
  const srcHeight = viewBounds.bottom - viewBounds.top;

  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  if (width > srcWidth * 0.7 || height > srcHeight * 0.7) {
    return;
  }

  const style = {
    fillOpacity: 0.1,
    fillColor: "blue",
    strokeColor: "white",
    strokeOpacity: 0.5,
    strokeWidth: 1,
  };
  const geoJsAnnotation = geojs.annotation.polygonAnnotation({
    style,
    vertices,
  });
  geoJsAnnotation.options("specialAnnotation", true);

  objectSegmentationLivePreviewAnnotation.value = markRaw(geoJsAnnotation);
  props.annotationLayer.addAnnotation(
    objectSegmentationLivePreviewAnnotation.value,
  );
}

function onMousePathChanged(
  newState: IMouseState | null,
  oldState: IMouseState | null,
) {
  if (
    newState === null &&
    oldState !== null &&
    !oldState.isMouseMovePreviewState
  ) {
    consumeMouseState(oldState);
  } else {
    previewMouseState(newState);
  }
}

function renderWorkerPreview() {
  if (workerPreview.value?.image && displayWorkerPreview.value) {
    props.workerPreviewFeature.data([
      {
        ul: { x: 0, y: 0 },
        lr: { x: props.tileWidth, y: props.tileHeight },
        image: workerPreview.value.image,
      },
    ]);
  } else {
    props.workerPreviewFeature.data([]);
  }
  props.workerPreviewFeature.draw();
}

function onSamPromptsChanged(prompts: TSamPrompt[]) {
  for (const annotation of samPromptAnnotations.value) {
    props.annotationLayer.removeAnnotation(annotation);
  }
  const promptBaseStyle = {
    fillOpacity: 0,
    strokeColor: "white",
    strokeOpacity: 1,
    strokeWidth: 2,
    closed: true,
  };
  const newAnnotations = [];
  for (const prompt of prompts) {
    const newAnnotation = markRaw(
      samPromptToAnnotation(prompt, promptBaseStyle),
    );
    newAnnotation.options("specialAnnotation", true);
    props.annotationLayer.addAnnotation(newAnnotation);
    newAnnotations.push(newAnnotation);
  }
  samPromptAnnotations.value = newAnnotations;
}

function drawRoiFilters() {
  props.annotationLayer
    .annotations()
    .filter((annotation: IGeoJSAnnotation) => annotation.options("isRoiFilter"))
    .forEach((annotation: IGeoJSAnnotation) => {
      props.annotationLayer.removeAnnotation(annotation);
    });
  enabledRoiFilters.value.forEach((filter: IROIAnnotationFilter) => {
    const newGeoJSAnnotation = geojsAnnotationFactory("polygon", filter.roi, {
      id: filter.id,
      isRoiFilter: true,
    });

    if (!newGeoJSAnnotation) {
      return;
    }

    newGeoJSAnnotation.style({
      fill: false,
      strokeWidth: 3,
      strokeColor: "black",
    });
    props.annotationLayer.addAnnotation(newGeoJSAnnotation);
  });
}

function handleAnnotationLayerMouseclick(evt: IGeoJSMouseState) {
  if (evt.buttonsDown.right) {
    handleAnnotationRightClick(evt);
  }
}

function bindAnnotationEvents(
  layer: IGeoJSAnnotationLayer = props.annotationLayer,
) {
  layer.geoOn(geojs.event.mouseclick, handleAnnotationLayerMouseclick);

  const map = layer.map();
  const interactorOpts = map.interactor().options();
  const actions = interactorOpts.actions || [];

  const panAction = actions.find((action: any) => action.name === "button pan");
  if (panAction) {
    panAction.modifiers = { shift: false, ctrl: false, alt: false };
  }

  map.interactor().options({ ...interactorOpts, actions });

  layer.geoOn(geojs.event.mousedown, handleDragStart);
  layer.geoOn(geojs.event.mousemove, handleDragMove);
  layer.geoOn(geojs.event.mouseup, handleDragEnd);

  drawAnnotationsAndTooltips();
}

function unbindAnnotationEvents(layer: IGeoJSAnnotationLayer | undefined) {
  if (!layer) return;
  layer.geoOff(geojs.event.mouseclick, handleAnnotationLayerMouseclick);
  layer.geoOff(geojs.event.mousedown, handleDragStart);
  layer.geoOff(geojs.event.mousemove, handleDragMove);
  layer.geoOff(geojs.event.mouseup, handleDragEnd);
  // handleValueOnMouseMove is bound elsewhere (updateValueOnHover) but
  // detached here so layer-prop changes don't leak it onto the old layer.
  // Mildly asymmetric — geoOff is a no-op when nothing matches, so safe.
  // A symmetric refactor that pulls hover-handler ownership into
  // updateValueOnHover broke initial render in testing; leaving as-is.
  layer.geoOff(geojs.event.mousemove, handleValueOnMouseMove);
}

function bindInteractionEvents(
  layer: IGeoJSAnnotationLayer | undefined = props.interactionLayer,
) {
  if (!layer) {
    return;
  }
  layer.geoOn(geojs.event.annotation.mode, handleInteractionModeChange);
  layer.geoOn(geojs.event.annotation.add, handleInteractionAnnotationChange);
  layer.geoOn(geojs.event.annotation.update, handleInteractionAnnotationChange);
  layer.geoOn(geojs.event.annotation.state, handleInteractionAnnotationChange);
  if (selectedToolConfiguration.value?.type === "tagging") {
    layer.geoOn(geojs.event.mouseclick, handleTaggingClick);
  }
  refreshAnnotationMode();
}

function unbindInteractionEvents(layer: IGeoJSAnnotationLayer | undefined) {
  if (!layer) return;
  layer.geoOff(geojs.event.annotation.mode, handleInteractionModeChange);
  layer.geoOff(geojs.event.annotation.add, handleInteractionAnnotationChange);
  layer.geoOff(
    geojs.event.annotation.update,
    handleInteractionAnnotationChange,
  );
  layer.geoOff(geojs.event.annotation.state, handleInteractionAnnotationChange);
  // handleTaggingClick and handleLineScanMouseMove are conditionally bound
  // based on tool type; geoOff is a no-op when nothing matches, so
  // always-detach is safe.
  layer.geoOff(geojs.event.mouseclick, handleTaggingClick);
  layer.geoOff(geojs.event.mousemove, handleLineScanMouseMove);
  layer.geoOff(geojs.event.actionmove, handleLineScanMouseMove);
}

function bindTimelapseEvents(
  layer: IGeoJSAnnotationLayer = props.timelapseLayer,
) {
  layer.geoOn(geojs.event.mouseclick, handleTimelapseAnnotationClick);
}

function unbindTimelapseEvents(layer: IGeoJSAnnotationLayer | undefined) {
  if (!layer) return;
  layer.geoOff(geojs.event.mouseclick, handleTimelapseAnnotationClick);
}

function updateValueOnHover() {
  store.setHoverValue(null);
  if (valueOnHover.value) {
    props.annotationLayer.geoOn(geojs.event.mousemove, handleValueOnMouseMove);
  } else {
    props.annotationLayer.geoOff(geojs.event.mousemove, handleValueOnMouseMove);
  }
}

function handleValueOnMouseMove(e: any) {
  handleValueOnMouseMoveDebounce(e);
}

async function handleValueOnMouseMoveNoDebounce(e: any) {
  if (!dataset.value) {
    return;
  }

  const frameIndices: number[] = [];
  const layerToFrameMap: { [layerId: string]: number } = {};

  for (const layer of validLayers.value) {
    const image = store.getImagesFromLayer(layer)[0];
    if (image) {
      frameIndices.push(image.frameIndex);
      layerToFrameMap[layer.id] = image.frameIndex;
    }
  }

  if (frameIndices.length === 0) {
    return;
  }

  const firstImage = store.getImagesFromLayer(validLayers.value[0])[0];
  if (!firstImage) {
    return;
  }

  const itemId = firstImage.item._id;

  try {
    const pixelData = await store.api.getPixelValuesForAllLayers(
      itemId,
      e.geo.x,
      e.geo.y,
      frameIndices,
    );

    const values: { [layerId: string]: number[] } = {};
    for (const pixel of pixelData) {
      for (const [layerId, frameIndex] of Object.entries(layerToFrameMap)) {
        if (pixel.frame === frameIndex && pixel.value) {
          values[layerId] = pixel.value;
          break;
        }
      }
    }

    if (Object.keys(values).length > 0) {
      store.setHoverValue(values);
    }
  } catch (error) {
    logError("Error fetching pixel values:", error);
  }
}

const handleValueOnMouseMoveDebounce = debounce(
  handleValueOnMouseMoveNoDebounce,
  15,
);

function addHoverCallback() {
  props.annotationLayer.geoOn(geojs.event.mouseclick, (evt: any) => {
    if (selectedToolConfiguration.value === null && evt?.geo) {
      setHoveredAnnotationFromCoordinates(evt.geo);
    }
  });
}

async function handleAnnotationTagging(annotation: IGeoJSAnnotation) {
  if (!annotation) {
    return;
  }
  const selectedAnns = getSelectedAnnotationsFromAnnotation(annotation);
  if (selectedAnns.length > 0) {
    const action = selectedToolConfiguration.value?.values?.action?.value;
    const tags = selectedToolConfiguration.value?.values?.tags || [];
    const removeExisting =
      selectedToolConfiguration.value?.values?.removeExisting || false;

    await updateAnnotationTags(
      selectedAnns.map((a) => a.id),
      action,
      tags,
      removeExisting,
    );

    if (selectedAnns.length === 1) {
      annotationStore.setHoveredAnnotationId(selectedAnns[0].id);
    }
  }
  props.interactionLayer.removeAnnotation(annotation);
}

function handleTaggingClick(evt: any) {
  if (
    !selectedToolConfiguration.value ||
    selectedToolConfiguration.value.type !== "tagging" ||
    !evt?.geo
  ) {
    return;
  }
  const selectedAnns = getSelectedAnnotationsFromAnnotation({
    type: () => AnnotationShape.Point,
    coordinates: () => [evt.geo],
  } as IGeoJSAnnotation);

  if (selectedAnns.length === 1) {
    const selectedAnnotation = selectedAnns[0];
    const action = selectedToolConfiguration.value.values.action.value;
    const tags = selectedToolConfiguration.value.values.tags || [];
    const removeExisting =
      selectedToolConfiguration.value?.values?.removeExisting || false;

    updateAnnotationTags([selectedAnnotation.id], action, tags, removeExisting);

    annotationStore.setHoveredAnnotationId(selectedAnnotation.id);
  }
}

async function updateAnnotationTags(
  annotationIds: string[],
  action: string,
  tags: string[],
  removeExisting: boolean,
) {
  await annotationStore.updateAnnotationsPerId({
    annotationIds,
    editFunction: (ann: IAnnotation) => {
      if (action.startsWith("untag")) {
        ann.tags = ann.tags.filter((tag) => !tags.includes(tag));
      } else {
        ann.tags = removeExisting
          ? [...tags]
          : [...new Set([...ann.tags, ...tags])];
      }
    },
  });
}

function handleAnnotationRightClick(evt: IGeoJSMouseState) {
  if (!evt) {
    return;
  }

  const geoAnnotations: IGeoJSAnnotation[] =
    props.annotationLayer.annotations();
  for (const geoAnnotation of geoAnnotations) {
    const id = geoAnnotation.options("girderId");
    if (!id) {
      continue;
    }
    const annotation = getAnnotationFromId.value(id);
    if (!annotation) {
      continue;
    }
    const unitsPerPixel = getMapUnitsPerPixel();
    const shouldSelect = shouldSelectAnnotation(
      AnnotationShape.Point,
      [evt.geo],
      annotation,
      geoAnnotation.style(),
      unitsPerPixel,
    );
    if (shouldSelect) {
      rightClickedAnnotation.value = annotation;
      contextMenuX.value = evt.evt.clientX;
      contextMenuY.value = evt.evt.clientY;
      showContextMenu.value = true;
      break;
    }
  }
}

function handleContextMenuCancel() {
  showContextMenu.value = false;
  rightClickedAnnotation.value = null;
}

function handleContextMenuSave({
  annotationId,
  color,
}: {
  annotationId?: string;
  color: string;
}) {
  if (annotationId) {
    annotationStore.colorAnnotationIds({
      annotationIds: [annotationId],
      color,
    });
  }
  showContextMenu.value = false;
  rightClickedAnnotation.value = null;
}

function handleDeselectAll() {
  annotationStore.clearSelectedAnnotations();
}

function handleTagSubmit({
  tags,
  addOrRemove,
  replaceExisting,
}: {
  tags: string[];
  addOrRemove: "add" | "remove";
  replaceExisting: boolean;
}) {
  if (addOrRemove === "add") {
    annotationStore.tagSelectedAnnotations({
      tags,
      replace: replaceExisting,
    });
  } else {
    annotationStore.removeTagsFromSelectedAnnotations(tags);
  }
}

function handleColorSubmit({
  useColorFromLayer,
  color,
  randomize,
}: {
  useColorFromLayer: boolean;
  color: string;
  randomize?: boolean;
}) {
  const newColor = useColorFromLayer ? null : color;
  annotationStore.colorSelectedAnnotations({
    color: newColor,
    randomize,
  });
}

function handleDragStart(evt: IGeoJSMouseState) {
  if (!evt?.geo || !evt.modifiers?.alt) {
    return;
  }

  const geoAnnotations: IGeoJSAnnotation[] =
    props.annotationLayer.annotations();
  for (const geoAnnotation of geoAnnotations) {
    const id = geoAnnotation.options("girderId");
    if (!id) {
      continue;
    }
    const annotation = getAnnotationFromId.value(id);
    if (!annotation) {
      continue;
    }
    const unitsPerPixel = getMapUnitsPerPixel();
    const shouldSelect = shouldSelectAnnotation(
      AnnotationShape.Point,
      [evt.geo],
      annotation,
      geoAnnotation.style(),
      unitsPerPixel,
    );
    if (shouldSelect) {
      isDragging.value = true;
      dragStartPosition.value = evt.geo;
      draggedAnnotation.value = annotation;
      dragOriginalCoordinates.value = [...annotation.coordinates];

      const style = {
        fillOpacity: 0.25,
        strokeOpacity: 0.5,
        fillColor: "red",
        strokeColor: "red",
        strokeWidth: 2,
      };

      const ghost = geojsAnnotationFactory(
        annotation.shape,
        [...annotation.coordinates],
        { style },
      );
      dragGhostAnnotation.value = ghost ? markRaw(ghost) : null;

      if (dragGhostAnnotation.value) {
        dragGhostAnnotation.value.options("specialAnnotation", true);
        props.interactionLayer.addAnnotation(dragGhostAnnotation.value);
      }
      break;
    }
  }
}

function handleDragMove(evt: IGeoJSMouseState) {
  if (
    !isDragging.value ||
    !dragStartPosition.value ||
    !draggedAnnotation.value ||
    !dragGhostAnnotation.value ||
    !evt?.geo
  ) {
    return;
  }

  const dx = evt.geo.x - dragStartPosition.value.x;
  const dy = evt.geo.y - dragStartPosition.value.y;

  const newCoordinates = dragOriginalCoordinates.value!.map((coord) => {
    return {
      x: coord.x + dx,
      y: -(coord.y + dy),
    };
  });

  dragGhostAnnotation.value._coordinates(newCoordinates);
  dragGhostAnnotation.value.draw();
}

async function handleDragEnd(evt: IGeoJSMouseState) {
  if (
    !isDragging.value ||
    !dragStartPosition.value ||
    !draggedAnnotation.value ||
    !dragGhostAnnotation.value ||
    !evt?.geo
  ) {
    return;
  }

  const dx = evt.geo.x - dragStartPosition.value.x;
  const dy = evt.geo.y - dragStartPosition.value.y;

  await annotationStore.updateAnnotationsPerId({
    annotationIds: [draggedAnnotation.value.id],
    editFunction: (ann: IAnnotation) => {
      ann.coordinates = dragOriginalCoordinates.value!.map((coord) => ({
        x: coord.x + dx,
        y: coord.y + dy,
        z: coord.z,
      }));
    },
  });

  props.interactionLayer.removeAnnotation(dragGhostAnnotation.value);
  isDragging.value = false;
  dragStartPosition.value = null;
  draggedAnnotation.value = null;
  dragGhostAnnotation.value = null;
  dragOriginalCoordinates.value = null;
}

// ---- Watchers ----

// Primary change: 3 sources.
// Frame changes (xy/z/time) are intentionally NOT here. A frame change updates
// `visibleAnnotationIds` via the updateVisibility watcher; that change flows
// through layerAnnotations -> displayedAnnotations -> onDisplayedAnnotationsChange,
// which draws once with the correct visible set. Drawing here too produced a
// wasted leading draw with the stale (pre-update) visible set, which both
// rendered an empty/incorrect frame momentarily and forced layerAnnotations to
// recompute twice per frame change (the dominant residual cost of the scrub
// freeze once feature reconstruction is cached).
// connectionPassesTrackFilters rather than the raw trackFilters state: the
// predicate is what the draw paths read, and watching it also covers a metric
// changing under an active filter (e.g. a connection delete changing a track's
// length). While no filter is active it is a stable constant, so this adds no
// firing to the common case.
watch(
  [
    annotationConnections,
    shouldDrawAnnotations,
    shouldDrawConnections,
    connectionPassesTrackFilters,
  ],
  () => {
    onPrimaryChange();
  },
);

// Object selection/hover has to reach BOTH layers. `restyleAnnotations` (via
// onAnnotationStateChanged) only ever touches `annotationLayer`, so the timelapse
// centroid dots need their own pass — without it, selecting a whole track's
// objects from the Connections tab changed nothing on screen while its links did
// light up, making a correct object selection read as "it selected the
// connections instead". In place rather than a rebuild: a selection can be
// hundreds of objects, and unlike a connection duplicate's representative, a
// dot's identity is not a draw-time choice.
//
// One watcher, not two on the same pair: this file has already been bitten by
// "everything that must happen on event X" being spread across the file rather
// than enumerated (see the cancel list in onBeforeUnmount).
watch([hoveredAnnotationId, selectedAnnotationIds], () => {
  onAnnotationStateChanged();
  if (showTimelapseMode.value) {
    restyleTimelapseFeaturesThrottled();
  }
});

// Connection selection/hover restyles normal-mode connection lines in place —
// that path is throttled and touches only the affected features.
watch([selectedConnectionIds, hoveredConnectionId], () => {
  onAnnotationStateChanged();
});

// The timelapse layer's styling is decided during its rebuild pass, so the two
// highlight channels are reflected differently there. SELECTION runs the
// (diff-based) rebuild pass: it also decides which duplicate represents an
// endpoint pair, which is a materialization-time choice. HOVER restyles the
// drawn segments in place — it changes continuously while the pointer moves
// down the connection list, and running the full desired-set computation per
// row made the list feel sluggish. Both must do something: a row click
// highlights via hover, so leaving hover unhandled made clicking a connection
// look broken in timelapse mode while it worked everywhere else.
watch(selectedConnectionIds, () => {
  if (showTimelapseMode.value) {
    onTimelapseModeChanged();
  }
});

watch(hoveredConnectionId, () => {
  if (showTimelapseMode.value) {
    restyleTimelapseFeaturesThrottled();
  }
});

// Rebuild spatial index asynchronously when displayed annotations change
watch(displayedAnnotations, (annotations) => {
  buildSpatialIndex(annotations);
});

// Timelapse mode: every draw input (watching the store directly fixes an older
// timelapseTags bug). Track colour is baked into the line features at build
// time — there is no restyle-in-place path for it, the way there is for
// hover — so the colouring controls MUST appear here or they change nothing
// until the next unrelated redraw.
watch(
  [
    showTimelapseMode,
    timelapseModeWindow,
    () => timelapseStore.tags,
    showTimelapseLabels,
    () => timelapseStore.trackColoring,
    () => timelapseStore.colorSeed,
    // connectionPassesTrackFilters is deliberately NOT here: the PRIMARY
    // watcher observes it, and its drawAnnotationsAndTooltips already
    // rebuilds the timelapse layer directly — a second entry here made every
    // filter keystroke reconstruct all track features twice (three times with
    // the selection-clearing watcher). This list is for inputs the primary
    // watcher does NOT observe.
  ],
  () => {
    onTimelapseModeChanged();
  },
);

// Displayed annotations
watch(displayedAnnotations, () => {
  onDisplayedAnnotationsChange();
});

// Restyle
watch([baseStyle, layers, toolHighlightedAnnotationIds], () => {
  onRestyleNeeded();
});

// Unrolling toggle
watch(unrolling, () => {
  refreshAnnotationMode();
});

// Tooltips: 6 sources
watch(
  [
    showTooltips,
    filteredAnnotationTooltips,
    filteredAnnotations,
    properties,
    propertyValues,
    displayedPropertyPaths,
  ],
  () => {
    onDrawTooltipsChanged();
  },
);

// Unroll dimensions
watch([() => props.unrollH, () => props.unrollW], () => {
  onUnrollChanged();
});

// Tool configuration
watch(selectedToolConfiguration, () => {
  watchTool();
});

// The stub circle's stroke width (px), matching getStubStyleFromBaseStyle. The
// stroke dominates a dot's on-screen footprint when zoomed out (cells are
// sub-pixel there), so it drives the density-derived render budget.
const STUB_STROKE_PX = 4;

// Hysteresis baseline: the camera state at the last visibility refresh.
let lastRefreshCamera: { zoom: number; center: IGeoJSPosition } | null = null;
// The previous camera event — used to tell a pure pan (zoom unchanged this
// event) from a zoom, independently of the refresh baseline.
let lastCameraEvent: { zoom: number; center: IGeoJSPosition } | null = null;

// Visibility and hydration updates
function updateVisibility() {
  if (rasterActive.value && props.allowSharedVisibilitySuppression) {
    annotationStore.updateVisibilityAndHydration({
      currentFrameLocation: { XY: xy.value, Z: z.value, Time: time.value },
      suppress: true,
    });
    lastRefreshCamera = {
      zoom: store.cameraInfo.zoom,
      center: store.cameraInfo.center,
    };
    return;
  }
  // Only materialize an id array when a client filter is active. Without one,
  // omit it and let the store derive ids from its own stub map, avoiding a
  // full-dataset id array allocation per frame change (Finding 15).
  //
  // The track-filter object opt-in composes here exactly as it does in
  // displayableAnnotations — the two are twins: this id set drives the
  // stub-mode visibility budget, hydration, and the HUD's viewport counts, so
  // narrowing only the drawn set would spend budget slots on objects the draw
  // path then discards and leave the HUD counting hidden objects. The
  // full-array materialization in the opt-in-only branch is the same
  // filteredDraw tradeoff, paid only while the opt-in narrows.
  const passesTrackFilters = annotationPassesTrackFilters.value;
  const trackNarrowing = connectionListStore.trackFilterHidesObjects;
  let ids: string[] | undefined;
  if (store.filteredDraw) {
    const filtered = filteredAnnotations.value;
    ids = (
      trackNarrowing
        ? filtered.filter((a: TAnnotationOrStub) => passesTrackFilters(a.id))
        : filtered
    ).map((a: TAnnotationOrStub) => a.id);
  } else if (trackNarrowing) {
    ids = [];
    for (const annotation of annotationStore.annotationsForIteration) {
      if (passesTrackFilters(annotation.id)) {
        ids.push(annotation.id);
      }
    }
  }
  // Zoom-adaptive budget (C4): render fewer objects when zoomed out (where they
  // overlap into noise and the heavy redraw briefly locks the UI), ramping up to
  // the full configured cap as the user zooms in. The zoomed-out floor is
  // derived from on-screen annotation density (size + stroke vs screen).
  const map = props.annotationLayer.map();
  const { maxVisible, maxHydrated, coverageTarget, revealMoreOnZoom } =
    annotationStore.visibilityConfig;
  const zoomMin = map.zoomRange().min;
  const size = map.size();
  const budget = visibilityBudgetForZoom({
    zoom: map.zoom(),
    zoomMin,
    avgRadius: annotationStore.averageStubRadius,
    unitsPerPixelAtZoomMin: map.unitsPerPixel(zoomMin),
    screenArea: size.width * size.height,
    strokePx: STUB_STROKE_PX,
    coverageTarget,
    revealMoreOnZoom,
    maxVisible,
    maxHydrated,
    loaded: annotationStore.annotationStubs.size,
  });
  annotationStore.updateVisibilityAndHydration({
    ...(ids !== undefined ? { filteredIds: ids } : {}),
    gcsBounds: store.cameraInfo.gcsBounds,
    currentFrameLocation: { XY: xy.value, Z: z.value, Time: time.value },
    maxVisible: budget.maxVisible,
    maxHydrated: budget.maxHydrated,
  });
  // Record the hysteresis baseline so the camera watcher can skip sub-threshold
  // centered-zoom changes until the next genuine refresh.
  lastRefreshCamera = {
    zoom: store.cameraInfo.zoom,
    center: store.cameraInfo.center,
  };
  // Property-value lazy loading (D): load values for the now-visible set in lazy
  // mode. Property filtering is now applied server-side (Stage 2), so even with
  // an active filter we only need values for the visible subset here.
  if (annotationStore.stubOnlyMode) {
    propertiesStore.ensureVisiblePropertyValues();
  }
}
const updateVisibilityDebounced = debounce(updateVisibility, 250);

watch(rasterActive, updateVisibility);
watch(() => props.allowSharedVisibilitySuppression, updateVisibility);

watch(
  [
    () => store.cameraInfo.zoom,
    () => annotationStore.overviewConfig,
    unrolling,
    () => props.annotationOverviewLayer,
    () => store.drawAnnotations,
    rasterSelectors,
  ],
  updateAnnotationOverviewMode,
  { immediate: true },
);

// Frame changes (XY, Z, Time) and annotation list changes update immediately
// to avoid flash of empty frame while debounce waits
// annotationPassesTrackFilters: the object opt-in narrows the visibility id
// set (see updateVisibility), so toggling it — or a metric changing under an
// active bound — must refresh visibility like any filter change. A stable
// constant while the opt-in is off, so no extra firing in the common case.
watch(
  [filteredAnnotations, xy, z, time, annotationPassesTrackFilters],
  updateVisibility,
);

// Camera changes (pan/zoom) are debounced since they fire rapidly. Pan refreshes
// on any amount (a new region is revealed); zoom keeps a magnification
// hysteresis (viewportRefreshFraction) to avoid re-render + re-hydration churn
// on small zoom nudges. The debounce coalesces a drag into one refresh on settle.
watch(
  () => store.cameraInfo,
  () => {
    stubPerf.trackCameraUpdate();
    const cam = store.cameraInfo;
    const current = { zoom: cam.zoom, center: cam.center };
    const needed = cameraRefreshNeeded(
      current,
      lastRefreshCamera,
      lastCameraEvent,
      annotationStore.visibilityConfig.viewportRefreshFraction,
    );
    // Track every event (not just refreshes) so a pure pan is detected as
    // "zoom unchanged since the previous event" even after a sub-threshold zoom.
    lastCameraEvent = current;
    if (!needed) {
      return;
    }
    updateVisibilityDebounced();
  },
);

// Render-budget settings (maxVisible/maxHydrated/coverageTarget etc.) are read
// inside updateVisibility. Without this watch a change made in the settings only
// took effect on the next pan/zoom/frame change; re-run immediately so editing
// the fields reflects on the canvas right away. setVisibilityConfig replaces
// the config object, so a reference watch fires on any field change.
// (stubThreshold gates stub-only mode at load time and is intentionally not
// re-evaluated here — crossing it still needs a dataset reload.)
watch(() => annotationStore.visibilityConfig, updateVisibility);

// Hydrate-on-selection (C3): a selected stub that isn't in the hydration cache
// renders as a dot and can't show its real shape. Selection happens through
// many code paths (list click, drag-select, context menu), so hydrate reactively
// here rather than from each mutation caller. ensureHydrated dedupes against the
// cache, so already-hydrated selections cost nothing.
watch(
  () => annotationStore.selectedAnnotationIds,
  (ids) => {
    // Pass the Set directly — ensureHydrated iterates it, so no need to spread
    // a potentially huge "select all" selection into a throwaway array on every
    // selection change (Finding 14).
    annotationStore.ensureHydrated(ids);
  },
);

// Property-value lazy loading (D, Stage 2): in lazy mode, property filtering is
// applied server-side — refresh the passing-id set whenever the property filters
// change (their content, not just enabled on/off). filteredAnnotations then
// narrows drawing to that set, and updateVisibility loads values only for the
// visible subset, so no wholesale value load is ever needed.
// refreshPropertyFilterPassingIds clears the set when no filter is active.
watch(
  () => filterStore.propertyFilters,
  () => {
    if (annotationStore.stubOnlyMode) {
      filterStore.refreshPropertyFilterPassingIds();
    }
  },
);

// Adding/removing a property column changes which values the visible set needs.
watch(
  () => propertiesStore.displayedPropertyPaths,
  () => {
    if (annotationStore.stubOnlyMode) {
      propertiesStore.ensureVisiblePropertyValues();
    }
  },
);

// Linescan tool selection: publish the tool state the panel needs (channel
// layer, line type) and drop any ongoing scan when switching to another tool
watch(selectedToolConfiguration, (toolConfiguration) => {
  if (toolConfiguration?.type === "linescan") {
    lineScanStore.setToolLayerId(toolConfiguration.values.layer ?? null);
    lineScanStore.setToolLineType(
      toolConfiguration.values.lineType?.value === "segment"
        ? "segment"
        : "freehand",
    );
    // A segment started with the previously selected tool can't be finished
    lineScanSegmentStart.value = null;
    lineScanStore.setSegmentStartPlaced(false);
  } else {
    lineScanStore.setToolLineType(null);
    lineScanStore.clearLine();
    // clearLine doesn't retrigger the points watcher when no line was ever
    // published (points already null, e.g. a segment start without a
    // preview), so clear the local state directly as well
    clearLineScanState();
  }
});

// Linescan dismissal (panel close button, tool switch): remove the displayed
// line and reset the segment state
watch(
  () => lineScanStore.points,
  (points) => {
    if (points === null) {
      clearLineScanState();
    }
  },
);

// ROI filter
watch(roiFilter, () => {
  watchFilter();
});

// Enabled ROI filters
watch(enabledRoiFilters, () => {
  drawRoiFilters();
});

// Pending store annotation
watch(pendingStoreAnnotation, () => {
  pendingAnnotationChanged();
});

// SAM main output
watch(samMainOutput, () => {
  onSamMainOutputChanged();
});

// SAM live preview output
watch(samLivePreviewOutput, () => {
  onSamLivePreviewOutputChanged();
});

// Unified tool resolved examples
watch(objectSegmentationExamples, () => {
  onObjectSegmentationExamplesChanged();
});

// Unified tool putative proposals
watch(objectSegmentationProposals, () => {
  onObjectSegmentationProposalsChanged();
});

// SAM similarity hover live-preview outline (feature A)
watch(objectSegmentationLivePreview, () => {
  onObjectSegmentationLivePreviewChanged();
});

// SAM similarity example-input mode toggle (feature B): re-arm the
// interaction mode (polygon draw vs raw mouse capture) live when the panel
// switches between "Click" and "Circle", same trigger pattern as watchTool.
// Also drop any lingering hover-preview outline: previewMouseState only
// feeds (and clears) the preview node in click mode, so a preview from just
// before the switch would otherwise stay rendered in circle mode.
watch(
  () => objectSegmentationToolState.value?.selectionMode,
  () => {
    objectSegmentationToolState.value?.nodes.input.previewPrompt.setValue(
      NoOutput,
      true,
    );
    refreshAnnotationMode();
  },
);

// Captured mouse state — split into two cheap watchers instead of one
// `{ deep: true }` watcher that recursively dirty-checks IMouseState (which
// includes the entire IMapEntry → GeoJS map). Identity transitions handle
// state→null (consume) and state-object swap (new preview); a length watcher
// on `path` handles in-place vertex pushes during a drag.
//
// Note: on a state-object swap (e.g., preview-A → fresh-B at mouseDown when
// path lengths differ), both watchers fire and previewMouseState gets called
// twice. Idempotent and rare, so we accept the duplicate over the complexity
// of deduping.
watch(() => props.capturedMouseState, onMousePathChanged);
watch(
  () => props.capturedMouseState?.path.length ?? 0,
  () => {
    if (props.capturedMouseState) {
      previewMouseState(props.capturedMouseState);
    }
  },
);

// Worker preview
watch([displayWorkerPreview, workerPreview], () => {
  renderWorkerPreview();
});

// SAM prompts
watch(samPrompts, (newPrompts) => {
  onSamPromptsChanged(newPrompts);
});

// Selected tool radius
watch(selectedToolRadius, () => {
  updateCursorAnnotation();
});

// Annotation layer — geoOff old layer before re-binding to prevent
// handler accumulation across mapentry rebuilds (e.g., dataset reset).
watch(
  () => props.annotationLayer,
  (newLayer, oldLayer) => {
    // The retained features belong to the old layer instance; drop them so a
    // rebuilt layer (e.g. dataset reset) never re-adds dead feature objects.
    clearRetainedFeatureCache();
    unbindAnnotationEvents(oldLayer);
    bindAnnotationEvents(newLayer);
    addHoverCallback();
  },
);

// Annotation layer + valueOnHover
watch([() => props.annotationLayer, valueOnHover], () => {
  updateValueOnHover();
});

// Interaction layer
watch(
  () => props.interactionLayer,
  (newLayer, oldLayer) => {
    unbindInteractionEvents(oldLayer);
    bindInteractionEvents(newLayer);
  },
);

// Timelapse layer
watch(
  () => props.timelapseLayer,
  (newLayer, oldLayer) => {
    unbindTimelapseEvents(oldLayer);
    bindTimelapseEvents(newLayer);
  },
);

// ---- Lifecycle ----

onMounted(() => {
  bindAnnotationEvents();
  bindTimelapseEvents();
  bindInteractionEvents();
  updateValueOnHover();
  void filterStore
    .updateHistograms()
    .catch((error) => logError("Failed to refresh property histograms", error));
  addHoverCallback();
  updateVisibilityDebounced();
});

onBeforeUnmount(() => {
  unbindAnnotationEvents(props.annotationLayer);
  unbindInteractionEvents(props.interactionLayer);
  unbindTimelapseEvents(props.timelapseLayer);
  // Cancel pending debounced/throttled callbacks so a trailing fire after
  // teardown (e.g. navigating away right after a pan) can't run against a dead
  // layer / torn-down view (Finding 4).
  // Every throttled/debounced function in this file belongs here. The list is
  // covered by a test that DISCOVERS them rather than naming them, because an
  // enumerated list is how the two below went missing in the first place.
  updateVisibilityDebounced.cancel();
  restyleAnnotationsThrottled.cancel();
  restyleTimelapseFeaturesThrottled.cancel();
  drawTimelapseThrottled.cancel();
  drawAnnotations.cancel();
  drawTooltips.cancel();
  handleValueOnMouseMoveDebounce.cancel();
  handleLineScanMouseMove.cancel();
  lineScanStore.setToolLineType(null);
  lineScanStore.clearLine();
  if (spatialIndexRequestId !== null) {
    cancelIdleCallback(spatialIndexRequestId);
  }
  clearRetainedFeatureCache();
  if (props.annotationOverviewLayer) {
    emit("annotation-overview-visibility-change", {
      visible: false,
      opacity: annotationStore.overviewConfig.opacity,
    });
  }
});

// ---- Expose ----

defineExpose({
  // Stores (used in template)
  annotationStore,
  propertiesStore,
  filterStore,
  // Refs
  isDragging,
  rasterActive,
  dragStartPosition,
  draggedAnnotation,
  dragGhostAnnotation,
  dragOriginalCoordinates,
  pendingAnnotation,
  selectionAnnotation,
  samPromptAnnotations,
  samUnsubmittedAnnotation,
  samLivePreviewAnnotation,
  objectSegmentationExampleAnnotations,
  objectSegmentationProposalAnnotations,
  objectSegmentationLivePreviewAnnotation,
  cursorAnnotation,
  lastCursorPosition,
  handlingPrimaryChange,
  showContextMenu,
  contextMenuX,
  contextMenuY,
  rightClickedAnnotation,
  showTagDialog,
  showColorDialog,
  geometryNotLoadedSnackbar,
  // Computed
  unrollLayout,
  unrolledCentroidCoordinates,
  annotationSelectionType,
  roiFilter,
  enabledRoiFilters,
  displayWorkerPreview,
  configuration,
  layers,
  filteredAnnotations,
  annotationConnections,
  unrolling,
  xy,
  z,
  time,
  dataset,
  workerImage,
  workerPreview,
  valueOnHover,
  isAnnotationSelected,
  showAnnotationsFromHiddenLayers,
  selectedToolConfiguration,
  selectedToolState,
  samToolState,
  samPrompts,
  objectSegmentationToolState,
  objectSegmentationExamples,
  objectSegmentationProposals,
  objectSegmentationLivePreview,
  toolHighlightedAnnotationIds,
  pendingStoreAnnotation,
  samMainOutput,
  samLivePreviewOutput,
  hoveredAnnotationId,
  selectedAnnotationIds,
  shouldDrawAnnotations,
  shouldDrawConnections,
  showTooltips,
  showTimelapseMode,
  timelapseModeWindow,
  showTimelapseLabels,
  filteredAnnotationTooltips,
  getAnnotationFromId,
  baseStyle,
  displayedPropertyPaths,
  properties,
  propertyValues,
  displayableAnnotations,
  validLayers,
  isLayerIdValid,
  layerAnnotations,
  layerDisplaysAnnotation,
  displayedAnnotationIds,
  displayedAnnotations,
  connectionIdsSet,
  selectedToolRadius,
  // Functions
  getAnyLayerForChannel,
  getAnnotationStyle,
  drawAnnotationsAndTooltips,
  drawAnnotationsNoThrottle,
  drawAnnotations,
  drawTooltipsNoThrottle,
  drawTooltips,
  updateVisibilityDebounced,
  restyleAnnotationsThrottled,
  restyleTimelapseFeatures,
  restyleTimelapseFeaturesThrottled,
  clearOldAnnotations,
  drawNewAnnotations,
  drawNewConnections,
  findConnectedComponents,
  getDisplayedAnnotationIdsAcrossTime,
  drawTimelapseConnectionsAndCentroids,
  timelapseRebuildCount,
  drawTimelapseTrack,
  drawTimelapseAnnotationCentroidsAndLabels,
  createGeoJSAnnotation,
  drawGeoJSAnnotationFromConnection,
  createAnnotationFromTool,
  restyleAnnotations,
  pointNearPoint,
  pointNearLine,
  findConnectionIdAtPoint,
  shouldSelectAnnotation,
  shouldSelectStub,
  getSelectedAnnotationsFromAnnotation,
  shouldSelectGeoJSAnnotation,
  getTimelapseAnnotationsFromAnnotation,
  selectAnnotations,
  handleAnnotationConnections,
  handleAnnotationCombine,
  addAnnotationFromGeoJsAnnotation,
  addAnnotationFromSnapping,
  addObjectSegmentationExample,
  addObjectSegmentationCircleExample,
  handleAnnotationEdits,
  // Linescan tool
  lineScanAnnotation,
  lineScanSegmentStart,
  isLineScanSegmentTool,
  updateLineScanLine,
  handleLineScanMouseMove,
  handleLineScanMouseDown,
  handleLineScanAnnotationDone,
  clearLineScanState,
  editPolygonAnnotation,
  handleNewROIFilter,
  updateCursorAnnotation,
  addCursorAnnotation,
  refreshAnnotationMode,
  clearAnnotationMode,
  setupCircleDrawingMode,
  setNewAnnotationMode,
  handleModeChange,
  handleInteractionModeChange,
  setHoveredAnnotationFromCoordinates,
  getMapUnitsPerPixel,
  handleInteractionAnnotationChange,
  handleTimelapseAnnotationClick,
  previewMouseState,
  consumeMouseState,
  // Watcher handlers
  onPrimaryChange,
  onTimelapseModeChanged,
  onDisplayedAnnotationsChange,
  onRestyleNeeded,
  onUnrollChanged,
  onDrawTooltipsChanged,
  watchTool,
  watchFilter,
  pendingAnnotationChanged,
  onSamMainOutputChanged,
  onSamLivePreviewOutputChanged,
  onObjectSegmentationExamplesChanged,
  onObjectSegmentationProposalsChanged,
  onObjectSegmentationLivePreviewChanged,
  onMousePathChanged,
  renderWorkerPreview,
  onSamPromptsChanged,
  drawRoiFilters,
  // Event handlers
  bindAnnotationEvents,
  bindInteractionEvents,
  bindTimelapseEvents,
  updateValueOnHover,
  handleValueOnMouseMove,
  handleValueOnMouseMoveNoDebounce,
  handleValueOnMouseMoveDebounce,
  addHoverCallback,
  handleAnnotationTagging,
  handleTaggingClick,
  updateAnnotationTags,
  handleAnnotationRightClick,
  handleContextMenuCancel,
  handleContextMenuSave,
  handleDeselectAll,
  handleTagSubmit,
  handleColorSubmit,
  handleDragStart,
  handleDragMove,
  handleDragEnd,
});
</script>

<style lang="scss" scoped></style>
