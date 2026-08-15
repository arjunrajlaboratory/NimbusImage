import { IGirderItem, IGirderFolder, IUPennCollection } from "@/girder";
import type { ITileHistogram } from "./images";
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
  | "objectSegmentation"
  | "tagging"
  | "linescan";

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
  // Reactive mirror of nodes.input.geoJSMap.output. In Vue 3, pipeline node
  // outputs are not reactive (markRaw'd ComputeNode instances write to raw
  // targets, bypassing Proxy). This property is updated by an onOutputUpdate
  // callback and can be safely read by Vue computeds.
  mapEntry: IMapEntry | null;
  mouseState: {
    path: IGeoJSPoint2D[]; // In GCS coordinates
  };
  output: IGeoJSPosition[] | null;
  livePreview: IGeoJSPosition[] | null;
}

export const ObjectSegmentationToolStateSymbol: unique symbol = Symbol(
  "ObjectSegmentationToolState",
);

export type TObjectSegmentationToolStateSymbol =
  typeof ObjectSegmentationToolStateSymbol;

// How the user picks a training/example object.
//  - "samClick": shift-click a point; SAM decodes the object under it.
//  - "samBox":   shift-drag a box; SAM decodes the object inside it.
//  - "circle":   shift-drag a freehand lasso; the polygon IS the example
//                (no decoder run).
export type TObjectSelectionMode = "samClick" | "samBox" | "circle";

// How examples are propagated to the rest of the image.
//  - "samSimilarity":     SAM-embedding similarity search over candidate prompts.
//  - "classifier":        in-browser random-forest classifier (web worker).
//  - "samThenClassifier": chained - run SAM similarity, then train the
//                         classifier on the examples + SAM proposals and show
//                         the classifier's result.
export type TObjectApplicationMethod =
  | "samSimilarity"
  | "classifier"
  | "samThenClassifier";

// Where matches are searched. "image" (whole-image) is not yet implemented;
// only "viewport" (the currently displayed view) is available for now.
export type TObjectSegmentationScope = "viewport" | "image";

export interface IObjectSegmentationExample {
  polarity: "foreground" | "background";
  // null for a circled example: its polygon (below) is authoritative and no
  // decoder prompt was ever run.
  prompt: TSamPrompt | null;
  // The resolved example outline in GCS (image) coords - the given polygon
  // for a circled example, or the SAM-decoded mask for a prompt example.
  // null until the example-resolve node has processed this example. Both
  // application methods consume this: the classifier trains on these
  // polygons, so a SAM-clicked example can feed the classifier too.
  polygon: IGeoJSPosition[] | null;
}

export interface IObjectSegmentationStatus {
  phase: "idle" | "computing" | "ready" | "error";
  error?: string;
  putativeCount: number; // proposals.length after all filtering
  // SAM candidate-decode progress ("Scanning candidates … 23/64"). null when
  // no SAM decode run is in flight (and always null for the classifier).
  progress: { done: number; total: number } | null;
  // Superset of both methods' timings: SAM (encode/decode) + classifier
  // (features/train/predict/postprocess).
  timings: {
    encodeMs?: number;
    decodeMs?: number;
    featuresMs?: number;
    trainMs?: number;
    predictMs?: number;
    postprocessMs?: number;
  };
  // Auto size range derived from foreground example areas, surfaced so the
  // panel can display the size-filter placeholders.
  autoSizeRange?: { min: number; max: number } | null;
}

