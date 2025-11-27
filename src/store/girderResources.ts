import {
  getModule,
  Action,
  Module,
  VuexModule,
  Mutation,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import {
  IGirderFolder,
  IGirderItem,
  IGirderLargeImage,
  IGirderSelectAble,
  IGirderUser,
  IUPennCollection,
} from "@/girder";
import Vue from "vue";
import { IDataset, IDatasetConfiguration } from "./model";
import { setBaseCollectionValues, asDataset, parseTiles } from "./GirderAPI";
import { logError } from "@/utils/log";

/**
 * Store to cache requests to resources, mostly items and folders
 */
@Module({ dynamic: true, store, name: "girderResources" })
export class GirderResources extends VuexModule {
  resources: { [resourceId: string]: IGirderSelectAble | null } = {};
  resourcesLocks: { [resourceId: string]: Promise<void> } = {};

  @Mutation
  public setResource({
    id,
    resource,
  }: {
    id: string;
    resource: IGirderSelectAble | null;
  }) {
    Vue.set(this.resources, id, resource);
  }

  @Action
  private requestResource({
    id,
    type,
  }: {
    id: string;
    type: IGirderSelectAble["_modelType"];
  }) {
    return main.api.getResource(id, type);
  }

  @Action
  private async requestAndSetResource({
    id,
    type,
  }: {
    id: string;
    type: IGirderSelectAble["_modelType"];
  }) {
    try {
      const resource = await this.requestResource({ id, type });
      this.setResource({ id, resource });
    } catch (e) {
      this.setResource({ id, resource: null });
    }
  }

  @Action
  public async getResource({
    id,
    type,
  }: {
    id: string;
    type: IGirderSelectAble["_modelType"];
  }) {
    if (id in this.resourcesLocks) {
      await this.resourcesLocks[id];
    }

    const cached = this.resources[id];

    // Not cached OR cached with wrong type → re-fetch
    if (!(id in this.resources) || cached?._modelType !== type) {
      this.resourcesLocks[id] = this.requestAndSetResource({ id, type });
      await this.resourcesLocks[id];
    }

    const resource = this.resources[id];
    // This check ensures that get{Type} returns a resource of the right type (e.g. getFolder)
    return resource?._modelType === type ? resource : null;
  }

  @Action
  public async getFolder(id: string): Promise<IGirderFolder | null> {
    const resource = await this.getResource({ id, type: "folder" });
    return resource as IGirderFolder | null;
  }

  @Action
  public async getItem(id: string): Promise<IGirderItem | null> {
    const resource = await this.getResource({ id, type: "item" });
    return resource as IGirderItem | null;
  }

  @Action
  public async getUser(id: string): Promise<IGirderUser | null> {
    // Skip user requests if not logged in to avoid 401 errors
    if (!main.isLoggedIn) {
      // Mark as null in cache to prevent retry
      if (!(id in this.resources)) {
        this.setResource({ id, resource: null });
      }
      return null;
    }
    const resource = await this.getResource({ id, type: "user" });
    return resource as IGirderUser | null;
  }

  @Action
  public async getCollection(id: string): Promise<IGirderItem | null> {
    const resource = await this.getResource({ id, type: "upenn_collection" });
    return resource as IGirderItem | null;
  }

  get watchResource() {
    return (id: string, type: IGirderSelectAble["_modelType"]) => {
      if (!(id in this.resources)) {
        return undefined;
      }
      const resource = this.resources[id];
      return resource?._modelType === type ? resource : null;
    };
  }

  get watchFolder() {
    return (id: string) =>
      this.watchResource(id, "folder") as IGirderFolder | null | undefined;
  }

  get watchCollection() {
    return (id: string) =>
      this.watchResource(id, "upenn_collection") as
        | IUPennCollection
        | null
        | undefined;
  }

  get watchUser() {
    return (id: string) =>
      this.watchResource(id, "user") as IGirderUser | null | undefined;
  }

  @Mutation
  private resetResource(id: string) {
    Vue.delete(this.resources, id);
    Vue.delete(this.resourcesLocks, id);
  }

  @Action
  public async forceFetchResource({
    id,
    type,
  }: {
    id: string;
    type: IGirderSelectAble["_modelType"];
  }) {
    this.resetResource(id);
    return await this.getResource({ id, type });
  }

  @Action
  public ressourceChanged(id: string) {
    this.resetResource(id);
  }

  @Action
  public ressourceDeleted(id: string) {
    this.setResource({ id, resource: null });
  }

  @Action
  public async batchFetchResources({
    folderIds = [],
    collectionIds = [],
    userIds = [],
  }: {
    folderIds?: string[];
    collectionIds?: string[];
    userIds?: string[];
  }) {
    if (
      folderIds.length === 0 &&
      collectionIds.length === 0 &&
      userIds.length === 0
    ) {
      return;
    }

    // Skip user requests if not logged in to avoid unnecessary 401 errors
    const effectiveUserIds = main.isLoggedIn ? userIds : [];

    try {
      const response = await main.api.batchResources({
        folder: folderIds,
        upenn_collection: collectionIds,
        user: effectiveUserIds,
      });

      // Update the cache with all fetched resources
      if (response.folder) {
        Object.entries(response.folder).forEach(([id, resource]) => {
          this.setResource({
            id,
            resource: { ...resource, _modelType: "folder" },
          });
        });
      }

      if (response.upenn_collection) {
        Object.entries(response.upenn_collection).forEach(([id, resource]) => {
          this.setResource({
            id,
            resource: { ...resource, _modelType: "upenn_collection" },
          });
        });
      }

      if (response.user) {
        Object.entries(response.user).forEach(([id, resource]) => {
          this.setResource({
            id,
            resource: { ...resource, _modelType: "user" },
          });
        });
      }

      // If we skipped user requests, mark them as null in cache
      if (!main.isLoggedIn && userIds.length > 0) {
        userIds.forEach((id) => {
          if (!(id in this.resources)) {
            this.setResource({ id, resource: null });
          }
        });
      }
    } catch (error) {
      logError("Failed to batch fetch resources:", error);
      // Mark failed resources as null to prevent retry loops
      [...folderIds, ...collectionIds, ...effectiveUserIds].forEach((id) => {
        if (!(id in this.resources)) {
          this.setResource({ id, resource: null });
        }
      });
    }
  }

  @Action
  async getConfiguration(id: string): Promise<IDatasetConfiguration | null> {
    const configuration = await this.getCollection(id);
    return configuration ? setBaseCollectionValues(configuration) : null;
  }

  @Action
  async getDataset({
    id,
    unrollXY = false,
    unrollZ = false,
    unrollT = false,
  }: {
    id: string;
    unrollXY?: boolean;
    unrollZ?: boolean;
    unrollT?: boolean;
  }): Promise<IDataset | null> {
    const [folder, items] = await Promise.all([
      this.getFolder(id),
      main.api.getItems(id),
    ]);
    if (!folder) {
      return null;
    }
    const baseDataset = asDataset(folder);

    // For a contrast dataset, the selectedLargeImageId is the id of the
    // large image that is currently selected. It may or may not exist.
    // If not, then default to the first large image (previous behavior).
    let imageItem: IGirderItem | undefined = undefined;
    if (folder.meta.selectedLargeImageId) {
      imageItem =
        (await this.getItem(folder.meta.selectedLargeImageId)) || undefined;
    } else {
      imageItem = items!.find((d) => d.largeImage);
    }

    if (imageItem === undefined) {
      return baseDataset;
    }
    const tiles = await main.api.getTiles(imageItem);
    return {
      ...baseDataset,
      ...parseTiles(imageItem, tiles, unrollXY, unrollZ, unrollT),
    };
  }

  @Action
  public async getAllLargeImages(
    id: string,
  ): Promise<IGirderLargeImage[] | undefined> {
    const [folder, items] = await Promise.all([
      this.getFolder(id),
      main.api.getItems(id),
    ]);
    if (!folder) {
      return [];
    }

    const allItems = items!.filter((d) => d.largeImage);
    return allItems as IGirderLargeImage[];
  }

  @Action
  public async getCurrentLargeImage(
    datasetId: string,
  ): Promise<IGirderLargeImage | null> {
    const resource = await this.getFolder(datasetId);
    if (!resource || resource.meta.subtype !== "contrastDataset") {
      return null;
    }

    // For a contrast dataset, the selectedLargeImageId is the id of the large image that is currently selected
    // It may or may not exist. If not, then default to the first large image
    if (resource.meta.selectedLargeImageId) {
      const item = await this.getItem(resource.meta.selectedLargeImageId);
      if (item) {
        return item as IGirderLargeImage;
      }
    }

    // If there is no selectedLargeImageId, then return the first large image
    const items = await main.api.getItems(datasetId);
    const imageItem = items!.find((d) => d.largeImage);
    return imageItem as IGirderLargeImage | null;
  }

  @Action
  public async setCurrentLargeImage({
    datasetId,
    largeImage,
  }: {
    datasetId: string;
    largeImage: IGirderLargeImage;
  }): Promise<IGirderLargeImage | null> {
    await main.api.updateDatasetMetadata(datasetId, {
      selectedLargeImageId: largeImage._id,
    });

    return largeImage;
  }
}

export default getModule(GirderResources);
