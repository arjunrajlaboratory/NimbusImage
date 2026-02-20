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
      v-if="selectedAnnotations.length > 0"
      :selected-count="selectedAnnotations.length"
      @delete-selected="annotationStore.deleteSelectedAnnotations"
      @delete-unselected="annotationStore.deleteUnselectedAnnotations"
      @tag-selected="showTagDialog = true"
      @color-selected="showColorDialog = true"
      @deselect-all="handleDeselectAll"
    />

    <tag-selection-dialog
      :show.sync="showTagDialog"
      @submit="handleTagSubmit"
    />

    <color-selection-dialog
      :show.sync="showColorDialog"
      @submit="handleColorSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, getCurrentInstance } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import filterStore from "@/store/filters";

import geojs from "geojs";
import { snapCoordinates } from "@/utils/itk";

import { throttle, debounce } from "lodash";
const THROTTLE = 100;

import {
  AnnotationSelectionTypes,
  AnnotationShape,
  IAnnotation,
  ITimelapseAnnotation,
  IAnnotationConnection,
  IAnnotationLocation,
  IDisplayLayer,
  IGeoJSAnnotation,
  IGeoJSAnnotationLayer,
  IGeoJSFeature,
  IGeoJSFeatureLayer,
  IGeoJSLineFeatureStyle,
  IGeoJSMap,
  IGeoJSPosition,
  IGeoJSPointFeatureStyle,
  IGeoJSPolygonFeatureStyle,
  IImage,
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
} from "../store/model";

import { logError, logWarning } from "@/utils/log";

import {
  pointDistance,
  getAnnotationStyleFromBaseStyle,
  unrollIndexFromImages,
  geojsAnnotationFactory,
  tagFilterFunction,
  ellipseToPolygonCoordinates,
} from "@/utils/annotation";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import {
  mouseStateToSamPrompt,
  samPromptToAnnotation,
} from "@/pipelines/samPipeline";
import { NoOutput } from "@/pipelines/computePipeline";

import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import AnnotationContextMenu from "@/components/AnnotationContextMenu.vue";
import AnnotationActionPanel from "@/components/AnnotationActionPanel.vue";
import TagSelectionDialog from "@/components/TagSelectionDialog.vue";
import ColorSelectionDialog from "@/components/ColorSelectionDialog.vue";

import { editPolygonAnnotation as editPolygonAnnotationUtil } from "@/utils/polygonSlice";

// Module-level helpers

function filterAnnotations(
  annotations: IAnnotation[],
  { tags, tagsInclusive, layerId }: IRestrictTagsAndLayer,
) {
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

// Custom class to ensure type safety for the parent map
class ParentMap {
  private map = new Map<string, string>();

  set(key: string, value: string) {
    this.map.set(key, value);
  }

  get(key: string): string {
    const value = this.map.get(key);
    if (value === undefined) {
      throw new Error(`Key not found in ParentMap: ${key}`);
    }
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  forEach(callback: (value: string, key: string) => void) {
    this.map.forEach(callback);
  }
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
    unrollH: number;
    unrollW: number;
    maps: IMapEntry[];
    tileWidth: number;
    tileHeight: number;
    lowestLayer: number;
    layerCount: number;
  }>(),
  { maps: () => [] },
);

const _instance = getCurrentInstance();

// ---- Refs (data fields) ----

const isDragging = ref(false);
const dragStartPosition = ref<IGeoJSPosition | null>(null);
const draggedAnnotation = ref<IAnnotation | null>(null);
const dragGhostAnnotation = ref<IGeoJSAnnotation | null>(null);
const dragOriginalCoordinates = ref<IGeoJSPosition[] | null>(null);
const pendingAnnotation = ref<IGeoJSAnnotation | null>(null);
const selectionAnnotation = ref<IGeoJSAnnotation | null>(null);
const samPromptAnnotations = ref<IGeoJSAnnotation[]>([]);
const samUnsubmittedAnnotation = ref<IGeoJSAnnotation | null>(null);
const samLivePreviewAnnotation = ref<IGeoJSAnnotation | null>(null);
const cursorAnnotation = ref<IGeoJSAnnotation | null>(null);
const lastCursorPosition = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const handlingPrimaryChange = ref(false);
const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);
const rightClickedAnnotation = ref<IAnnotation | null>(null);
const showTagDialog = ref(false);
const showColorDialog = ref(false);

// ---- Computed properties ----

// Simple store proxies
const annotationSelectionType = computed(() => store.annotationSelectionType);
const roiFilter = computed(() => filterStore.emptyROIFilter);
const enabledRoiFilters = computed(() =>
  filterStore.roiFilters.filter(
    (filter: IROIAnnotationFilter) => filter.enabled,
  ),
);
const displayWorkerPreview = computed(() => propertiesStore.displayWorkerPreview);
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
const selectedAnnotations = computed(
  () => annotationStore.selectedAnnotations,
);
const shouldDrawAnnotations = computed((): boolean => store.drawAnnotations);
const shouldDrawConnections = computed(
  (): boolean => store.drawAnnotationConnections,
);
const showTooltips = computed((): boolean => store.showTooltips);
const showTimelapseMode = computed((): boolean => store.showTimelapseMode);
const timelapseModeWindow = computed((): number => store.timelapseModeWindow);
const showTimelapseLabels = computed((): boolean => store.showTimelapseLabels);
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

const selectedToolConfiguration = computed(
  (): IToolConfiguration | null =>
    store.selectedTool?.configuration ?? null,
);

const selectedToolState = computed(
  (): TToolState | null => store.selectedTool?.state ?? null,
);

const samToolState = computed((): ISamAnnotationToolState | null => {
  const state = selectedToolState.value;
  if (!(state?.type === SamAnnotationToolStateSymbol)) {
    return null;
  }
  const samMapEntry = state.nodes.input.geoJSMap.output;
  if (samMapEntry === NoOutput || samMapEntry.map !== props.map) {
    return null;
  }
  return state;
});