export interface IObjectSegmentationToolState {
  type: TObjectSegmentationToolStateSymbol;
  nodes: TObjectSegmentationNodes; // markRaw'd pipeline nodes
  // Reactive mirror of nodes.input.geoJSMap.output, same pattern as
  // ISamAnnotationToolState.mapEntry.
  mapEntry: IMapEntry | null;
  // Reactive mirror of the examples input node, with resolved polygons filled
  // in by the example-resolve node (same array order as the input).
  examples: IObjectSegmentationExample[];
  proposals: IGeoJSPosition[][] | null; // GCS polygons, post-dedupe; null = nothing computed
  // Polarity applied to the next example; set by the panel.
  nextPolarity: "foreground" | "background";
  status: IObjectSegmentationStatus; // reactive mirror
  // Transient per-node progress labels for the in-viewer overlay (e.g. "SAM
  // encoding…", "SAM segmenting…", "Training classifier…"), same overlay as
  // ISamAnnotationToolState.loadingMessages.
  loadingMessages: string[];
  // How the next example is captured; set by the panel. Reactive so the
  // AnnotationViewer interaction/preview routing can switch live.
  selectionMode: TObjectSelectionMode;
  // How examples are propagated; set by the panel. Reactive mirror of the
  // applicationMethod input node (which gates the two pipeline branches).
  applicationMethod: TObjectApplicationMethod;
  // Search scope; set by the panel. Only "viewport" is functional for now.
  scope: TObjectSegmentationScope;
  // Reactive mirror of the hover-preview decode node's output (GCS outline of
  // the object under the cursor in a SAM selection mode); null when idle,
  // dragging, in circle mode, or between debounced decodes.
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

export const CombineToolStateSymbol: unique symbol = Symbol("CombineToolState");

export type TCombineToolStateSymbol = typeof CombineToolStateSymbol;

export interface ICombineToolState {
  type: TCombineToolStateSymbol;
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
  objectSegmentation: IObjectSegmentationToolState | IErrorToolState;
  connection: IConnectionToolState;
  // Edit tool can have CombineToolState when action is "combine_click"
  edit: ICombineToolState | IBaseToolState;
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
  ANNOTATION_RASTER = "ANNOTATION_RASTER",
  ANNOTATION_SAVE = "ANNOTATION_SAVE",
  ANNOTATION_DELETE = "ANNOTATION_DELETE",
  ANNOTATION_COMPUTE = "ANNOTATION_COMPUTE",
  BATCH_ANNOTATION_COMPUTE = "BATCH_ANNOTATION_COMPUTE",
  ANNOTATION_UNDO = "ANNOTATION_UNDO",
  ANNOTATION_REDO = "ANNOTATION_REDO",
  PROPERTY_FETCH = "PROPERTY_FETCH",
  PROPERTY_COMPUTE = "PROPERTY_COMPUTE",
  BATCH_PROPERTY_COMPUTE = "BATCH_PROPERTY_COMPUTE",
  PIPELINE_COMPUTE = "PIPELINE_COMPUTE",
  BATCH_PIPELINE_COMPUTE = "BATCH_PIPELINE_COMPUTE",
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
  ZENODO_UPLOAD = "ZENODO_UPLOAD",
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
  [ProgressType.ANNOTATION_RASTER, 1],
  [ProgressType.ANNOTATION_SAVE, 2],
  [ProgressType.ANNOTATION_DELETE, 3],
  [ProgressType.ANNOTATION_COMPUTE, 4],
  [ProgressType.BATCH_ANNOTATION_COMPUTE, 5],
  [ProgressType.PROPERTY_FETCH, 6],
  [ProgressType.PROPERTY_COMPUTE, 7],
  [ProgressType.BATCH_PROPERTY_COMPUTE, 8],
  [ProgressType.CONNECTION_FETCH, 9],
  [ProgressType.CONNECTION_SAVE, 10],
  [ProgressType.CONNECTION_DELETE, 11],
  [ProgressType.VIEW_FETCH, 12],
  [ProgressType.LAYER_CACHE, 13],
  [ProgressType.QUADTILE_CACHE, 14],
  [ProgressType.MAXMERGE_SCHEDULE, 15],
  [ProgressType.MAXMERGE_CACHE, 16],
  [ProgressType.HISTOGRAM_SCHEDULE, 17],
  [ProgressType.HISTOGRAM_CACHE, 18],
  [ProgressType.MOVIE_GENERATION, 19],
  [ProgressType.SNAPSHOT_BATCH_DOWNLOAD, 20],
  [ProgressType.ZENODO_UPLOAD, 21],
  [ProgressType.GENERIC, 22],
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

export interface IDimensionLabels {
  xy?: string[] | null;
  z?: string[] | null;
  t?: string[] | null;
}

export interface IDataset {
  readonly id: string;

