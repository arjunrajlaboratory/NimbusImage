import { isAxiosError } from "axios";
import { RestClientInstance } from "@/girder";
import {
  IAnnotationListFilters,
  ISpatialAggregate,
  ISpatialFeature,
  ISpatialInfo,
  ISpatialJob,
  ISpatialMaterializeResult,
} from "./model";

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
}
