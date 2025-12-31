import { IGirderItem } from "@/girder";
import { ITileHistogram } from "./images";
import Shepherd from "shepherd.js";

interface IObject<Values = any> {
  [key: string]: Values;
}

export interface IHistoryEntry {
  actionName: string;
  isUndone: boolean;
  actionDate: Date;
}

export interface IFrameInfo {
  DeltaT: number;
  PositionX: number;
  PositionY: number;
  PositionZ: number;
  IndexXY?: number;
  IndexZ?: number;
  IndexC?: number;
  IndexT?: number;
  Channel?: string;
}

export interface IImage {
  item: IGirderItem;
  levels: number;
  frameIndex: number;
  key: {
    z: number;
    xy: number;
    t: number;
    c: number;
  };
  keyOffset: number;
  frame: IFrameInfo;
  sizeX: number;
  sizeY: number;
  tileWidth: number;
  tileHeight: number;
  mm_x: number;
  mm_y: number;
  tileinfo: ITileMeta;
}

export interface IImageTile {
  x: number;
  y: number;
  width: number;
  height: number;
  frame: number;
  url: string;
  image: HTMLImageElement;
  fullImage: HTMLImageElement;
}

// see templates.json
export type TToolType =
  | "create"
  | "snap"
  | "select"
  | "connection"
  | "edit"
  | "segmentation"
  | "samAnnotation"
  | "tagging";

export interface IToolTemplateInterface {
  id: string;
  name: string;
  type: string;
  meta: any;
}

export interface IToolTemplate {
  name: string;
  type: TToolType;
  description: string;
  interface: IToolTemplateInterface[];
  shortName?: string;
}

export interface IToolConfiguration<Type extends TToolType = TToolType> {
  readonly id: string;
  name: string;
  hotkey: string | null;
  type: Type;
  values: any;
  template: IToolTemplate;
}

export const BaseToolStateSymbol: unique symbol = Symbol("BaseToolState");

export type TBaseToolStateSymbol = typeof BaseToolStateSymbol;

export interface IBaseToolState {
  type: TBaseToolStateSymbol;
}

export enum PromptType {
  backgroundPoint,
  foregroundPoint,
  box,
}

export interface ISamForegroundPointPrompt {
  type: PromptType.foregroundPoint;
  point: IGeoJSPosition;
}

export interface ISamBackgroundPointPrompt {
  type: PromptType.backgroundPoint;
  point: IGeoJSPosition;
}

export interface ISamBoxPrompt {
  type: PromptType.box;
  topLeft: IGeoJSPosition;
  bottomRight: IGeoJSPosition;
}

export type TSamPrompt =
  | ISamForegroundPointPrompt
  | ISamBackgroundPointPrompt
  | ISamBoxPrompt;

export const SamAnnotationToolStateSymbol: unique symbol = Symbol(
  "SamAnnotationToolState",
);

export type TSamAnnotationToolStateSymbol = typeof SamAnnotationToolStateSymbol;

export interface ISamAnnotationToolState {
  type: TSamAnnotationToolStateSymbol;
  nodes: TSamNodes;
  loadingMessages: string[];
  mouseState: {
    path: IGeoJSPoint2D[]; // In GCS coordinates
  };
  output: IGeoJSPosition[] | null;
  livePreview: IGeoJSPosition[] | null;
}

export const ConnectionToolStateSymbol: unique symbol = Symbol(
  "ConnectionToolState",
);

export type TConnectionToolStateSymbol = typeof ConnectionToolStateSymbol;

export interface IConnectionToolState {
  type: TConnectionToolStateSymbol;
  selectedAnnotationId: null | string;
}

export interface IMouseState {
  isMouseMovePreviewState: boolean;
  mapEntry: IMapEntry;
  target: HTMLElement;
  path: IGeoJSPosition[];
  initialMouseEvent: MouseEvent;
}

export const ErrorToolStateSymbol: unique symbol = Symbol("ErrorToolState");

export type TErrorToolStateSymbol = typeof ErrorToolStateSymbol;

export interface IErrorToolState {
  type: TErrorToolStateSymbol;
  error?: Error;
}

interface IExplicitToolStateMap {
  samAnnotation: ISamAnnotationToolState | IErrorToolState;
  connection: IConnectionToolState;
}

type TFullToolStateMap = {
  [toolType in TToolType]: toolType extends keyof IExplicitToolStateMap
    ? IExplicitToolStateMap[toolType]
    : IBaseToolState;
};

export type TToolState<T extends TToolType = TToolType> = TFullToolStateMap[T];

export interface IActiveTool<T extends TToolType = TToolType> {
  configuration: IToolConfiguration<T>;
  state: TToolState<T>;
}

export enum ProgressType {
  ANNOTATION_FETCH = "ANNOTATION_FETCH",
  ANNOTATION_SAVE = "ANNOTATION_SAVE",
  ANNOTATION_DELETE = "ANNOTATION_DELETE",
  ANNOTATION_COMPUTE = "ANNOTATION_COMPUTE",
  ANNOTATION_UNDO = "ANNOTATION_UNDO",
  ANNOTATION_REDO = "ANNOTATION_REDO",
  PROPERTY_FETCH = "PROPERTY_FETCH",
  PROPERTY_COMPUTE = "PROPERTY_COMPUTE",
  CONNECTION_FETCH = "CONNECTION_FETCH",
  CONNECTION_SAVE = "CONNECTION_SAVE",
  CONNECTION_DELETE = "CONNECTION_DELETE",
  VIEW_FETCH = "VIEW_FETCH",
  LAYER_CACHE = "LAYER_CACHE",
  QUADTILE_CACHE = "QUADTILE_CACHE",
  MAXMERGE_SCHEDULE = "MAXMERGE_SCHEDULE",
  MAXMERGE_CACHE = "MAXMERGE_CACHE",
  HISTOGRAM_SCHEDULE = "HISTOGRAM_SCHEDULE",
  HISTOGRAM_CACHE = "HISTOGRAM_CACHE",
  MOVIE_GENERATION = "MOVIE_GENERATION",
  SNAPSHOT_BATCH_DOWNLOAD = "SNAPSHOT_BATCH_DOWNLOAD",
  GENERIC = "GENERIC",
}

export enum NotificationType {
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
}

export interface INotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  info?: string;
  timeout: number; // Time in seconds before auto-dismiss (0 means no auto-dismiss)
  timestamp: number; // Creation timestamp
}

