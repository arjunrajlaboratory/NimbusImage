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

<script lang="ts">
import { Vue, Component, Watch, Prop } from "vue-property-decorator";
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
  TAnnotationOrStub,
  isHydratedAnnotation,
} from "../store/model";

import { logError, logWarning } from "@/utils/log";

import {
  pointDistance,
  getAnnotationStyleFromBaseStyle,
  getStubStyleFromBaseStyle,
  unrollIndexFromImages,
  geojsAnnotationFactory,
  tagFilterFunction,
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

import { editPolygonAnnotation } from "@/utils/polygonSlice";

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

// Draws annotations on the given layer, and provides functionality for the user selected tool.
@Component({
  components: {
    ColorPickerMenu,
    AnnotationContextMenu,
    AnnotationActionPanel,
    TagSelectionDialog,
    ColorSelectionDialog,
  },
})
export default class AnnotationViewer extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;
  readonly propertyStore = propertiesStore;
  readonly filterStore = filterStore;

  // Drag state
  private isDragging = false;
  private dragStartPosition: IGeoJSPosition | null = null;
  private draggedAnnotation: IAnnotation | null = null;
  private dragGhostAnnotation: IGeoJSAnnotation | null = null;
  private dragOriginalCoordinates: IGeoJSPosition[] | null = null;

  // Compute the centroid of each annotation, taking unrolling into account
  get unrolledCentroidCoordinates() {
    const centroidMap: { [annotationId: string]: IGeoJSPosition } = {};
    const annotationCentroids = this.annotationStore.annotationCentroids;

    const anyImage = this.store.dataset?.anyImage();
    if (anyImage) {
      for (const annotation of this.annotationStore.annotations) {
        const centroid = annotationCentroids[annotation.id];
        const unrolledCentroid = this.unrolledCoordinates(
          [centroid],
          annotation.location,
          anyImage,
        )[0];
        centroidMap[annotation.id] = unrolledCentroid;
      }
    }

    return centroidMap;
  }

  get annotationSelectionType() {
    return this.store.annotationSelectionType;
  }

  get roiFilter() {
    return this.filterStore.emptyROIFilter;
  }

  get enabledRoiFilters() {
    return this.filterStore.roiFilters.filter(
      (filter: IROIAnnotationFilter) => filter.enabled,
    );
  }

  @Prop()
  readonly map!: IGeoJSMap;

  @Prop()
  readonly capturedMouseState!: IMouseState | null;

  @Prop()
  readonly annotationLayer!: IGeoJSAnnotationLayer;

  @Prop()
  readonly textLayer!: IGeoJSFeatureLayer;

  @Prop()
  readonly workerPreviewFeature!: IGeoJSFeature;

  @Prop()
  readonly timelapseLayer!: IGeoJSAnnotationLayer;

  @Prop()
  readonly timelapseTextLayer!: IGeoJSFeatureLayer;

  @Prop()
  readonly interactionLayer!: IGeoJSAnnotationLayer;

  @Prop()
  readonly unrollH!: number;

  @Prop()
  readonly unrollW!: number;

  @Prop({ default: [] })
  readonly maps!: IMapEntry[];

  @Prop()
  readonly tileWidth!: number;

  @Prop()
  readonly tileHeight!: number;

  @Prop()
  readonly lowestLayer!: number;

  @Prop()
  readonly layerCount!: number;

  get displayWorkerPreview() {
    return this.propertyStore.displayWorkerPreview;
  }

  get configuration() {
    return this.store.configuration;
  }

  get layers() {
    return this.store.layers;
  }

  get filteredAnnotations() {
    return this.filterStore.filteredAnnotations;
  }

  get annotationConnections() {
    return this.annotationStore.annotationConnections;
  }

  get unrolling() {
    return this.store.unroll;
  }

  get xy() {
    return this.store.xy;
  }

  get z() {
    return this.store.z;
  }

  get time() {
    return this.store.time;
  }

  get dataset() {
    return this.store.dataset;
  }

  get zoom() {
    return this.store.cameraInfo.zoom;
  }

  get gcsBounds() {
    return this.store.cameraInfo.gcsBounds;
  }

  get workerImage() {
    return this.selectedToolConfiguration?.values?.image?.image;
  }

  get workerPreview() {
    return this.workerImage
      ? this.propertyStore.getWorkerPreview(this.workerImage)
      : { text: null, image: "" };
  }

  get valueOnHover() {
    return this.store.valueOnHover;
  }

  get isAnnotationSelected() {
    return this.annotationStore.isAnnotationSelected;
  }

  get showAnnotationsFromHiddenLayers(): boolean {
    return this.store.showAnnotationsFromHiddenLayers;
  }

  // Special annotations

  // This annotation has not been submited yet
  pendingAnnotation: IGeoJSAnnotation | null = null;
  // This annotations comes from the mouse state preview
  selectionAnnotation: IGeoJSAnnotation | null = null;
  // These annotations represents the prompts of the user
  samPromptAnnotations: IGeoJSAnnotation[] = [];
  // User clicked to get this annotation when not in turbo mode
  samUnsubmittedAnnotation: IGeoJSAnnotation | null = null;
  // This is the annotation that is shown as a "what if the user clicks here"
  samLivePreviewAnnotation: IGeoJSAnnotation | null = null;

  get selectedToolConfiguration(): IToolConfiguration | null {
    return this.store.selectedTool?.configuration ?? null;
  }

  get selectedToolState(): TToolState | null {
    return this.store.selectedTool?.state ?? null;
  }

  get samToolState(): ISamAnnotationToolState | null {
    const state = this.selectedToolState;
    if (!(state?.type === SamAnnotationToolStateSymbol)) {
      return null;
    }
    const samMapEntry = state.nodes.input.geoJSMap.output;
    if (samMapEntry === NoOutput || samMapEntry.map !== this.map) {
      return null;
    }
    return state;
  }

  get samPrompts(): TSamPrompt[] {
    const prompts = this.samToolState?.nodes.input.mainPrompt.output;
    return prompts === undefined || prompts === NoOutput ? [] : prompts;
  }

  get toolHighlightedAnnotationIds(): Set<string> {
    const state = this.selectedToolState;
    if (
      (state?.type === ConnectionToolStateSymbol ||
        state?.type === CombineToolStateSymbol) &&
      state.selectedAnnotationId
    ) {
      return new Set([state.selectedAnnotationId]);
    }
    return new Set();
  }

  get pendingStoreAnnotation(): IAnnotation | null {
    return this.annotationStore.pendingAnnotation;
  }

  @Watch("pendingStoreAnnotation")
  pendingAnnotationChanged() {
    if (this.pendingAnnotation) {
      this.interactionLayer.removeAnnotation(this.pendingAnnotation);
      this.pendingAnnotation = null;
    }
    if (this.pendingStoreAnnotation) {
      this.pendingAnnotation = this.createGeoJSAnnotation(
        this.pendingStoreAnnotation,
      );
    }
    if (this.pendingAnnotation) {
      this.pendingAnnotation.options("specialAnnotation", true);
      this.interactionLayer.addAnnotation(this.pendingAnnotation);
    }
  }

  get samMainOutput() {
    return this.samToolState?.output ?? null;
  }

  @Watch("samMainOutput")
  onSamMainOutputChanged() {
    // Remove previous annotation
    if (this.samUnsubmittedAnnotation) {
      this.annotationLayer.removeAnnotation(this.samUnsubmittedAnnotation);
      this.samUnsubmittedAnnotation = null;
    }

    // Create the new annotation
    const vertices = this.samMainOutput;
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

    // Add it to the layer
    this.samUnsubmittedAnnotation = geoJsAnnotation;
    this.annotationLayer.addAnnotation(this.samUnsubmittedAnnotation);
  }

  get samLivePreviewOutput() {
    return this.samToolState?.livePreview ?? null;
  }

  @Watch("samLivePreviewOutput")
  onSamLivePreviewOutputChanged() {
    // Remove previous annotation
    if (this.samLivePreviewAnnotation) {
      this.annotationLayer.removeAnnotation(this.samLivePreviewAnnotation);
      this.samLivePreviewAnnotation = null;
    }

    // Create the new annotation
    const vertices = this.samLivePreviewOutput;
    if (!vertices) {
      return;
    }

    // Get the current screenshot dimensions
    const viewBounds = this.map.bounds();
    const srcWidth = viewBounds.right - viewBounds.left;
    const srcHeight = viewBounds.bottom - viewBounds.top;

    // Check if annotation takes up too much of viewport
    const xs = vertices.map((v) => v.x);
    const ys = vertices.map((v) => v.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    // If annotation takes up more than 70% of source area in either dimension, skip it
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

    // Add it to the layer
    this.samLivePreviewAnnotation = geoJsAnnotation;
    this.annotationLayer.addAnnotation(this.samLivePreviewAnnotation);
  }

  @Watch("capturedMouseState", { deep: true })
  onMousePathChanged(
    newState: IMouseState | null,
    oldState: IMouseState | null,
  ) {
    if (
      newState === null &&
      oldState !== null &&
      !oldState.isMouseMovePreviewState
    ) {
      this.consumeMouseState(oldState);
    } else {
      this.previewMouseState(newState);
    }
  }

  previewMouseState(mouseState: IMouseState | null) {
    if (this.selectionAnnotation) {
      this.interactionLayer.removeAnnotation(this.selectionAnnotation);
    }

    const baseStyle = {
      fillOpacity: 0,
      strokeColor: "white",
      strokeOpacity: 0.5,
      strokeWidth: 2,
      closed: true,
    };

    if (this.samToolState) {
      // Preview SAM prompt
      const previewPrompt = mouseState && mouseStateToSamPrompt(mouseState);
      const previewPromptNode = this.samToolState.nodes.input.previewPrompt;
      if (previewPrompt) {
        this.selectionAnnotation = samPromptToAnnotation(
          previewPrompt,
          baseStyle,
        );
        const currentPrompts = this.samPrompts;
        const previewPrompts = [...currentPrompts, previewPrompt];
        previewPromptNode.setValue(previewPrompts);
      } else {
        this.selectionAnnotation = null;
        previewPromptNode.setValue(NoOutput);
      }
    } else {
      // Preview shift drag select
      const vertices = mouseState?.path ?? [];
      if (vertices.length > 1) {
        this.selectionAnnotation = geojs.annotation.lineAnnotation({
          style: baseStyle,
          vertices,
        });
      } else {
        this.selectionAnnotation = null;
      }
    }

    if (this.selectionAnnotation) {
      this.selectionAnnotation.options("specialAnnotation", true);
      this.interactionLayer.addAnnotation(this.selectionAnnotation);
    }
  }

  consumeMouseState(mouseState: IMouseState) {
    if (this.selectionAnnotation) {
      this.interactionLayer.removeAnnotation(this.selectionAnnotation);
      this.selectionAnnotation = null;
    }
    const mousePath = mouseState.path;
    if (mousePath.length <= 0) {
      return;
    }
    if (this.samToolState) {
      // Create a new SAM prompt from the mouse state
      const newPrompt = mouseStateToSamPrompt(mouseState);
      if (newPrompt) {
        const promptNode = this.samToolState.nodes.input.mainPrompt;
        const currentPrompts = promptNode.output;
        const newPrompts =
          currentPrompts === NoOutput
            ? [newPrompt]
            : [...currentPrompts, newPrompt];
        promptNode.setValue(newPrompts);
      }
    } else {
      // Select the annotations using a point or a polygon annotation
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
      this.selectAnnotations(annotation);
    }
  }

  @Watch("displayWorkerPreview")
  @Watch("workerPreview")
  renderWorkerPreview() {
    if (this.workerPreview?.image && this.displayWorkerPreview) {
      this.workerPreviewFeature.data([
        {
          ul: { x: 0, y: 0 },
          lr: { x: this.tileWidth, y: this.tileHeight },
          image: this.workerPreview.image,
        },
      ]);
    } else {
      this.workerPreviewFeature.data([]);
    }
    this.workerPreviewFeature.draw();
  }

  @Watch("samPrompts")
  onSamPromptsChanged(prompts: TSamPrompt[]) {
    // Update the annotations of the map
    for (const annotation of this.samPromptAnnotations) {
      this.annotationLayer.removeAnnotation(annotation);
    }
    const baseStyle = {
      fillOpacity: 0,
      strokeColor: "white",
      strokeOpacity: 1,
      strokeWidth: 2,
      closed: true,
    };
    const newAnnotations = [];
    for (const prompt of prompts) {
      const newAnnotation = samPromptToAnnotation(prompt, baseStyle);
      newAnnotation.options("specialAnnotation", true);
      this.annotationLayer.addAnnotation(newAnnotation);
      newAnnotations.push(newAnnotation);
    }
    this.samPromptAnnotations = newAnnotations;
  }

  get hoveredAnnotationId() {
    return this.annotationStore.hoveredAnnotationId;
  }

  get selectedAnnotations() {
    return this.annotationStore.selectedAnnotations;
  }

  getAnyLayerForChannel(channel: number) {
    return this.layers.find(
      (layer: IDisplayLayer) => channel === layer.channel,
    );
  }

  get shouldDrawAnnotations(): boolean {
    return this.store.drawAnnotations;
  }

  get shouldDrawConnections(): boolean {
    return this.store.drawAnnotationConnections;
  }

  get showTooltips(): boolean {
    return this.store.showTooltips;
  }

  get showTimelapseMode(): boolean {
    return this.store.showTimelapseMode;
  }

  get timelapseModeWindow(): number {
    return this.store.timelapseModeWindow;
  }

  get showTimelapseLabels(): boolean {
    return this.store.showTimelapseLabels;
  }

  get filteredAnnotationTooltips(): boolean {
    return this.store.filteredAnnotationTooltips;
  }

  get getAnnotationFromId() {
    return this.annotationStore.getAnnotationFromId;
  }

  get baseStyle(): IGeoJSPointFeatureStyle &
    IGeoJSLineFeatureStyle &
    IGeoJSPolygonFeatureStyle {
    return {
      scaled: this.store.scaleAnnotationsWithZoom ? false : 1,
      radius: this.store.annotationsRadius,
      fillOpacity: this.store.annotationOpacity,
    };
  }

  getAnnotationStyle(
    annotationId: string,
    annotationColor: string | null,
    layerColor?: string,
    isStub: boolean = false,
  ) {
    // Use "hover" style for annotations selected by a tool
    const hovered =
      annotationId === this.hoveredAnnotationId ||
      this.toolHighlightedAnnotationIds.has(annotationId);
    const selected = this.isAnnotationSelected(annotationId);

    // Stubs use specialized styling (smaller, thinner strokes)
    if (isStub) {
      return getStubStyleFromBaseStyle(
        annotationColor || layerColor,
        hovered,
        selected,
      );
    }

    return getAnnotationStyleFromBaseStyle(
      this.baseStyle,
      annotationColor || layerColor,
      hovered,
      selected,
    );
  }

  // Get the index of the tile an annotation should be drawn in.
  unrollIndex(
    XY: number,
    Z: number,
    Time: number,
    unrollXY: boolean,
    unrollZ: boolean,
    unrollT: boolean,
  ) {
    const images = this.store.dataset?.images(
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

  // Transform a list of coordinates, taking unrolling into account.
  unrolledCoordinates(
    coordinates: IGeoJSPosition[],
    location: IAnnotationLocation,
    image: IImage,
  ) {
    const tileW = image.sizeX;
    const tileH = image.sizeY;
    if (this.unrolling) {
      const locationIdx = this.unrollIndex(
        location.XY,
        location.Z,
        location.Time,
        this.store.unrollXY,
        this.store.unrollZ,
        this.store.unrollT,
      );

      const tileX = Math.floor(locationIdx % this.unrollW);
      const tileY = Math.floor(locationIdx / this.unrollW);

      return coordinates.map((point: IGeoJSPosition) => ({
        x: tileW * tileX + point.x,
        y: tileH * tileY + point.y,
        z: point.z,
      }));
    }
    return coordinates;
  }

  drawAnnotationsAndTooltips() {
    this.drawAnnotations();
    this.drawTooltips();
    if (this.showTimelapseMode) {
      // AR: The call to drawTimelapseConnectionsAndCentroids should be fine here, but if in testing we see
      // that it is missing some updates, it may be that we need to call it elsewhere as well.
      this.drawTimelapseConnectionsAndCentroids();
    }
  }

  drawAnnotations = throttle(this.drawAnnotationsNoThrottle, THROTTLE).bind(
    this,
  );
  drawAnnotationsNoThrottle() {
    if (!this.annotationLayer) {
      return;
    }

    if (!this.shouldDrawAnnotations) {
      this.clearOldAnnotations(true);
      return;
    }

    // First remove undesired annotations (layer was disabled and showAnnotationsFromHiddenLayers is false, uneligible coordinates...)
    // AR: I changed it to clear all annotations. Removing annotations one at a time is O(n^2) in the number of annotations,
    // whereas clearing all annotations is O(n) in the number of annotations, so I think we don't save much time by removing annotations one at a time.
    // TODO: It may be that cases where we just removed a single annotation might be slower now, need to check,
    // but with other performance improvements in drawing, it may not be a big concern.
    // If it is, we can also capture those events specifically, but again, unless it's only a few annotation, we will face the O(n^2) issue.
    this.clearOldAnnotations(true, false);

    // We want to ignore these already displayed annotations
    // Use a map with id as key for performance and layer id as key
    const drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]> = new Map();
    for (const geoJSAnnotation of this.annotationLayer.annotations()) {
      const id = geoJSAnnotation.options("girderId");
      if (id) {
        if (!drawnGeoJSAnnotations.has(id)) {
          drawnGeoJSAnnotations.set(id, []);
        }
        drawnGeoJSAnnotations.get(id)!.push(geoJSAnnotation);
      }
    }

    // Then draw the new annotations
    this.drawNewAnnotations(drawnGeoJSAnnotations);
    if (this.shouldDrawConnections) {
      this.drawNewConnections(drawnGeoJSAnnotations);
    }
    this.annotationLayer.draw();
  }

  drawTooltips = throttle(this.drawTooltipsNoThrottle, THROTTLE).bind(this);
  drawTooltipsNoThrottle() {
    this.textLayer.clear();

    if (this.showTooltips) {
      // One text feature per line as in https://opengeoscience.github.io/geojs/tutorials/text/
      // Centroid is computed once per new line (optimization needed?)
      // TODO: More performance with renderThreshold https://opengeoscience.github.io/geojs/apidocs/geo.textFeature.html#.styleSpec
      const anyImage = this.store.dataset?.anyImage();
      if (!anyImage) {
        return;
      }
      const unrolledCoordinates = this.unrolledCentroidCoordinates;
      const baseStyle = {
        fontSize: "12px",
        fontFamily: "sans-serif",
        textAlign: "center",
        textBaseline: "middle",
        color: "white",
        textStrokeColor: "black",
        textStrokeWidth: 2,
      };
      let yOffset = 0;
      this.textLayer
        .createFeature("text")
        .data(this.displayedAnnotations)
        .position((annotation: TAnnotationOrStub) => {
          return unrolledCoordinates[annotation.id];
        })
        .style({
          text: (annotation: TAnnotationOrStub) => {
            const index = this.annotationStore.annotationIdToIdx[annotation.id];
            return index + ": " + annotation.tags.join(", ");
          },
          offset: { x: 0, y: yOffset },
          ...baseStyle,
        });
      yOffset += 12;
      for (const propertyPath of this.displayedPropertyPaths) {
        const fullName = this.propertyStore.getSubIdsNameFromPath(propertyPath);
        if (fullName) {
          const propertyValues = this.propertyValues;
          const propertyData: Map<string, string> = new Map();
          const filteredIds: string[] = [];
          for (const annotation of this.displayedAnnotations) {
            const stringValue = getStringFromPropertiesAndPath(
              propertyValues[annotation.id],
              propertyPath,
            );
            if (stringValue) {
              propertyData.set(annotation.id, stringValue);
              filteredIds.push(annotation.id);
            }
          }
          this.textLayer
            .createFeature("text")
            .data(filteredIds)
            .position(
              (annotationId: string) => unrolledCoordinates[annotationId],
            )
            .style({
              // This is the part where we display the property value.
              // Right now, one issue is that if you have multiple properties to show and
              // one of them isn't defined for an annotation, the yOffset will be wrong.
              // That could be fixed by looping through the annotations independently, but I'm
              // worried that that would create performance issues, so leaving it as is for now.
              text: (annotationId: string) =>
                `${fullName}=${propertyData.get(annotationId)}`,
              offset: { x: 0, y: yOffset },
              ...baseStyle,
            });
          yOffset += 12;
        }
      }
    }

    this.textLayer.draw();
  }

  get displayedPropertyPaths() {
    return this.propertyStore.displayedPropertyPaths;
  }

  get properties() {
    return this.propertyStore.properties;
  }

  get propertyValues() {
    return this.propertyStore.propertyValues;
  }

  // Annotations that could be displayed by a layer
  get displayableAnnotations() {
    if (!this.annotationLayer || !this.shouldDrawAnnotations) {
      return [];
    }
    return this.store.filteredDraw
      ? this.filteredAnnotations
      : this.annotationStore.annotations;
  }

  get validLayers() {
    return this.layers.slice(
      this.lowestLayer,
      this.lowestLayer + this.layerCount,
    );
  }

  get isLayerIdValid() {
    const validLayerIds: Set<string> = new Set();
    for (const layer of this.validLayers) {
      validLayerIds.add(layer.id);
    }
    return (id: string) => validLayerIds.has(id);
  }

  // A map: map<layer id, map<annotation id, annotation or stub>>
  // It provides an easy way to get all the annotations visible from a layer or
  // to check if an annotation belongs to a layer
  // Uses stub/hydrated architecture for memory efficiency
  // Respects visibility budget and hydration mode
  get layerAnnotations(): Map<string, Map<string, TAnnotationOrStub>> {
    // channel -> array of annotations/stubs
    const channelToAnnotations: Map<number, TAnnotationOrStub[]> = new Map();
    for (const annotation of this.displayableAnnotations) {
      // Skip if not in visible set (respects render budget)
      if (!this.annotationStore.isVisible(annotation.id)) {
        continue;
      }

      // Get the annotation for rendering (respects hydration mode)
      // Returns full annotation for shapes mode, stub for dots mode
      const annotationOrStub =
        this.annotationStore.getForRendering(annotation.id) ?? annotation;
      if (!channelToAnnotations.has(annotationOrStub.channel)) {
        channelToAnnotations.set(annotationOrStub.channel, []);
      }
      channelToAnnotations
        .get(annotationOrStub.channel)!
        .push(annotationOrStub);
    }

    // layer id -> set of annotation ids
    const layerIdToAnnotations: Map<
      string,
      Map<string, TAnnotationOrStub>
    > = new Map();
    for (const layer of this.validLayers) {
      // Create a new set of annotation ids for this layer
      const annotationMap: Map<string, TAnnotationOrStub> = new Map();
      layerIdToAnnotations.set(layer.id, annotationMap);

      // Get all annotations in the layer's channel
      // Check if we should include annotations for this layer
      if (layer.visible || this.showAnnotationsFromHiddenLayers) {
        const layerChannelAnnotations =
          channelToAnnotations.get(layer.channel) || [];
        const sliceIndexes = this.store.layerSliceIndexes(layer);
        const allXY = this.store.unrollXY || layer.xy.type === "max-merge";
        const allZ = this.store.unrollZ || layer.z.type === "max-merge";
        const allT = this.store.unrollT || layer.time.type === "max-merge";
        for (const annotationOrStub of layerChannelAnnotations) {
          if (
            (allXY || annotationOrStub.location.XY === sliceIndexes?.xyIndex) &&
            (allZ || annotationOrStub.location.Z === sliceIndexes?.zIndex) &&
            (allT || annotationOrStub.location.Time === sliceIndexes?.tIndex)
          ) {
            annotationMap.set(annotationOrStub.id, annotationOrStub);
          }
        }
      }
    }
    return layerIdToAnnotations;
  }

  get layerDisplaysAnnotation() {
    return (layerId: string, annotationId: string) =>
      !!this.layerAnnotations.get(layerId)?.has(annotationId);
  }

  // A set of annotation ids
  get displayedAnnotationIds() {
    const totalAnnotationIdsSet: Set<string> = new Set();
    for (const layerAnnotationIdsSet of this.layerAnnotations.values()) {
      for (const annotationId of layerAnnotationIdsSet.keys()) {
        totalAnnotationIdsSet.add(annotationId);
      }
    }
    return totalAnnotationIdsSet;
  }

  // An array of annotations or stubs
  get displayedAnnotations(): TAnnotationOrStub[] {
    const annotationList: TAnnotationOrStub[] = [];
    for (const layerAnnotationSet of this.layerAnnotations.values()) {
      for (const annotation of layerAnnotationSet.values()) {
        annotationList.push(annotation);
      }
    }
    return annotationList;
  }

  get connectionIdsSet() {
    const result: Set<string> = new Set();
    const connections = this.annotationConnections;
    const len = connections.length;
    for (let i = 0; i < len; i++) {
      result.add(connections[i].id);
    }
    return result;
  }

  // Remove from the layer annotations that should no longer be renderered (index change, layer change...)
  clearOldAnnotations(clearAll = false, redraw = true) {
    if (clearAll) {
      this.annotationLayer.removeAllAnnotations(undefined, undefined, false);
      this.annotationLayer.modified();
    } else {
      this.annotationLayer
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
            geoJsAnnotation === this.annotationLayer.currentAnnotation ||
            specialAnnotation
          ) {
            // Don't do anything with currentAnnotation as it is used internally by geoJS
            // Don't remove special annotations as they are removed by other ways
            return;
          }

          if (clearAll) {
            this.annotationLayer.removeAnnotation(geoJsAnnotation, false);
            this.annotationLayer.modified();
            return;
          }

          if (!girderId) {
            return;
          }

          // Check for connections
          if (isConnection) {
            const parent = this.getAnnotationFromId(parentId);
            const child = this.getAnnotationFromId(childId);
            if (
              !this.connectionIdsSet.has(girderId) ||
              !this.shouldDrawConnections ||
              !parent ||
              !child ||
              !this.displayedAnnotationIds.has(parent.id) ||
              !this.displayedAnnotationIds.has(child.id)
            ) {
              this.annotationLayer.removeAnnotation(geoJsAnnotation, false);
              this.annotationLayer.modified();
            }
            return;
          }

          const annotation = this.getAnnotationFromId(girderId);
          const layer = this.store.getLayerFromId(layerId);
          if (
            layer &&
            annotation &&
            this.layerDisplaysAnnotation(layer.id, annotation.id) &&
            annotation.color === color
          ) {
            return;
          }

          this.annotationLayer.removeAnnotation(geoJsAnnotation, false);
          this.annotationLayer.modified();
        });
    }
    if (redraw) {
      this.annotationLayer.draw();
    }
  }

  // Add to the layer annotations that should be rendered and have not already been added.
  drawNewAnnotations(drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]>) {
    for (const [layerId, annotationMap] of this.layerAnnotations) {
      const layer = this.store.getLayerFromId(layerId);
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
            const geoJSAnnotation = this.createGeoJSAnnotation(
              annotation,
              layerId,
            );
            if (geoJSAnnotation) {
              newAnnotations.push(geoJSAnnotation);
            }
          }
        }
        if (newAnnotations.length > 0) {
          this.annotationLayer.addMultipleAnnotations(
            newAnnotations,
            undefined,
            false,
          );
        }
      }
    }
    for (const [annotationId, geoJSAnnotationList] of drawnGeoJSAnnotations) {
      const isHoveredGT = annotationId === this.hoveredAnnotationId;
      const isSelectedGT = this.isAnnotationSelected(annotationId);
      for (const geoJSAnnotation of geoJSAnnotationList) {
        const { layerId, isHovered, isSelected, style, customColor, isStub } =
          geoJSAnnotation.options();
        // If hover or select changed, update style
        if (isHovered != isHoveredGT || isSelected != isSelectedGT) {
          const layer = this.store.getLayerFromId(layerId);
          const newStyle = this.getAnnotationStyle(
            annotationId,
            customColor,
            layer?.color,
            isStub ?? false,
          );
          geoJSAnnotation.options("style", { ...style, ...newStyle });
          geoJSAnnotation.options("isHovered", isHoveredGT);
          geoJSAnnotation.options("isSelected", isSelectedGT);
        }
      }
    }
  }

  drawNewConnections(drawnGeoJSAnnotations: Map<string, IGeoJSAnnotation[]>) {
    const displayedAnnotationIds = this.displayedAnnotationIds;
    const getAnnotationFromId = this.getAnnotationFromId;
    const connections = this.annotationConnections;
    const len = connections.length;
    for (let i = 0; i < len; i++) {
      const connection = connections[i];
      // If connection is drawn, or one of the parent is not displayed, don't display
      if (
        drawnGeoJSAnnotations.has(connection.id) ||
        !displayedAnnotationIds.has(connection.parentId) ||
        !displayedAnnotationIds.has(connection.childId)
      ) {
        continue;
      }
      // Get the two annotations for this connection
      const childAnnotation = getAnnotationFromId(connection.childId);
      const parentAnnotation = getAnnotationFromId(connection.parentId);
      if (!childAnnotation || !parentAnnotation) {
        continue;
      }
      // Draw the connection
      this.drawGeoJSAnnotationFromConnection(
        connection,
        childAnnotation,
        parentAnnotation,
      );
    }
  }

  // Helper function to find connected components using Union-Find
  private findConnectedComponents(
    connections: IAnnotationConnection[],
  ): { annotations: Set<string>; connections: IAnnotationConnection[] }[] {
    // Simple Union-Find implementation
    // Use our custom ParentMap instead of Map to ensure type safety
    const parent = new ParentMap();

    // Find with path compression
    function find(x: string): string {
      if (!parent.has(x)) {
        parent.set(x, x);
      }
      return parent.get(x) === x ? x : find(parent.get(x));
    }

    // Union operation
    function union(x: string, y: string): void {
      parent.set(find(x), find(y));
    }

    // Process all connections
    connections.forEach((conn) => {
      union(conn.parentId, conn.childId);
    });

    // Group annotations and their connections by root
    const components = new Map<
      string,
      {
        annotations: Set<string>;
        connections: IAnnotationConnection[];
      }
    >();

    // Initialize components with annotations
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

    // Add connections to their respective components
    connections.forEach((conn) => {
      const root = find(conn.parentId); // Could use either parent or child
      components.get(root)!.connections.push(conn);
    });

    return Array.from(components.values());
  }

  // This helper function collects just the annotations that are displayed
  // but across all time, which is important for timelapse mode.
  getDisplayedAnnotationIdsAcrossTime(): Set<string> {
    const totalAnnotationIdsSet: Set<string> = new Set();
    for (const layer of this.validLayers) {
      if (layer.visible || this.showAnnotationsFromHiddenLayers) {
        for (const annotation of this.displayableAnnotations) {
          if (annotation.channel === layer.channel) {
            const sliceIndexes = this.store.layerSliceIndexes(layer);
            if (
              (this.store.unrollXY ||
                annotation.location.XY === sliceIndexes?.xyIndex) &&
              (this.store.unrollZ ||
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

  // Another helper function that uses the IDs collected across time
  // and returns a set of annotations.
  // TODO: Could be optimized by removing the .map.filter iterations.
  getDisplayedAnnotationsAcrossTime(): Set<IAnnotation> {
    const displayedAnnotationIds = this.getDisplayedAnnotationIdsAcrossTime();
    return new Set(
      Array.from(displayedAnnotationIds)
        .map((id) => this.getAnnotationFromId(id))
        .filter((a): a is IAnnotation => a !== undefined),
    );
  }

  drawTimelapseConnectionsAndCentroids() {
    // Remove all previous tracks and centroids
    this.timelapseLayer.removeAllAnnotations(undefined, undefined, false);
    this.timelapseTextLayer.features([]);

    if (!this.showTimelapseMode) {
      // Redraw to ensure we clear the layers. I found that this was necessary for the timelapseTextLayer to clear.
      this.timelapseLayer.draw();
      this.timelapseTextLayer.draw();
      return;
    }

    // Only render tracks and annotations within this time window
    const timelapseModeWindow = this.timelapseModeWindow;
    const currentTime = this.time;
    const timelapseTags = this.store.timelapseTags;

    // First, let's only keep the connections corresponding to annotations
    // that are being displayed
    const displayedAnnotationIds = this.getDisplayedAnnotationIdsAcrossTime();

    // Filter the connections to only include those that are between displayed annotations
    const connections = this.annotationConnections;
    const connectionsLength = connections.length;
    const filteredConnections: IAnnotationConnection[] = [];
    for (let i = 0; i < connectionsLength; i++) {
      const conn = connections[i];
      if (
        displayedAnnotationIds.has(conn.parentId) &&
        displayedAnnotationIds.has(conn.childId)
      ) {
        filteredConnections.push(conn);
      }
    }

    // Get connected components to find each individual track
    const components = this.findConnectedComponents(filteredConnections);

    // Draw each component separately
    components.forEach((component) => {
      const componentAnnotations: ITimelapseAnnotation[] = [];
      let color: string = "#FFFFFF";
      if (component.annotations.size > 0) {
        // Use the first GeoJSAnnotation ID to generate a color that is unique for the component irrespective
        // of the timelapse window.
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
        const annotation = this.getAnnotationFromId(id);
        if (!annotation) {
          continue;
        }
        // If the annotation doesn't have a tag in the timelapseTags list, skip it
        // If the timelapseTags list is empty, include all annotations
        if (
          timelapseTags.length > 0 &&
          !annotation.tags.some((tag: string) => timelapseTags.includes(tag))
        ) {
          continue;
        }
        const timelapseAnnotation: ITimelapseAnnotation = {
          // Cast to IAnnotation to access the common properties
          ...(annotation as IAnnotation),
          trackPositionType: TrackPositionType.INTERIOR,
        };
        if (
          annotation.location.Time >= currentTime - timelapseModeWindow &&
          annotation.location.Time <= currentTime + timelapseModeWindow
        ) {
          componentAnnotations.push(timelapseAnnotation);
        }
      }

      if (componentAnnotations.length === 0) {
        return;
      }

      // Set the trackPositionType for the start and end annotations
      // We define START as annotations with no connection to an earlier point, and
      // END as annotations with no connection to a later point.
      for (const annotation of componentAnnotations) {
        // Check if it's a start annotation (no incoming connections)
        const isStart = !component.connections.some(
          (conn) =>
            conn.childId === annotation.id && conn.parentId !== annotation.id,
        );

        // Check if it's an end annotation (no outgoing connections)
        const isEnd = !component.connections.some(
          (conn) =>
            conn.parentId === annotation.id && conn.childId !== annotation.id,
        );

        // Set position type, with CURRENT taking precedence
        if (annotation.location.Time === currentTime) {
          annotation.trackPositionType = TrackPositionType.CURRENT;
        } else if (isStart) {
          annotation.trackPositionType = TrackPositionType.START;
        } else if (isEnd) {
          annotation.trackPositionType = TrackPositionType.END;
        }
      }

      this.drawTimelapseTrack(
        componentAnnotations,
        component.connections,
        color,
      );
      this.drawTimelapseAnnotationCentroidsAndLabels(componentAnnotations);
    });

    // Find orphaned annotations
    const orphanAnnotations: ITimelapseAnnotation[] = [];
    const connectedIds = new Set<string>(
      Array.from(components).flatMap((component) =>
        Array.from(component.annotations),
      ),
    );

    const displayedAnnotations = this.getDisplayedAnnotationsAcrossTime();

    const annotations = Array.from(displayedAnnotations);
    const len = annotations.length;
    for (let i = 0; i < len; i++) {
      const annotation = annotations[i];
      if (
        // If the annotation is not in the connected set, it is orphaned
        // provided it is within the timelapse window and has a tag in the timelapseTags list
        !connectedIds.has(annotation.id) &&
        annotation.location.Time >= currentTime - timelapseModeWindow &&
        annotation.location.Time <= currentTime + timelapseModeWindow &&
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
      this.drawTimelapseAnnotationCentroidsAndLabels(orphanAnnotations);
    }

    this.timelapseLayer.draw();
    this.timelapseTextLayer.draw();
  }

  drawTimelapseTrack(
    annotations: ITimelapseAnnotation[],
    connections: IAnnotationConnection[],
    color?: string,
  ) {
    // Sort annotations by time, latest first
    annotations.sort((a, b) => b.location.Time - a.location.Time);

    const currentTime = this.time;
    const drawnLines = new Set<string>(); // To avoid drawing duplicate lines

    // For each annotation, draw lines to its connected annotations in previous frames
    let lines: IGeoJSAnnotation[] = [];
    for (const annotation of annotations) {
      // Find all connections where this annotation is either parent or child
      const len = connections.length;
      const relevantConnections: IAnnotationConnection[] = [];
      for (let i = 0; i < len; i++) {
        const conn = connections[i];
        if (conn.parentId === annotation.id || conn.childId === annotation.id) {
          relevantConnections.push(conn);
        }
      }

      for (const connection of relevantConnections) {
        // Get the ID of the other annotation in the connection
        const otherId =
          connection.parentId === annotation.id
            ? connection.childId
            : connection.parentId;

        const otherAnnotation = annotations.find((a) => a.id === otherId);
        if (
          !otherAnnotation ||
          otherAnnotation.location.Time >= annotation.location.Time
        ) {
          continue; // Skip if connecting to future frames
        }

        // Create unique line ID to avoid duplicates
        const lineId = [annotation.id, otherId].sort().join("-");
        if (drawnLines.has(lineId)) continue;
        drawnLines.add(lineId);

        const points = [
          this.unrolledCentroidCoordinates[annotation.id],
          this.unrolledCentroidCoordinates[otherId],
        ];

        // Calculate time difference
        const timeDiff =
          annotation.location.Time - otherAnnotation.location.Time;
        const isTimeJump = timeDiff > 1;

        // Determine if line is before or after current time
        const isBeforeCurrent = annotation.location.Time <= currentTime;
        const line = geojsAnnotationFactory(AnnotationShape.Line, points, {
          style: {
            strokeColor: isTimeJump ? "#ff6b6b" : color, // Use a warning color for time jumps
            strokeWidth: isBeforeCurrent ? 3 : 6,
            strokeOpacity: isTimeJump ? 0.7 : 1, // Slightly more transparent for time jumps
            lineDash: isTimeJump ? [5, 5] : undefined, // Add dashed style for time jumps
          },
        });

        if (line) {
          lines.push(line);
        }
      }
    }
    this.timelapseLayer.addMultipleAnnotations(lines, undefined, false);
  }

  drawTimelapseAnnotationCentroidsAndLabels(
    annotations: ITimelapseAnnotation[],
  ) {
    const currentTime = this.time;

    // Create point annotations for each centroid
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
        [this.unrolledCentroidCoordinates[annotation.id]],
        {
          // Add metadata for click and connection handling
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
    this.timelapseLayer.addMultipleAnnotations(points, undefined, false);

    // Add time labels for the different categories of points
    // Only draw labels if showTimelapseLabels is true
    if (this.showTimelapseLabels) {
      // Add time labels for the different categories of points
      const textPoints: IGeoJSPosition[] = [];
      const textLabels: string[] = [];
      const textStyles: { fontSize?: string }[] = [];
      const textColors: string[] = [];

      // Orphan annotations
      const len = annotations.length;
      const orphanAnnotations: ITimelapseAnnotation[] = [];
      for (let i = 0; i < len; i++) {
        const a = annotations[i];
        if (a.trackPositionType === TrackPositionType.ORPHAN) {
          orphanAnnotations.push(a);
        }
      }
      for (const orphanAnnotation of orphanAnnotations) {
        textPoints.push(this.unrolledCentroidCoordinates[orphanAnnotation.id]);
        textLabels.push(`t=${orphanAnnotation.location.Time + 1}`);
        textStyles.push({}); // default style
        textColors.push("gray");
      }

      // Start point
      // For all annotations whose .trackPositionType is START, draw a text label
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
          textPoints.push(this.unrolledCentroidCoordinates[startAnnotation.id]);
          textLabels.push(`T=${startAnnotation.location.Time + 1}`);
          textStyles.push({}); // default style
          textColors.push("white");
        }
      }

      // End point
      // For all annotations whose .trackPositionType is END, draw a text label
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
          textPoints.push(this.unrolledCentroidCoordinates[endAnnotation.id]);
          textLabels.push(`T=${endAnnotation.location.Time + 1}`);
          textStyles.push({}); // default style
          textColors.push("white");
        }
      }

      // Current time point (if it exists in the sequence)
      // Adding this last so that it is drawn on top of the other points
      // This could be improved by ensuring it draws on top of ALL tracks, not just the current one
      const currentAnnotationsLength = annotations.length;
      const currentAnnotations: ITimelapseAnnotation[] = [];
      for (let i = 0; i < currentAnnotationsLength; i++) {
        const a = annotations[i];
        if (a.trackPositionType === TrackPositionType.CURRENT) {
          currentAnnotations.push(a);
        }
      }
      for (const currentAnnotation of currentAnnotations) {
        textPoints.push(this.unrolledCentroidCoordinates[currentAnnotation.id]);
        textLabels.push(`Curr T=${currentTime + 1}`);
        textStyles.push({ fontSize: "16px" }); // larger font for current time
        textColors.push("white");
      }

      // Draw text labels
      this.timelapseTextLayer
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
          offset: { x: 0, y: -10 }, // Offset text above the points
        });
    }
  }

  createGeoJSAnnotation(
    annotation: TAnnotationOrStub,
    layerId?: string,
  ): IGeoJSAnnotation | null {
    if (!this.store.dataset || !this.store.dataset.anyImage()) {
      return null;
    }

    const anyImage = this.store.dataset.anyImage();
    if (!anyImage) {
      return null;
    }

    let coordinates: IGeoJSPosition[];
    let renderShape: AnnotationShape;

    if (isHydratedAnnotation(annotation)) {
      // Full shape - use actual coordinates
      coordinates = this.unrolledCoordinates(
        annotation.coordinates,
        annotation.location,
        anyImage,
      );
      renderShape = annotation.shape;
    } else {
      // Stub: render as point at centroid location
      coordinates = this.unrolledCoordinates(
        [annotation.centroid],
        annotation.location,
        anyImage,
      );
      renderShape = AnnotationShape.Point;
    }

    // Consolidate all options into a single object
    const layer = this.store.getLayerFromId(layerId);
    const customColor = annotation.color;
    const isStub = !isHydratedAnnotation(annotation);
    const style = this.getAnnotationStyle(
      annotation.id,
      customColor,
      layer?.color,
      isStub,
    );

    const options = {
      girderId: annotation.id,
      isHovered: annotation.id === this.hoveredAnnotationId,
      isSelected: this.isAnnotationSelected(annotation.id),
      location: annotation.location,
      channel: annotation.channel,
      color: annotation.color,
      layerId,
      customColor,
      style,
      isStub, // Track if this is a stub for restyling
    };

    const newGeoJSAnnotation = geojsAnnotationFactory(
      renderShape,
      coordinates,
      options,
    );

    return newGeoJSAnnotation;
  }

  // Draw lines as a way to show the connections
  // TODO: This could be greatly improved by using addMultipleAnnotations
  // and by adding the options before the creation of the annotation rather than after.
  drawGeoJSAnnotationFromConnection(
    connection: IAnnotationConnection,
    parent: IAnnotation,
    child: IAnnotation,
  ) {
    const pA = { ...this.unrolledCentroidCoordinates[child.id] };
    delete pA.z;
    const pB = { ...this.unrolledCentroidCoordinates[parent.id] };
    delete pB.z;
    const line = geojs.annotation.lineAnnotation();
    line.options("vertices", [pA, pB]);
    line.options("isConnection", true);
    line.options("childId", connection.childId);
    line.options("parentId", connection.parentId);
    line.options("girderId", connection.id);
    this.annotationLayer.addAnnotation(line, undefined, false);
  }

  private async createAnnotationFromTool(
    coordinates: IGeoJSPosition[],
    tool: IToolConfiguration,
  ) {
    if (!coordinates || !coordinates.length || !this.dataset) {
      return null;
    }
    const annotation = await this.annotationStore.addAnnotationFromTool({
      coordinates,
      toolConfiguration: tool,
      datasetId: this.dataset.id,
    });
    this.drawAnnotationsAndTooltips();
    return annotation;
  }

  private restyleAnnotations() {
    for (const geoJSAnnotation of this.annotationLayer.annotations()) {
      const { girderId, layerId, style, customColor, isStub } =
        geoJSAnnotation.options();
      if (girderId) {
        const layer = this.store.getLayerFromId(layerId);
        const newStyle = this.getAnnotationStyle(
          girderId,
          customColor,
          layer?.color,
          isStub ?? false,
        );
        geoJSAnnotation.options("style", Object.assign({}, style, newStyle));
      }
    }
    this.annotationLayer.draw();
  }

  private pointNearPoint(
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

  private pointNearLine(
    selectionPosition: IGeoJSPosition,
    linePoints: IGeoJSPosition[],
    strokeWidth: number,
    unitsPerPixel: number,
  ): boolean {
    const width = (strokeWidth as number) * unitsPerPixel;
    return linePoints.reduce(
      (isIn: boolean, point: IGeoJSPosition, index: number) => {
        if (index === linePoints.length - 1) {
          // Specific case for the last point that does not have a next point
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

  private shouldSelectAnnotation(
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
      // If the selection annotation type is "Point"
      // Case 1: Annotation to test is a "Point":
      // The distance point to point should be lower than the annotation radius
      // Case 2: Annotation to test is a "Line":
      // The distance between the line and the point should be lower than the lineAnnotation width
      // Case 3: Annotation to test is "Polygon":
      // Check if the selection point is positioned into the Polygon.

      const selectionPosition = selectionAnnotationCoordinates[0];
      const { radius, strokeWidth } = annotationStyle;

      if (annotation.shape === AnnotationShape.Point) {
        return this.pointNearPoint(
          selectionPosition,
          annotationCoordinates[0],
          radius as number,
          strokeWidth as number,
          unitsPerPixel,
        );
      } else if (annotation.shape === AnnotationShape.Line) {
        // Check if click on points of the line, or on the line directly
        return this.pointNearLine(
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
      // If the selection annotation type is "Polygon"
      // Check if the tested annotation (independently from its type)
      // is in the defined polygon
      return annotation.coordinates.some((point: IGeoJSPosition) => {
        return geojs.util.pointInPolygon(point, selectionAnnotationCoordinates);
      });
    }
  }

  private getSelectedAnnotationsFromAnnotation(
    selectAnnotation: IGeoJSAnnotation,
  ) {
    const coordinates = selectAnnotation.coordinates();
    const type = selectAnnotation.type();

    // Get general information from the map.
    // When working with pointAnnotation, unitsPerPixels is necessary to
    // compute the right value of the radius.
    const unitsPerPixel = this.getMapUnitsPerPixel();

    // Get selected annotations.
    const selectedAnnotations: IAnnotation[] = this.annotationLayer
      .annotations()
      .reduce(
        (
          selectedAnnotations: IAnnotation[],
          geoJSannotation: IGeoJSAnnotation,
        ) => {
          const { girderId, isConnection } = geoJSannotation.options();
          if (
            !girderId ||
            isConnection ||
            selectedAnnotations.some(
              (selectedAnnotation) => selectedAnnotation.id === girderId,
            )
          ) {
            return selectedAnnotations;
          }
          const annotation = this.getAnnotationFromId(girderId);
          if (
            !annotation ||
            !this.shouldSelectAnnotation(
              type,
              coordinates,
              annotation,
              geoJSannotation.style(),
              unitsPerPixel,
            )
          ) {
            return selectedAnnotations;
          }
          return [...selectedAnnotations, annotation];
        },
        [],
      );
    return selectedAnnotations;
  }

  private shouldSelectGeoJSAnnotation(
    selectionAnnotationType: AnnotationShape,
    selectionAnnotationCoordinates: IGeoJSPosition[],
    geoJSAnnotation: IGeoJSAnnotation,
    unitsPerPixel: number,
    radius?: number, // Optional radius to use instead of the ones derives from the annotation style
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
        return this.pointNearPoint(
          selectionPosition,
          annotationCoordinates[0],
          radius as number,
          strokeWidth as number,
          unitsPerPixel,
        );
      } else if (geoJSAnnotation.type() === AnnotationShape.Line) {
        return this.pointNearLine(
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

  private getTimelapseAnnotationsFromAnnotation(
    selectAnnotation: IGeoJSAnnotation,
  ) {
    const coordinates = selectAnnotation.coordinates();
    const type = selectAnnotation.type();

    // Get general information from the map.
    // When working with pointAnnotation, unitsPerPixels is necessary to
    // compute the right value of the radius.
    const unitsPerPixel = this.getMapUnitsPerPixel();

    // Get selected annotations from the timelapse layer
    const selectedAnnotations: IGeoJSAnnotation[] = this.timelapseLayer
      .annotations()
      .reduce(
        (
          selectedAnnotations: IGeoJSAnnotation[],
          geoJSAnnotation: IGeoJSAnnotation,
        ) => {
          // Skip if it's not a timelapse point. Could also skip if already selected, but not implemented yet.
          const { isTimelapsePoint } = geoJSAnnotation.options();
          if (!isTimelapsePoint) {
            return selectedAnnotations;
          }

          if (
            !this.shouldSelectGeoJSAnnotation(
              type,
              coordinates,
              geoJSAnnotation,
              unitsPerPixel,
              5, // Radius for selection to allow for clicking on small points.
            )
          ) {
            return selectedAnnotations;
          }

          return [...selectedAnnotations, geoJSAnnotation];
        },
        [],
      );
    return selectedAnnotations;
  }

  private selectAnnotations(selectAnnotation: IGeoJSAnnotation) {
    if (!selectAnnotation) {
      return;
    }
    const selectedAnnotations =
      this.getSelectedAnnotationsFromAnnotation(selectAnnotation);

    // Update annotation store
    switch (this.annotationSelectionType) {
      case AnnotationSelectionTypes.ADD:
        this.annotationStore.selectAnnotations(selectedAnnotations);
        break;
      case AnnotationSelectionTypes.REMOVE:
        this.annotationStore.unselectAnnotations(selectedAnnotations);
        break;
      case AnnotationSelectionTypes.TOGGLE:
        this.annotationStore.toggleSelected(selectedAnnotations);
    }

    // Remove the selection annotation from layer (do not show the annotation used to select)
    this.interactionLayer.removeAnnotation(selectAnnotation);
  }

  private async handleAnnotationConnections(
    selectAnnotation: IGeoJSAnnotation,
  ) {
    const datasetId = this.dataset?.id;
    if (!selectAnnotation || !datasetId || !this.selectedToolConfiguration) {
      return;
    }

    let selectedAnnotations: IAnnotation[];
    if (this.showTimelapseMode) {
      // In the timelapse mode, we can use the same selection logic,
      // but the getTimelapseAnnotationsFromAnnotation returns GeoJS annotations,
      // so we need to map them to the corresponding annotations in the annotation store
      // using the girderId (filtering out undefined).
      const selectedGeoJSAnnotations =
        this.getTimelapseAnnotationsFromAnnotation(selectAnnotation);
      selectedAnnotations = selectedGeoJSAnnotations
        .map((a) => this.getAnnotationFromId(a.options().girderId))
        .filter((a): a is IAnnotation => a !== undefined);
    } else {
      selectedAnnotations =
        this.getSelectedAnnotationsFromAnnotation(selectAnnotation);
    }

    const parentTemplate = this.selectedToolConfiguration.values
      ?.parentAnnotation as IRestrictTagsAndLayer;
    const childTemplate = this.selectedToolConfiguration.values
      ?.childAnnotation as IRestrictTagsAndLayer;
    if (!parentTemplate || !childTemplate) {
      return;
    }
    // Get all the parents and children
    const parents = filterAnnotations(selectedAnnotations, parentTemplate);
    const children = filterAnnotations(selectedAnnotations, childTemplate);
    const parentIds = parents.map((a) => a.id);
    const childIds = children.map((a) => a.id);

    // Can be add_click, add_lasso, delete_lasso, delete_click
    const action = this.selectedToolConfiguration.values.action.value;
    const addAction = action.startsWith("add");
    const clickAction = action.endsWith("click");
    const clickedAnnotation = selectedAnnotations[0];

    if (addAction) {
      if (clickAction) {
        // Select an annotation or connect to selected annotation
        if (
          clickedAnnotation &&
          this.selectedToolState?.type === ConnectionToolStateSymbol &&
          this.selectedToolState.selectedAnnotationId
        ) {
          // Connect to selected
          if (this.showTimelapseMode) {
            this.annotationStore.createTimelapseConnection({
              parentId: this.selectedToolState.selectedAnnotationId,
              childId: clickedAnnotation.id,
              datasetId,
              label: this.selectedToolConfiguration.name,
              tags: ["Time lapse connection"],
            });
          } else {
            this.annotationStore.createConnection({
              parentId: this.selectedToolState.selectedAnnotationId,
              childId: clickedAnnotation.id,
              datasetId,
              label: this.selectedToolConfiguration.name,
              tags: [...parentTemplate.tags, ...childTemplate.tags],
            });
          }
        }
      } else {
        // Add all connections between parents and children
        if (this.showTimelapseMode) {
          await this.annotationStore.createAllTimelapseConnections({
            parentIds,
            childIds,
            label: this.selectedToolConfiguration.name,
            tags: ["Time lapse connection"],
          });
        } else {
          await this.annotationStore.createAllConnections({
            parentIds,
            childIds,
            label: this.selectedToolConfiguration.name,
            tags: [...parentTemplate.tags, ...childTemplate.tags],
          });
        }
      }
    } else {
      if (clickAction) {
        // Select an annotation or connect to selected annotation
        if (
          clickedAnnotation &&
          this.selectedToolState?.type === ConnectionToolStateSymbol &&
          this.selectedToolState.selectedAnnotationId
        ) {
          // Disconnect from selected
          const firstId = this.selectedToolState.selectedAnnotationId;
          const secondId = clickedAnnotation.id;
          this.annotationStore.deleteAllConnections({
            childIds: [firstId, secondId],
            parentIds: [firstId, secondId],
          });
        }
      } else {
        // Delete any connection between a parent and a child
        await this.annotationStore.deleteAllConnections({
          parentIds,
          childIds,
        });
      }
    }

    // Reset or set the selected annotation id in the tool state
    if (
      clickAction &&
      this.selectedToolState?.type === ConnectionToolStateSymbol
    ) {
      const selectedId = this.selectedToolState.selectedAnnotationId;
      Vue.set(
        this.selectedToolState,
        "selectedAnnotationId",
        selectedId || !clickedAnnotation ? null : clickedAnnotation.id,
      );
    }

    // Remove the selection annotation from layer (do not show the annotation used to select)
    this.interactionLayer.removeAnnotation(selectAnnotation);
  }

  /**
   * Handle the combine tool click interaction.
   * First click selects an annotation, second click combines it with the first.
   */
  private async handleAnnotationCombine(selectAnnotation: IGeoJSAnnotation) {
    if (!selectAnnotation || !this.selectedToolConfiguration) {
      return;
    }

    // Get the annotation(s) that were clicked
    const selectedAnnotations =
      this.getSelectedAnnotationsFromAnnotation(selectAnnotation);

    // Apply tool configuration filters (tags/layer restrictions)
    const annotationTemplate = this.selectedToolConfiguration.values
      ?.annotation as IRestrictTagsAndLayer;
    const filteredAnnotations = annotationTemplate
      ? filterAnnotations(selectedAnnotations, annotationTemplate)
      : selectedAnnotations;

    // Only consider polygon/blob annotations for combining
    const polygonAnnotations = filteredAnnotations.filter(
      (a) => a.shape === AnnotationShape.Polygon,
    );

    const clickedAnnotation = polygonAnnotations[0];

    // Handle the two-click pattern
    if (
      clickedAnnotation &&
      this.selectedToolState?.type === CombineToolStateSymbol &&
      this.selectedToolState.selectedAnnotationId
    ) {
      // Second click - combine the annotations
      const firstAnnotationId = this.selectedToolState.selectedAnnotationId;
      const secondAnnotationId = clickedAnnotation.id;

      // Don't combine with itself
      if (firstAnnotationId !== secondAnnotationId) {
        // Get tolerance from tool configuration (default to 2 if not specified)
        const tolerance = parseFloat(
          this.selectedToolConfiguration.values?.tolerance ?? "2",
        );

        const success = await this.annotationStore.combineAnnotations({
          firstAnnotationId,
          secondAnnotationId,
          tolerance: isNaN(tolerance) ? 2 : tolerance,
        });

        if (!success) {
          logWarning("Failed to combine annotations");
        }
      }

      // Reset the tool state after combining
      Vue.set(this.selectedToolState, "selectedAnnotationId", null);
    } else if (
      clickedAnnotation &&
      this.selectedToolState?.type === CombineToolStateSymbol
    ) {
      // First click - select the annotation
      Vue.set(
        this.selectedToolState,
        "selectedAnnotationId",
        clickedAnnotation.id,
      );
    }

    // Remove the interaction annotation from the layer
    this.interactionLayer.removeAnnotation(selectAnnotation);
  }

  private async addAnnotationFromGeoJsAnnotation(annotation: IGeoJSAnnotation) {
    if (!annotation || !this.selectedToolConfiguration) {
      return;
    }

    const coordinates = annotation.coordinates();
    this.interactionLayer.removeAnnotation(annotation);

    // Create the new annotation
    await this.createAnnotationFromTool(
      coordinates,
      this.selectedToolConfiguration,
    );
  }

  async addAnnotationFromSnapping(annotation: IGeoJSAnnotation) {
    if (!annotation || this.maps.length !== 1) {
      return;
    }
    const mapentry = this.maps[0];
    const coordinates = annotation.coordinates();
    this.interactionLayer.removeAnnotation(annotation);
    if (!this.selectedToolConfiguration) {
      return;
    }
    const location =
      this.selectedToolConfiguration.values.annotation.coordinateAssignments;
    if (!location) {
      logError("Invalid snapping tool, annotation was not configured properly");
      return;
    }
    const layerId = location.layer;
    const layerIndex = this.store.getLayerIndexFromId(layerId);
    if (layerIndex === null) {
      return;
    }
    const layerImage = mapentry.imageLayers[layerIndex * 2];
    if (!layerImage) {
      return;
    }
    // Capture a screenshot of the layer and convert to png binary
    const canvas = await mapentry.map.screenshot(layerImage, "canvas");
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r));
    if (!blob) {
      return;
    }
    const array = new Uint8Array(await blob.arrayBuffer());
    // Compute snapped coordinates
    const snappedCoordinates = await snapCoordinates(
      coordinates,
      array,
      this.selectedToolConfiguration,
      mapentry.map,
    );
    if (!snappedCoordinates || !snappedCoordinates.length) {
      logError("Failed to compute new coordinates for the snapping tool");
      return;
    }
    // Create the new annotation
    await this.createAnnotationFromTool(
      snappedCoordinates,
      this.selectedToolConfiguration,
    );
  }

  async handleAnnotationEdits(selectAnnotation: IGeoJSAnnotation) {
    // Get the selected annotations that intersect with the lasso
    const selectedAnnotations =
      this.getSelectedAnnotationsFromAnnotation(selectAnnotation);

    if (selectedAnnotations.length === 0) {
      this.interactionLayer.removeAnnotation(selectAnnotation);
      return;
    }

    // Filter out annotations that are not polygons
    const polygonAnnotations = selectedAnnotations.filter(
      (annotation) => annotation.shape === AnnotationShape.Polygon,
    );

    if (polygonAnnotations.length === 0) {
      this.interactionLayer.removeAnnotation(selectAnnotation);
      return;
    }

    // Filter out annotations that do not match the tool configuration
    const annotationTemplate = this.selectedToolConfiguration?.values
      ?.annotation as IRestrictTagsAndLayer;
    let filteredAnnotations: IAnnotation[] = [];
    if (annotationTemplate) {
      filteredAnnotations = filterAnnotations(
        selectedAnnotations,
        annotationTemplate,
      );
    } else {
      filteredAnnotations = polygonAnnotations;
    }

    if (filteredAnnotations.length === 0) {
      this.interactionLayer.removeAnnotation(selectAnnotation);
      return;
    }

    // Edit the first annotation in the list.
    // TODO: This logic could be improved by using some more intelligent logic
    // to determine which annotation to edit.
    const annotationToEdit = filteredAnnotations[0];

    await this.annotationStore.updateAnnotationsPerId({
      annotationIds: [annotationToEdit.id],
      editFunction: (annotation: IAnnotation) => {
        const newAnnotation = this.editPolygonAnnotation(
          annotation,
          selectAnnotation.coordinates(),
        );
        annotation.coordinates = newAnnotation.coordinates;
      },
    });

    // Remove the temporary selection annotation
    this.interactionLayer.removeAnnotation(selectAnnotation);
  }

  // This function edits the polygon annotation by "carving" with a line.
  editPolygonAnnotation(
    annotation: IAnnotation,
    newLine: IGeoJSPosition[],
  ): IAnnotation {
    return {
      ...annotation,
      coordinates: editPolygonAnnotation(annotation, newLine),
    };
  }

  handleNewROIFilter(geojsAnnotation: IGeoJSAnnotation) {
    if (!this.roiFilter) {
      return;
    }
    this.filterStore.validateNewROIFilter(geojsAnnotation.coordinates());
    this.interactionLayer.removeAnnotation(geojsAnnotation);
  }

  get selectedToolRadius(): number | undefined {
    return this.selectedToolConfiguration?.values?.radius;
  }

  cursorAnnotation: IGeoJSAnnotation | null = null;
  lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  @Watch("selectedToolRadius")
  updateCursorAnnotation(evt?: any) {
    if (
      !this.selectedToolConfiguration ||
      !this.cursorAnnotation ||
      !this.selectedToolRadius ||
      !this.maps
    ) {
      return false;
    }
    const map = this.map;
    const basePositionGCS = evt?.mapgcs ? evt.mapgcs : this.lastCursorPosition;
    this.lastCursorPosition = basePositionGCS;
    const basePositionDisplay = map.gcsToDisplay(basePositionGCS);
    this.cursorAnnotation._coordinates(
      [
        {
          x: basePositionDisplay.x - this.selectedToolRadius,
          y: basePositionDisplay.y - this.selectedToolRadius,
        },
        {
          x: basePositionDisplay.x + this.selectedToolRadius,
          y: basePositionDisplay.y - this.selectedToolRadius,
        },
        {
          x: basePositionDisplay.x + this.selectedToolRadius,
          y: basePositionDisplay.y + this.selectedToolRadius,
        },
        {
          x: basePositionDisplay.x - this.selectedToolRadius,
          y: basePositionDisplay.y + this.selectedToolRadius,
        },
      ].map((point) => map.displayToGcs(point)),
    );
    this.cursorAnnotation.draw();
    return true;
  }

  addCursorAnnotation() {
    if (this.cursorAnnotation) {
      return;
    }
    this.cursorAnnotation = geojs.createAnnotation("circle");
    this.cursorAnnotation.layer(this.interactionLayer);
    this.interactionLayer.addAnnotation(this.cursorAnnotation);
    this.interactionLayer.geoOn(
      geojs.event.mousemove,
      this.updateCursorAnnotation,
    );
    this.interactionLayer.geoOn(geojs.event.zoom, this.updateCursorAnnotation);
    this.cursorAnnotation.style({
      fill: true,
      fillColor: "white",
      fillOpacity: 0.2,
      strokeWidth: 3,
      strokeColor: "black",
    });
    this.updateCursorAnnotation();
  }

  refreshAnnotationMode() {
    this.clearAnnotationMode();
    this.setNewAnnotationMode();
  }

  clearAnnotationMode() {
    // Remove cursor annotation if there is one
    if (this.cursorAnnotation) {
      this.interactionLayer.removeAnnotation(this.cursorAnnotation);
      this.interactionLayer.geoOff(
        geojs.event.mousemove,
        this.updateCursorAnnotation,
      );
      this.interactionLayer.geoOff(
        geojs.event.zoom,
        this.updateCursorAnnotation,
      );
      this.cursorAnnotation = null;
    }
  }

  setNewAnnotationMode() {
    if (this.unrolling) {
      this.interactionLayer.mode(null);
      return;
    }

    if (this.roiFilter) {
      if (this.selectedToolConfiguration) {
        this.store.setSelectedToolId(null);
      }
      this.interactionLayer.mode("polygon");
      return;
    }

    switch (this.selectedToolConfiguration?.type) {
      case "create":
        const annotation = this.selectedToolConfiguration.values.annotation;
        this.interactionLayer.mode(annotation?.shape);
        break;
      case "tagging":
        if (
          ["tag_click", "untag_click"].includes(
            this.selectedToolConfiguration.values.action.value,
          )
        ) {
          this.interactionLayer.mode("point");
        } else {
          this.interactionLayer.mode("polygon");
        }
        break;
      case "snap":
        if (
          this.selectedToolConfiguration.values.snapTo.value === "circleToDot"
        ) {
          this.addCursorAnnotation();
          this.interactionLayer.mode("point");
        } else {
          this.interactionLayer.mode("polygon");
        }
        break;
      case "segmentation":
        // TODO: tool asks for ROI, change layer mode and trigger computation afterwards
        // TODO: otherwise, trigger computation here
        // TODO: when computation is triggered, toggle a bool that enables a v-menu
        // TODO: for now with just a compute button, but later previews, custom forms served from the started worker ?
        // If needed, set mode or handle segmentation differently
        this.interactionLayer.mode(null);
        break;
      case "connection":
        if (
          this.selectedToolConfiguration.values.action.value.endsWith("click")
        ) {
          this.interactionLayer.mode("point");
        } else {
          this.interactionLayer.mode("polygon");
        }
        break;
      case "select":
        const selectionType =
          this.selectedToolConfiguration.values.selectionType.value ===
          "pointer"
            ? "point"
            : "polygon";
        this.interactionLayer.mode(selectionType);
        break;
      case "edit":
        // combine_click action uses point mode, blob_edit uses line mode
        if (
          this.selectedToolConfiguration?.values?.action?.value ===
          "combine_click"
        ) {
          this.interactionLayer.mode("point");
        } else {
          this.interactionLayer.mode("line");
        }
        break;
      case "samAnnotation":
      case null:
      case undefined:
        this.interactionLayer.mode(null);
        break;
      default:
        logWarning(
          `${this.selectedToolConfiguration?.type} tools are not supported yet`,
        );
        this.interactionLayer.mode(null);
    }
  }

  handleModeChange(evt: any) {
    if (evt.mode === null) {
      this.refreshAnnotationMode();
    }
  }

  handleInteractionModeChange(evt: any) {
    if (evt.mode === null) {
      this.refreshAnnotationMode();
    }
  }

  setHoveredAnnotationFromCoordinates(gcsCoordinates: IGeoJSPosition) {
    const geoAnnotations: IGeoJSAnnotation[] =
      this.annotationLayer.annotations();
    let annotationToToggle: IAnnotation | null = null;
    // TODO (performance): use a spatial index or something else to speed this up
    for (let i = 0; i < geoAnnotations.length; ++i) {
      const geoAnnotation = geoAnnotations[i];
      const id = geoAnnotation.options("girderId");
      if (!id) {
        continue;
      }
      const annotation = this.getAnnotationFromId(id);
      if (!annotation) {
        continue;
      }
      const unitsPerPixel = this.getMapUnitsPerPixel();
      const shouldSelect = this.shouldSelectAnnotation(
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
      this.annotationStore.hoveredAnnotationId === annotationToToggle.id
    ) {
      this.annotationStore.setHoveredAnnotationId(null);
    } else {
      this.annotationStore.setHoveredAnnotationId(annotationToToggle.id);
    }
  }

  private getMapUnitsPerPixel(): number {
    const map = this.annotationLayer.map();
    return map.unitsPerPixel(map.zoom());
  }

  handleInteractionAnnotationChange(evt: any) {
    if (!this.selectedToolConfiguration && !this.roiFilter) {
      return;
    }

    if (
      evt.event === "geo_annotation_state" &&
      evt.annotation?.layer() === this.interactionLayer
    ) {
      if (this.selectedToolConfiguration) {
        switch (this.selectedToolConfiguration.type) {
          case "create":
            this.addAnnotationFromGeoJsAnnotation(evt.annotation);
            break;
          case "tagging":
            this.handleAnnotationTagging(evt.annotation);
            break;
          case "snap":
            this.addAnnotationFromSnapping(evt.annotation);
            break;
          case "select":
            this.selectAnnotations(evt.annotation);
            break;
          case "connection":
            this.handleAnnotationConnections(evt.annotation);
            break;
          case "edit":
            // Route combine_click action to handleAnnotationCombine
            if (
              this.selectedToolConfiguration?.values?.action?.value ===
              "combine_click"
            ) {
              this.handleAnnotationCombine(evt.annotation);
            } else {
              this.handleAnnotationEdits(evt.annotation);
            }
            break;
        }
      } else {
        this.handleNewROIFilter(evt.annotation);
      }
    }
  }

  handleTimelapseAnnotationClick(evt: IGeoJSMouseState) {
    if (!evt?.geo) {
      return;
    }

    let timeToSet: number | null = null;

    // Create a temporary point annotation from the click
    const clickAnnotation = {
      type: () => AnnotationShape.Point,
      coordinates: () => [evt.geo],
      style: () => ({
        radius: 10, // Matches the radius used for current time points
        //strokeWidth: 1, // Add some padding for easier clicking
        //scaled: 0, // Fixed size in image coordinates
      }),
    } as IGeoJSAnnotation;

    const selectedTimelapseAnnotations =
      this.getTimelapseAnnotationsFromAnnotation(clickAnnotation);

    if (selectedTimelapseAnnotations.length > 0) {
      timeToSet = selectedTimelapseAnnotations[0].options("time");

      if (timeToSet !== null && this.time !== timeToSet) {
        this.store.setTime(timeToSet);
      }
    }
  }

  // AR: I added some code here to prevent duplicate redraws. I found that when e.g. xy changes, then the watcher for displayedAnnotations also changed.
  // This caused a double redraw. But the problem is that if you remove the watcher for displayedAnnotations, then the annotations are not redrawn when the user for instance deletes an annotation.
  // The solution implemented here is to have a flag that is set when any of the primary watchers are triggered, and then unset when the drawAnnotationsAndTooltips is called.
  // However, I don't think this is a robust solution, because it makes it very hard to track down exactly what watchers could be double-triggering the redraw.
  // It also makes the code harder to understand.
  // TODO: I think a better solution would be to have a Vuex store variable that sets a single flag for a redraw. Then, if multiple watchers trigger a redraw, the flag is already set and the redraw would not be triggered.
  // That would also the logic for redrawing a lot more explicit and easier to understand.
  // I decided not to implement this just yet because I think it would require a fair number of changes and debugging, so it didn't seem worth it right now. But if we run into more such issues, we should consider it.
  // Add this property to track if we're handling a redraw from a primary change
  private handlingPrimaryChange = false;

  @Watch("annotationConnections")
  @Watch("xy")
  @Watch("z")
  @Watch("time")
  @Watch("hoveredAnnotationId")
  @Watch("selectedAnnotations")
  @Watch("shouldDrawAnnotations")
  @Watch("shouldDrawConnections")
  onPrimaryChange() {
    // Set flag before triggering redraw
    this.handlingPrimaryChange = true;
    this.drawAnnotationsAndTooltips();

    // Clear flag after a tick to allow Vue to process all watchers
    Vue.nextTick(() => {
      this.handlingPrimaryChange = false;
    });
  }

  @Watch("showTimelapseMode")
  @Watch("timelapseModeWindow")
  @Watch("timelapseTags")
  @Watch("showTimelapseLabels")
  onTimelapseModeChanged() {
    this.drawTimelapseConnectionsAndCentroids();
  }

  @Watch("displayedAnnotations")
  onDisplayedAnnotationsChange() {
    // Only trigger redraw if we're not already handling a primary change
    if (!this.handlingPrimaryChange) {
      this.drawAnnotationsAndTooltips();
    }
  }

  @Watch("baseStyle")
  @Watch("layers")
  @Watch("toolHighlightedAnnotationIds")
  onRestyleNeeded() {
    this.restyleAnnotations();
  }

  @Watch("unrolling")
  toggleAnnotationModeWhenUnrolling() {
    this.refreshAnnotationMode();
  }

  @Watch("showTooltips")
  @Watch("filteredAnnotationTooltips")
  @Watch("filteredAnnotations")
  @Watch("properties")
  @Watch("propertyValues")
  @Watch("displayedPropertyPaths")
  onDrawTooltipsChanged() {
    this.drawTooltips();
  }

  // Watch for changes that affect visibility budget and hydration mode
  @Watch("filteredAnnotations")
  @Watch("gcsBounds")
  @Watch("xy")
  @Watch("z")
  @Watch("time")
  onVisibilityInputsChanged() {
    this.updateVisibilityDebounced();
  }

  @Watch("unrollH")
  @Watch("unrollW")
  onUnrollChanged() {
    this.clearOldAnnotations(true);
    this.drawAnnotationsAndTooltips();
  }

  @Watch("selectedToolConfiguration")
  watchTool() {
    this.refreshAnnotationMode();
  }

  @Watch("roiFilter")
  watchFilter() {
    if (this.roiFilter) {
      this.refreshAnnotationMode();
    }
  }

  @Watch("enabledRoiFilters")
  drawRoiFilters() {
    this.annotationLayer
      .annotations()
      .filter((annotation: IGeoJSAnnotation) =>
        annotation.options("isRoiFilter"),
      )
      .forEach((annotation: IGeoJSAnnotation) => {
        this.annotationLayer.removeAnnotation(annotation);
      });
    this.enabledRoiFilters.forEach((filter: IROIAnnotationFilter) => {
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
      this.annotationLayer.addAnnotation(newGeoJSAnnotation);
    });
  }

  @Watch("annotationLayer")
  bindAnnotationEvents() {
    // TODO: We could move the click handler for hover here instead of having its own
    // separate handler. But not sure if there was a reason for keeping it separate.
    this.annotationLayer.geoOn(
      geojs.event.mouseclick,
      (evt: IGeoJSMouseState) => {
        if (evt.buttonsDown.right) {
          this.handleAnnotationRightClick(evt);
        }
      },
    );

    // Configure the map interactor to prevent panning during Alt-drag
    // TODO: Unclear if I should be setting this here or in ImageViewer.vue
    const map = this.annotationLayer.map();
    const interactorOpts = map.interactor().options();
    const actions = interactorOpts.actions || [];

    // Find and modify the pan action to not trigger when Alt is pressed
    const panAction = actions.find(
      (action: any) => action.name === "button pan",
    );
    if (panAction) {
      panAction.modifiers = { shift: false, ctrl: false, alt: false };
    }

    map.interactor().options({ ...interactorOpts, actions });

    // Handle drag events
    this.annotationLayer.geoOn(geojs.event.mousedown, this.handleDragStart);
    this.annotationLayer.geoOn(geojs.event.mousemove, this.handleDragMove);
    this.annotationLayer.geoOn(geojs.event.mouseup, this.handleDragEnd);

    this.drawAnnotationsAndTooltips();
  }

  @Watch("interactionLayer")
  bindInteractionEvents() {
    if (!this.interactionLayer) {
      return;
    }
    // Handle annotation changes (creation, tagging, snapping, selection, connection) on the interactionLayer
    this.interactionLayer.geoOn(
      geojs.event.annotation.mode,
      this.handleInteractionModeChange,
    );
    this.interactionLayer.geoOn(
      geojs.event.annotation.add,
      this.handleInteractionAnnotationChange,
    );
    this.interactionLayer.geoOn(
      geojs.event.annotation.update,
      this.handleInteractionAnnotationChange,
    );
    this.interactionLayer.geoOn(
      geojs.event.annotation.state,
      this.handleInteractionAnnotationChange,
    );
    if (this.selectedToolConfiguration?.type === "tagging") {
      this.interactionLayer.geoOn(
        geojs.event.mouseclick,
        this.handleTaggingClick,
      );
    }
    this.refreshAnnotationMode();
  }

  @Watch("timelapseLayer")
  bindTimelapseEvents() {
    this.timelapseLayer.geoOn(
      geojs.event.mouseclick,
      this.handleTimelapseAnnotationClick,
    );
    // TODO: Not sure this next line is necessary. It seems to draw just fine, so I'm leaving it out for now.
    // But if some drawing is not happening, this might be something to check.
    // this.drawTimelapseConnectionsAndCentroids();
  }

  @Watch("annotationLayer")
  @Watch("valueOnHover")
  updateValueOnHover() {
    this.store.setHoverValue(null);
    if (this.valueOnHover) {
      this.annotationLayer.geoOn(
        geojs.event.mousemove,
        this.handleValueOnMouseMove,
      );
    } else {
      this.annotationLayer.geoOff(
        geojs.event.mousemove,
        this.handleValueOnMouseMove,
      );
    }
  }

  handleValueOnMouseMove(e: any) {
    this.handleValueOnMouseMoveDebounce(e);
  }

  handleValueOnMouseMoveDebounce = debounce(
    this.handleValueOnMouseMoveNoDebounce,
    15,
  );

  // Debounced visibility update to avoid excessive re-renders during pan/zoom
  updateVisibilityDebounced = debounce(() => {
    const filteredIds = this.filteredAnnotations.map((a) => a.id);
    this.annotationStore.updateVisibilityAndHydration({
      filteredIds,
      gcsBounds: this.gcsBounds,
      currentFrameLocation: { XY: this.xy, Z: this.z, Time: this.time },
    });
  }, 250);

  async handleValueOnMouseMoveNoDebounce(e: any) {
    if (!this.dataset) {
      return;
    }

    // Collect all frame indices from all layers (including invisible ones)
    const frameIndices: number[] = [];
    const layerToFrameMap: { [layerId: string]: number } = {};

    for (const layer of this.validLayers) {
      const image = this.store.getImagesFromLayer(layer)[0];
      if (image) {
        frameIndices.push(image.frameIndex);
        layerToFrameMap[layer.id] = image.frameIndex;
      }
    }

    if (frameIndices.length === 0) {
      return;
    }

    // Get the itemId from the first image (all images should have the same item)
    const firstImage = this.store.getImagesFromLayer(this.validLayers[0])[0];
    if (!firstImage) {
      return;
    }

    const itemId = firstImage.item._id;

    try {
      // Make single API call to get pixel values for all layers
      const pixelData = await this.store.api.getPixelValuesForAllLayers(
        itemId,
        e.geo.x,
        e.geo.y,
        frameIndices,
      );

      // Process the response and map back to layers
      const values: { [layerId: string]: number[] } = {};
      for (const pixel of pixelData) {
        // Find which layer this pixel data belongs to by matching frame index
        for (const [layerId, frameIndex] of Object.entries(layerToFrameMap)) {
          if (pixel.frame === frameIndex && pixel.value) {
            values[layerId] = pixel.value;
            break;
          }
        }
      }

      if (Object.keys(values).length > 0) {
        this.store.setHoverValue(values);
      }
    } catch (error) {
      logError("Error fetching pixel values:", error);
    }
  }

  mounted() {
    this.bindAnnotationEvents();
    this.bindTimelapseEvents();
    this.bindInteractionEvents();

    this.updateValueOnHover();

    this.filterStore.updateHistograms();

    this.addHoverCallback();
  }

  beforeDestroy() {
    // Clean up drag event listeners
    if (this.annotationLayer) {
      this.annotationLayer.geoOff(geojs.event.mousedown, this.handleDragStart);
      this.annotationLayer.geoOff(geojs.event.mousemove, this.handleDragMove);
      this.annotationLayer.geoOff(geojs.event.mouseup, this.handleDragEnd);
    }
  }

  @Watch("annotationLayer")
  addHoverCallback() {
    this.annotationLayer.geoOn(geojs.event.mouseclick, (evt: any) => {
      if (this.selectedToolConfiguration === null && evt?.geo) {
        this.setHoveredAnnotationFromCoordinates(evt.geo);
      }
    });
  }

  private async handleAnnotationTagging(annotation: IGeoJSAnnotation) {
    if (!annotation) {
      return;
    }
    const selectedAnnotations =
      this.getSelectedAnnotationsFromAnnotation(annotation);
    if (selectedAnnotations.length > 0) {
      const action = this.selectedToolConfiguration?.values?.action?.value;
      const tags = this.selectedToolConfiguration?.values?.tags || [];
      const removeExisting =
        this.selectedToolConfiguration?.values?.removeExisting || false;

      await this.updateAnnotationTags(
        selectedAnnotations.map((a) => a.id),
        action,
        tags,
        removeExisting,
      );

      // Highlight the last tagged annotation in the list
      if (selectedAnnotations.length === 1) {
        this.annotationStore.setHoveredAnnotationId(selectedAnnotations[0].id);
      }
    }
    this.interactionLayer.removeAnnotation(annotation);
  }

  private handleTaggingClick = (evt: any) => {
    if (
      !this.selectedToolConfiguration ||
      this.selectedToolConfiguration.type !== "tagging" ||
      !evt?.geo
    ) {
      return;
    }
    const selectedAnnotations = this.getSelectedAnnotationsFromAnnotation({
      type: () => AnnotationShape.Point,
      coordinates: () => [evt.geo],
    } as IGeoJSAnnotation);

    if (selectedAnnotations.length === 1) {
      const selectedAnnotation = selectedAnnotations[0];
      const action = this.selectedToolConfiguration.values.action.value;
      const tags = this.selectedToolConfiguration.values.tags || [];
      const removeExisting =
        this.selectedToolConfiguration?.values?.removeExisting || false;

      this.updateAnnotationTags(
        [selectedAnnotation.id],
        action,
        tags,
        removeExisting,
      );

      // Highlight the tagged annotation in the list
      this.annotationStore.setHoveredAnnotationId(selectedAnnotation.id);
    }
  };

  private async updateAnnotationTags(
    annotationIds: string[],
    action: string,
    tags: string[],
    removeExisting: boolean,
  ) {
    await this.annotationStore.updateAnnotationsPerId({
      annotationIds,
      editFunction: (annotation: IAnnotation) => {
        if (action.startsWith("untag")) {
          // Remove specified tags if they exist
          annotation.tags = annotation.tags.filter(
            (tag) => !tags.includes(tag),
          );
        } else {
          // Add tags (either replacing or merging)
          annotation.tags = removeExisting
            ? [...tags]
            : [...new Set([...annotation.tags, ...tags])];
        }
      },
    });
  }

  showContextMenu = false;
  contextMenuX = 0;
  contextMenuY = 0;
  rightClickedAnnotation: IAnnotation | null = null;

  handleAnnotationRightClick(evt: IGeoJSMouseState) {
    if (!evt) {
      return;
    }

    // Find which annotation was clicked
    // TODO: It is possible that this could be optimized by directly asking GeoJS for the annotationId
    const geoAnnotations: IGeoJSAnnotation[] =
      this.annotationLayer.annotations();
    for (const geoAnnotation of geoAnnotations) {
      const id = geoAnnotation.options("girderId");
      if (!id) {
        continue;
      }
      const annotation = this.getAnnotationFromId(id);
      if (!annotation) {
        continue;
      }
      const unitsPerPixel = this.getMapUnitsPerPixel();
      const shouldSelect = this.shouldSelectAnnotation(
        AnnotationShape.Point,
        [evt.geo],
        annotation,
        geoAnnotation.style(),
        unitsPerPixel,
      );
      if (shouldSelect) {
        // Show context menu
        this.rightClickedAnnotation = annotation;
        this.contextMenuX = evt.evt.clientX;
        this.contextMenuY = evt.evt.clientY;
        this.showContextMenu = true;
        break;
      }
    }
  }

  handleContextMenuCancel() {
    this.showContextMenu = false;
    this.rightClickedAnnotation = null;
  }

  handleContextMenuSave({
    annotationId,
    color,
  }: {
    annotationId?: string;
    color: string;
  }) {
    if (annotationId) {
      this.annotationStore.colorAnnotationIds({
        annotationIds: [annotationId],
        color,
      });
    }
    this.showContextMenu = false;
    this.rightClickedAnnotation = null;
  }

  handleDeselectAll() {
    this.annotationStore.clearSelectedAnnotations();
  }

  showTagDialog = false;
  showColorDialog = false;

  handleTagSubmit({
    tags,
    addOrRemove,
    replaceExisting,
  }: {
    tags: string[];
    addOrRemove: "add" | "remove";
    replaceExisting: boolean;
  }) {
    if (addOrRemove === "add") {
      this.annotationStore.tagSelectedAnnotations({
        tags,
        replace: replaceExisting,
      });
    } else {
      this.annotationStore.removeTagsFromSelectedAnnotations(tags);
    }
  }

  handleColorSubmit({
    useColorFromLayer,
    color,
    randomize,
  }: {
    useColorFromLayer: boolean;
    color: string;
    randomize?: boolean;
  }) {
    const newColor = useColorFromLayer ? null : color;
    this.annotationStore.colorSelectedAnnotations({
      color: newColor,
      randomize,
    });
  }

  // Drag handlers
  private handleDragStart(evt: IGeoJSMouseState) {
    if (!evt?.geo || !evt.modifiers?.alt) {
      return;
    }

    // Find which annotation was clicked
    const geoAnnotations: IGeoJSAnnotation[] =
      this.annotationLayer.annotations();
    for (const geoAnnotation of geoAnnotations) {
      const id = geoAnnotation.options("girderId");
      if (!id) {
        continue;
      }
      const annotation = this.getAnnotationFromId(id);
      if (!annotation) {
        continue;
      }
      const unitsPerPixel = this.getMapUnitsPerPixel();
      const shouldSelect = this.shouldSelectAnnotation(
        AnnotationShape.Point,
        [evt.geo],
        annotation,
        geoAnnotation.style(),
        unitsPerPixel,
      );
      if (shouldSelect) {
        // Start dragging
        this.isDragging = true;
        this.dragStartPosition = evt.geo;
        this.draggedAnnotation = annotation;
        this.dragOriginalCoordinates = [...annotation.coordinates];

        // Create ghost annotation
        const style = {
          fillOpacity: 0.25,
          strokeOpacity: 0.5,
          fillColor: "red",
          strokeColor: "red",
          strokeWidth: 2,
        };

        // Create directly with GeoJS instead of using createGeoJSAnnotation
        this.dragGhostAnnotation = geojsAnnotationFactory(
          annotation.shape,
          [...annotation.coordinates],
          { style },
        );

        if (this.dragGhostAnnotation) {
          this.dragGhostAnnotation.options("specialAnnotation", true);
          this.interactionLayer.addAnnotation(this.dragGhostAnnotation);
        }
        break;
      }
    }
  }

  private handleDragMove(evt: IGeoJSMouseState) {
    if (
      !this.isDragging ||
      !this.dragStartPosition ||
      !this.draggedAnnotation ||
      !this.dragGhostAnnotation ||
      !evt?.geo
    ) {
      return;
    }

    // Calculate offset
    const dx = evt.geo.x - this.dragStartPosition.x;
    const dy = evt.geo.y - this.dragStartPosition.y;

    // Create new coordinates
    const newCoordinates = this.dragOriginalCoordinates!.map((coord) => {
      return {
        x: coord.x + dx,
        y: -(coord.y + dy), // TODO: I feel like there is some sort of
        // automatic transformation that should be applied here, but I
        // don't know what it is.
      };
    });

    this.dragGhostAnnotation._coordinates(newCoordinates);
    this.dragGhostAnnotation.draw();
  }

  private async handleDragEnd(evt: IGeoJSMouseState) {
    if (
      !this.isDragging ||
      !this.dragStartPosition ||
      !this.draggedAnnotation ||
      !this.dragGhostAnnotation ||
      !evt?.geo
    ) {
      return;
    }

    // Calculate final offset
    const dx = evt.geo.x - this.dragStartPosition.x;
    const dy = evt.geo.y - this.dragStartPosition.y;

    // Update the actual annotation
    await this.annotationStore.updateAnnotationsPerId({
      annotationIds: [this.draggedAnnotation.id],
      editFunction: (annotation: IAnnotation) => {
        annotation.coordinates = this.dragOriginalCoordinates!.map((coord) => ({
          x: coord.x + dx,
          y: coord.y + dy,
          z: coord.z,
        }));
      },
    });

    // Clean up
    this.interactionLayer.removeAnnotation(this.dragGhostAnnotation);
    this.isDragging = false;
    this.dragStartPosition = null;
    this.draggedAnnotation = null;
    this.dragGhostAnnotation = null;
    this.dragOriginalCoordinates = null;
  }
}
</script>

<style lang="scss" scoped></style>