const samPrompts = computed((): TSamPrompt[] => {
  const prompts = samToolState.value?.nodes.input.mainPrompt.output;
  return prompts === undefined || prompts === NoOutput ? [] : prompts;
});

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
  return store.filteredDraw
    ? filteredAnnotations.value
    : annotationStore.annotations;
});

const validLayers = computed(() =>
  layers.value.slice(
    props.lowestLayer,
    props.lowestLayer + props.layerCount,
  ),
);

const isLayerIdValid = computed(() => {
  const validLayerIds: Set<string> = new Set();
  for (const layer of validLayers.value) {
    validLayerIds.add(layer.id);
  }
  return (id: string) => validLayerIds.has(id);
});

// A map: map<layer id, map<annotation id, annotation>>
const layerAnnotations = computed(() => {
  const channelToAnnotationIds: Map<number, IAnnotation[]> = new Map();
  for (const annotation of displayableAnnotations.value) {
    if (!channelToAnnotationIds.has(annotation.channel)) {
      channelToAnnotationIds.set(annotation.channel, []);
    }
    channelToAnnotationIds.get(annotation.channel)!.push(annotation);
  }

  const layerIdToAnnotationIds: Map<
    string,
    Map<string, IAnnotation>
  > = new Map();
  for (const layer of validLayers.value) {
    const annotationIdsSet: Map<string, IAnnotation> = new Map();
    layerIdToAnnotationIds.set(layer.id, annotationIdsSet);

    if (layer.visible || showAnnotationsFromHiddenLayers.value) {
      const layerChannelAnnotations =
        channelToAnnotationIds.get(layer.channel) || [];
      const sliceIndexes = store.layerSliceIndexes(layer);
      const allXY = store.unrollXY || layer.xy.type === "max-merge";
      const allZ = store.unrollZ || layer.z.type === "max-merge";
      const allT = store.unrollT || layer.time.type === "max-merge";
      for (const annotation of layerChannelAnnotations) {
        if (
          (allXY || annotation.location.XY === sliceIndexes?.xyIndex) &&
          (allZ || annotation.location.Z === sliceIndexes?.zIndex) &&
          (allT || annotation.location.Time === sliceIndexes?.tIndex)
        ) {
          annotationIdsSet.set(annotation.id, annotation);
        }
      }
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
  const annotationList: IAnnotation[] = [];
  for (const layerAnnotationIdsSet of layerAnnotations.value.values()) {
    for (const annotation of layerAnnotationIdsSet.values()) {
      annotationList.push(annotation);
    }
  }
  return annotationList;
});

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

const unrolledCentroidCoordinates = computed(() => {
  const centroidMap: { [annotationId: string]: IGeoJSPosition } = {};
  const annotationCentroids = annotationStore.annotationCentroids;

  const anyImage = store.dataset?.anyImage();
  if (anyImage) {
    for (const annotation of annotationStore.annotations) {
      const centroid = annotationCentroids[annotation.id];
      const unrolledCentroid = unrolledCoordinates(
        [centroid],
        annotation.location,
        anyImage,
      )[0];
      centroidMap[annotation.id] = unrolledCentroid;
    }
  }

  return centroidMap;
});

// ---- Functions ----

function getAnyLayerForChannel(channel: number) {
  return layers.value.find(
    (layer: IDisplayLayer) => channel === layer.channel,
  );
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

function unrollIndex(
  XY: number,
  Z: number,
  Time: number,
  unrollXY: boolean,
  unrollZ: boolean,
  unrollT: boolean,
) {
  const images = store.dataset?.images(
    unrollZ ? -1 : Z,
    unrollT ? -1 : Time,
    unrollXY ? -1 : XY,
    0,
  );
  if (!images) {
    return 0;
  }
  return unrollIndexFromImages(XY, Z, Time, images);
}

function unrolledCoordinates(
  coordinates: IGeoJSPosition[],
  location: IAnnotationLocation,
  image: IImage,
) {
  const tileW = image.sizeX;
  const tileH = image.sizeY;
  if (unrolling.value) {
    const locationIdx = unrollIndex(
      location.XY,
      location.Z,
      location.Time,
      store.unrollXY,
      store.unrollZ,
      store.unrollT,
    );

    const tileX = Math.floor(locationIdx % props.unrollW);
    const tileY = Math.floor(locationIdx / props.unrollW);

    return coordinates.map((point: IGeoJSPosition) => ({
      x: tileW * tileX + point.x,
      y: tileH * tileY + point.y,
      z: point.z,
    }));
  }
  return coordinates;
}

function drawAnnotationsAndTooltips() {
  drawAnnotations();
  drawTooltips();
  if (showTimelapseMode.value) {
    drawTimelapseConnectionsAndCentroids();
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

  clearOldAnnotations(true, false);

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

  drawNewAnnotations(drawnGeoJSAnnotations);
  if (shouldDrawConnections.value) {
    drawNewConnections(drawnGeoJSAnnotations);
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
      .data(displayedAnnotations.value)
      .position((annotation: IAnnotation) => {
        return unrolledCoords[annotation.id];
      })
      .style({
        text: (annotation: IAnnotation) => {
          const index =
            annotationStore.annotationIdToIdx[annotation.id];
          return index + ": " + annotation.tags.join(", ");
        },
        offset: { x: 0, y: yOffset },
        ...textBaseStyle,
      });
    yOffset += 12;
    for (const propertyPath of displayedPropertyPaths.value) {
      const fullName = propertiesStore.getSubIdsNameFromPath(propertyPath);
      if (fullName) {
        const propValues = propertyValues.value;
        const propertyData: Map<string, string> = new Map();
        const filteredIds: string[] = [];
        for (const annotation of displayedAnnotations.value) {
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
          .position(
            (annotationId: string) => unrolledCoords[annotationId],
          )
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
    props.annotationLayer
      .annotations()
      .forEach((geoJsAnnotation: IGeoJSAnnotation) => {
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
          specialAnnotation
        ) {
          return;
        }

        if (clearAll) {
          props.annotationLayer.removeAnnotation(geoJsAnnotation, false);
          props.annotationLayer.modified();
          return;
        }

        if (!girderId) {
          return;
        }

        if (isConnection) {
          const parent = getAnnotationFromId.value(parentId);
          const child = getAnnotationFromId.value(childId);
          if (
            !connectionIdsSet.value.has(girderId) ||
            !shouldDrawConnections.value ||
            !parent ||
            !child ||
            !displayedAnnotationIds.value.has(parent.id) ||
            !displayedAnnotationIds.value.has(child.id)
          ) {
            props.annotationLayer.removeAnnotation(geoJsAnnotation, false);
            props.annotationLayer.modified();
          }
          return;
        }

        const annotation = getAnnotationFromId.value(girderId);
        const layer = store.getLayerFromId(layerId);
        if (
          layer &&
          annotation &&
          layerDisplaysAnnotation.value(layer.id, annotation.id) &&
          annotation.color === color
        ) {
          return;
        }

        props.annotationLayer.removeAnnotation(geoJsAnnotation, false);
        props.annotationLayer.modified();
      });
  }
  if (redraw) {
    props.annotationLayer.draw();
  }
}

function drawNewAnnotations(
  drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]>,
) {
  for (const [layerId, annotationMap] of layerAnnotations.value) {
    const layer = store.getLayerFromId(layerId);
    if (layer) {
      let newAnnotations: IGeoJSAnnotation[] = [];
      for (const [annotationId, annotation] of annotationMap) {
        const excluded = drawnGeoJSAnnotations
          .get(annotationId)
          ?.some(
            (geoJSAnnotation) =>
              geoJSAnnotation.options("layerId") === layer.id,
          );
        if (!excluded) {
          const geoJSAnnotation = createGeoJSAnnotation(
            annotation,
            layerId,
          );
          if (geoJSAnnotation) {
            newAnnotations.push(geoJSAnnotation);
          }
        }
      }
      if (newAnnotations.length > 0) {
        props.annotationLayer.addMultipleAnnotations(
          newAnnotations,
          undefined,
          false,
        );
      }
    }
  }
  for (const [annotationId, geoJSAnnotationList] of drawnGeoJSAnnotations) {
    const isHoveredGT = annotationId === hoveredAnnotationId.value;
    const isSelectedGT = isAnnotationSelected.value(annotationId);
    for (const geoJSAnnotation of geoJSAnnotationList) {
      const { layerId, isHovered, isSelected, style, customColor } =
        geoJSAnnotation.options();
      if (isHovered != isHoveredGT || isSelected != isSelectedGT) {
        const layer = store.getLayerFromId(layerId);
        const newStyle = getAnnotationStyle(
          annotationId,
          customColor,
          layer?.color,
        );
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
  const getAnnotation = getAnnotationFromId.value;
  const connections = annotationConnections.value;
  const len = connections.length;
  for (let i = 0; i < len; i++) {
    const connection = connections[i];
    if (
      drawnGeoJSAnnotations.has(connection.id) ||
      !dispAnnotationIds.has(connection.parentId) ||
      !dispAnnotationIds.has(connection.childId)
    ) {
      continue;
    }
    const childAnnotation = getAnnotation(connection.childId);
    const parentAnnotation = getAnnotation(connection.parentId);
    if (!childAnnotation || !parentAnnotation) {
      continue;
    }
    drawGeoJSAnnotationFromConnection(
      connection,
      childAnnotation,
      parentAnnotation,
    );
  }
}

function findConnectedComponents(
  connections: IAnnotationConnection[],
): { annotations: Set<string>; connections: IAnnotationConnection[] }[] {
  const parent = new ParentMap();

  function find(x: string): string {
    if (!parent.has(x)) {
      parent.set(x, x);
    }
    return parent.get(x) === x ? x : find(parent.get(x));
  }

  function union(x: string, y: string): void {
    parent.set(find(x), find(y));
  }

  connections.forEach((conn) => {
    union(conn.parentId, conn.childId);
  });

  const components = new Map<
    string,
    {
      annotations: Set<string>;
      connections: IAnnotationConnection[];
    }
  >();

  parent.forEach((_, node) => {
    const root = find(node);
    if (!components.has(root)) {
      components.set(root, {
        annotations: new Set(),
        connections: [],
      });
    }
    components.get(root)!.annotations.add(node);
  });

  connections.forEach((conn) => {
    const root = find(conn.parentId);
    components.get(root)!.connections.push(conn);
  });

  return Array.from(components.values());
}

function getDisplayedAnnotationIdsAcrossTime(): Set<string> {
  const totalAnnotationIdsSet: Set<string> = new Set();
  for (const layer of validLayers.value) {
    if (layer.visible || showAnnotationsFromHiddenLayers.value) {
      for (const annotation of displayableAnnotations.value) {
        if (annotation.channel === layer.channel) {
          const sliceIndexes = store.layerSliceIndexes(layer);
          if (
            (store.unrollXY ||
              annotation.location.XY === sliceIndexes?.xyIndex) &&
            (store.unrollZ ||
              annotation.location.Z === sliceIndexes?.zIndex)
          ) {
            totalAnnotationIdsSet.add(annotation.id);
          }
        }
      }
    }
  }
  return totalAnnotationIdsSet;
}

function getDisplayedAnnotationsAcrossTime(): Set<IAnnotation> {
  const displayedIds = getDisplayedAnnotationIdsAcrossTime();
  return new Set(
    Array.from(displayedIds)
      .map((id) => getAnnotationFromId.value(id))
      .filter((a): a is IAnnotation => a !== undefined),
  );
}

function drawTimelapseConnectionsAndCentroids() {
  props.timelapseLayer.removeAllAnnotations(undefined, undefined, false);
  props.timelapseTextLayer.features([]);

  if (!showTimelapseMode.value) {
    props.timelapseLayer.draw();
    props.timelapseTextLayer.draw();
    return;
  }

  const tlModeWindow = timelapseModeWindow.value;
  const currentTime = time.value;
  const timelapseTags = store.timelapseTags;

  const displayedIds = getDisplayedAnnotationIdsAcrossTime();

  const connections = annotationConnections.value;
  const connectionsLength = connections.length;
  const filteredConnections: IAnnotationConnection[] = [];
  for (let i = 0; i < connectionsLength; i++) {
    const conn = connections[i];
    if (
      displayedIds.has(conn.parentId) &&
      displayedIds.has(conn.childId)
    ) {
      filteredConnections.push(conn);
    }
  }

  const components = findConnectedComponents(filteredConnections);

  components.forEach((component) => {
    const componentAnnotations: ITimelapseAnnotation[] = [];
    let color: string = "#FFFFFF";
    if (component.annotations.size > 0) {
      const hash = Array.from(component.annotations)[0]
        .split("")
        .reduce((acc, char) => {
          return char.charCodeAt(0) + ((acc << 5) - acc);
        }, 0);
      color = `#${Math.abs(hash).toString(16).slice(0, 6).padEnd(6, "0")}`;
    }

    const annotations = Array.from(component.annotations);
    const len = annotations.length;
    for (let i = 0; i < len; i++) {
      const id = annotations[i];
      const annotation = getAnnotationFromId.value(id);
      if (!annotation) {
        continue;
      }
      if (
        timelapseTags.length > 0 &&
        !annotation.tags.some((tag: string) => timelapseTags.includes(tag))
      ) {
        continue;
      }
      const timelapseAnnotation: ITimelapseAnnotation = {
        ...(annotation as IAnnotation),
        trackPositionType: TrackPositionType.INTERIOR,
      };
      if (
        annotation.location.Time >= currentTime - tlModeWindow &&
        annotation.location.Time <= currentTime + tlModeWindow
      ) {
        componentAnnotations.push(timelapseAnnotation);
      }
    }

    if (componentAnnotations.length === 0) {
      return;
    }

    for (const annotation of componentAnnotations) {
      const isStart = !component.connections.some(
        (conn) =>
          conn.childId === annotation.id && conn.parentId !== annotation.id,
      );
      const isEnd = !component.connections.some(
        (conn) =>
          conn.parentId === annotation.id && conn.childId !== annotation.id,
      );
      if (annotation.location.Time === currentTime) {
        annotation.trackPositionType = TrackPositionType.CURRENT;
      } else if (isStart) {
        annotation.trackPositionType = TrackPositionType.START;
      } else if (isEnd) {
        annotation.trackPositionType = TrackPositionType.END;
      }
    }

    drawTimelapseTrack(
      componentAnnotations,
      component.connections,
      color,
    );
    drawTimelapseAnnotationCentroidsAndLabels(componentAnnotations);
  });

  const orphanAnnotations: ITimelapseAnnotation[] = [];
  const connectedIds = new Set<string>(
    Array.from(components).flatMap((component) =>
      Array.from(component.annotations),
    ),
  );

  const displayedAnns = getDisplayedAnnotationsAcrossTime();

  const annsArray = Array.from(displayedAnns);
  const annsLen = annsArray.length;
  for (let i = 0; i < annsLen; i++) {
    const annotation = annsArray[i];
    if (
      !connectedIds.has(annotation.id) &&
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
    drawTimelapseAnnotationCentroidsAndLabels(orphanAnnotations);
  }

  props.timelapseLayer.draw();
  props.timelapseTextLayer.draw();
}

function drawTimelapseTrack(
  annotations: ITimelapseAnnotation[],
  connections: IAnnotationConnection[],
  color?: string,
) {
  annotations.sort((a, b) => b.location.Time - a.location.Time);

  const currentTime = time.value;
  const drawnLines = new Set<string>();

  let lines: IGeoJSAnnotation[] = [];
  for (const annotation of annotations) {
    const len = connections.length;
    const relevantConnections: IAnnotationConnection[] = [];
    for (let i = 0; i < len; i++) {
      const conn = connections[i];
      if (conn.parentId === annotation.id || conn.childId === annotation.id) {
        relevantConnections.push(conn);
      }
    }

    for (const connection of relevantConnections) {
      const otherId =
        connection.parentId === annotation.id
          ? connection.childId
          : connection.parentId;

      const otherAnnotation = annotations.find((a) => a.id === otherId);
      if (
        !otherAnnotation ||
        otherAnnotation.location.Time >= annotation.location.Time
      ) {
        continue;
      }

      const lineId = [annotation.id, otherId].sort().join("-");
      if (drawnLines.has(lineId)) continue;
      drawnLines.add(lineId);

      const points = [
        unrolledCentroidCoordinates.value[annotation.id],
        unrolledCentroidCoordinates.value[otherId],
      ];

      const timeDiff =
        annotation.location.Time - otherAnnotation.location.Time;
      const isTimeJump = timeDiff > 1;

      const isBeforeCurrent = annotation.location.Time <= currentTime;
      const line = geojsAnnotationFactory(AnnotationShape.Line, points, {
        style: {
          strokeColor: isTimeJump ? "#ff6b6b" : color,
          strokeWidth: isBeforeCurrent ? 3 : 6,
          strokeOpacity: isTimeJump ? 0.7 : 1,
          lineDash: isTimeJump ? [5, 5] : undefined,
        },
      });

      if (line) {
        lines.push(line);
      }
    }
  }
  props.timelapseLayer.addMultipleAnnotations(lines, undefined, false);
}

function drawTimelapseAnnotationCentroidsAndLabels(
  annotations: ITimelapseAnnotation[],
) {
  const currentTime = time.value;

  const styleObj = {
    scaled: 1,
    fill: true,
    fillColor: "white",
    fillOpacity: 1,
    stroke: true,
    strokeColor: "black",
    strokeWidth: 1,
    strokeOpacity: 1,
    radius: 0.09,
  };
  let points: IGeoJSAnnotation[] = [];
  const len = annotations.length;
  for (let i = 0; i < len; i++) {
    const annotation = annotations[i];
    const locationTime = annotation.location.Time;

    styleObj.fillColor =
      annotation.trackPositionType === TrackPositionType.ORPHAN
        ? "gray"
        : "white";
    styleObj.fillOpacity = locationTime < currentTime ? 0.5 : 1;
    styleObj.strokeOpacity = locationTime < currentTime ? 0.5 : 1;
    styleObj.radius = locationTime === currentTime ? 0.16 : 0.09;

    const pointAnnotation = geojsAnnotationFactory(
      AnnotationShape.Point,
      [unrolledCentroidCoordinates.value[annotation.id]],
      {
        time: annotation.location.Time,
        girderId: annotation.id,
        isTimelapsePoint: true,
        style: styleObj,
      },
    );

    if (pointAnnotation) {
      points.push(pointAnnotation);
    }
  }
  props.timelapseLayer.addMultipleAnnotations(points, undefined, false);

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
      textPoints.push(
        unrolledCentroidCoordinates.value[orphanAnnotation.id],
      );
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
        textPoints.push(
          unrolledCentroidCoordinates.value[startAnnotation.id],
        );
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
        textPoints.push(
          unrolledCentroidCoordinates.value[endAnnotation.id],
        );
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

function createGeoJSAnnotation(annotation: IAnnotation, layerId?: string) {
  if (!store.dataset || !store.dataset.anyImage()) {
    return null;
  }

  const anyImage = store.dataset.anyImage();
  if (!anyImage) {
    return null;
  }
  const coordinates = unrolledCoordinates(
    annotation.coordinates,
    annotation.location,
    anyImage,
  );

  const layer = store.getLayerFromId(layerId);
  const customColor = annotation.color;
  const style = getAnnotationStyle(
    annotation.id,
    customColor,
    layer?.color,
  );

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
  };

  const newGeoJSAnnotation = geojsAnnotationFactory(
    annotation.shape,
    coordinates,
    options,
  );

  return newGeoJSAnnotation;
}

function drawGeoJSAnnotationFromConnection(
  connection: IAnnotationConnection,
  parent: IAnnotation,
  child: IAnnotation,
) {
  const pA = { ...unrolledCentroidCoordinates.value[child.id] };
  delete pA.z;
  const pB = { ...unrolledCentroidCoordinates.value[parent.id] };
  delete pB.z;
  const line = geojs.annotation.lineAnnotation();
  line.options("vertices", [pA, pB]);
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
  for (const geoJSAnnotation of props.annotationLayer.annotations()) {
    const { girderId, layerId, style, customColor } =
      geoJSAnnotation.options();
    if (girderId) {
      const layer = store.getLayerFromId(layerId);
      const newStyle = getAnnotationStyle(
        girderId,
        customColor,
        layer?.color,
      );
      geoJSAnnotation.options("style", Object.assign({}, style, newStyle));
    }
  }
  props.annotationLayer.draw();
}

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
      return geojs.util.pointInPolygon(
        point,
        selectionAnnotationCoordinates,
      );
    });
  }
}

function getSelectedAnnotationsFromAnnotation(
  selectAnnotation: IGeoJSAnnotation,
) {
  const coordinates = selectAnnotation.coordinates();
  const type = selectAnnotation.type();

  const unitsPerPixel = getMapUnitsPerPixel();

  const selectedAnns: IAnnotation[] = props.annotationLayer
    .annotations()
    .reduce(
      (
        selected: IAnnotation[],
        geoJSannotation: IGeoJSAnnotation,
      ) => {
        const { girderId, isConnection } = geoJSannotation.options();
        if (
          !girderId ||
          isConnection ||
          selected.some(
            (selectedAnnotation) => selectedAnnotation.id === girderId,
          )
        ) {
          return selected;
        }
        const annotation = getAnnotationFromId.value(girderId);
        if (
          !annotation ||
          !shouldSelectAnnotation(
            type,
            coordinates,
            annotation,
            geoJSannotation.style(),
            unitsPerPixel,
          )
        ) {
          return selected;
        }
        return [...selected, annotation];
      },
      [],
    );
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
      return geojs.util.pointInPolygon(
        point,
        selectionAnnotationCoordinates,
      );
    });
  }
}

function getTimelapseAnnotationsFromAnnotation(
  selectAnnotation: IGeoJSAnnotation,
) {
  const coordinates = selectAnnotation.coordinates();
  const type = selectAnnotation.type();

  const unitsPerPixel = getMapUnitsPerPixel();

  const selectedAnns: IGeoJSAnnotation[] = props.timelapseLayer
    .annotations()
    .reduce(
      (
        selected: IGeoJSAnnotation[],
        geoJSAnnotation: IGeoJSAnnotation,
      ) => {
        const { isTimelapsePoint } = geoJSAnnotation.options();
        if (!isTimelapsePoint) {
          return selected;
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
          return selected;
        }

        return [...selected, geoJSAnnotation];
      },
      [],
    );
  return selectedAnns;
}

function selectAnnotations(selectAnnotation: IGeoJSAnnotation) {
  if (!selectAnnotation) {
    return;
  }
  const selected =
    getSelectedAnnotationsFromAnnotation(selectAnnotation);

  switch (annotationSelectionType.value) {
    case AnnotationSelectionTypes.ADD:
      annotationStore.selectAnnotations(selected);
      break;
    case AnnotationSelectionTypes.REMOVE:
      annotationStore.unselectAnnotations(selected);
      break;
    case AnnotationSelectionTypes.TOGGLE:
      annotationStore.toggleSelected(selected);
  }

  props.interactionLayer.removeAnnotation(selectAnnotation);
}

async function handleAnnotationConnections(
  selectAnnotation: IGeoJSAnnotation,
) {
  const datasetId = dataset.value?.id;
  if (!selectAnnotation || !datasetId || !selectedToolConfiguration.value) {
    return;
  }

  let selectedAnns: IAnnotation[];
  if (showTimelapseMode.value) {
    const selectedGeoJSAnnotations =
      getTimelapseAnnotationsFromAnnotation(selectAnnotation);
    selectedAnns = selectedGeoJSAnnotations
      .map((a) => getAnnotationFromId.value(a.options().girderId))
      .filter((a): a is IAnnotation => a !== undefined);
  } else {
    selectedAnns =
      getSelectedAnnotationsFromAnnotation(selectAnnotation);
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

  const selectedAnns =
    getSelectedAnnotationsFromAnnotation(selectAnnotation);

  const annotationTemplate = selectedToolConfiguration.value.values
    ?.annotation as IRestrictTagsAndLayer;
  const filteredAnns = annotationTemplate
    ? filterAnnotations(selectedAnns, annotationTemplate)
    : selectedAnns;

  const polygonAnnotations = filteredAnns.filter(
    (a) => a.shape === AnnotationShape.Polygon,
  );

  const clickedAnnotation = polygonAnnotations[0];

  if (
    clickedAnnotation &&
    selectedToolState.value?.type === CombineToolStateSymbol &&
    (selectedToolState.value as any).selectedAnnotationId
  ) {
    const firstAnnotationId = (selectedToolState.value as any)
      .selectedAnnotationId;
    const secondAnnotationId = clickedAnnotation.id;

    if (firstAnnotationId !== secondAnnotationId) {
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

async function addAnnotationFromGeoJsAnnotation(
  annotation: IGeoJSAnnotation,
) {
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

async function handleAnnotationEdits(selectAnnotation: IGeoJSAnnotation) {
  const selectedAnns =
    getSelectedAnnotationsFromAnnotation(selectAnnotation);

  if (selectedAnns.length === 0) {
    props.interactionLayer.removeAnnotation(selectAnnotation);
    return;
  }

  const polygonAnns = selectedAnns.filter(
    (annotation) => annotation.shape === AnnotationShape.Polygon,
  );

  if (polygonAnns.length === 0) {
    props.interactionLayer.removeAnnotation(selectAnnotation);
    return;
  }

  const annotationTemplate = selectedToolConfiguration.value?.values
    ?.annotation as IRestrictTagsAndLayer;
  let filteredAnns: IAnnotation[] = [];
  if (annotationTemplate) {
    filteredAnns = filterAnnotations(selectedAnns, annotationTemplate);
  } else {
    filteredAnns = polygonAnns;
  }

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
  cursorAnnotation.value = geojs.createAnnotation("circle");
  cursorAnnotation.value.layer(props.interactionLayer);
  props.interactionLayer.addAnnotation(cursorAnnotation.value);
  props.interactionLayer.geoOn(
    geojs.event.mousemove,
    updateCursorAnnotation,
  );
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
    props.interactionLayer.geoOff(
      geojs.event.zoom,
      updateCursorAnnotation,
    );
    cursorAnnotation.value = null;
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
      const annotation =
        selectedToolConfiguration.value.values.annotation;
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
        selectedToolConfiguration.value.values.snapTo.value ===
        "circleToDot"
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
        selectedToolConfiguration.value.values.action.value.endsWith(
          "click",
        )
      ) {
        props.interactionLayer.mode("point");
      } else {
        props.interactionLayer.mode("polygon");
      }
      break;
    case "select":
      const selectionType =
        selectedToolConfiguration.value.values.selectionType.value ===
        "pointer"
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
    case "samAnnotation":
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
    (_instance!.proxy as any).refreshAnnotationMode();
  }
}

function setHoveredAnnotationFromCoordinates(
  gcsCoordinates: IGeoJSPosition,
) {
  const geoAnnotations: IGeoJSAnnotation[] =
    props.annotationLayer.annotations();
  let annotationToToggle: IAnnotation | null = null;
  for (let i = 0; i < geoAnnotations.length; ++i) {
    const geoAnnotation = geoAnnotations[i];
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
      [gcsCoordinates],
      annotation,
      geoAnnotation.style(),
      unitsPerPixel,
    );
    if (shouldSelect) {
      annotationToToggle = annotation;
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
}

function getMapUnitsPerPixel(): number {
  const map = props.annotationLayer.map();
  return map.unitsPerPixel(map.zoom());
}

function handleInteractionAnnotationChange(evt: any) {
  if (!selectedToolConfiguration.value && !roiFilter.value) {
    return;
  }

  const proxy = _instance!.proxy as any;
  if (
    evt.event === "geo_annotation_state" &&
    evt.annotation?.layer() === props.interactionLayer
  ) {
    if (selectedToolConfiguration.value) {
      switch (selectedToolConfiguration.value.type) {
        case "create":
          proxy.addAnnotationFromGeoJsAnnotation(evt.annotation);
          break;
        case "tagging":
          proxy.handleAnnotationTagging(evt.annotation);
          break;
        case "snap":
          proxy.addAnnotationFromSnapping(evt.annotation);
          break;
        case "select":
          proxy.selectAnnotations(evt.annotation);
          break;
        case "connection":
          proxy.handleAnnotationConnections(evt.annotation);
          break;
        case "edit":
          if (
            selectedToolConfiguration.value?.values?.action?.value ===
            "combine_click"
          ) {
            proxy.handleAnnotationCombine(evt.annotation);
          } else {
            proxy.handleAnnotationEdits(evt.annotation);
          }
          break;
      }
    } else {
      proxy.handleNewROIFilter(evt.annotation);
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

  if (samToolState.value) {
    const previewPrompt = mouseState && mouseStateToSamPrompt(mouseState);
    const previewPromptNode = samToolState.value.nodes.input.previewPrompt;
    if (previewPrompt) {
      selectionAnnotation.value = samPromptToAnnotation(
        previewPrompt,
        previewBaseStyle,
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
      selectionAnnotation.value = geojs.annotation.lineAnnotation({
        style: previewBaseStyle,
        vertices,
      });
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
  } else {
    let annotation;
    if (
      mousePath.every(
        (point) =>
          point.x === mousePath[0].x && point.y === mousePath[0].y,
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
  (_instance!.proxy as any).drawAnnotationsAndTooltips();
  nextTick(() => {
    handlingPrimaryChange.value = false;
  });
}

function onTimelapseModeChanged() {
  (_instance!.proxy as any).drawTimelapseConnectionsAndCentroids();
}

function onDisplayedAnnotationsChange() {
  if (!handlingPrimaryChange.value) {
    (_instance!.proxy as any).drawAnnotationsAndTooltips();
  }
}

function onRestyleNeeded() {
  (_instance!.proxy as any).restyleAnnotations();
}

function onUnrollChanged() {
  (_instance!.proxy as any).clearOldAnnotations(true);
  (_instance!.proxy as any).drawAnnotationsAndTooltips();
}

function onDrawTooltipsChanged() {
  drawTooltips();
}

function watchTool() {
  (_instance!.proxy as any).refreshAnnotationMode();
}

function watchFilter() {
  if (roiFilter.value) {
    (_instance!.proxy as any).refreshAnnotationMode();
  }
}

function pendingAnnotationChanged() {
  if (pendingAnnotation.value) {
    props.interactionLayer.removeAnnotation(pendingAnnotation.value);
    pendingAnnotation.value = null;
  }
  if (pendingStoreAnnotation.value) {
    pendingAnnotation.value = createGeoJSAnnotation(
      pendingStoreAnnotation.value,
    );
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

  samUnsubmittedAnnotation.value = geoJsAnnotation;
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

  samLivePreviewAnnotation.value = geoJsAnnotation;
  props.annotationLayer.addAnnotation(samLivePreviewAnnotation.value);
}

function onMousePathChanged(
  newState: IMouseState | null,
  oldState: IMouseState | null,
) {
  const proxy = _instance!.proxy as any;
  if (
    newState === null &&
    oldState !== null &&
    !oldState.isMouseMovePreviewState
  ) {
    proxy.consumeMouseState(oldState);
  } else {
    proxy.previewMouseState(newState);
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
    const newAnnotation = samPromptToAnnotation(prompt, promptBaseStyle);
    newAnnotation.options("specialAnnotation", true);
    props.annotationLayer.addAnnotation(newAnnotation);
    newAnnotations.push(newAnnotation);
  }
  samPromptAnnotations.value = newAnnotations;
}

function drawRoiFilters() {
  props.annotationLayer
    .annotations()
    .filter((annotation: IGeoJSAnnotation) =>
      annotation.options("isRoiFilter"),
    )
    .forEach((annotation: IGeoJSAnnotation) => {
      props.annotationLayer.removeAnnotation(annotation);
    });
  enabledRoiFilters.value.forEach((filter: IROIAnnotationFilter) => {
    const newGeoJSAnnotation = geojsAnnotationFactory(
      "polygon",
      filter.roi,
      {
        id: filter.id,
        isRoiFilter: true,
      },
    );

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

function bindAnnotationEvents() {
  props.annotationLayer.geoOn(
    geojs.event.mouseclick,
    (evt: IGeoJSMouseState) => {
      if (evt.buttonsDown.right) {
        handleAnnotationRightClick(evt);
      }
    },
  );

  const map = props.annotationLayer.map();
  const interactorOpts = map.interactor().options();
  const actions = interactorOpts.actions || [];

  const panAction = actions.find(
    (action: any) => action.name === "button pan",
  );
  if (panAction) {
    panAction.modifiers = { shift: false, ctrl: false, alt: false };
  }

  map.interactor().options({ ...interactorOpts, actions });

  props.annotationLayer.geoOn(geojs.event.mousedown, handleDragStart);
  props.annotationLayer.geoOn(geojs.event.mousemove, handleDragMove);
  props.annotationLayer.geoOn(geojs.event.mouseup, handleDragEnd);

  drawAnnotationsAndTooltips();
}

function bindInteractionEvents() {
  if (!props.interactionLayer) {
    return;
  }
  props.interactionLayer.geoOn(
    geojs.event.annotation.mode,
    handleInteractionModeChange,
  );
  props.interactionLayer.geoOn(
    geojs.event.annotation.add,
    handleInteractionAnnotationChange,
  );
  props.interactionLayer.geoOn(
    geojs.event.annotation.update,
    handleInteractionAnnotationChange,
  );
  props.interactionLayer.geoOn(
    geojs.event.annotation.state,
    handleInteractionAnnotationChange,
  );
  if (selectedToolConfiguration.value?.type === "tagging") {
    props.interactionLayer.geoOn(
      geojs.event.mouseclick,
      handleTaggingClick,
    );
  }
  refreshAnnotationMode();
}

function bindTimelapseEvents() {
  props.timelapseLayer.geoOn(
    geojs.event.mouseclick,
    handleTimelapseAnnotationClick,
  );
}

function updateValueOnHover() {
  store.setHoverValue(null);
  if (valueOnHover.value) {
    props.annotationLayer.geoOn(
      geojs.event.mousemove,
      handleValueOnMouseMove,
    );
  } else {
    props.annotationLayer.geoOff(
      geojs.event.mousemove,
      handleValueOnMouseMove,
    );
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
  const selectedAnns =
    getSelectedAnnotationsFromAnnotation(annotation);
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

    updateAnnotationTags(
      [selectedAnnotation.id],
      action,
      tags,
      removeExisting,
    );

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

      dragGhostAnnotation.value = geojsAnnotationFactory(
        annotation.shape,
        [...annotation.coordinates],
        { style },
      );

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

// Primary change: 8 sources
watch(
  [
    annotationConnections,
    xy,
    z,
    time,
    hoveredAnnotationId,
    selectedAnnotations,
    shouldDrawAnnotations,
    shouldDrawConnections,
  ],
  () => { onPrimaryChange(); },
);

// Timelapse mode: 4 sources (fixes timelapseTags bug by watching store directly)
watch(
  [showTimelapseMode, timelapseModeWindow, () => store.timelapseTags, showTimelapseLabels],
  () => { onTimelapseModeChanged(); },
);

// Displayed annotations
watch(displayedAnnotations, () => { onDisplayedAnnotationsChange(); });

// Restyle
watch([baseStyle, layers, toolHighlightedAnnotationIds], () => {
  onRestyleNeeded();
});

// Unrolling toggle
watch(unrolling, () => { refreshAnnotationMode(); });

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
  () => { onDrawTooltipsChanged(); },
);

// Unroll dimensions
watch([() => props.unrollH, () => props.unrollW], () => {
  onUnrollChanged();
});

// Tool configuration
watch(selectedToolConfiguration, () => { watchTool(); });

// ROI filter
watch(roiFilter, () => { watchFilter(); });

// Enabled ROI filters
watch(enabledRoiFilters, () => { drawRoiFilters(); });

// Pending store annotation
watch(pendingStoreAnnotation, () => { pendingAnnotationChanged(); });

// SAM main output
watch(samMainOutput, () => { onSamMainOutputChanged(); });

// SAM live preview output
watch(samLivePreviewOutput, () => { onSamLivePreviewOutputChanged(); });

// Captured mouse state
watch(() => props.capturedMouseState, onMousePathChanged, { deep: true });

// Worker preview
watch([displayWorkerPreview, workerPreview], () => { renderWorkerPreview(); });

// SAM prompts
watch(samPrompts, (newPrompts) => { onSamPromptsChanged(newPrompts); });

// Selected tool radius
watch(selectedToolRadius, () => { updateCursorAnnotation(); });

// Annotation layer
watch(() => props.annotationLayer, () => {
  bindAnnotationEvents();
  addHoverCallback();
});

// Annotation layer + valueOnHover
watch([() => props.annotationLayer, valueOnHover], () => {
  updateValueOnHover();
});

// Interaction layer
watch(() => props.interactionLayer, () => { bindInteractionEvents(); });

// Timelapse layer
watch(() => props.timelapseLayer, () => { bindTimelapseEvents(); });

// ---- Lifecycle ----

onMounted(() => {
  bindAnnotationEvents();
  bindTimelapseEvents();
  bindInteractionEvents();
  updateValueOnHover();
  filterStore.updateHistograms();
  addHoverCallback();
});

onBeforeUnmount(() => {
  if (props.annotationLayer) {
    props.annotationLayer.geoOff(geojs.event.mousedown, handleDragStart);
    props.annotationLayer.geoOff(geojs.event.mousemove, handleDragMove);
    props.annotationLayer.geoOff(geojs.event.mouseup, handleDragEnd);
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
  dragStartPosition,
  draggedAnnotation,
  dragGhostAnnotation,
  dragOriginalCoordinates,
  pendingAnnotation,
  selectionAnnotation,
  samPromptAnnotations,
  samUnsubmittedAnnotation,
  samLivePreviewAnnotation,
  cursorAnnotation,
  lastCursorPosition,
  handlingPrimaryChange,
  showContextMenu,
  contextMenuX,
  contextMenuY,
  rightClickedAnnotation,
  showTagDialog,
  showColorDialog,
  // Computed
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
  toolHighlightedAnnotationIds,
  pendingStoreAnnotation,
  samMainOutput,
  samLivePreviewOutput,
  hoveredAnnotationId,
  selectedAnnotations,
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
  unrollIndex,
  unrolledCoordinates,
  drawAnnotationsAndTooltips,
  drawAnnotationsNoThrottle,
  drawAnnotations,
  drawTooltipsNoThrottle,
  drawTooltips,
  clearOldAnnotations,
  drawNewAnnotations,
  drawNewConnections,
  findConnectedComponents,
  getDisplayedAnnotationIdsAcrossTime,
  getDisplayedAnnotationsAcrossTime,
  drawTimelapseConnectionsAndCentroids,
  drawTimelapseTrack,
  drawTimelapseAnnotationCentroidsAndLabels,
  createGeoJSAnnotation,
  drawGeoJSAnnotationFromConnection,
  createAnnotationFromTool,
  restyleAnnotations,
  pointNearPoint,
  pointNearLine,
  shouldSelectAnnotation,
  getSelectedAnnotationsFromAnnotation,
  shouldSelectGeoJSAnnotation,
  getTimelapseAnnotationsFromAnnotation,
  selectAnnotations,
  handleAnnotationConnections,
  handleAnnotationCombine,
  addAnnotationFromGeoJsAnnotation,
  addAnnotationFromSnapping,
  handleAnnotationEdits,
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