export const PROGRESS_TYPE_ORDER = new Map<ProgressType, number>([
  [ProgressType.ANNOTATION_FETCH, 0],
  [ProgressType.ANNOTATION_SAVE, 1],
  [ProgressType.ANNOTATION_DELETE, 2],
  [ProgressType.ANNOTATION_COMPUTE, 3],
  [ProgressType.PROPERTY_FETCH, 4],
  [ProgressType.PROPERTY_COMPUTE, 5],
  [ProgressType.CONNECTION_FETCH, 6],
  [ProgressType.CONNECTION_SAVE, 7],
  [ProgressType.CONNECTION_DELETE, 8],
  [ProgressType.VIEW_FETCH, 9],
  [ProgressType.LAYER_CACHE, 10],
  [ProgressType.QUADTILE_CACHE, 11],
  [ProgressType.MAXMERGE_SCHEDULE, 12],
  [ProgressType.MAXMERGE_CACHE, 13],
  [ProgressType.HISTOGRAM_SCHEDULE, 14],
  [ProgressType.HISTOGRAM_CACHE, 15],
  [ProgressType.MOVIE_GENERATION, 16],
  [ProgressType.SNAPSHOT_BATCH_DOWNLOAD, 17],
  [ProgressType.GENERIC, 18],
]);

export interface IProgress {
  id: string;
  type: ProgressType;
  progress: number;
  total: number;
  title: string;
  metadata: Record<string, any>;
  isReactive?: boolean;
}

export interface IProgressGroup {
  type: ProgressType;
  display: "single" | "stacked";
  title: string;
  progress?: number;
  total?: number;
  value?: number;
  indeterminate: boolean;
  count: number;
  items: IProgress[];
}

export interface IRestrictTagsAndLayer {
  tags: string[];
  tagsInclusive: boolean;
  layerId: string | null;
}

export interface IDataset {
  readonly id: string;

  name: string;
  description: string;
  creatorId: string;

  xy: number[];
  z: number[];
  time: number[];
  channels: number[];
  channelNames: Map<number, string>;
  width: number;
  height: number;
  images(z: number, zTime: number, xy: number, channel: number): IImage[];
  anyImage(): IImage | null;
  allImages: IImage[];
}

export interface IViewConfiguration {
  layers: IDisplayLayer[];
}

export type TLayerMode = "single" | "multiple" | "unroll";

export interface IDownloadParameters {
  encoding: string;
  contentDisposition: string;
  contentDispositionFilename?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  width?: number;
  height?: number;
  magnification?: number;
  jpeqQuality?: number;
  style?: string;
  tiffCompression?: string;
}

export interface ISnapshot {
  name: string;
  description: string;
  tags: string[];
  created: any;
  modified: number;
  datasetViewId: string;
  viewport: {
    tl: any;
    tr: any;
    bl: any;
    br: any;
  };
  rotation: any;
  unrollXY: boolean;
  unrollZ: boolean;
  unrollT: boolean;
  xy: number;
  z: number;
  time: number;
  layerMode: TLayerMode;
  layers: IDisplayLayer[];
  screenshot: {
    bbox: IGeoJSBounds;
  };
}

export type IDimensionCompatibility = "one" | "multiple";

export type TUnitLength = "nm" | "µm" | "mm" | "m";
export const unitLengthOptions: TUnitLength[] = ["nm", "µm", "mm", "m"];
export type TUnitTime = "ms" | "s" | "m" | "h" | "d";
export const unitTimeOptions: TUnitTime[] = ["ms", "s", "m", "h", "d"];

export interface IScaleInformation<TUnit> {
  value: number;
  unit: TUnit;
}

export interface IScales {
  pixelSize: IScaleInformation<TUnitLength>;
  zStep: IScaleInformation<TUnitLength>;
  tStep: IScaleInformation<TUnitTime>;
}

export interface IDatasetConfigurationCompatibility {
  xyDimensions: IDimensionCompatibility;
  zDimensions: IDimensionCompatibility;
  tDimensions: IDimensionCompatibility;
  channels: { [key: number]: string };
}

export interface IDatasetConfigurationBase {
  compatibility: IDatasetConfigurationCompatibility;
  layers: IDisplayLayer[];
  tools: IToolConfiguration[];
  snapshots: ISnapshot[];
  propertyIds: string[];
  scales: IScales;
}

export interface IDatasetConfiguration extends IDatasetConfigurationBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface IDatasetViewBase {
  datasetId: string;
  configurationId: string;
  layerContrasts: {
    [layerId: string]: IContrast;
  };
  scales: Partial<IScales>;
  lastViewed: number;
  lastLocation: {
    xy: number;
    z: number;
    time: number;
  };
}

export interface IDatasetView extends IDatasetViewBase {
  readonly id: string;
}

export type TDisplaySliceType = "current" | "max-merge" | "constant" | "offset";

export interface IDisplaySlice {
  type: TDisplaySliceType;
  value: number | null;
}

export interface IDisplayLayer {
  readonly id: string; // to have better keys for UI
  name: string;
  color: string;

  channel: number;

  xy: IDisplaySlice;
  z: IDisplaySlice;
  time: IDisplaySlice;

  visible: boolean;

  contrast: IContrast;

  layerGroup: string | null;

  _histogram?: {
    promise: Promise<null | ITileHistogram>;
    lastHistogram: null | ITileHistogram;
    lastImages: IImage[] | null;
    nextImages: IImage[] | null;
    lock: boolean;
  };
}

export interface ICombinedLayer {
  layer: IDisplayLayer; // configurationLayer + contrast override from datasetView
  configurationLayer: IDisplayLayer; // layer as saved in configuration item
}

export interface IPixel {
  l?: number;
  value?: number[];
}

export interface IPixelMultiLayer {
  frame: number;
  l?: number;
  value?: number[];
}

