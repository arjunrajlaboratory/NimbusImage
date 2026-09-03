import { isAxiosError } from "axios";
import { RestClientInstance } from "@/girder";
import {
  IAnnotationListFilters,
  ISpatialAggregate,
  ISpatialFeature,
  ISpatialInfo,
  ISpatialJob,
  ISpatialMaterializeResult,
  ISpatialNeighbourhood,
  ISpatialRecomputeRequest,
  ISpatialRegionSummary,
  ISpatialStaleness,
  ISpatialTranscriptsSchema,
  ISpatialVersions,
  ITranscriptPoints,
} from "./model";
import { decodeTranscriptPoints } from "@/utils/transcriptPoints";

export interface ITranscriptDensityUrlOptions {
  datasetId: string;
  genes: string[];
  sizeX: number;
  sizeY: number;
  tileSize: number;
  maxLevel: number;
  color: string;
}

// Client for the upenncontrast_spatial plugin: a dataset's expression table
// (SPATIAL_PLUGIN.md). Filters are the list-filter object the Objects tab
// sends, so a gate means the same thing here as in the selection summary.
export default class SpatialAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  /** The registered table, or null when the dataset has none (404). Other
   * failures propagate: "no table" and "could not ask" must stay distinct. */
  async fetchInfo(datasetId: string): Promise<ISpatialInfo | null> {
    try {
      const response = await this.client.get(`spatial/${datasetId}`);
      return response.data as ISpatialInfo;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async searchFeatures(
    datasetId: string,
    search: string,
    limit = 25,
  ): Promise<ISpatialFeature[]> {
    const response = await this.client.get(`spatial/${datasetId}/features`, {
      params: { search, limit },
    });
    return response.data as ISpatialFeature[];
  }

  async aggregate(
    datasetId: string,
    filters: IAnnotationListFilters,
    features: string[],
  ): Promise<ISpatialAggregate> {
    const response = await this.client.post(`spatial/${datasetId}/aggregate`, {
      filters,
      features,
    });
    return response.data as ISpatialAggregate;
  }

  async materialize(
    datasetId: string,
    features: string[],
    propertyName: string,
  ): Promise<ISpatialMaterializeResult> {
    const response = await this.client.post(
      `spatial/${datasetId}/materialize`,
      { features, propertyName },
    );
    return response.data as ISpatialMaterializeResult;
  }

  /** Gene-set score (mean or sum of the features per cell) as one sub-value
   * `name` of a property; same job behaviour as materialize. */
  async score(
    datasetId: string,
    features: string[],
    name: string,
    method: "mean" | "sum",
    propertyName: string,
  ): Promise<ISpatialMaterializeResult> {
    const response = await this.client.post(`spatial/${datasetId}/score`, {
      features,
      name,
      method,
      propertyName,
    });
    return response.data as ISpatialMaterializeResult;
  }

  /** Schedule a differential-expression job; the table arrives on the job
   * (`fetchJob`). `filtersB` null means every cell not in A. */
  async differential(
    datasetId: string,
    filtersA: IAnnotationListFilters,
    filtersB: IAnnotationListFilters | null,
    maxFeatures: number,
  ): Promise<{ jobId: string; nA: number }> {
    const response = await this.client.post(
      `spatial/${datasetId}/differential`,
      { filtersA, filtersB, maxFeatures },
    );
    return response.data as { jobId: string; nA: number };
  }

  async fetchJob(jobId: string): Promise<ISpatialJob> {
    const response = await this.client.get(`job/${jobId}`);
    return response.data as ISpatialJob;
  }

  // ---- transcripts (per-molecule store) ----

  /** The transcript pyramid, or null when the dataset has none (404). */
  async fetchTranscriptsSchema(
    datasetId: string,
  ): Promise<ISpatialTranscriptsSchema | null> {
    try {
      const response = await this.client.get(
        `spatial/${datasetId}/transcripts`,
      );
      return response.data as ISpatialTranscriptsSchema;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async searchTranscriptGenes(
    datasetId: string,
    search: string,
    limit = 25,
  ): Promise<string[]> {
    const response = await this.client.get(
      `spatial/${datasetId}/transcripts/genes`,
      { params: { search, limit } },
    );
    return response.data as string[];
  }

  /** Molecules of `genes` in the given pyramid tiles, in image pixels. A
   * 413 (too many points) propagates as an axios error for the caller to
   * step to a coarser level. */
  async fetchTranscriptPoints(
    datasetId: string,
    genes: string[],
    level: number,
    tiles: string[],
    minQv: number,
  ): Promise<ITranscriptPoints> {
    const response = await this.client.post(
      `spatial/${datasetId}/transcripts/points`,
      { genes, level, tiles, minQv },
      { responseType: "arraybuffer" },
    );
    return decodeTranscriptPoints(response.data as ArrayBuffer);
  }

  // ---- table versions and recompute (Phase 4) ----

  async fetchVersions(datasetId: string): Promise<ISpatialVersions> {
    const response = await this.client.get(`spatial/${datasetId}/versions`);
    return response.data as ISpatialVersions;
  }

  async activateVersion(
    datasetId: string,
    itemId: string,
  ): Promise<ISpatialVersions> {
    const response = await this.client.post(
      `spatial/${datasetId}/versions/${itemId}/activate`,
    );
    return response.data as ISpatialVersions;
  }

  async forgetVersion(
    datasetId: string,
    itemId: string,
  ): Promise<ISpatialVersions> {
    const response = await this.client.delete(
      `spatial/${datasetId}/versions/${itemId}`,
    );
    return response.data as ISpatialVersions;
  }

  async fetchStaleness(datasetId: string): Promise<ISpatialStaleness> {
    const response = await this.client.get(`spatial/${datasetId}/staleness`);
    return response.data as ISpatialStaleness;
  }

  /** Schedule a rebuild of the expression table from the current cell
   * polygons; the result lands on the job (`fetchJob`). */
  async recompute(
    datasetId: string,
    request: ISpatialRecomputeRequest,
  ): Promise<{ jobId: string }> {
    const response = await this.client.post(
      `spatial/${datasetId}/recompute`,
      request,
    );
    return response.data as { jobId: string };
  }

  // ---- neighbourhood and regions (Phase 6) ----

  /** The last neighbourhood enrichment, or null until one was computed. */
  async fetchNeighbourhood(
    datasetId: string,
  ): Promise<ISpatialNeighbourhood | null> {
    try {
      const response = await this.client.get(
        `spatial/${datasetId}/neighbourhood`,
      );
      return response.data as ISpatialNeighbourhood;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Schedule the neighbourhood job; `radius` in image pixels. */
  async computeNeighbourhood(
    datasetId: string,
    radius: number,
    excludeTags: string[],
    propertyName: string,
  ): Promise<{ jobId: string; propertyId: string }> {
    const response = await this.client.post(
      `spatial/${datasetId}/neighbourhood`,
      { radius, excludeTags, propertyName },
    );
    return response.data as { jobId: string; propertyId: string };
  }

  async regionSummary(
    datasetId: string,
    regionTag: string,
    features: string[],
  ): Promise<ISpatialRegionSummary[]> {
    const response = await this.client.post(
      `spatial/${datasetId}/regions/summary`,
      { regionTag, features },
    );
    return response.data as ISpatialRegionSummary[];
  }

  /** GeoJS tile URL template for the density heat map, on the annotation
   * overview's pyramid. */
  transcriptDensityTemplateUrl(options: ITranscriptDensityUrlOptions): string {
    const url = new URL(
      `${this.client.apiRoot}/spatial/${options.datasetId}/transcripts/density/0/0/0`,
    );
    url.searchParams.set("genes", options.genes.join(","));
    url.searchParams.set("sizeX", options.sizeX.toString());
    url.searchParams.set("sizeY", options.sizeY.toString());
    url.searchParams.set("tileSize", options.tileSize.toString());
    url.searchParams.set("maxLevel", options.maxLevel.toString());
    url.searchParams.set("color", options.color);
    return url.href.replace("/density/0/0/0", "/density/{z}/{x}/{y}");
  }
}