  name: string;
  description: string;
  creatorId: string;
  dimensionLabels?: IDimensionLabels;

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

/**
 * How timelapse track segments are coloured. "track" gives every connected
 * component its own hue; "uniform" draws them all in `TRACK_UNIFORM_COLOR`,
 * which is easier to read when many tracks overlap.
 */
export type TTimelapseTrackColoring = "track" | "uniform";

/** Which tab the Object Browser is showing. */
export type TAnnotationBrowserTab = "objects" | "measurements" | "connections";

export type TVolumeViewMode = "2d" | "3d";

export type TVolumeBlendMode = "composite" | "mip";

export type TVolumeSegmentationColorMode = "tag" | "property";

// Which dataset axis is mapped to the 3rd (depth) dimension of the volume.
export type TVolumeAxis = "z" | "t";

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

export interface IAnnotationBrowserConfig {
  // Property columns shown in the annotation list
  displayedPropertyPaths: string[][];
  // Properties with a filter row in the annotation browser
  filterPaths: string[][];
  // Range/values and enabled state of those filter rows
  propertyFilters: IPropertyAnnotationFilter[];
  // Analysis-panel scatter plots and their gate polygons. Optional for
  // compatibility with configurations saved before analysis plots existed.
  analysisPlots?: IAnalysisPlot[];
}

export interface IDatasetConfigurationBase {
  compatibility: IDatasetConfigurationCompatibility;
  layers: IDisplayLayer[];
  tools: IToolConfiguration[];
  snapshots: ISnapshot[];
  propertyIds: string[];
  pipelines: IPipeline[];
  scales: IScales;
  // Shared annotation-rendering tuning for this configuration. Optional for
  // compatibility with configurations created before these settings were
  // persisted.
  visibilityConfig?: IVisibilityConfig;
  // Shared raster-overview settings. Optional for configurations created
  // before the overview layer was introduced.
  overviewConfig?: IAnnotationOverviewConfig;
  // Shared annotation-browser state (displayed property columns and property
  // filters). Optional for compatibility with configurations created before
  // this was persisted.
  annotationBrowserConfig?: IAnnotationBrowserConfig;
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
  readonly _accessLevel?: number;
}

// Resolved view tile shown in the Recent Datasets list.
// Built in Home.vue by joining a datasetView with the corresponding
// resolved Girder folder (dataset) and configuration documents.
export interface IRecentDatasetViewItem {
  datasetView: IDatasetView;
  datasetInfo: IGirderFolder;
  configInfo: IUPennCollection;
}

// Access control types for sharing datasets
export interface IDatasetAccessUser {
  id: string;
  login: string;
  name: string;
  email: string;
  level: 0 | 1 | 2; // READ=0, WRITE=1, ADMIN=2
}

export interface IDatasetAccessConfiguration {
  id: string;
  name: string;
  public: boolean;
}

export interface IDatasetAccessList {
  datasetId: string;
  public: boolean;
  users: IDatasetAccessUser[];
  groups: unknown[]; // Future use
  configurations: IDatasetAccessConfiguration[];
}

export interface IConfigurationAccessDataset {
  id: string;
  name: string;
  public: boolean;
}

export interface IConfigurationAccessList {
  configurationId: string;
  public: boolean;
  users: IDatasetAccessUser[];
  groups: unknown[];
  datasets: IConfigurationAccessDataset[];
}

export interface IProjectAccessList {
  projectId: string;
  public: boolean;
  users: IDatasetAccessUser[];
  groups: unknown[];
}

export interface IProjectDatasetReference {
  datasetId: string;
  addedDate: string;
}

export interface IProjectCollectionReference {
  collectionId: string;
  addedDate: string;
}

export interface IProjectMetadata {
  title: string;
  description: string;
  license: string;
  keywords: string[];
  authors?: string;
  doi?: string;
  publicationDate?: string;
  funding?: string;
}

export type TProjectStatus = "draft" | "exporting" | "exported";

/**
 * Get display color for project status
 */
export function getProjectStatusColor(
  status: TProjectStatus | undefined,
): string {
  switch (status) {
    case "exported":
      return "success";
    case "exporting":
      return "warning";
    default:
      return "grey";
  }
}

export type TZenodoStatus =
  | "none"
  | "uploading"
  | "draft"
  | "published"
  | "error";

export interface IZenodoProgress {
  current: number;
  total: number;
  message: string;
}

export interface IProjectZenodo {
  depositionId?: number;
  depositionUrl?: string;
  doi?: string;
  status: TZenodoStatus;
  sandbox: boolean;
  progress?: IZenodoProgress | null;
  error?: string | null;
  lastPublished?: string;
}

export interface IProject {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  created: string;
  updated: string;
  public?: boolean;
  _accessLevel?: number;
  meta: {
    datasets: IProjectDatasetReference[];
    collections: IProjectCollectionReference[];
    metadata: IProjectMetadata;
    status: TProjectStatus;
    zenodo?: IProjectZenodo;
  };
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
    cacheRevision: number;
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
  opacity: (value?: number) => number | IGeoJSLayer;
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
  // The annotation currently being created or edited, if any
  currentAnnotation: IGeoJSAnnotation | null;
  options: (() => IObject) &
    ((key: string) => any) &
    ((key: string, value: any) => IGeoJSAnnotationLayer) &
    ((values: IObject) => IGeoJSAnnotationLayer);
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
  // The tile factory GeoJS documents for derived classes to override. Tiles
  // have a promise-like interface; `catch` is the only failure signal the
  // library exposes (there is no tile-error event).
  _getTile?: (
    ...args: unknown[]
  ) => IGeoJSTile & { catch: (callback: (reason?: unknown) => void) => void };
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

// https://opengeoscience.github.io/geojs/apidocs/geo.gui.domWidget.html
// Created with a `position` of map coordinates ({ x, y }), the widget's element
// tracks that point as the map is panned and zoomed.
export interface IGeoJSDomWidget extends IGeoJSWidget {
  canvas: (() => HTMLElement) & ((val: HTMLElement) => IGeoJSDomWidget);
  layer: () => IGeoJSUiLayer;
}

// https://opengeoscience.github.io/geojs/apidocs/geo.gui.uiLayer.html
export interface IGeoJSUiLayer extends IGeoJSLayer {
  createWidget: <WidgetName extends string, ParentType extends IGeoJsObject>(
    widgetName: WidgetName,
    arg: { parent?: ParentType; [k: string]: any },
  ) => WidgetName extends "scale"
    ? IGeoJSScaleWidget
    : WidgetName extends "dom"
      ? IGeoJSDomWidget
      : IGeoJSWidget;
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
  Circle = "circle",
  Ellipse = "ellipse",
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
  [AnnotationShape.Circle]: "Circle",
  [AnnotationShape.Ellipse]: "Ellipse",
  [AnnotationShape.Any]: "Any", // This was added to support the "Any" shape
};

// Shapes a computed property can be attached to. Must match the backend
// annotation_property schema enum (server/models/property.py) — property
// workers only operate on these, so a property step / materialized property
// with any other shape would be rejected on compute.
export const MATERIALIZABLE_PROPERTY_SHAPES: AnnotationShape[] = [
  AnnotationShape.Point,
  AnnotationShape.Line,
  AnnotationShape.Polygon,
];

// Clamp an arbitrary annotation shape to one a property can be computed on,
// falling back to Polygon (a rectangle/circle/ellipse annotation is closest to
// a blob). Used wherever a property step derives its shape from an annotation
// source: the AI suggestion path and the builder's tag auto-wiring.
export function clampToMaterializablePropertyShape(
  shape: AnnotationShape,
): AnnotationShape {
  return MATERIALIZABLE_PROPERTY_SHAPES.includes(shape)
    ? shape
    : AnnotationShape.Polygon;
}

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

// --- Stub/Hydrated Annotation Architecture ---

export interface IAnnotationStub {
  id: string;
  centroid: IGeoJSPosition;
  location: IAnnotationLocation;
  shape: AnnotationShape;
  channel: number;
  tags: string[];
  color: string | null;
  estimatedRadius?: number;
}

export type TAnnotationOrStub = IAnnotation | IAnnotationStub;

// --- Server-side annotation list query/response ---

export interface IAnnotationListSort {
  type: "field" | "property";
  key: string | string[]; // "location.XY" | "name" | ... | ["propId","sub"]
  order: "asc" | "desc";
}

export interface IAnnotationListPropertyFilter {
  path: string[];
  mode: "range" | "values";
  min?: number;
  max?: number;
  values?: number[];
}

// One analysis gate as a query term: the DEFINITION (axes + polygon +
// pinned categories), which the server resolves per request as a pure
// predicate (SERVER_GATING.md, Phase 3). Shipping definitions instead of
// resolved id lists keeps page fetches small at any gate size.
export interface IAnalysisGateFilterTerm {
  xAxis: TAnalysisAxis;
  yAxis: TAnalysisAxis;
  gate: IAnalysisGate;
}

export interface IAnnotationListFilters {
  shape?: string;
  tags?: { values: string[]; exclusive: boolean };
  location?: IAnnotationLocation;
  idSubstring?: string;
  propertyFilters?: IAnnotationListPropertyFilter[];
  // A list of id-sets; an annotation matches iff its _id is in EVERY set
  // (AND of $in's). Used to apply the selection and annotation-id filters.
  idConstraints?: string[][];
  // Analysis gate definitions, ANDed with everything above.
  analysisGates?: IAnalysisGateFilterTerm[];
}

export interface IAnnotationListQuery {
  datasetId: string;
  filters: IAnnotationListFilters;
  sort: IAnnotationListSort | null;
  propertyPaths: string[][];
  offset: number;
  limit: number;
  // When supplied, the server ignores `offset` and returns the page containing
  // this annotation under the same filters and sort. `offset` in the response
  // is null when the annotation is not part of the filtered result.
  anchorId?: string;
}

// A server list row: stub fields + the requested property values.
export interface IAnnotationListRow extends IAnnotationStub {
  name: string | null;
  values: IAnnotationPropertyValues[string]; // {[propId]: value | nested}
}

export interface IAnnotationListPage {
  total: number;
  rows: IAnnotationListRow[];
  offset?: number | null;
}

export type THydrationMode = "shapes" | "dots";

export interface IVisibilityConfig {
  // Dataset annotation count above which stub-only (lazy) mode activates: stubs
  // are fetched and coordinates/property values load on demand. Independent of
  // the render budget (maxVisible).
  stubThreshold: number;
  // Max annotations to render (stubs or shapes) — the cap when fully zoomed in.
  // Datasets at or below this render fully at every zoom (the size gate).
  maxVisible: number;
  // Floor on the zoom-adaptive render budget: at least this many are drawn at
  // any zoom (clamped to maxVisible). So a view holding fewer than this shows
  // everything; a busier view shows at least this many (or the zoom-rule count,
  // whichever is higher). Set to 0 to defer entirely to the zoom rule.
  minimumVisible: number;
  // Max annotations to keep hydrated per visibility update — the cap when fully
  // zoomed in.
  maxHydrated: number;
  // Total cap on the hydration cache (accumulates across updates; LRU-evicts
  // beyond cap, protecting selected).
  hydrationCacheCap: number;
  // If true, threshold applies to total frame annotations across all layers.
  globalThreshold: boolean;
  // Fraction of the screen the rendered dots may cover. See revealMoreOnZoom for
  // how this interacts with zoom.
  coverageTarget: number;
  // Controls how the render budget responds to zoom:
  //   false (default): enforce coverageTarget at EVERY zoom — the budget is the
  //     number of dots that cover coverageTarget of the screen at the current
  //     zoom, so the view stays at ~that density (uncrowded) and reveals
  //     everything only when you zoom into a genuinely sparse region.
  //   true: "reveal more as you zoom in" — coverageTarget sets the zoomed-out
  //     floor and the budget doubles per zoom level up to maxVisible, so working
  //     zooms progressively reveal (and can crowd) more.
  revealMoreOnZoom: boolean;
  // Zoom hysteresis: skip the camera-driven refresh until the zoom magnification
  // changes by this fraction (e.g. 0.2 = 20%). Panning has no threshold — any
  // pan refreshes — so this governs zoom only.
  viewportRefreshFraction: number;
}

export type TAnnotationOverviewMode = "shapes" | "discs";

export interface IAnnotationOverviewConfig {
  enabled: boolean;
  mode: TAnnotationOverviewMode;
  opacity: number;
  // Raster is used above this many image pixels per screen pixel; vectors
  // take over at or below it.
  vectorSwitchThreshold: number;
}

export const DEFAULT_ANNOTATION_OVERVIEW_CONFIG: IAnnotationOverviewConfig = {
  enabled: false,
  mode: "shapes",
  opacity: 0.6,
  vectorSwitchThreshold: 1,
};

export function resolveAnnotationOverviewConfig(
  config?: Partial<IAnnotationOverviewConfig>,
): IAnnotationOverviewConfig {
  return {
    ...DEFAULT_ANNOTATION_OVERVIEW_CONFIG,
    ...config,
  };
}

// Annotation count above which the annotation browser list switches to the
// backend-paginated (server) list, independently of stub-only mode. This is a
// UI materialization limit (one v-data-table row per annotation, client-side
// sort), NOT a data-loading concern like stubThreshold — a fully-fetched
// dataset can still be too large to sort/render as a client-side table.
export const ANNOTATION_LIST_SERVER_THRESHOLD = 20000;

export const DEFAULT_VISIBILITY_CONFIG: IVisibilityConfig = {
  stubThreshold: 100000,
  maxVisible: 50000,
  minimumVisible: 5000,
  maxHydrated: 20000,
  hydrationCacheCap: 40000,
  globalThreshold: true,
  coverageTarget: 0.3,
  revealMoreOnZoom: false,
  viewportRefreshFraction: 0.2,
};

export function resolveVisibilityConfig(
  config?: Partial<IVisibilityConfig>,
): IVisibilityConfig {
  return {
    ...DEFAULT_VISIBILITY_CONFIG,
    ...config,
  };
}

export function isHydratedAnnotation(
  annotation: TAnnotationOrStub,
): annotation is IAnnotation {
  return "coordinates" in annotation;
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

// --- Analysis panel (scatter gating) ---

// Categorical axes are annotation fields available on stubs too, so the
// analysis panel works in both full and lazy (stub-only) modes.
export type TAnalysisCategoricalKey =
  | "tags"
  | "shape"
  | "channel"
  | "xy"
  | "z"
  | "time";

export type TAnalysisAxis =
  | { type: "property"; path: string[] }
  | { type: "categorical"; key: TAnalysisCategoricalKey };

// Explicitly identifies how categorical values in a gate are encoded. This
// cannot be inferred from a string prefix: legacy display labels are
// user-controlled and may themselves begin with that prefix.
export const ANALYSIS_CATEGORY_KEY_VERSION = 1 as const;

// A drawn gate, stored as the lasso polygon in PLOT COORDINATE space rather
// than as the annotation ids it happened to contain.
//
// This is what makes a gate persistable. A configuration is shared by every
// dataset using it, while annotation ids belong to one dataset — persisting ids
// would apply one dataset's objects to another. A polygon is defined in
// property-value space, so it re-resolves correctly in any dataset, which is
// also the point of a gating strategy: draw it once, apply it to each replicate.
//
// For a categorical axis a coordinate is a category index, so the ordering of
// collision-free raw category keys that was in effect when the gate was drawn
// is part of the gate's meaning and is stored with it. Human-readable labels
// are display-only and are not persisted as identities.
export interface IAnalysisGate {
  categoryKeyVersion: typeof ANALYSIS_CATEGORY_KEY_VERSION;
  vertices: IGeoJSPosition[];
  xCategories: string[] | null;
  yCategories: string[] | null;
}

// One scatter plot in the analysis panel. Plots are ordered: each plot shows
// the population passing the gates of all plots BEFORE it (plus the regular
// filters), and its own gate further narrows the population downstream —
// flow-cytometry-style sequential gating. `gate` is null until a selection is
// drawn. The annotation ids inside a gate are derived, not stored here: see
// `analysisGateIds` in the filters store.
export interface IAnalysisPlot {
  id: string;
  xAxis: TAnalysisAxis | null;
  yAxis: TAnalysisAxis | null;
  gate: IAnalysisGate | null;
  gateEnabled: boolean;
}

// One plot in a server-side gate-resolution request: a DRAWN plot's
// definition (both axes chosen, gate present). The server resolves the gate
// as a pure per-annotation predicate over the whole dataset; see
// codebaseDocumentation/SERVER_GATING.md.
export interface IAnalysisGatePlotRequest {
  id: string;
  xAxis: TAnalysisAxis;
  yAxis: TAnalysisAxis;
  gate: IAnalysisGate;
}

// Server-binned display data for one analysis plot above the cap
// (SERVER_GATING.md, Phase 2). Rows of `counts` are y bins, columns x bins.
export interface IAnalysisHistogramResponse {
  counts: number[][];
  xEdges: number[] | null;
  yEdges: number[] | null;
  xCategories: string[] | null;
  yCategories: string[] | null;
  inputCount: number;
  plottedCount: number;
  // |own gate ∩ input| — the chained badge count — when a gate was sent.
  gateCount: number | null;
}

// The histogram response plus display labels for categorical axes, resolved
// by the panel (labels need the dataset's channel names, which the server
// does not have).
export interface IAnalysisHistogramDisplay extends IAnalysisHistogramResponse {
  xCategoryLabels: string[] | null;
  yCategoryLabels: string[] | null;
}

export interface IAnalysisHistogramRequest {
  xAxis: TAnalysisAxis;
  yAxis: TAnalysisAxis;
  xCategories: string[] | null;
  yCategories: string[] | null;
  bins: { x: number; y: number };
  upstreamGates: Omit<IAnalysisGatePlotRequest, "id">[];
  filters: IAnnotationListFilters;
  gate: IAnalysisGate | null;
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

// Annotation setup shared by the annotation-producing tool UIs and by
// annotation pipeline steps. (Historically defined in AnnotationConfiguration.vue,
// which now re-exports it from here.)
export interface IAnnotationSetup {
  tags: string[];
  coordinateAssignments: {
    layer: string | null | undefined;
    Z: {
      type: string;
      value: number;
      max: number;
    };
    Time: {
      type: string;
      value: number;
      max: number;
    };
  };
  shape: AnnotationShape;
  color: string | undefined;
}

// ---------------------------------------------------------------------------
// Worker pipelines
//
// A pipeline is an ordered list of steps stored on a configuration. Each step
// is a self-contained worker invocation: either an annotation-producing worker
// (segmentation path) or a property-computing worker (property path). Steps do
// not pass data in memory — each writes annotations/property values back to the
// dataset and downstream steps read them back, joined by tags + shape.
// See codebaseDocumentation/WORKER_PIPELINES.md.
// ---------------------------------------------------------------------------

export type TPipelineStepKind = "annotation" | "property";

export interface IPipelineStepBase {
  // Stable id, unique within the pipeline.
  readonly id: string;
  kind: TPipelineStepKind;
  // Display name, defaults to the worker's interfaceName label.
  name: string;
  // Docker image tag.
  image: string;
  // The user-picked runtime parameters for this worker image.
  workerInterfaceValues: IWorkerInterfaceValues;
  // Skipped by the runner when false.
  enabled: boolean;
}

export interface IAnnotationPipelineStep extends IPipelineStepBase {
  kind: "annotation";
  // Mirrors tool.values.annotation. `annotation.tags` ARE this step's output
  // tags (applied to the annotations the worker produces).
  annotation: IAnnotationSetup;
  // Mirrors tool.values.connectTo (optional connection wiring).
  connectTo?: {
    tags: string[];
    layer: string | null;
    exclusive?: boolean;
  };
  // Mirrors tool.values.jobDateTag.
  jobDateTag?: boolean;
}

export interface IPropertyPipelineStep extends IPipelineStepBase {
  kind: "property";
  // Which annotations this property computes on.
  shape: AnnotationShape;
  // Tag filter selecting INPUT annotations. Normally set to the output tags of
  // an upstream annotation step (see tag wiring in WORKER_PIPELINES.md).
  inputTags: { tags: string[]; exclusive: boolean };
  // True when inputTags/shape were auto-wired from an upstream annotation step
  // (so the builder knows it may safely refresh them; manual edits clear it).
  autoWired?: boolean;
  // Set lazily by the runner on first successful run: the id of the persisted
  // IAnnotationProperty this step created. Reused on later runs. Cleared if the
  // referenced property no longer exists (runner re-creates).
  materializedPropertyId?: string;
}

export type TPipelineStep = IAnnotationPipelineStep | IPropertyPipelineStep;

export interface IPipeline {
  readonly id: string;
  name: string;
  description?: string;
  steps: TPipelineStep[];
  // Provenance, for UI badges.
  origin?: "user" | "preset";
}

export interface IPipelineRunResult {
  succeeded: number;
  failed: number;
  cancelled: number;
  failedStepIndex: number | null;
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

// Annotation export files are raw Mongo documents produced by
// `GET /export/json`: the identifier lives under `_id`, and `id` isn't
// present. These types describe that on-disk/import shape, as opposed to
// the normalized `IAnnotation`/`IAnnotationConnection`/`IAnnotationProperty`
// used everywhere else once the frontend has parsed a server response.
export type ISerializedAnnotation = Omit<IAnnotation, "id"> & {
  id?: string;
  _id?: string;
};

export type ISerializedConnection = Omit<IAnnotationConnection, "id"> & {
  id?: string;
  _id?: string;
};

export type ISerializedProperty = Omit<IAnnotationProperty, "id"> & {
  id?: string;
  _id?: string;
};

export interface ISerializedData {
  annotations: ISerializedAnnotation[];
  annotationConnections: ISerializedConnection[];
  annotationProperties: ISerializedProperty[];
  annotationPropertyValues: IAnnotationPropertyValues;
}

export interface IAnnotationImportPayload {
  datasetId: string;
  annotations?: ISerializedAnnotation[];
  connections?: ISerializedConnection[];
  propertyValues?: IAnnotationPropertyValues;
  propertyIdMap?: { [oldPropertyId: string]: string };
}

export interface IAnnotationImportResult {
  annotationCount: number;
  connectionCount: number;
  propertyValueCount: number;
}

// Storage usage and quota for a user, as reported by the girder-user-quota
// plugin. Sizes are in bytes; quota is null when unlimited.
export interface IUserStorageQuota {
  used: number;
  quota: number | null;
}

export interface IJobEventData {
  _id: string;
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
  args?: string[];
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
  showNextButton?: boolean;
  onTriggerEvent?: string;
}

// Internal representation the TourManager builds from an ITourStep.
// Engine-neutral: holds everything the controller needs to render and advance.
export interface ITourStepRuntime {
  id: string;
  route: string;
  element?: string;
  title: string;
  text: string;
  position: "top" | "bottom" | "left" | "right";
  waitForElement: number;
  hasModalOverlay: boolean;
  showNextButton: boolean;
  onTriggerEvent?: string;
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
  [WelcomeTourTypes.VIEWER]: "IntroViewerTour",
  [WelcomeTourTypes.ADVANCED_UPLOAD]: "AdvancedUploadTour",
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
  annotationOverviewLayer?: IGeoJSOsmLayer;
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
import type { ITileMeta } from "./GirderAPI";
import { isEqual } from "lodash";
import type { TSamNodes } from "@/pipelines/samPipeline";
import type { TObjectSegmentationNodes } from "@/pipelines/objectSegmentationPipeline";

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
    pipelines: [],
    scales: {
      pixelSize: { value: 1, unit: "m" },
      zStep: { value: 1, unit: "m" },
      tStep: { value: 1, unit: "s" },
    },
    visibilityConfig: resolveVisibilityConfig(),
    overviewConfig: resolveAnnotationOverviewConfig(),
    annotationBrowserConfig: {
      displayedPropertyPaths: [],
      filterPaths: [],
      propertyFilters: [],
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

// --- Automatic tool suggestions (see codebaseDocumentation/AUTO_TOOL_SUGGESTIONS.md) ---

// One entry in the catalog of tools the frontend knows how to set up. Sent to
// the backend so Claude can pick from tools that actually exist for this
// dataset, and reused on the way back to build the concrete IToolConfiguration.
export interface IToolSuggestionCatalogEntry {
  id: string;
  name: string;
  kind: "worker" | "manual";
  description: string;
  // Worker tools only: the docker image to instantiate.
  image?: string;
  // Default annotation shape used when building the tool configuration.
  defaultShape?: AnnotationShape;
}

// Display-layer context sent with the screenshot so Claude can map rendered
// colors in the composite image back to the dataset's channel names.
export interface IToolSuggestionLayerContext {
  id: string;
  name: string;
  channel: number;
  channelName: string;
  color: string;
  visible: boolean;
}

// A raw suggestion as returned by the backend (references a catalog entry by
// id and, optionally, a channel to run on).
export interface IToolSuggestion {
  toolId: string;
  channelName?: string;
  reason: string;
  confidence?: "low" | "medium" | "high";
}

// A suggestion after the frontend has resolved it against the catalog and
// built a ready-to-add tool configuration.
export interface IResolvedToolSuggestion {
  suggestion: IToolSuggestion;
  catalogEntry: IToolSuggestionCatalogEntry;
  tool: IToolConfiguration;
}

export type TToolSuggestionStatus = "idle" | "loading" | "done" | "error";

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

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