// https://opengeoscience.github.io/geojs/apidocs/geo.object.html
export interface IGeoJsObject {
  modified: () => IGeoJsObject;
  geoOn: (event: string, handler: (event: any) => any) => IGeoJsObject;
  geoOff: (event: string, handler: (event: any) => any) => IGeoJsObject;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.sceneObject.html
export interface IGeoJsSceneObject extends IGeoJsObject {}

// https://opengeoscience.github.io/geojs/apidocs/geo.transform.html
export interface IGeoJSTransform {}

// https://opengeoscience.github.io/geojs/apidocs/geo.camera.html
export interface IGeoJSCamera {}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.actionRecord
export interface IGeoJSActionRecord {
  action: string;
  owner?: string;
  name?: string;
  input: string | IObject;
  modifiers?: string | IObject;
  selectionRectangle?: string | IObject;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.map.html#.spec
export interface IGeoJSMapSpec {
  node: string;
  gcs?: string | IGeoJSTransform;
  ingcs?: string | IGeoJSTransform;
  unitsPerPixel?: number;
  maxBounds?: {
    left?: number;
    right?: number;
    bottom?: number;
    top?: number;
    gcs?: string | IGeoJSTransform;
  };
  zoom?: number;
  center?: {
    x: number;
    y: number;
  };
  rotation?: number;
  width?: number;
  height?: number;
  min?: number;
  max?: number;
  discreteZoom?: boolean;
  allowRotation?: boolean | (() => boolean);
  camera?: IGeoJSCamera;
  interactor?: IGeoJSMapInteractor;
  animationQueue?: any[];
  clampBoundsX?: boolean;
  clampBoundsY?: boolean;
  clampZoom?: boolean;
  autoshareRenderer?: boolean | string;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.mapInteractor.html#.spec
export interface IGeoJSMapInteractorSpec {
  throttle?: number;
  discreteZoom?: boolean | number;
  actions?: IGeoJSActionRecord[];
  click?: {
    enabled?: boolean;
    buttons?: IObject;
    duration?: number;
    cancelOnMove?: boolean | number;
  };
  keyboard?: {
    actions?: { [actionKey: string]: string[] };
    meta?: IObject;
    metakeyMouseEvents?: string[];
    focusHighlight?: boolean;
  };
  alwaysTouch?: boolean;
  wheelScaleX?: number;
  wheelScaleY?: number;
  zoomScale?: number;
  rotateWheelScale?: number;
  zoomrotateMinimumRotation?: number;
  zoomrotateReverseRotation?: number;
  zoomrotateMinimumZoom?: number;
  zoomrotateMinimumPan?: number;
  touchPanDelay?: number;
  momentum?: {
    enabled?: boolean;
    maxSpeed?: number;
    minSpeed?: number;
    stopTime?: number;
    drag?: number;
    actions?: string[];
  };
  spring?: {
    enabled?: boolean;
    springConstant?: number;
  };
  zoomAnimation?: {
    enabled?: boolean;
    duration?: number;
    ease?: (t: number) => number;
  };
}

// https://opengeoscience.github.io/geojs/apidocs/geo.mapInteractor.html
export interface IGeoJSMapInteractor extends IGeoJsObject {
  options: ((opt: IGeoJSMapInteractorSpec) => IGeoJSMapInteractor) &
    (() => IGeoJSMapInteractorSpec);
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.geoBounds
export interface IGeoJSBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type TGeoJSScreenShotTypes = "image/png" | "canvas";

// https://opengeoscience.github.io/geojs/apidocs/geo.map.html
export interface IGeoJSMap extends IGeoJsSceneObject {
  interactor: ((arg: IGeoJSMapInteractor) => IGeoJSMap) &
    (() => IGeoJSMapInteractor);
  bounds: (bds?: IGeoJSBounds, gcs?: string | null) => IGeoJSBounds;
  center: ((
    coordinates: IGeoJSPosition,
    gcs?: string | null,
    ignoreDiscreteZoom?: boolean,
    ignoreClampBounds?: boolean | "limited",
  ) => IGeoJSMap) &
    (() => IGeoJSPosition);
  createLayer: <T extends string>(
    layerName: T,
    arg?: IObject,
  ) => T extends "osm"
    ? IGeoJSOsmLayer
    : T extends "annotation"
      ? IGeoJSAnnotationLayer
      : T extends "feature"
        ? IGeoJSFeatureLayer
        : T extends "ui"
          ? IGeoJSUiLayer
          : IGeoJSLayer;
  deleteLayer: (layer: IGeoJSLayer | null) => IGeoJSLayer;
  displayToGcs: ((c: IGeoJSPosition, gcs?: string | null) => IGeoJSPosition) &
    ((c: IGeoJSPosition[], gcs?: string | null) => IGeoJSPosition[]);
  draw: () => IGeoJSMap;
  exit: () => void;
  gcs: ((arg: string) => IGeoJSMap) & (() => string);
  gcsToDisplay: ((c: IGeoJSPosition, gcs?: string | null) => IGeoJSPosition) &
    ((c: IGeoJSPosition[], gcs?: string | null) => IGeoJSPosition[]);
  geoOn: (event: string, handler: Function) => IGeoJSMap;
  geoOff: (
    event?: string | string[],
    arg?: Function | Function[] | null,
  ) => IGeoJSMap;
  ingcs: ((arg: string) => IGeoJSMap) & (() => string);
  layers: () => IGeoJSLayer[];
  maxBounds: ((bounds: IGeoJSBounds, gcs?: string | null) => IGeoJSMap) &
    ((bounds: undefined, gcs?: string | null) => IGeoJSBounds);
  node: () => JQuery;
  rotation: ((
    rotation: number,
    origin?: IObject,
    ignoreRotationFunc?: boolean,
  ) => IGeoJSMap) &
    (() => number);
  screenshot: <Type extends TGeoJSScreenShotTypes = "image/png">(
    layers: IGeoJSLayer | IGeoJSLayer[] | false | IObject | undefined,
    type?: Type,
    encoderOptions?: number,
    opts?: IObject,
  ) => Promise<Type extends "canvas" ? HTMLCanvasElement : string>;
  size: ((arg: IGeoScreenSize) => IGeoJSMap) & (() => IGeoScreenSize);
  unitsPerPixel: ((zoom: number, unit: number) => IGeoJSMap) &
    ((zoom?: number, unit?: null) => number);
  zoom: ((
    val: number,
    origin?: IObject,
    ingoreDiscreteZoom?: boolean,
    ignoreClampBounds?: boolean,
  ) => IGeoJSMap) &
    (() => number);
  zoomRange: ((
    arg: { min?: number; max?: number },
    noRefresh?: boolean,
  ) => IGeoJSMap) &
    (() => { min: number; max: number });
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.screenSize
export interface IGeoScreenSize {
  width: number;
  height: number;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.layer.html#.spec
export interface IGeoJSLayerSpec {
  id?: number;
  map?: IGeoJSMap | null;
  renderer?: string | IGeoJSRenderer;
  crossDomain?: "anonymous" | "use-credentials";
  autoshareRenderer?: boolean | string;
  canvas?: HTMLCanvasElement;
  annotations?: string[] | IObject;
  features?: string[];
  active?: boolean;
  attribution?: string;
  opacity?: number;
  name?: string;
  selectionAPI?: boolean;
  sticky?: boolean;
  visible?: boolean;
  zIndex?: number;

