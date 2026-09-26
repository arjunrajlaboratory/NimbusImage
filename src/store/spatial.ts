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
import { createSequenceGuard } from "@/utils/sequenceGuard";

// Only the latest refreshInfo may commit: a refresh after a table activation
// or recompute can overlap an older one for the same dataset.
const infoRequestGuard = createSequenceGuard();

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
    // Claimed before the early return, so a bail-out also retires a pending
    // answer for the previous dataset.
    const token = infoRequestGuard.next();
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      this.setInfo({ datasetId: "", info: null });
      this.setLoading(false);
      return;
    }
    this.setLoading(true);
    this.setError(null);
    try {
      const info = await main.spatialAPI.fetchInfo(datasetId);
      // A newer refresh (or a dataset switch) makes this answer stale.
      if (infoRequestGuard.isCurrent(token) && main.dataset?.id === datasetId) {
        this.setInfo({ datasetId, info });
        await this.adoptRegistryPixelSize(datasetId);
      }
    } catch (error) {
      logError("Failed to fetch the spatial table registration:", error);
      if (infoRequestGuard.isCurrent(token) && main.dataset?.id === datasetId) {
        this.setError("Could not read the dataset's spatial table.");
      }
    } finally {
      if (infoRequestGuard.isCurrent(token)) {
        this.setLoading(false);
      }
    }
  }

  /**
   * Copy the table's microns-per-pixel into the configuration's scale.
   *
   * A vendor table (Xenium and friends) records the pixel size the section
   * was imaged at, and the analyses that take a radius or an area in microns
   * need it. Making the configuration scale the one place that holds it keeps
   * those dialogs working on a freshly ingested dataset instead of asking the
   * user to retype a number the table already carries.
   *
   * Only ever fills a blank: a pixel size someone set by hand is the
   * authority, and a read-only viewer (a share link included, which
   * `canEditDatasetView` excludes) must not try to write at all.
   */
  @Action
  async adoptRegistryPixelSize(datasetId: string): Promise<void> {
    const micronsPerPixel = this.info?.pixelSize;
    if (
      typeof micronsPerPixel !== "number" ||
      !Number.isFinite(micronsPerPixel) ||
      micronsPerPixel <= 0
    ) {
      return;
    }
    if (!main.canEditDatasetView || !main.configuration) {
      return;
    }
    // Already set (including by a previous call) — never overwrite.
    if ((main.configuration.scales?.pixelSize?.value ?? 0) > 0) {
      return;
    }
    // The write targets whatever configuration is open now, so a dataset
    // switch while the registration was in flight must not redirect it.
    if (main.dataset?.id !== datasetId) {
      return;
    }
    try {
      await main.saveScalesInConfiguration({
        scales: { pixelSize: { value: micronsPerPixel, unit: "µm" } },
      });
    } catch (error) {
      // A viewer who can edit the view but not the configuration: the scale
      // stays blank and the dialogs say so. Not worth failing the fetch.
      logError("Could not adopt the spatial table's pixel size:", error);
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
