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
} from "@/girder";
import Vue from "vue";
import { IDataset, IDatasetConfiguration } from "./model";
import { asConfigurationItem, asDataset, parseTiles } from "./GirderAPI";

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
    if (!(id in this.resources)) {
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
    const resource = await this.getResource({ id, type: "user" });
    return resource as IGirderUser | null;
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

  get watchItem() {
    return (id: string) =>
      this.watchResource(id, "item") as IGirderItem | null | undefined;
  }

  get watchUser() {
    return (id: string) =>
      this.watchResource(id, "user") as IGirderUser | null | undefined;
  }

  @Mutation
  private resetResource(id: string) {
    Vue.delete(this.resources, id);
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
  async getConfiguration(id: string): Promise<IDatasetConfiguration | null> {
    const item = await this.getItem(id);
    return item ? asConfigurationItem(item) : null;
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