  // For OSM layers (should move to a different interface):
  minLevel?: number;
  maxLevel?: number;
  nearestPixel?: boolean | number;
  queue?: IGeoJSFetchQueue;
  tileHeight: number;
  tileOffset: () => IGeoJSPoint2D;
  tileRounding: (x: number) => number;
  tilesAtZoom: (zoom: number) => IGeoJSPoint2D | undefined;
  tilesMaxBounds?: ((zoom: number) => IGeoJSPoint2D) | null;
  tileWidth: number;
  url?: string | (() => string);
  useCredentials?: boolean;
  wrapX: boolean;
  wrapY: boolean;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.layer.html
export interface IGeoJSLayer extends IGeoJsObject {
  visible: (value?: boolean) => boolean | IGeoJSLayer;
  draw: () => IGeoJSLayer;
  map: () => IGeoJSMap;
  modes: {
    edit: "edit";
    cursor: "cursor";
  };
  node: () => JQuery<HTMLDivElement>;
  moveToTop: () => void;
  zIndex: (index?: number, allowDuplicate?: boolean) => number | IGeoJSLayer;
  currentAnnotation: null | IGeoJSAnnotation;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.annotationLayer.html
export interface IGeoJSAnnotationLayer extends IGeoJSLayer {
  addAnnotation: (
    annotation: IGeoJSAnnotation,
    gcs?: string | null,
    update?: boolean,
    trigger?: boolean,
  ) => IGeoJSAnnotationLayer;
  addMultipleAnnotations: (
    annotations: IGeoJSAnnotation[],
    gcs?: string | null,
    update?: boolean,
  ) => IGeoJSAnnotationLayer;
  removeAnnotation: (annotation: IGeoJSAnnotation, update?: boolean) => boolean;
  removeAllAnnotations: (
    skipCreating?: boolean,
    update?: boolean,
    trigger?: boolean,
  ) => number;
  annotations: () => IGeoJSAnnotation[];
  mode: (
    arg?: string | null,
    editAnnotation?: IGeoJSAnnotation,
  ) => string | null | IGeoJSAnnotationLayer;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.point2D
export interface IGeoJSPoint2D {
  x: number;
  y: number;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.worldPosition
// https://opengeoscience.github.io/geojs/apidocs/geo.html#.geoPosition
export interface IGeoJSPosition extends IGeoJSPoint2D {
  z?: number; // Optional z coordinate
}

// Includes the transform matrix for processing multi-source data
export interface IGeoJSPositionWithTransform extends IGeoJSPosition {
  s11?: number;
  s12?: number;
  s21?: number;
  s22?: number;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.fetchQueue.html
export interface IGeoJSFetchQueue {}

// https://opengeoscience.github.io/geojs/apidocs/geo.tile.html
export interface IGeoJSTile {
  index: {
    x: number;
    y: number;
    level?: number;
    reference?: number;
  };
  size: IGeoJSPoint2D;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.quadFeature.html#.position
export interface IGeoJSQuad {
  crop: IGeoJSPosition & IGeoJSBounds;
  lr: IGeoJSPosition;
  ul: IGeoJSPosition;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.renderer.html
export interface IGeoJSRenderer extends IGeoJsObject {
  _maxTextureSize: number;
  constructor: Function & { _maxTextureSize: number };
}

// https://opengeoscience.github.io/geojs/apidocs/geo.osmLayer.html
export interface IGeoJSOsmLayer extends IGeoJSLayer {
  readonly idle: boolean;
  queue: IGeoJSFetchQueue;
  displayToLevel: (pt?: IGeoJSPoint2D, zoom?: number) => IGeoJSPoint2D;
  renderer: () => IGeoJSRenderer | null;
  reset: () => IGeoJSOsmLayer;
  tileAtPoint: (point: IGeoJSPoint2D, level: number) => IGeoJSPoint2D;
  url: (url?: string | ((...args: any[]) => string)) => string;

  onIdle: (handler: () => void) => IGeoJSOsmLayer;

  _imageUrls?: (string | undefined)[];
  _tileBounds: (tile: IGeoJSTile) => IGeoJSBounds;
  _options?: {
    minLevel?: number;
    maxLevel?: number;
  };

  baseQuad?: null | IGeoJSQuad;
  setFrameQuad?: ((frame: number) => void) & { status?: ISetQuadStatus };
}

// https://opengeoscience.github.io/geojs/apidocs/geo.feature.html
export interface IGeoJSFeature extends IGeoJSFeatureBase<IGeoJSFeature> {}
export interface IGeoJSFeatureBase<ThisType> extends IGeoJsSceneObject {
  data: ((arg: any[]) => ThisType) & (() => any[]);
  draw: (arg?: IObject) => ThisType;
  style: (() => IObject) &
    ((arg1: string) => IObject) &
    ((arg1: string, arg2: IObject) => ThisType) &
    ((arg1: IObject) => ThisType);
}

// https://opengeoscience.github.io/geojs/apidocs/geo.textFeature.html
export interface IGeoJSTextFeature
  extends IGeoJSFeatureBase<IGeoJSTextFeature> {
  position: ((
    val: IGeoJSPosition[] | ((dataPoint: any) => IGeoJSPosition),
  ) => IGeoJSTextFeature) &
    (() => IGeoJSPosition[] | ((dataPoint: any) => IGeoJSPosition));
}

// https://opengeoscience.github.io/geojs/apidocs/geo.featureLayer.html
export interface IGeoJSFeatureLayer extends IGeoJSLayer {
  readonly idle: boolean;
  createFeature: <T extends string>(
    featureName: T,
    arg?: IObject,
  ) => T extends "text" ? IGeoJSTextFeature : IGeoJSFeature;
  deleteFeature: (feature: IGeoJSFeature) => IGeoJSFeatureLayer;
  clear: () => IGeoJSFeatureLayer;
  geoOn: (event: string, handler: Function) => IGeoJSFeatureLayer;
  geoOff: (
    event?: string | string[],
    arg?: Function | Function[] | null,
  ) => IGeoJSFeatureLayer;
  renderer: () => IGeoJSRenderer | null;
  features: (() => IGeoJSFeature[]) &
    ((val: IGeoJSFeature[]) => IGeoJSFeatureLayer);

  onIdle: (handler: () => void) => IGeoJSFeatureLayer;

