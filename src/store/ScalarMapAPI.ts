import { RestClientInstance } from "@/girder";
import {
  IScalarMap,
  TScalarMapColormap,
  TScalarMapThresholdSide,
} from "./model";
import { exactNumberString } from "@/utils/scalarMap";

export interface IScalarMapTileUrlOptions {
  itemId: string;
  // The map's key for the viewer's XY/Z/Time.
  location: string;
  // The image pyramid the tiles are cut on, as for the transcript heat map.
  sizeX: number;
  sizeY: number;
  tileSize: number;
  maxLevel: number;
  colormap: TScalarMapColormap;
  min: number;
  max: number;
  // null: no threshold, every pixel keeps its color.
  threshold: number | null;
  thresholdSide: TScalarMapThresholdSide;
  // Shared views send their isolated bearer on the tile URL.
  authToken?: string | null;
  // The list entry's `revision` (changes with the backing file): tiles may
  // be cached, so a rewritten map must change the URL.
  version?: string;
}

/**
 * Saved scalar maps (HOTSPOT_REGIONS_WORKER.md §8.2): smoothed per-cell
 * property maps the Hotspot Regions worker uploads, drawn as a heat map.
 * The resource is in the core annotation plugin, so it is always available.
 */
export default class ScalarMapAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async listMaps(datasetId: string): Promise<IScalarMap[]> {
    const response = await this.client.get("scalar_map", {
      params: { datasetId },
    });
    return response.data as IScalarMap[];
  }

  async deleteMap(itemId: string): Promise<void> {
    await this.client.delete(`scalar_map/${itemId}`);
  }

  /** A GeoJS tile URL template (`{z}/{x}/{y}`) for one map and location. */
  tileTemplateUrl(options: IScalarMapTileUrlOptions): string {
    const url = new URL(
      `${this.client.apiRoot}/scalar_map/${options.itemId}/tiles/0/0/0`,
    );
    const params = url.searchParams;
    params.set("location", options.location);
    params.set("sizeX", options.sizeX.toString());
    params.set("sizeY", options.sizeY.toString());
    params.set("maxLevel", options.maxLevel.toString());
    params.set("tileSize", options.tileSize.toString());
    params.set("colormap", options.colormap);
    params.set("min", options.min.toString());
    params.set("max", options.max.toString());
    if (options.threshold !== null) {
      // The same string the panel offers to copy into the worker.
      params.set("threshold", exactNumberString(options.threshold));
      params.set("thresholdSide", options.thresholdSide);
    }
    if (options.version) {
      params.set("v", options.version);
    }
    if (options.authToken) {
      params.set("token", options.authToken);
    }
    return url.href.replace("/tiles/0/0/0", "/tiles/{z}/{x}/{y}");
  }
}
