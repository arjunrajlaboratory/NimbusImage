import {
  Action,
  Module,
  Mutation,
  VuexModule,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import { ISpatialInfo } from "./model";
import { logError } from "@/utils/log";

/**
 * The current dataset's spatial expression table (upenncontrast_spatial
 * plugin, SPATIAL_PLUGIN.md). `info` is null when the dataset has none;
 * `infoDatasetId` says which dataset the answer is for, so a stale answer
 * from a previous dataset is never shown as the current one.
 */
@Module({ dynamic: true, store, name: "spatial" })
export class Spatial extends VuexModule {
  info: ISpatialInfo | null = null;
  infoDatasetId: string | null = null;
  loading = false;
  // Set when the last fetch failed: "no table" (null info, no error) and
  // "could not ask" must stay distinct so the UI does not hide the feature
  // on a network blip.
  error: string | null = null;

  get hasTable(): boolean {
    return (
      this.info !== null && this.infoDatasetId === (main.dataset?.id ?? null)
    );
  }

  @Mutation
  setInfo(payload: { datasetId: string; info: ISpatialInfo | null }) {
    this.infoDatasetId = payload.datasetId;
    this.info = payload.info;
  }

  @Mutation
  setLoading(loading: boolean) {
    this.loading = loading;
  }

  @Mutation
  setError(error: string | null) {
    this.error = error;
  }

  /** Fetch (or re-fetch) the current dataset's registration. */
  @Action
  async refreshInfo(): Promise<void> {
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      this.setInfo({ datasetId: "", info: null });
      return;
    }
    this.setLoading(true);
    this.setError(null);
    try {
      const info = await main.spatialAPI.fetchInfo(datasetId);
      // A dataset switch during the await would make this answer stale.
      if (main.dataset?.id === datasetId) {
        this.setInfo({ datasetId, info });
      }
    } catch (error) {
      logError("Failed to fetch the spatial table registration:", error);
      if (main.dataset?.id === datasetId) {
        this.setError("Could not read the dataset's spatial table.");
      }
    } finally {
      this.setLoading(false);
    }
  }

  /** refreshInfo unless the answer for this dataset is already known. */
  @Action
  async ensureInfo(): Promise<void> {
    const datasetId = main.dataset?.id ?? null;
    if (datasetId !== null && this.infoDatasetId === datasetId) {
      return;
    }
    await this.refreshInfo();
  }
}

export default getModule(Spatial);