  baseQuad?: null | IGeoJSQuad;
  setFrameQuad?: ((frame: number) => void) & { status?: ISetQuadStatus };
}

// https://opengeoscience.github.io/geojs/apidocs/geo.gui.widget.html
export interface IGeoJSWidget {}

// https://opengeoscience.github.io/geojs/apidocs/geo.gui.scaleWidget.html
export interface IGeoJSScaleWidget {
  options: (() => IObject) &
    (<Key extends IGeoJSScaleWidgetOptions>(
      arg1: Key,
    ) => IGeoJSScaleWidgetSpec[Key]) &
    (<Key extends IGeoJSScaleWidgetOptions>(
      arg1: Key,
      arg2: IGeoJSScaleWidgetSpec[Key],
    ) => IGeoJSScaleWidget);
  parent: (() => IGeoJsSceneObject) &
    ((arg: IGeoJsSceneObject) => IGeoJSScaleWidget);
  parentCanvas: () => HTMLElement;
  canvas: (() => HTMLElement) & ((val: HTMLElement) => IGeoJSScaleWidget);
  layer: () => IGeoJSUiLayer;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.gui.scaleWidget.html#.spec
interface IGeoJSScaleWidgetSpec {
  scale: number;
}

type IGeoJSScaleWidgetOptions = keyof IGeoJSScaleWidgetSpec;

// https://opengeoscience.github.io/geojs/apidocs/geo.gui.uiLayer.html
export interface IGeoJSUiLayer extends IGeoJSLayer {
  createWidget: <WidgetName extends string, ParentType extends IGeoJsObject>(
    widgetName: WidgetName,
    arg: { parent?: ParentType; [k: string]: any },
  ) => WidgetName extends "scale" ? IGeoJSScaleWidget : IGeoJSWidget;
  deleteWidget: (widget: IGeoJSWidget) => IGeoJSUiLayer;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.annotation.html
export interface IGeoJSAnnotation {
  draw: () => IGeoJSAnnotation;
  options: (() => IObject) &
    ((key: string) => any) &
    ((key: string, value: any) => IGeoJSAnnotation) &
    ((values: IObject) => IGeoJSAnnotation);
  style: (value?: IObject) => any;
  coordinates: () => IGeoJSPosition[];
  _coordinates: (coordinates?: IGeoJSPosition[]) => IGeoJSPosition[];
  geojson: () => any;
  mouseClick: ((handler: (evt: IGeoJSMouseState) => void) => IGeoJSAnnotation) &
    ((handler: (evt: IGeoJSMouseState) => void) => void);
  type: () => AnnotationShape;
  layer: ((arg: IGeoJSLayer) => IGeoJSAnnotation) & (() => IGeoJSLayer);
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.mouseState
export interface IGeoJSMouseState {
  page: IGeoJSPoint2D;
  map: IGeoJSPosition;
  geo: IGeoJSPosition;
  mapgcs: IGeoJSPosition;
  buttons: {
    left: boolean;
    right: boolean;
    middle: boolean;
  };
  buttonsDown: {
    left: boolean;
    right: boolean;
    middle: boolean;
  };
  evt: {
    clientX: number;
    clientY: number;
  };
  modifiers: {
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
  };
  time: number;
  deltaTime: number;
  velocity: IGeoJSPoint2D;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.polygonFeature.html#.styleSpec
export interface IGeoJSPolygonFeatureStyle {
  fill?: boolean | (() => boolean);
  fillColor?: TGeoJSColor | (() => TGeoJSColor);
  fillOpacity?: number | (() => number);
  stroke?: boolean | (() => boolean);
  uniformPolygon?: boolean | (() => boolean);
  closed?: boolean | (() => boolean);
  origin?: Array<number> | (() => Array<number>);
  strokeColor?: TGeoJSColor | (() => TGeoJSColor);
  strokeOpacity?: number | (() => number);
  strokeWidth?: number | (() => number);
  strokeOffset?: number | (() => number);
  lineCap?: string | (() => string);
  lineJoin?: string | (() => string);
  miterLimit?: number | (() => number);
  uniformLine?: boolean | string | (() => boolean | string);
  antialiasing?: number | (() => number);
  debug?: string | (() => string);
}

// https://opengeoscience.github.io/geojs/apidocs/geo.pointFeature.html#.styleSpec
export interface IGeoJSPointFeatureStyle {
  radius?: number | (() => number);
  stroke?: boolean | (() => boolean);
  strokeColor?: TGeoJSColor | (() => TGeoJSColor);
  strokeOpacity?: number | (() => number);
  strokeWidth?: number | (() => number);
  fill?: boolean | (() => boolean);
  fillColor?: TGeoJSColor | (() => TGeoJSColor);
  fillOpacity?: number | (() => number);
  origin?: Array<number> | (() => Array<number>);
  scaled?: boolean | number | (() => boolean | number); // missing from the documentation
}

// https://opengeoscience.github.io/geojs/apidocs/geo.lineFeature.html#.styleSpec
export interface IGeoJSLineFeatureStyle {
  strokeColor?: TGeoJSColor | (() => TGeoJSColor);
  strokeOpacity?: number | (() => number);
  strokeWidth?: number | (() => number);
  strokeOffset?: number | (() => number);
  lineCap?: string | (() => string);
  lineJoin?: string | (() => string);
  closed?: boolean | (() => boolean);
  miterLimit?: number | (() => number);
  uniformLine?: boolean | string | (() => boolean | string);
  antialiasing?: number | (() => number);
  debug?: string | (() => string);
  origin?: Array<number> | (() => Array<number>);
}

// https://opengeoscience.github.io/geojs/apidocs/geo.pointAnnotation.html#.spec
export interface IGeoJSPointAnnotationSpec {
  position?: IGeoJSPosition;
  coordinates?: IGeoJSPosition[];
  style?: IGeoJSPointFeatureStyle;
  editStyle?: IGeoJSPointFeatureStyle;
  name?: string;
  layer?: IGeoJSAnnotationLayer;
  state?: string;
  showLabel?: boolean | string[];
  allowBooleanOperations?: boolean;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.lineAnnotation.html#.spec
export interface IGeoJSLineAnnotationSpec {
  vertices?: IGeoJSPosition[];
  coordinates?: IGeoJSPosition[];
  style?: IGeoJSLineFeatureStyle;
  editStyle?: IGeoJSLineFeatureStyle;
  name?: string;
  layer?: IGeoJSAnnotationLayer;
  state?: string;
  showLabel?: boolean | string[];
  allowBooleanOperations?: boolean;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.rectangleAnnotation.html#.spec
export interface IGeoJSRectangleAnnotationSpec {
  corners?: IGeoJSPosition[];
  coordinates?: IGeoJSPosition[];
  style?: IGeoJSPolygonFeatureStyle;
  editStyle?: IGeoJSPolygonFeatureStyle;
  constraint?: number | number[] | (() => number);
  name?: string;
  layer?: IGeoJSAnnotationLayer;
  state?: string;
  showLabel?: boolean | string[];
  allowBooleanOperations?: boolean;

