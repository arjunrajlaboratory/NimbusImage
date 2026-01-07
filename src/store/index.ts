import {
  RestClient,
  RestClientInstance,
  IGirderItem,
  IGirderLocation,
  IGirderAssetstore,
  IGirderSelectAble,
  IGirderUser,
  IGirderLargeImage,
  DEFAULT_LARGE_IMAGE_SOURCE,
} from "@/girder";
import type { AxiosError } from "axios";
import pLimit from "p-limit";
import pRetry from "p-retry";
import {
  Action,
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";

import AnnotationsAPI from "./AnnotationsAPI";
import PropertiesAPI from "./PropertiesAPI";
import ChatAPI from "./ChatAPI";
import GirderAPI from "./GirderAPI";
import ExportAPI from "./ExportAPI";
import girderResources from "./girderResources";

import { getLayerImages, getLayerSliceIndexes } from "./images";
import jobs from "./jobs";
import progress from "./progress";

import {
  IDataset,
  IDatasetConfiguration,
  IDisplayLayer,
  IImage,
  newLayer,
  AnnotationSelectionTypes,
  ILayerStackImage,
  IDisplaySlice,
  TLayerMode,
  ISnapshot,
  IDatasetConfigurationBase,
  IToolConfiguration,
  AnnotationNames,
  AnnotationShape,
  IDatasetView,
  IContrast,
  IMapEntry,
  IHistoryEntry,
  IJobEventData,
  IScales,
  TUnitLength,
  TUnitTime,
  IScaleInformation,
  exampleConfigurationBase,
  IActiveTool,
  TToolType,
  BaseToolStateSymbol,
  TToolState,
  ICameraInfo,
  IDatasetLocation,
  ConnectionToolStateSymbol,
  NotificationType,
} from "./model";

import persister from "./Persister";
import store from "./root";
import sync from "./sync";
import { MAX_NUMBER_OF_RECENT_DATASET_VIEWS } from "./constants";
import Vue from "vue";
export { default as store } from "./root";
import { app } from "@/main";

import { Debounce } from "@/utils/debounce";
import { TCompositionMode } from "@/utils/compositionModes";
import { createSamToolStateFromToolConfiguration } from "@/pipelines/samPipeline";
import { isEqual } from "lodash";
import { logError } from "@/utils/log";

const apiRootSuffix = "/api/v1";
const defaultGirderUrl =
  import.meta.env.VITE_GIRDER_URL || "http://localhost:8080";

export function girderUrlFromApiRoot(apiRoot: string): string {
  if (apiRoot.endsWith(apiRootSuffix)) {
    return apiRoot.slice(0, apiRoot.length - apiRootSuffix.length);
  }
  return apiRoot;
}

function apiRootFromGirderUrl(girderUrl: string) {
  return girderUrl + apiRootSuffix;
}

@Module({ dynamic: true, store, name: "main" })
export class Main extends VuexModule {
  girderRest = new RestClient({
    apiRoot: apiRootFromGirderUrl(persister.get("girderUrl", defaultGirderUrl)),
  });

  // Use a proxy to dynamically resolve to the right girderRest client
  girderRestProxy = new Proxy(this, {
    get(obj: Main, prop: keyof RestClientInstance) {
      return obj.girderRest[prop];
    },
    set(target: Main, p: keyof RestClientInstance, newValue: any) {
      if (p != "token") {
        throw "Can only set token to RestClient";
      }
      target.girderRest[p] = newValue;
      return true;
    },
  }) as unknown as RestClientInstance;

  api = new GirderAPI(this.girderRestProxy);
  annotationsAPI = new AnnotationsAPI(this.girderRestProxy);
  propertiesAPI = new PropertiesAPI(this.girderRestProxy);
  chatAPI = new ChatAPI(this.girderRestProxy);
  exportAPI = new ExportAPI(this.girderRestProxy);

  readonly girderResources = girderResources;

  girderUser: IGirderUser | null = this.girderRest.user as IGirderUser | null;
  folderLocation: IGirderLocation = this.girderUser || { type: "users" };
  assetstores: IGirderAssetstore[] = [];

  history: IHistoryEntry[] = [];

  selectedDatasetId: string | null = null;
  dataset: IDataset | null = null;

  selectedConfigurationId: string | null = null;
  configuration: IDatasetConfiguration | null = null;
  recentDatasetViews: IDatasetView[] = [];

  currentLargeImage: IGirderLargeImage | null = null;
  allLargeImages: IGirderLargeImage[] = [];

  datasetView: IDatasetView | null = null;

  xy: number = 0;
  z: number = 0;
  time: number = 0;
  layerMode: TLayerMode = "multiple";

  previousMultipleLayerVisibility: string[] = []; // Store IDs of visible layers from multiple/unroll mode
  previousSingleLayerVisibility: string | null = null; // Store ID of the visible layer from single mode

  cameraInfo: ICameraInfo = {
    center: { x: 0, y: 0 },
    zoom: 1,
    rotate: 0,
    gcsBounds: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  };

  drawAnnotations: boolean = true;
  filteredDraw: boolean = true;
  annotationSelectionType: AnnotationSelectionTypes =
    AnnotationSelectionTypes.TOGGLE;

  showAnnotationsFromHiddenLayers: boolean = true;

  showTooltips: boolean = false;
  filteredAnnotationTooltips: boolean = false;

  valueOnHover: boolean = true;
  overview: boolean = true;
  hoverValue: { [layerId: string]: number[] } | null = null;

  showXYLabels: boolean = true;
  showZLabels: boolean = true;
  showTimeLabels: boolean = true;

  showScalebar: boolean = true;
  showPixelScalebar: boolean = true;
  scalebarColor: string = "#ffffff";

  scaleAnnotationsWithZoom: boolean = true;
  annotationsRadius: number = 10;
  annotationOpacity: number = 0.5;

  compositionMode: TCompositionMode = "lighten";
  backgroundColor: string = "black";

  restrictAnnotationsToFilters: boolean = true;
  restrictAnnotationsToActive: boolean = true;
  drawAnnotationConnections: boolean = true;

  unrollXY: boolean = false;
  unrollZ: boolean = false;
  unrollT: boolean = false;

  showTimelapseMode: boolean = false;
  timelapseModeWindow: number = 10;
  timelapseTags: string[] = [];
  showTimelapseLabels: boolean = true;

  maps: IMapEntry[] = [];

  isAnnotationPanelOpen: boolean = false;
  annotationPanelBadge: boolean = false;
  isHelpPanelOpen: boolean = false;

  toolTemplateList: any[] = [];
  selectedTool: IActiveTool | null = null;
  readonly availableToolShapes: { value: string; text: string }[] = [
    {
      text: AnnotationNames[AnnotationShape.Point],
      value: AnnotationShape.Point,
    },
    {
      text: AnnotationNames[AnnotationShape.Polygon],
      value: AnnotationShape.Polygon,
    },
    {
      text: AnnotationNames[AnnotationShape.Line],
      value: AnnotationShape.Line,
    },
    {
      text: AnnotationNames[AnnotationShape.Rectangle],
      value: AnnotationShape.Rectangle,
    },
  ];

  get tools() {
    return this.configuration?.tools || [];
  }

  get toolTags() {
    const tagSet: Set<string> = new Set();
    for (const tool of this.tools) {
      if (tool.values?.annotation?.tags) {
        const tags = tool.values.annotation.tags;
        for (const tag of tags) {
          tagSet.add(tag);
        }
      }
    }
    return tagSet;
  }

  get layers(): IDisplayLayer[] {
    const configurationLayers = this.configuration?.layers || [];
    // Use contrast from dataset view
    return configurationLayers.map((layer) => {
      const contrast = this.datasetView?.layerContrasts[layer.id];
      return contrast ? { ...layer, contrast } : { ...layer };
    });
  }

  get unroll() {
    return this.unrollXY || this.unrollZ || this.unrollT;
  }

  get userName() {
    return this.girderUser ? this.girderUser.login : "anonymous";
  }

  get isLoggedIn() {
    return this.girderUser != null;
  }

  get userChannelColors() {
    return this.girderUser?.meta?.channelColors || {};
  }

  get configurationScales() {
    return this.configuration?.scales || exampleConfigurationBase().scales;
  }

  get viewScales() {
    return this.datasetView?.scales || {};
  }

  get scales() {
    return { ...this.configurationScales, ...this.viewScales };
  }

  get currentLocation(): IDatasetLocation {
    return {
      xy: this.xy,
      z: this.z,
      time: this.time,
    };
  }

  get layerSliceIndexes() {
    return (layer: IDisplayLayer) => {
      if (!this.dataset) {
        return null;
      }
      return getLayerSliceIndexes(
        layer,
        this.dataset,
        this.time,
        this.xy,
        this.z,
      );
    };
  }

  @Mutation
  setAssetstores(assetstores: IGirderAssetstore[]) {
    this.assetstores = assetstores;
  }

  @Mutation
  setFolderLocation(location: IGirderLocation) {
    this.folderLocation = location;
  }

  @Mutation
  public setMaps(maps: IMapEntry[]) {
    this.maps = maps;
  }

  @Mutation
  public setDrawAnnotations(value: boolean) {
    this.drawAnnotations = value;
  }

  @Mutation
  public setShowTooltips(value: boolean) {
    this.showTooltips = value;
  }

  @Mutation
  public setShowTimelapseMode(value: boolean) {
    this.showTimelapseMode = value;
  }

  @Mutation
  public setTimelapseModeWindow(value: number) {
    this.timelapseModeWindow = value;
  }

  @Mutation
  public setTimelapseTags(value: string[]) {
    this.timelapseTags = value;
  }

  @Mutation
  public setShowTimelapseLabels(value: boolean) {
    this.showTimelapseLabels = value;
  }

  @Mutation
  public setFilteredAnnotationTooltips(value: boolean) {
    this.filteredAnnotationTooltips = value;
  }

  @Mutation
  public setShowAnnotationsFromHiddenLayers(value: boolean) {
    this.showAnnotationsFromHiddenLayers = value;
  }

  get shouldShowAnnotationsFromHiddenLayers() {
    return this.showAnnotationsFromHiddenLayers;
  }

  @Mutation
  public setValueOnHover(value: boolean) {
    this.valueOnHover = value;
  }

  @Mutation
  public setShowScalebar(value: boolean) {
    this.showScalebar = value;
  }

  @Mutation
  public setShowPixelScalebar(value: boolean) {
    this.showPixelScalebar = value;
  }

  // This variable is watched in ImageViewer.vue to update the scale bar color
  // directly in the CSS variable.
  @Mutation
  public setScalebarColor(color: string) {
    this.scalebarColor = color;
  }

  @Mutation
  public setCompositionMode(value: TCompositionMode) {
    this.compositionMode = value;
  }

  @Mutation
  public setBackgroundColor(value: string) {
    this.backgroundColor = value;
  }

  @Mutation
  public setScaleAnnotationsWithZoom(value: boolean) {
    this.scaleAnnotationsWithZoom = value;
  }

  @Mutation
  public setAnnotationsRadius(value: number) {
    this.annotationsRadius = value;
  }

  @Mutation
  public setAnnotationOpacity(value: number) {
    this.annotationOpacity = value;
  }

  @Mutation
  public setOverview(value: boolean) {
    this.overview = value;
  }

  @Mutation
  public setShowXYLabels(value: boolean) {
    this.showXYLabels = value;
  }

  @Mutation
  public setShowZLabels(value: boolean) {
    this.showZLabels = value;
  }

  @Mutation
  public setShowTimeLabels(value: boolean) {
    this.showTimeLabels = value;
  }

  @Mutation
  public setHoverValue(value: { [layerId: string]: number[] } | null) {
    this.hoverValue = value;
  }

  @Mutation
  public setAnnotationSelectionType(value: AnnotationSelectionTypes) {
    this.annotationSelectionType = value;
  }

  @Mutation
  public setFilteredDraw(value: boolean) {
    this.filteredDraw = value;
  }

  @Mutation
  public setDrawAnnotationConnections(value: boolean) {
    this.drawAnnotationConnections = value;
  }

  @Mutation
  setToolTemplateList(value: any[]) {
    this.toolTemplateList = value;
  }

  @Mutation
  private setSelectedToolImpl<T extends TToolType>(
    configuration: IToolConfiguration<T> | null,
  ) {
    if (configuration === null) {
      this.selectedTool = null;
    } else if (this.selectedTool?.configuration.id === configuration.id) {
      // Update the configuration but not the state
      Vue.set(this.selectedTool, "configuration", configuration);
    } else {
      let state: TToolState;
      switch (configuration.type) {
        case "samAnnotation":
          state = createSamToolStateFromToolConfiguration(
            configuration as IToolConfiguration<"samAnnotation">,
          );
          break;
        case "connection":
          state = {
            type: ConnectionToolStateSymbol,
            selectedAnnotationId: null,
          };
          break;
        default:
          state = { type: BaseToolStateSymbol };
          break;
      }
      this.selectedTool = { configuration, state };
    }
  }

  @Action
  setSelectedToolId(id: string | null) {
    let tool: IToolConfiguration | null = null;
    if (id) {
      tool = this.tools.find((t) => t.id === id) || null;
    }
    this.setSelectedToolImpl(tool);
  }

  @Mutation
  private setConfigurationTools(tools: IToolConfiguration[]) {
    if (this.configuration) {
      this.configuration.tools = tools;
    }
  }

  @Action
  addToolToConfiguration(tool: IToolConfiguration) {
    if (this.configuration) {
      this.setConfigurationTools([...this.configuration.tools, tool]);
      // Fetch the worker interface for this new tool if there is one
      const image = tool.values?.image?.image;
      if (image) {
        this.context.dispatch("requestWorkerInterface", image);
      }
      this.syncConfiguration("tools");
    }
  }

  /**
   * Helper function to create a notification when user is not logged in
   */
  private createNotLoggedInNotification() {
    progress.createNotification({
      type: NotificationType.WARNING,
      title: "Authentication Required",
      message: "You must be logged in to perform this action.",
      timeout: 5,
    });
  }

  @Action
  removeToolFromConfiguration(toolId: string) {
    if (this.selectedTool?.configuration.id === toolId) {
      this.setSelectedToolId(null);
    }
    if (this.configuration) {
      this.configuration.tools = this.tools.filter((t) => t.id !== toolId);
      this.syncConfiguration("tools");
    }
  }

  @Action
  editToolInConfiguration(tool: IToolConfiguration) {
    const configurationTools = this.configuration?.tools;
    if (!configurationTools) {
      return;
    }
    const toolIdx = configurationTools.findIndex(({ id }) => id === tool.id);
    if (toolIdx < 0) {
      return;
    }
    Vue.set(configurationTools, toolIdx, tool);
    if (this.selectedTool?.configuration.id === tool.id) {
      this.setSelectedToolImpl(tool);
    }
    this.syncConfiguration("tools");
  }

  @Action
  protected async loggedIn(girderRest: RestClientInstance) {
    this.setGirderRest(girderRest);
    const user = this.girderUser;
    const promises = [];
    if (user) {
      promises.push(
        this.api.getUserPrivateFolder(user._id).then((privateFolder) => {
          if (privateFolder) {
            this.setFolderLocation(privateFolder);
          } else {
            this.setFolderLocation(user);
          }
        }),
        this.api
          .getAssetstores()
          .then((assetstores) => this.setAssetstores(assetstores))
          .catch(() => {
            this.setAssetstores([]);
          }),
        this.loadUserColors().catch((error) => {
          logError("Failed to load user colors during login:", error);
        }),
      );
    } else {
      this.setAssetstores([]);
    }
    promises.push(
      this.setSelectedConfiguration(this.selectedConfigurationId),
      this.setSelectedDataset(this.selectedDatasetId),
      this.fetchRecentDatasetViews(),
    );
    await Promise.allSettled(promises);
  }

  @Mutation
  protected setGirderRest(girderRest: RestClientInstance) {
    this.girderRest = girderRest;
    this.girderUser = girderRest.user as IGirderUser | null;
    const girderUrl = girderUrlFromApiRoot(girderRest.apiRoot);
    persister.set("girderUrl", girderUrl);
  }

  @Mutation
  protected loggedOut() {
    this.girderUser = null;
    this.selectedDatasetId = null;
    this.dataset = null;
    this.selectedConfigurationId = null;
    this.configuration = null;
  }

  @Mutation
  private updateUserChannelColors(channelColors: { [key: string]: string }) {
    if (this.girderUser) {
      const meta = this.girderUser.meta || {};
      Vue.set(meta, "channelColors", channelColors);
      Vue.set(this.girderUser, "meta", meta);
    }
  }

  @Mutation
  protected setDataset({
    id,
    data,
  }: {
    id: string | null;
    data: IDataset | null;
  }) {
    this.selectedDatasetId = id;
    this.dataset = data;
  }

  @Mutation
  setCurrentLargeImage(image: IGirderLargeImage | null) {
    this.currentLargeImage = image;
  }

  @Action
  async updateCurrentLargeImage(image: IGirderLargeImage) {
    if (!this.dataset?.id) return;

    // Update backend
    await this.girderResources.setCurrentLargeImage({
      datasetId: this.dataset.id,
      largeImage: image,
    });

    // Forces an updated fetch of the dataset, clearing caches
    await this.girderResources.forceFetchResource({
      id: this.dataset.id,
      type: "folder",
    });

    // TODO: Perhaps we need to flush caches here? Otherwise, we might not update the histograms and so on appropriately.
    // It doesn't seem to be a problem, but probably requires more testing.
    // this.store.api.flushCaches();

    // Update local state
    this.setCurrentLargeImage(image);

    // Refresh related data
    await this.refreshDataset();
  }

  @Action
  async deleteLargeImage(largeImage: IGirderLargeImage) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    if (!this.dataset?.id || !largeImage._id) {
      return;
    }

    // Do not delete the default large image (original data)
    if (largeImage.name === DEFAULT_LARGE_IMAGE_SOURCE) {
      return;
    }

    if (largeImage._id === this.currentLargeImage?._id) {
      const originalLargeImage = this.allLargeImages.find(
        (img) => img.name === DEFAULT_LARGE_IMAGE_SOURCE,
      );
      if (originalLargeImage) {
        this.updateCurrentLargeImage(originalLargeImage);
      }
    }

    await this.api.deleteLargeImage(largeImage);
    await this.loadLargeImages();
  }

  @Mutation
  setAllLargeImages(images: IGirderLargeImage[]) {
    this.allLargeImages = images;
  }

  @Action
  async loadLargeImages(
    switchToNewLargeImage: boolean = false,
  ): Promise<IGirderLargeImage | null> {
    if (!this.dataset?.id) return null;

    const oldAllLargeImages = this.allLargeImages;

    const newAllLargeImages = await this.girderResources.getAllLargeImages(
      this.dataset.id,
    );

    if (newAllLargeImages) {
      // Find all large_image items that are in newAllLargeImages but not in oldAllLargeImages
      // and take the first one
      const newLargeImage = newAllLargeImages.find(
        (img) => !oldAllLargeImages.some((oldImg) => oldImg._id === img._id),
      );
      this.setAllLargeImages(newAllLargeImages);
      if (newAllLargeImages.length > 0 && switchToNewLargeImage) {
        // If we are switching to a new large image, we need to update the current large image
        if (newLargeImage) {
          this.updateCurrentLargeImage(newLargeImage);
          return newLargeImage;
        } else {
          return null;
        }
      } else {
        if (newAllLargeImages.length > 0 && !this.currentLargeImage) {
          const currentLargeImage =
            await this.girderResources.getCurrentLargeImage(this.dataset.id);
          if (currentLargeImage) {
            this.setCurrentLargeImage(currentLargeImage);
            return currentLargeImage;
          }
        }
      }
    }

    logError("Store", "No large images found");
    return null;
  }

  @Action
  protected setConfiguration({
    id,
    data,
  }: {
    id: string | null;
    data: IDatasetConfiguration | null;
  }) {
    this.setConfigurationImpl({ id, data });
    this.context.dispatch("fetchProperties");
  }

  @Mutation
  protected setConfigurationImpl({
    id,
    data,
  }: {
    id: string | null;
    data: IDatasetConfiguration | null;
  }) {
    this.selectedConfigurationId = id;
    this.configuration = data;
    if (!data) {
      return;
    }
  }

  @Mutation
  protected setHistory(history: IHistoryEntry[]) {
    this.history = history;
  }

  @Mutation
  private setXYImpl(value: number) {
    this.xy = value;
  }

  @Mutation
  private setZImpl(value: number) {
    this.z = value;
  }

  @Mutation
  private setTimeImpl(value: number) {
    this.time = value;
  }

  @Mutation
  private setCameraInfoImpl(value: ICameraInfo) {
    this.cameraInfo = value;
  }

  @Mutation
  public setUnrollXYImpl(value: boolean) {
    this.unrollXY = value;
  }

  @Mutation
  public setUnrollZImpl(value: boolean) {
    this.unrollZ = value;
  }

  @Mutation
  public setUnrollTImpl(value: boolean) {
    this.unrollT = value;
  }

  @Mutation
  public setAnnotationPanelBadge(value: boolean) {
    this.annotationPanelBadge = value;
  }

  @Mutation
  public setIsAnnotationPanelOpen(value: boolean) {
    this.isAnnotationPanelOpen = value;
  }

  @Mutation
  public setIsHelpPanelOpen(value: boolean) {
    this.isHelpPanelOpen = value;
  }

  @Action
  async logout() {
    sync.setSaving(true);
    try {
      await this.girderRest.logout();
      sync.setSaving(false);
    } catch (error) {
      sync.setSaving(error as Error);
    }
    this.loggedOut();
  }

  @Mutation
  private setRecentDatasetViewsImpl(recentDatasetViews: IDatasetView[]) {
    this.recentDatasetViews = recentDatasetViews;
  }

  @Action
  createDatasetView({
    datasetId,
    configurationId,
  }: {
    datasetId: string;
    configurationId: string;
  }) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return null;
    }
    return this.api.createDatasetView({
      datasetId,
      configurationId,
      layerContrasts: {},
      scales: {},
      lastViewed: Date.now(),
      lastLocation: {
        xy: this.xy,
        z: this.z,
        time: this.time,
      },
    });
  }

  @Action
  async fetchRecentDatasetViews() {
    try {
      const recentDatasetViews = await this.api.getRecentDatasetViews(
        MAX_NUMBER_OF_RECENT_DATASET_VIEWS,
      );
      this.setRecentDatasetViewsImpl(recentDatasetViews);
    } catch {
      this.setRecentDatasetViewsImpl([]);
    }
  }

  @Action
  async initialize() {
    // The Girder client may set the token to the path of the API, but this actually means that we
    // have no token, hence we are disconnected.
    if (!this.girderRest.token || this.girderRest.token === "#/") {
      return;
    }
    try {
      sync.setLoading(true);
      const user = await this.girderRest.fetchUser();
      if (user) {
        await this.loggedIn(this.girderRest);
      }
      await this.initFromUrl();
      sync.setLoading(false);
    } catch (error) {
      sync.setLoading(error as Error);
    }
  }

  @Action
  setupWatchers() {
    store.watch(
      (state: any) => state.annotation.annotations,
      this.fetchHistory,
    );
    store.watch(
      (state: any) => state.annotation.annotationConnections,
      this.fetchHistory,
    );
    store.watch(
      (state: any) => state.properties.propertyValues,
      () => this.context.dispatch("updateDisplayedFromComputedProperties"),
    );
  }

  @Action
  private async initFromUrl() {
    // Note, removed the check for isLoggedIn to allow anonymous users to access datasets
    if (this.selectedDatasetId) {
      await this.setSelectedDataset(this.selectedDatasetId);
    }
    if (this.selectedConfigurationId && this.dataset) {
      await this.setSelectedConfiguration(this.selectedConfigurationId);
    }
  }

  @Action
  public async refreshDataset() {
    await this.setSelectedDataset(this.selectedDatasetId);
  }

  @Action
  async login({
    domain,
    username,
    password,
  }: {
    domain: string;
    username: string;
    password: string;
  }) {
    const restClient = new RestClient({
      apiRoot: apiRootFromGirderUrl(domain),
    });

    try {
      sync.setLoading(true);
      await restClient.login(username, password);
      sync.setLoading(false);
    } catch (error) {
      const err = error as any;
      if (!err.response || err.response.status !== 401) {
        sync.setLoading(err);
        return "Unknown error occurred";
      } else {
        const { message } = err.response.data;
        sync.setLoading(false);
        return message || "Unauthorized.";
      }
    }

    // Insert new token in client so components using it (Like Girder Web
    // Components & BreadCrumbs can start using Girder API).
    this.api.client.token = restClient.token;

    await this.loggedIn(restClient);
    await this.initFromUrl();
  }

  @Action
  async signUp({
    domain,
    ...user
  }: {
    domain: string;
    login: string;
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    admin: boolean;
  }): Promise<void> {
    const restClient = new RestClient({
      apiRoot: apiRootFromGirderUrl(domain),
    });

    const formData = new FormData();
    formData.append("login", user.login);
    formData.append("email", user.email);
    formData.append("firstName", user.firstName);
    formData.append("lastName", user.lastName);
    formData.append("password", user.password);
    formData.append("admin", `${user.admin}`);

    try {
      await restClient.post("user", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          accept: "application/json",
        },
      });
    } catch (unknownError: unknown) {
      // Assume this is an object that looks like an AxiosError
      const error = unknownError as Partial<AxiosError>;
      if (error.response) {
        // The request was made and the server responded with a status code that falls out of the range of 2xx
        const responseData = error.response.data as { message: string };
        throw new Error(responseData.message || "An error occurred");
      }
      if (error.request) {
        // The request was made but no response was received
        throw new Error(
          "No response received from server. Please try again later.",
        );
      }
      // Something happened in setting up the request that triggered an Error
      throw new Error("An unexpected error occurred. Please try again later.");
    }

    this.setGirderRest(restClient);
  }

  @Action
  async setSelectedDataset(id: string | null) {
    this.api.flushCaches();
    if (!id) {
      this.setDataset({ id, data: null });
      return;
    }
    try {
      sync.setLoading(true); // For the Girder activity indicator
      sync.setDatasetLoading(true); // For the dataset loading overlay
      const r = await this.context.dispatch("getDataset", {
        id,
        unrollXY: this.unrollXY,
        unrollZ: this.unrollZ,
        unrollT: this.unrollT,
      });
      this.setDataset({ id, data: r });
      await this.loadLargeImages();
      sync.setLoading(false);
      sync.setDatasetLoading(false);
    } catch (error) {
      sync.setLoading(error as Error);
      sync.setDatasetLoading(false);
    }
  }

  @Action
  async setSelectedConfiguration(id: string | null) {
    // Note, removed the check for isLoggedIn to allow anonymous users to access configurations
    // Needed to view public datasets even as anonymous
    // Note also that this does get called before the user is logged in with a null id,
    // so we need to return early if the id is null.
    if (id === null) {
      return;
    }
    try {
      sync.setLoading(true);
      const configuration = await this.context.dispatch("getConfiguration", id);
      if (!configuration) {
        this.setConfiguration({ id: null, data: null });
      } else {
        this.setConfiguration({ id, data: configuration });
      }
      sync.setLoading(false);
    } catch (error) {
      sync.setLoading(error as Error);
    }
  }

  @Action
  async setDatasetViewId(id: string | null) {
    if (!id) {
      this.setDatasetViewImpl(null);
    } else {
      let datasetView: IDatasetView;
      try {
        datasetView = await this.api.getDatasetView(id);
      } catch (err) {
        // The datasetView doesn't exist
        logError(
          `Failed to fetch dataset view ${id}.\nIt may be because it has been deleted or that you don't have the access is forbidden.\n`,
          err,
        );
        return;
      }
      datasetView.lastViewed = Date.now();
      this.setDatasetViewImpl(datasetView);
      const promises: Promise<any>[] = [];

      // Only update lastViewed if user is logged in (anonymous users can't update)
      if (this.isLoggedIn) {
        promises.push(this.api.updateDatasetView(datasetView));
      }

      const newLocation = datasetView.lastLocation;
      const query = app.$route.query;
      promises.push(
        this.setXY(query.xy == null ? newLocation.xy : Number(query.xy)),
        this.setZ(query.z == null ? newLocation.z : Number(query.z)),
        this.setTime(
          query.time == null ? newLocation.time : Number(query.time),
        ),
      );

      if (this.dataset?.id !== datasetView.datasetId) {
        promises.push(this.setSelectedDataset(datasetView.datasetId));
      }
      if (this.configuration?.id !== datasetView.configurationId) {
        promises.push(
          this.setSelectedConfiguration(datasetView.configurationId),
        );
      }
      await Promise.all(promises);
    }
  }

  @Mutation
  setDatasetViewImpl(datasetView: IDatasetView | null) {
    this.datasetView = datasetView;
  }

  @Action
  deleteDatasetView(datasetView: IDatasetView) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    return this.api.deleteDatasetView(datasetView.id);
  }

  @Action
  async createDataset({
    name,
    description,
    path,
  }: {
    name: string;
    description: string;
    path: IGirderSelectAble;
  }) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return null;
    }
    try {
      sync.setSaving(true);
      const ds = await this.api.createDataset(name, description, path);
      sync.setSaving(false);
      return ds;
    } catch (error) {
      sync.setSaving(error as Error);
    }
    return null;
  }

  @Action
  async importDataset(path: IGirderSelectAble) {
    try {
      sync.setSaving(true);
      const ds = await this.api.importDataset(path);
      sync.setSaving(false);
      return ds;
    } catch (error) {
      sync.setSaving(error as Error);
    }
    return null;
  }

  @Action
  async createConfiguration({
    name,
    description,
    folderId,
  }: {
    name: string;
    description: string;
    folderId: string;
  }) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return null;
    }
    if (!this.dataset) {
      return null;
    }
    try {
      sync.setSaving(true);
      const config = await this.api.createConfigurationFromDataset(
        name,
        description,
        folderId,
        this.dataset,
        this.userChannelColors,
      );
      sync.setSaving(false);
      return config;
    } catch (error) {
      sync.setSaving(error as Error);
    }
    return null;
  }

  @Mutation
  private deleteConfigurationImpl(configuration: IDatasetConfiguration) {
    if (this.configuration === configuration) {
      this.configuration = null;
    }
    if (this.selectedConfigurationId === configuration.id) {
      this.selectedConfigurationId = null;
    }
  }

  @Action
  async addMultiSourceMetadata({
    parentId,
    metadata,
    transcode,
    eventCallback,
  }: {
    parentId: string;
    metadata: string;
    transcode: boolean;
    eventCallback?: (data: IJobEventData) => void;
  }) {
    try {
      sync.setSaving(true);
      const newFile = (
        await this.api.uploadJSONFile(
          DEFAULT_LARGE_IMAGE_SOURCE,
          metadata,
          parentId,
          "folder",
        )
      ).data;
      const itemId: string = newFile.itemId;

      const items = await this.api.getItems(parentId);

      // When transcoding, remove all large image
      // Otherwise, remove large image only for items that are large image but not the uploaded one
      const itemsToRemoveLargeImage = transcode
        ? items
        : items.filter((item: any) => !!item.largeImage && item._id !== itemId);
      const limit = pLimit(4);
      const promises = itemsToRemoveLargeImage.map((item: IGirderItem) =>
        limit(async () => {
          return pRetry(
            async () => this.api.removeLargeImageForItem(item._id),
            { retries: 3, minTimeout: 2000, maxTimeout: 2000, factor: 1 },
          );
        }),
      );
      await Promise.all(promises);

      // When transcoding, force the regeneration of large image for the new file
      if (transcode) {
        const response = await this.api.generateTiles(itemId, true, true);
        const jobId = response.data?._id;
        if (!jobId) {
          throw new Error(
            "Failed to transcode the large image: no job received",
          );
        }
        const success = await jobs.addJob({
          jobId,
          datasetId: parentId,
          eventCallback,
        });
        if (!success) {
          throw new Error("Failed to transcode the large image: job failed");
        }
      }
      return itemId;
    } catch (error) {
      sync.setSaving(error as Error);
      return null;
    }
  }

  @Action
  async deleteConfiguration(configuration: IDatasetConfiguration) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    try {
      sync.setSaving(true);
      const promises: Promise<any>[] = [];
      promises.push(this.api.deleteConfiguration(configuration));
      const views = await this.api.findDatasetViews({
        configurationId: configuration.id,
      });
      for (const { id } of views) {
        promises.push(this.api.deleteDatasetView(id));
      }
      await Promise.allSettled(promises);
      await this.context.dispatch("ressourceDeleted", configuration.id);
      this.deleteConfigurationImpl(configuration);
      sync.setSaving(false);
    } catch (error) {
      sync.setSaving(error as Error);
    }
  }

  @Mutation
  private deleteDatasetImpl(dataset: IDataset) {
    if (this.dataset === dataset) {
      this.dataset = null;
      this.configuration = null;
      this.selectedConfigurationId = null;
    }
    if (this.selectedDatasetId === dataset.id) {
      this.selectedDatasetId = null;
    }
  }

  @Action
  async deleteDataset(dataset: IDataset) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    try {
      sync.setSaving(true);
      const promises: Promise<any>[] = [];
      promises.push(this.api.deleteDataset(dataset));
      const views = await this.api.findDatasetViews({
        datasetId: dataset.id,
      });
      for (const { id } of views) {
        promises.push(this.api.deleteDatasetView(id));
      }
      await Promise.all(promises);
      this.deleteDatasetImpl(dataset);
      sync.setSaving(false);
    } catch (error) {
      sync.setSaving(error as Error);
    }
  }

  @Action
  @Debounce(100, { leading: false, trailing: true })
  async fetchHistory() {
    const datasetId = this.dataset?.id;
    // Only fetch history if user is logged in to avoid 401 errors
    // (and because anonymous users should not access history)
    if (this.isLoggedIn && datasetId !== undefined) {
      const history = await this.api.getHistoryEntries(datasetId);
      this.setHistory(history);
    } else {
      this.setHistory([]);
    }
  }

  @Mutation
  setLastLocationInDatasetView(location: IDatasetView["lastLocation"]) {
    if (!this.datasetView) {
      return;
    }
    Vue.set(this.datasetView, "lastLocation", location);
  }

  @Action
  @Debounce(5000, { leading: false, trailing: true })
  async updateLastLocationInDatasetView() {
    const location = this.currentLocation;
    if (!this.datasetView || isEqual(this.datasetView.lastLocation, location)) {
      return;
    }
    this.setLastLocationInDatasetView(location);
    if (this.isLoggedIn) {
      await this.api.updateDatasetView(this.datasetView);
    }
  }

  @Action
  async setXY(value: number) {
    this.setXYImpl(value);
    this.updateLastLocationInDatasetView();
  }

  @Action
  async setUnrollXY(value: boolean) {
    this.setUnrollXYImpl(value);
  }

  @Action
  async setZ(value: number) {
    this.setZImpl(value);
    this.updateLastLocationInDatasetView();
  }

  @Action
  async setUnrollZ(value: boolean) {
    this.setUnrollZImpl(value);
  }

  @Action
  async setTime(value: number) {
    this.setTimeImpl(value);
    this.updateLastLocationInDatasetView();
  }

  @Action
  async setCameraInfo(value: ICameraInfo) {
    this.setCameraInfoImpl(value);
  }

  @Action
  async setUnrollT(value: boolean) {
    this.setUnrollTImpl(value);
  }

  @Mutation
  private pushLayer(layer: IDisplayLayer) {
    if (this.configuration) {
      const layers = this.configuration.layers;
      Vue.set(layers, layers.length, Object.assign({}, layer));
    }
  }

  @Mutation
  private toggleLayer(layerId: string) {
    if (!this.configuration) {
      return;
    }
    const layers = this.configuration.layers;
    switch (this.layerMode) {
      case "single":
        layers.forEach((l) => (l.visible = l.id === layerId));
        break;
      case "multiple":
      case "unroll":
        const index = layers.findIndex((l) => l.id === layerId);
        if (index === null) {
          break;
        }
        layers[index].visible = !layers[index].visible;
        Vue.set(layers, index, layers[index]);
        break;
    }
  }

  @Action
  updateConfigurationProperties(propertyIds: string[]) {
    if (this.configuration) {
      this.configuration.propertyIds = propertyIds;
      this.syncConfiguration("propertyIds");
    }
  }

  @Action
  async syncConfiguration(key: keyof IDatasetConfigurationBase) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    if (!this.configuration) {
      return;
    }
    sync.setSaving(true);
    try {
      await this.api.updateConfigurationKey(this.configuration, key);
      this.context.dispatch("ressourceChanged", this.configuration.id);
      sync.setSaving(false);
    } catch (error) {
      sync.setSaving(error as Error);
    }
  }

  @Action
  async renameConfiguration(newName: string) {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    if (!this.configuration) {
      return;
    }
    sync.setSaving(true);
    try {
      await this.api.renameConfiguration(this.configuration, newName);
      this.context.dispatch("ressourceChanged", this.configuration.id);
      sync.setSaving(false);
    } catch (error) {
      sync.setSaving(error as Error);
    }
  }

  @Action
  async addLayer() {
    if (!this.isLoggedIn) {
      this.createNotLoggedInNotification();
      return;
    }
    if (!this.configuration || !this.dataset) {
      return;
    }
    this.pushLayer(newLayer(this.dataset, this.layers, this.userChannelColors));
    await this.syncConfiguration("layers");
  }

  @Mutation
  private setLayerModeImpl(mode: TLayerMode) {
    this.layerMode = mode;
  }

  @Mutation
  private storeLayerVisibility(mode: TLayerMode) {
    if (!this.configuration) {
      return;
    }

    // Store current layer visibility before switching mode
    if (
      mode === "single" &&
      (this.layerMode === "multiple" || this.layerMode === "unroll")
    ) {
      // Going from multiple/unroll to single, store visible layers
      this.previousMultipleLayerVisibility = this.configuration.layers
        .filter((layer) => layer.visible)
        .map((layer) => layer.id);
    } else if (
      (mode === "multiple" || mode === "unroll") &&
      this.layerMode === "single"
    ) {
      // Going from single to multiple/unroll, store the visible layer
      const visibleLayer = this.configuration.layers.find(
        (layer) => layer.visible,
      );
      this.previousSingleLayerVisibility = visibleLayer
        ? visibleLayer.id
        : null;
    }
  }

  @Mutation
  private verifySingleLayerMode() {
    if (!this.configuration) {
      return;
    }
    let first = true;
    this.configuration.layers.forEach((l) => {
      if (l.visible) {
        if (!first) {
          l.visible = false;
        }
        first = false;
      }
    });
    if (first && this.configuration.layers.length) {
      this.configuration.layers[0].visible = true;
    }
  }

  @Mutation
  private restoreLayerVisibility(mode: TLayerMode) {
    if (!this.configuration) {
      return;
    }

    // Restore previous layer visibility when switching mode
    if (mode === "multiple" || mode === "unroll") {
      // Coming from single mode, restore multiple mode visibility
      if (this.previousMultipleLayerVisibility.length > 0) {
        // First, set all layers to invisible
        this.configuration.layers.forEach((layer) => {
          layer.visible = false;
        });

        // Then restore visibility for layers that existed in the previous state
        this.configuration.layers.forEach((layer) => {
          if (this.previousMultipleLayerVisibility.includes(layer.id)) {
            layer.visible = true;
          }
        });
      }
    } else if (mode === "single") {
      // First, set all layers to invisible
      this.configuration.layers.forEach((l) => {
        l.visible = false;
      });

      // Coming from multiple mode, try to restore single mode visibility
      if (this.previousSingleLayerVisibility) {
        const layer = this.configuration.layers.find(
          (l) => l.id === this.previousSingleLayerVisibility,
        );
        if (layer) {
          // Make the previously visible single layer visible again
          layer.visible = true;
          return; // Don't need verifySingleLayerMode since we've set a layer visible
        }
      }

      // If we reach here, we need to select a layer to make visible
      // For the first switch to single mode, try to use a currently visible layer
      const visibleLayer = this.configuration.layers.find((l) => l.visible);
      if (visibleLayer) {
        // Keep only this one visible, set others to invisible
        this.configuration.layers.forEach((l) => {
          l.visible = l.id === visibleLayer.id;
        });
      } else if (this.configuration.layers.length > 0) {
        // If no layer is visible, make the first layer visible
        this.configuration.layers[0].visible = true;
      }
    }
  }

  @Action
  async setLayerMode(mode: TLayerMode) {
    // Store current visibility state before changing mode
    this.storeLayerVisibility(mode);

    // Update the layer mode
    this.setLayerModeImpl(mode);

    // Restore previous visibility or enforce single layer constraint
    this.restoreLayerVisibility(mode);

    // For safety, ensure single mode constraints are enforced
    if (mode === "single") {
      this.verifySingleLayerMode();
    }

    // Sync the configuration with the backend
    if (this.isLoggedIn) {
      await this.syncConfiguration("layers");
    }
  }

  @Action
  async toggleLayerVisibility(layerId: string) {
    if (!this.dataset || !this.configuration) {
      return;
    }
    this.toggleLayer(layerId);
    if (this.isLoggedIn) {
      await this.syncConfiguration("layers");
    }
  }

  @Action
  async toggleGlobalZMaxMerge() {
    const layers = this.layers;
    if (!layers || !this.dataset) {
      return;
    }
    const currentZMaxMerge = layers.every(
      (layer) => layer.z.type === "max-merge",
    );
    const newLayerZ: IDisplaySlice = currentZMaxMerge
      ? { type: "current", value: null }
      : { type: "max-merge", value: null };
    layers.forEach((layer) =>
      this.changeLayer({
        layerId: layer.id,
        delta: {
          z: { ...newLayerZ },
        },
      }),
    );
  }

  @Action
  async toggleGlobalLayerVisibility() {
    const layers = this.layers;
    const currentVisibility = layers.every((layer) => layer.visible);
    layers.forEach((layer) => {
      if (layer.visible === currentVisibility) {
        this.toggleLayerVisibility(layer.id);
      }
    });
  }

  @Action
  async saveContrastInConfiguration({
    layerId,
    contrast,
  }: {
    layerId: string;
    contrast: IContrast;
  }) {
    this.changeLayer({ layerId, delta: { contrast }, sync: true });
    if (this.datasetView) {
      Vue.delete(this.datasetView.layerContrasts, layerId);
      if (this.isLoggedIn) {
        this.api.updateDatasetView(this.datasetView);
      }
    }
  }

  @Action
  async saveContrastInView({
    layerId,
    contrast,
  }: {
    layerId: string;
    contrast: IContrast;
  }) {
    if (this.datasetView) {
      Vue.set(this.datasetView.layerContrasts, layerId, contrast);
      if (this.isLoggedIn) {
        this.api.updateDatasetView(this.datasetView);
      }
    }
  }

  @Action
  async resetContrastInView(layerId: string) {
    if (this.datasetView) {
      Vue.delete(this.datasetView.layerContrasts, layerId);
      if (this.isLoggedIn) {
        this.api.updateDatasetView(this.datasetView);
      }
    }
  }

  @Action
  saveScaleInConfiguration({
    itemId,
    scale,
  }: {
    itemId: keyof IScales;
    scale: IScaleInformation<TUnitLength | TUnitTime>;
  }) {
    if (this.configuration) {
      Vue.set(this.configuration.scales, itemId, scale);
      this.syncConfiguration("scales");
    }
  }

  @Action
  saveScalesInView({
    itemId,
    scale,
  }: {
    itemId: keyof IScales;
    scale: IScaleInformation<TUnitLength | TUnitTime>;
  }) {
    if (this.datasetView) {
      Vue.set(this.datasetView.scales, itemId, scale);
      if (this.isLoggedIn) {
        this.api.updateDatasetView(this.datasetView);
      }
    }
  }

  @Action
  resetScalesInView(itemId: keyof IScales) {
    if (this.datasetView) {
      Vue.delete(this.datasetView.scales, itemId);
      if (this.isLoggedIn) {
        this.api.updateDatasetView(this.datasetView);
      }
    }
  }

  @Mutation
  private changeLayerImpl({
    layerId,
    delta,
  }: {
    layerId: string;
    delta: Partial<IDisplayLayer>;
  }) {
    if (!this.configuration) {
      return;
    }
    const confLayers = this.configuration.layers;
    const index = confLayers.findIndex((l) => l.id === layerId);
    if (index === null) {
      return;
    }
    const layer = confLayers[index];
    Vue.set(confLayers, index, Object.assign({}, layer, delta));
  }

  @Action
  async changeLayer(args: {
    layerId: string;
    delta: Partial<IDisplayLayer>;
    sync?: boolean;
  }) {
    this.changeLayerImpl(args);
    if (args.sync !== false && this.isLoggedIn) {
      await this.syncConfiguration("layers");
    }
  }

  @Mutation
  private removeLayerImpl(layerId: string) {
    if (!this.configuration) {
      return;
    }
    const layers = this.configuration.layers;
    const index = layers.findIndex((l) => l.id === layerId);
    if (index === null) {
      return;
    }
    layers.splice(index, 1);
  }

  @Action
  async removeLayer(layerId: string) {
    this.removeLayerImpl(layerId);
    await this.syncConfiguration("layers");
  }

  get getImagesFromLayer() {
    return (layer: IDisplayLayer) => {
      if (!this.dataset) {
        return [];
      }
      const indexes = this.layerSliceIndexes(layer);
      if (!indexes) {
        return [];
      }
      return (
        this.dataset.images(
          indexes.zIndex,
          indexes.tIndex,
          indexes.xyIndex,
          layer.channel,
        ) || []
      );
    };
  }

  get getFullLayerImages() {
    return (time: number, xy: number, z: number) => {
      const results: {
        neededHistograms: IImage[][];
        urls: string[];
        fullUrls: string[];
      } = {
        neededHistograms: [],
        urls: [],
        fullUrls: [],
      };
      if (!this.dataset || !this.configuration || !this.api.histogramsLoaded) {
        return results;
      }
      this.layers.forEach((layer) => {
        const images = getLayerImages(layer, this.dataset!, time, xy, z);
        const hist = this.api.getResolvedLayerHistogram(images);
        if (!hist) {
          results.neededHistograms.push(images);
        } else {
          images.forEach((image) => {
            results.urls.push(
              this.api.tileTemplateUrl(
                image,
                layer.color,
                layer.contrast,
                hist,
                layer,
                this.dataset,
              )!,
            );
            results.fullUrls.push(
              this.api.tileTemplateUrl(
                image,
                "#ffffff",
                {
                  mode: "percentile",
                  blackPoint: 0,
                  whitePoint: 100,
                },
                hist,
                layer,
                this.dataset,
              )!,
            );
          });
        }
      });
      return results;
    };
  }

  get layerStackImages() {
    if (!this.dataset || !this.configuration || !this.api.histogramsLoaded) {
      return [];
    }

    return this.layers.map((layer) => {
      const images = getLayerImages(
        layer,
        this.dataset!,
        this.time,
        this.xy,
        this.z,
      );
      const hist = this.api.getResolvedLayerHistogram(images);
      const singleFrame =
        layer.xy.type !== "max-merge" &&
        layer.time.type !== "max-merge" &&
        layer.z.type !== "max-merge" &&
        images.length === 1;
      const results: ILayerStackImage = {
        layer,
        images,
        urls: images.map((image) =>
          this.api.tileTemplateUrl(
            image,
            layer.color,
            layer.contrast,
            hist,
            layer,
            this.dataset,
          ),
        ),
        fullUrls: images.map((image) =>
          this.api.tileTemplateUrl(
            image,
            "#ffffff",
            {
              mode: "percentile",
              blackPoint: 0,
              whitePoint: 100,
            },
            hist,
            layer,
            this.dataset,
          ),
        ),
        hist,
        singleFrame: singleFrame ? images[0].frameIndex : null,
      };
      if (results.fullUrls && results.fullUrls.length && results.fullUrls[0]) {
        results.baseQuadOptions = {
          baseUrl: results.fullUrls[0].split("/tiles")[0] + "/tiles",
          restRequest: (params: any) =>
            this.girderRest
              .get(params.url, { params: params.data })
              .then((data) => data.data),
          restUrl:
            "item/" +
            results.fullUrls[0].split("/tiles")[0].split("item/")[1] +
            "/tiles",
          queryParameters: {
            maxTextures: 32,
            maxTextureSize: 4096,
            query:
              "style=" +
              encodeURIComponent(
                JSON.stringify({
                  min: "min",
                  max: "max",
                  palette: ["#000000", "#ffffff"],
                }),
              ) +
              "&cache=true",
          },
        };
        const anyImage = this.dataset!.anyImage();
        if (
          anyImage &&
          anyImage.tileinfo &&
          anyImage.tileinfo.IndexStride &&
          anyImage.tileinfo.IndexStride.IndexC === 1 &&
          anyImage.tileinfo.IndexRange &&
          anyImage.tileinfo.IndexRange.IndexC > 1
        ) {
          const query = results.baseQuadOptions.queryParameters;
          query.frameBase = layer.channel;
          query.frameStride = anyImage.tileinfo.IndexRange.IndexC;
          query.frameGroup = anyImage.tileinfo.IndexRange.IndexZ || 1;
          if (
            (anyImage.tileinfo.IndexStride || {}).IndexZ &&
            (anyImage.tileinfo.IndexStride || {}).IndexC &&
            anyImage.tileinfo.IndexStride.IndexZ >
              anyImage.tileinfo.IndexRange.IndexC
          ) {
            query.frameGroupStride =
              anyImage.tileinfo.IndexStride.IndexZ /
              anyImage.tileinfo.IndexRange.IndexC;
          }
        }
      }
      return results;
    });
  }

  get getLayerHistogram() {
    // need to be like that to be detected as a getter
    return (layer: IDisplayLayer) => {
      if (!this.dataset || !this.configuration) {
        return Promise.resolve(null);
      }

      if (!layer._histogram) {
        layer._histogram = {
          promise: Promise.resolve(null),
          lastHistogram: null,
          lastImages: null,
          nextImages: null,
          lock: false,
        };
      }

      // debounce histogram calls
      const nextHistogram = () => {
        if (
          layer._histogram &&
          !layer._histogram.lock &&
          layer._histogram.nextImages !== null
        ) {
          const histogramObj = layer._histogram;
          const images = layer._histogram.nextImages;
          histogramObj.nextImages = null;
          histogramObj.lock = true;
          histogramObj.promise = this.api.getLayerHistogram(images);
          histogramObj.promise.then((value) => {
            histogramObj.lastHistogram = value;
          });
          histogramObj.promise.catch(() => {
            histogramObj.lastHistogram = null;
          });
          histogramObj.promise.finally(() => {
            histogramObj.lastImages = images;
            histogramObj.lock = false;
            nextHistogram();
          });
        }
        return null;
      };

      const lastImages = layer._histogram.lastImages;
      const nextImages = getLayerImages(
        layer,
        this.dataset,
        this.time,
        this.xy,
        this.z,
      );

      if (
        lastImages === null ||
        nextImages.length !== lastImages.length ||
        nextImages.some((image, idx) => image !== lastImages[idx])
      ) {
        layer._histogram.nextImages = nextImages;
        nextHistogram();
      }
      return layer._histogram.promise;
    };
  }

  get getLayerFromId() {
    return (layerId: string | undefined) =>
      layerId === undefined
        ? undefined
        : this.layers.find((layer) => layer.id === layerId);
  }

  get getConfigurationLayerFromId() {
    return (layerId: string) =>
      this.configuration?.layers.find((layer) => layer.id === layerId);
  }

  get getLayerIndexFromId() {
    return (layerId: string) => {
      const index = this.configuration?.layers.findIndex(
        (layer) => layer.id === layerId,
      );
      if (index === undefined || index < 0) {
        return null;
      }
      return index;
    };
  }

  @Action
  async syncSnapshots() {
    if (!this.configuration) {
      return;
    }
    await this.syncConfiguration("snapshots");
  }

  @Action
  async addSnapshot(snapshot: ISnapshot) {
    if (!this.configuration) {
      return;
    }
    const snapshots = (this.configuration.snapshots || []).filter(
      (d) => d.name !== snapshot.name,
    );
    snapshots.push(snapshot);
    this.configuration.snapshots = snapshots;
    await this.syncSnapshots();
  }

  @Action
  async removeSnapshot(name: string) {
    if (!this.configuration) {
      return;
    }
    const snapshots = (this.configuration.snapshots || []).filter(
      (d) => d.name !== name,
    );
    this.configuration.snapshots = snapshots;
    await this.syncSnapshots();
  }

  @Action
  async setConfigurationLayers(layers: IDisplayLayer[]) {
    if (!this.configuration) {
      return;
    }
    this.configuration.layers = [];
    layers.forEach(this.pushLayer);
    await this.syncConfiguration("layers");
  }

  @Mutation
  resetDatasetViewContrasts() {
    if (!this.datasetView) {
      return;
    }
    Vue.set(this.datasetView, "layerContrasts", {});
    if (this.isLoggedIn) {
      this.api.updateDatasetView(this.datasetView);
    }
  }

  @Mutation
  setDatasetViewContrasts(contrasts: IDatasetView["layerContrasts"]) {
    if (!this.datasetView) {
      return;
    }
    Vue.set(this.datasetView, "layerContrasts", contrasts);
    if (this.isLoggedIn) {
      this.api.updateDatasetView(this.datasetView);
    }
  }

  @Action
  async loadSnapshotLayers(snapshot: ISnapshot) {
    await this.setLayerMode(snapshot.layerMode);
    await this.loadLayersContrastsInDatasetView(snapshot.layers);
    await this.loadLayersVisibilityInConfiguration(snapshot.layers);
  }

  @Action
  async loadLayersVisibilityInConfiguration(layers: IDisplayLayer[]) {
    for (const layer of layers) {
      this.changeLayer({
        layerId: layer.id,
        delta: { visible: layer.visible },
        sync: false,
      });
    }
    await this.syncConfiguration("layers");
  }

  @Action
  async loadLayersContrastsInDatasetView(layers: IDisplayLayer[]) {
    const contrasts: IDatasetView["layerContrasts"] = {};
    for (const layer of layers) {
      contrasts[layer.id] = layer.contrast;
    }
    this.setDatasetViewContrasts(contrasts);
  }

  @Action
  async scheduleTileFramesComputation(datasetId: string) {
    return this.api.scheduleTileFramesComputation(datasetId);
  }

  @Action
  async scheduleMaxMergeCache(datasetId: string) {
    return this.api.scheduleMaxMergeCache(datasetId);
  }

  @Action
  async scheduleHistogramCache(datasetId: string) {
    return this.api.scheduleHistogramCache(datasetId);
  }

  @Action
  async loadUserColors(): Promise<{ [key: string]: string }> {
    try {
      const colors = await this.api.getUserColors();

      // Update the local store with the loaded colors
      if (colors && Object.keys(colors).length > 0) {
        this.updateUserChannelColors(colors);
      }

      return colors;
    } catch (error) {
      logError("Failed to load user colors:", error);
      return {};
    }
  }

  @Action
  async saveUserColors(channelColors: {
    [key: string]: string;
  }): Promise<void> {
    try {
      if (this.isLoggedIn) {
        await this.api.setUserColors(channelColors);
      }

      // Update the user metadata in the store using mutation
      this.updateUserChannelColors(channelColors);
    } catch (error) {
      logError("Failed to save user colors:", error);
      throw error;
    }
  }
}

const main = getModule(Main);

export default main;