  editHandleStyle?: {
    strokeColor?: TGeoJSColor;
    handles?: {
      rotate?: boolean;
    };
  };
}

// https://opengeoscience.github.io/geojs/apidocs/geo.polygonAnnotation.html#.spec
export interface IGeoJSPolygonAnnotationSpec {
  vertices?: IGeoJSPosition[];
  coordinates?: IGeoJSPosition[];
  style?: IGeoJSPolygonFeatureStyle;
  editStyle?: IGeoJSPolygonFeatureStyle;
  constraint?: number | number[] | (() => number);
  name?: string;
  layer?: IGeoJSAnnotationLayer;
  state?: string;
  showLabel?: boolean | string[];
  allowBooleanOperations?: boolean;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.polygonObject
export interface IGeoJSPolygonObject {
  outer: IGeoJSPosition[];
  inner?: IGeoJSPosition[][];
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.geoColorObject
export interface IGeoJSColorObject {
  r: number;
  g: number;
  b: number;
  a?: number;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.html#.geoColor
export type TGeoJSColor = string | number | IGeoJSColorObject;

export interface ITimelapseAnnotationOptions {
  time: number;
  girderId?: string;
  isTimelapseAnnotation: true;
}

export interface ICommonWorkerInterfaceElement {
  displayOrder?: number;
  noCache?: boolean;
  tooltip?: string;
  vueAttrs?: { [vueAttr: string]: any };
}

export interface INumberWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  default?: number;
}

export interface INotesWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "notes";
  value?: string;
  default?: string;
}

export interface ITextWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "text";
  default?: string;
}

export interface ITagsWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "tags";
  default?: string[];
}

export interface ILayerWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "layer";
  default?: string | null;
  required?: boolean;
}

export interface ISelectWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "select";
  items: string[];
  default?: string;
  required?: boolean;
}

export interface IChannelWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "channel";
  default?: number;
  required?: boolean;
}

export interface IChannelCheckboxesWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "channelCheckboxes";
  default?: { [channel: number]: boolean };
  required?: boolean;
}

export interface ICheckboxWorkerInterfaceElement
  extends ICommonWorkerInterfaceElement {
  type: "checkbox";
  default?: boolean;
}

export type TWorkerInterfaceElement =
  | INumberWorkerInterfaceElement
  | INotesWorkerInterfaceElement
  | ITextWorkerInterfaceElement
  | ITagsWorkerInterfaceElement
  | ILayerWorkerInterfaceElement
  | ISelectWorkerInterfaceElement
  | IChannelWorkerInterfaceElement
  | IChannelCheckboxesWorkerInterfaceElement
  | ICheckboxWorkerInterfaceElement;

export type TWorkerInterfaceType = TWorkerInterfaceElement["type"];

// TWorkerInterfaceElement["default"] can be undefined because it is optional
// A value can't be undefined
// but it can be null when "required" field is false
export type TWorkerInterfaceValue = Exclude<
  TWorkerInterfaceElement["default"],
  undefined
> | null;

export interface IWorkerInterface {
  [id: string]: TWorkerInterfaceElement;
}

export interface IWorkerInterfaceValues {
  [id: string]: TWorkerInterfaceValue;
}

export interface IWorkerLabels {
  isUPennContrastWorker: string;
  isAnnotationWorker?: string;
  isPropertyWorker?: string;
  interfaceName?: string;
  interfaceCategory?: string;
  annotationShape?: AnnotationShape;
  description?: string;
  advancedOptionsPanel?: string;
  annotationConfigurationPanel?: string;
  defaultToolName?: string;
  hasPreview?: string;
}

export interface IWorkerImageList {
  [image: string]: IWorkerLabels;
}

export enum AnnotationShape {
  Point = "point",
  Line = "line",
  Polygon = "polygon",
  Rectangle = "rectangle",
  Any = "any",
}

export enum FeatureShape {
  Point = "point",
  Line = "line",
  Polygon = "polygon",
  Rectangle = "rectangle",
}

export const AnnotationNames = {
  [AnnotationShape.Point]: "Point",
  [AnnotationShape.Line]: "Line",
  [AnnotationShape.Polygon]: "Blob",
  [AnnotationShape.Rectangle]: "Rectangle",
  [AnnotationShape.Any]: "Any", // This was added to support the "Any" shape
};

export interface IAnnotationLocation {
  XY: number;
  Z: number;
  Time: number;
}

export interface IAnnotationBase {
  tags: string[];
  shape: AnnotationShape;
  channel: number;
  location: IAnnotationLocation;
  coordinates: IGeoJSPosition[];
  datasetId: string;
  color: string | null;
}

export interface IAnnotation extends IAnnotationBase {
  id: string;
  name: string | null;
}

export enum TrackPositionType {
  INTERIOR = "interior",
  START = "start",
  END = "end",
  ORPHAN = "orphan",
  CURRENT = "current",
}

export interface ITimelapseAnnotation extends IAnnotation {
  trackPositionType: TrackPositionType;
}

export interface IAnnotationConnectionBase {
  label: string;
  tags: string[];
  parentId: string;
  childId: string;
  datasetId: string;
}

export interface IAnnotationConnection extends IAnnotationConnectionBase {
  id: string;
}

export interface IAnnotationFilter {
  id: string;
  exclusive: boolean;
  enabled: boolean;
}

export interface ITagAnnotationFilter extends IAnnotationFilter {
  tags: string[];
}

export enum PropertyFilterMode {
  Values = "values",
  Range = "range",
}

export interface IPropertyAnnotationFilter extends IAnnotationFilter {
  propertyPath: string[];
  range: {
    min: number;
    max: number;
  };
  valuesOrRange: PropertyFilterMode;
  values?: number[];
  // Whether to exclude or include annotations that don't have the property
}

export interface IIdAnnotationFilter extends IAnnotationFilter {
  annotationIds: string[];
}

export interface IROIAnnotationFilter extends IAnnotationFilter {
  roi: IGeoJSPosition[];
}

export interface IAnnotationPropertyConfiguration {
  name: string;
  image: string;

  tags: {
    tags: string[];
    exclusive: boolean;
  };
  shape: AnnotationShape;
  workerInterface: IWorkerInterfaceValues;
}

export interface IAnnotationProperty extends IAnnotationPropertyConfiguration {
  id: string;
}

export type TNestedValues<T> = T | { [pathName: string]: TNestedValues<T> };

// Can't be an object
export type TPropertyValue = TNestedValues<number | null | string>;

export interface IAnnotationPropertyValues {
  [annotationId: string]: {
    [propertyId: string]: TPropertyValue;
  };
}

export type TPropertyHistogram = {
  count: number;
  min: number;
  max: number;
}[];

export interface ISerializedData {
  annotations: IAnnotation[];
  annotationConnections: IAnnotationConnection[];
  annotationProperties: IAnnotationProperty[];
  annotationPropertyValues: IAnnotationPropertyValues;
}

export interface IJobEventData {
  title?: string;
  text?: string;
  status?: number;
}

export interface IProgressInfo {
  title?: string;
  info?: string;
  progress?: number;
}

export enum MessageType {
  ERROR = "error",
  WARNING = "warning",
}

export interface IErrorInfo {
  title?: string;
  error?: string;
  warning?: string;
  info?: string;
  type?: MessageType;
}

export interface IErrorInfoList {
  errors: IErrorInfo[];
}

export interface ICameraInfo {
  center: IGeoJSPosition;
  zoom: number;
  rotate: number;
  gcsBounds: IGeoJSPosition[];
}

export type TJobType =
  | "large_image_cache_histograms"
  | "large_image_cache_tile_frames"
  | "large_image_tiff";

export interface IComputeJobBase {
  jobId: string;
  datasetId: string | null;
  eventCallback?: (data: IJobEventData) => void;
  errorCallback?: (data: IJobEventData) => void;
}
export interface IAnnotationComputeJob extends IComputeJobBase {
  toolId: string;
}
export interface IPropertyComputeJob extends IComputeJobBase {
  propertyId: string;
}

export type IComputeJob =
  | IAnnotationComputeJob
  | IPropertyComputeJob
  | IComputeJobBase;

export interface IJobTimestamp {
  status: number;
  time: string;
}

export interface IJob {
  _id: string;
  _modelType: string;
  args: string[];
  created: string;
  status: number;
  timestamps: IJobTimestamp[];
  title: string;
  type: string;
  updated: string;
  meta?: Record<string, any>;
  progress?: any;
  handler?: string;
  kwargs?: Record<string, any>;
  log?: string;
  endTime?: string;
}

export interface IContrast {
  mode: "percentile" | "absolute";
  blackPoint: number;
  whitePoint: number;
}

export interface IUISetting {
  dataset: Readonly<IDataset>;
  configuration: IDatasetConfiguration;
  z: number;
  time: number;
  activeLayer: IDisplayLayer;
}

export interface IDatasetLocation {
  xy: number;
  z: number;
  time: number;
}

// Tour System Types
export interface ITourStep {
  id: string;
  route: string;
  element?: string;
  title: string;
  text: string;
  position?: "top" | "bottom" | "left" | "right";
  waitForElement?: number;
  modalOverlay?: boolean;
  beforeShow?: string;
  onNext?: string;
  showNextButton?: boolean;
  onTriggerEvent?: string;
}

export interface IExtendedShepherdStep extends Shepherd.Step {
  options: Shepherd.Step.StepOptions & {
    route?: string;
    beforeShow?: () => void;
    onNext?: () => void;
    hasModalOverlay?: boolean;
    waitForElement?: number;
    onTriggerEvent?: string;
  };
}

export interface ITourMetadata {
  name: string;
  entryPoint: string;
  popular?: boolean;
  category?: string;
}

export interface ITourConfig extends ITourMetadata {
  steps: ITourStep[];
  options?: {
    modalOverlay?: boolean;
  };
}

declare module "vue/types/vue" {
  interface Vue {
    $startTour: (tourName: string) => Promise<void>;
    $nextStep: (targetElementId?: string) => Promise<void>;
    $loadAllTours: () => Promise<Record<string, ITourMetadata>>;
  }
}

export enum WelcomeTourTypes {
  HOME = "WelcomeTourType.home",
  VIEWER = "WelcomeTourType.viewer",
  ADVANCED_UPLOAD = "WelcomeTourType.advancedUpload",
  WORKING_WITH_TAGS = "WelcomeTourType.workingWithTags",
}

export enum WelcomeTourStatus {
  NOT_YET_RUN = "notYetRun", // This value is not strictly required because we can just check whether the key exists.
  // But if we want to capture more states at some point in the future, it is helpful to keep the option, I suppose.
  ALREADY_RUN = "alreadyRun",
}

export const WelcomeTourNames = {
  [WelcomeTourTypes.HOME]: "WelcomeTourHome",
  [WelcomeTourTypes.VIEWER]: "WelcomeTourViewer",
  [WelcomeTourTypes.ADVANCED_UPLOAD]: "WelcomeTourAdvancedUpload",
  [WelcomeTourTypes.WORKING_WITH_TAGS]: "WorkingWithTags",
};

// https://opengeoscience.github.io/geojs/apidocs/geo.util.html#.pixelCoordinateParams
export interface IGeoJSPixelCoordinateParams {
  map: IGeoJSMapSpec;
  layer: IGeoJSLayerSpec;
}

export interface IMapEntry {
  map: IGeoJSMap;
  imageLayers: IGeoJSOsmLayer[];
  params: IGeoJSPixelCoordinateParams;
  baseLayerIndex: number | undefined;
  annotationLayer: IGeoJSAnnotationLayer;
  workerPreviewLayer: IGeoJSFeatureLayer;
  workerPreviewFeature: IGeoJSFeature;
  textLayer: IGeoJSFeatureLayer;
  timelapseLayer: IGeoJSAnnotationLayer;
  timelapseTextLayer: IGeoJSFeatureLayer;
  interactionLayer: IGeoJSAnnotationLayer;
  uiLayer?: IGeoJSUiLayer;
  lowestLayer?: number;
}

export interface IQuadQuery {
  alignment?: number;
  format?: string;
  frameBase?: number;
  frameGroup?: number;
  frameGroupFactor?: number;
  frameGroupStride?: number;
  frameStride?: number;
  maxFrameSize?: number;
  maxTextures?: number;
  maxTextureSize?: number;
  maxTotalTexturePixels?: number;
  query?: string;
}

export interface IQuadInformation {
  baseUrl: string;
  restRequest: (params: any) => Promise<any>;
  restUrl: string;
  queryParameters: IQuadQuery;
}

export interface ILayerStackImage {
  layer: IDisplayLayer;
  images: IImage[];
  urls: (string | undefined)[];
  fullUrls: (string | undefined)[];
  hist: ITileHistogram | null;
  singleFrame: number | null;
  baseQuadOptions?: IQuadInformation;
}

// Fallback colors for channels with unknown names or with duplicate colors.
// Keep the same uppercase/lowercase as the `channelColors` color values.
const colors = [
  "#FF0000",
  "#00FF00",
  "#0000FF",
  "#FFFF00",
  "#FF00FF",
  "#00FFFF",
  "#FF8000",
  "#FF0080",
  "#00FF80",
  "#80FF00",
  "#8000FF",
  "#0080FF",
  "#FF8080",
  "#80FF80",
  "#8080FF",
  "#FFFF80",
  "#80FFFF",
  "#FF80FF",
  "#FF4000",
  "#FF0040",
  "#00FF40",
  "#40FF00",
  "#4000FF",
  "#0040FF",
  "#FF4040",
  "#40FF40",
  "#4040FF",
  "#FFFF40",
  "#40FFFF",
  "#FF40FF",
  "#FFC000",
  "#FF00C0",
  "#00FFC0",
  "#C0FF00",
  "#C000FF",
  "#00C0FF",
  "#FFC0C0",
  "#C0FFC0",
  "#C0C0FF",
  "#FFFFC0",
  "#C0FFFF",
  "#FFC0FF",
  "#FF8040",
  "#FF4080",
  "#40FF80",
  "#80FF40",
  "#8040FF",
  "#4080FF",
  "#FF80C0",
  "#FFC080",
  "#C0FF80",
  "#80FFC0",
  "#80C0FF",
  "#C080FF",
  "#FFC040",
  "#FF40C0",
  "#40FFC0",
  "#C0FF40",
  "#C040FF",
  "#40C0FF",
];

// Commonly reused colors (enum-like)
export const COLOR = {
  RED: "#FF0000",
  GREEN: "#00FF00",
  BLUE: "#0000FF",
  WHITE: "#FFFFFF",
  YELLOW: "#FFFF00",
  MAGENTA: "#FF00FF",
  CYAN: "#00FFFF",
  VIOLET: "#FF33CC",
  ORANGE: "#FF9933",
} as const;

// Keys should be all uppercase.  Values should have the same case as the
// `colors` list.
const channelColors: { [key: string]: string } = {
  BRIGHTFIELD: COLOR.WHITE,
  DIC: COLOR.WHITE,
  PHASE: COLOR.WHITE,
  TRANSMISSION: COLOR.WHITE,
  TRANS: COLOR.WHITE,
  DAPI: "#007FFF",
  CY3: "#FFEE00", // Pure wavelength here would be yellow, but that's a little loud, so I made it a bit more orange
  TMR: "#FFEE00",
  TAMRA: "#FFEE00",
  A594: COLOR.ORANGE, // I slightly redshifted this from the actual value for discrimination from Cy3
  ALEXA594: COLOR.ORANGE, // I slightly redshifted this from the actual value for discrimination from Cy3
  CY5: COLOR.RED,
  ATTO647: COLOR.RED,
  ATTO647N: COLOR.RED,
  CY7: COLOR.VIOLET, // I made this more purple to allow discrimination from ALEXA594
  ATTO700: "#FF33CC",
  A700: "#FF33CC",
  YFP: "#52FF00",
  GFP: "#00FF28",
  DEFAULT: COLOR.WHITE,
  MCHERRY: "#FFAD00",
  CHERRY: "#FFAD00",
  A488: "#4AFF00",
  ATTO488: "#4AFF00",
  ALEXA488: "#4AFF00",
  FITC: "#4AFF00",
  TRITC: COLOR.YELLOW,
  BFP: COLOR.BLUE,
  MORANGE: "#C9FF00",
  MKATE: "#FF3900",
  CFP: "#00C0FF",
  RED: COLOR.RED,
  GREEN: COLOR.GREEN,
  BLUE: COLOR.BLUE,
};

/**
 * Get channel colors with user overrides applied
 * @param userColors Optional user-specific color overrides
 * @returns Merged color mapping with user colors taking precedence
 */
export function getChannelColors(userColors?: { [key: string]: string }): {
  [key: string]: string;
} {
  return {
    ...channelColors, // Default colors
    ...userColors, // User overrides (if any)
  };
}

import { v4 as uuidv4 } from "uuid";
import { ISetQuadStatus } from "@/utils/setFrameQuad";
import { ITileMeta } from "./GirderAPI";
import { isEqual } from "lodash";
import { TSamNodes } from "@/pipelines/samPipeline";

// TODO: It's kind of weird to have this function here.
export function newLayer(
  dataset: IDataset,
  layers: IDisplayLayer[],
  userColors?: { [key: string]: string },
): IDisplayLayer {
  const usedColors = new Set(layers.map((l) => l.color));
  const nextColor = colors.filter((c) => !usedColors.has(c));
  const usedChannels = new Set(layers.map((l) => l.channel));
  const nextChannel = dataset.channels
    .map((_, i) => i)
    .filter((c) => !usedChannels.has(c));

  const channelName =
    dataset.channelNames.get(nextChannel[0] || 0) ||
    `Channel ${nextChannel[0] || 0}`;
  const resolvedChannelColors = getChannelColors(userColors);
  let channelColor = resolvedChannelColors[channelName.toUpperCase()];

  if (!channelColor || usedColors.has(channelColor)) {
    channelColor = nextColor[0] || colors[layers.length % colors.length];
  }
  let layerName = channelName;
  if (layerName === "" || layers.some((l) => l.name === layerName)) {
    layerName = `Layer ${layers.length + 1}`;
  }

  // guess a good new layer
  return {
    id: uuidv4(),
    name: layerName,
    visible: true,
    channel: nextChannel[0] || 0,
    time: {
      type: "current",
      value: null,
    },
    xy: {
      type: "current",
      value: null,
    },
    z: {
      type: "current",
      value: null,
    },
    color: channelColor,
    contrast: {
      mode: "percentile",
      blackPoint: 0,
      whitePoint: 100,
    },
    layerGroup: null,
  };
}

export function copyLayerWithoutPrivateAttributes(
  layer: IDisplayLayer,
): IDisplayLayer {
  const newLayer: IDisplayLayer = { ...layer };
  for (const key of Object.keys(newLayer)) {
    if (key.startsWith("_")) {
      delete newLayer[key as keyof IDisplayLayer];
    }
  }
  return newLayer;
}

// To get all the keys of IDatasetConfigurationBase without missing one
export function exampleConfigurationBase(): IDatasetConfigurationBase {
  return {
    compatibility: {
      xyDimensions: "multiple",
      zDimensions: "multiple",
      tDimensions: "multiple",
      channels: {},
    },
    layers: [],
    tools: [],
    snapshots: [],
    propertyIds: [],
    scales: {
      pixelSize: { value: 1, unit: "m" },
      zStep: { value: 1, unit: "m" },
      tStep: { value: 1, unit: "s" },
    },
  };
}

export function areCompatibles(
  a: IDatasetConfigurationCompatibility,
  b: IDatasetConfigurationCompatibility,
) {
  return (
    a.tDimensions === b.tDimensions &&
    a.xyDimensions === b.xyDimensions &&
    a.zDimensions === b.zDimensions &&
    isEqual(a.channels, b.channels)
  );
}

export const configurationBaseKeys = new Set(
  Object.keys(exampleConfigurationBase()),
) as Set<keyof IDatasetConfigurationBase>;

export enum AnnotationSelectionTypes {
  ADD = "ADD",
  TOGGLE = "TOGGLE",
  REMOVE = "REMOVE",
}

export const AnnotationSelectionTypesNames = {
  [AnnotationSelectionTypes.ADD]: "Add",
  [AnnotationSelectionTypes.TOGGLE]: "Toggle",
  [AnnotationSelectionTypes.REMOVE]: "Remove",
};

export const AnnotationSelectionTypesTooltips = {
  [AnnotationSelectionTypes.ADD]: "Add annotations to selection",
  [AnnotationSelectionTypes.TOGGLE]: "Toggle annotations selection",
  [AnnotationSelectionTypes.REMOVE]: "Remove annotation from selection",
};

export interface IChatImage {
  data: string;
  type: string;
  visible?: boolean;
}

export interface IChatMessage {
  type: "user" | "assistant" | "system" | "error";
  content: string;
  images?: IChatImage[];
  visible?: boolean;
}

export const TaggingToolStateSymbol: unique symbol = Symbol("TaggingToolState");

export type TTaggingToolStateSymbol = typeof TaggingToolStateSymbol;

export interface ITaggingToolState {
  type: TTaggingToolStateSymbol;
}

// Strategy for how dimensions were assigned during first dataset configuration
export interface IDimensionStrategy {
  XY: { source: "file" | "filename" | "images"; guess: string } | null;
  Z: { source: "file" | "filename" | "images"; guess: string } | null;
  T: { source: "file" | "filename" | "images"; guess: string } | null;
  C: { source: "file" | "filename" | "images"; guess: string } | null;
  transcode: boolean;
}
