import {
  Action,
  Module,
  Mutation,
  VuexModule,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import { IScalarMap, IScalarMapDisplay } from "./model";
import { logError } from "@/utils/log";
import { valueAtPercentile } from "@/utils/scalarMap";

export const DEFAULT_SCALAR_MAP_OPACITY = 0.7;
// The worker's default threshold: `Top percent of tissue` 20.
export const DEFAULT_SCALAR_MAP_TOP_PERCENT = 20;

let listRequestGeneration = 0;

/** How a map is drawn before the user changes anything. */
export function defaultScalarMapDisplay(map: IScalarMap): IScalarMapDisplay {
  const [min, max] = map.meta.valueRange;
  const threshold = valueAtPercentile(
    map.meta.percentiles,
    100 - DEFAULT_SCALAR_MAP_TOP_PERCENT,
  );
  return {
    visible: false,
    opacity: DEFAULT_SCALAR_MAP_OPACITY,
    colormap: "viridis",
    min,
    max,
    thresholdEnabled: false,
    threshold: Number.isFinite(threshold) ? threshold : (min + max) / 2,
    thresholdSide: "above",
  };
}

/**
 * The scalar map layer's state (HOTSPOT_REGIONS_WORKER.md §8.3): the current
 * dataset's saved maps and, per map, how the overlay draws it.
 *
 * `mapsDatasetId` says which dataset `maps` belongs to, so a stale answer is
 * never shown for the current dataset (`currentMaps` is empty until the
 * current dataset's answer lands). "No maps" (an empty list, no error) and
 * "could not ask" (`error`) stay distinct so a network blip does not hide
 * the feature.
 */
@Module({ dynamic: true, store, name: "scalarMaps" })
export class ScalarMaps extends VuexModule {
  maps: IScalarMap[] = [];
  mapsDatasetId: string | null = null;
  loading = false;
  error: string | null = null;
  // Keyed by item id; entries for maps no longer listed are dropped.
  display: Record<string, IScalarMapDisplay> = {};

  get currentMaps(): IScalarMap[] {
    return this.mapsDatasetId !== null &&
      this.mapsDatasetId === (main.dataset?.id ?? null)
      ? this.maps
      : [];
  }

  get hasMaps(): boolean {
    return this.currentMaps.length > 0;
  }

  @Mutation
  setMaps(payload: { datasetId: string; maps: IScalarMap[] }) {
    const sameDataset = payload.datasetId === this.mapsDatasetId;
    const display: Record<string, IScalarMapDisplay> = {};
    for (const map of payload.maps) {
      const kept = sameDataset ? this.display[map.itemId] : undefined;
      display[map.itemId] = kept ?? defaultScalarMapDisplay(map);
    }
    this.mapsDatasetId = payload.datasetId;
    this.maps = payload.maps;
    this.display = display;
  }

  @Mutation
  setLoading(loading: boolean) {
    this.loading = loading;
  }

  @Mutation
  setError(error: string | null) {
    this.error = error;
  }

  @Mutation
  updateDisplay(payload: {
    itemId: string;
    changes: Partial<IScalarMapDisplay>;
  }) {
    const current = this.display[payload.itemId];
    if (!current) {
      return;
    }
    const next = { ...current, ...payload.changes };
    next.opacity = Math.min(1, Math.max(0.05, next.opacity));
    this.display[payload.itemId] = next;
  }

  /** Reset a map's display range to its full value range. */
  @Mutation
  resetRange(itemId: string) {
    const map = this.maps.find((candidate) => candidate.itemId === itemId);
    const current = this.display[itemId];
    if (map && current) {
      this.display[itemId] = {
        ...current,
        min: map.meta.valueRange[0],
        max: map.meta.valueRange[1],
      };
    }
  }

  @Mutation
  removeMap(itemId: string) {
    this.maps = this.maps.filter((map) => map.itemId !== itemId);
    const display = { ...this.display };
    delete display[itemId];
    this.display = display;
  }

  @Action
  async refreshMaps(): Promise<void> {
    // Claimed before any early return: a request still in flight for the
    // previous dataset must not land after this one decided anything.
    const generation = ++listRequestGeneration;
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      this.setMaps({ datasetId: "", maps: [] });
      this.setError(null);
      this.setLoading(false);
      return;
    }
    this.setLoading(true);
    this.setError(null);
    try {
      const maps = await main.scalarMapAPI.listMaps(datasetId);
      if (
        generation === listRequestGeneration &&
        main.dataset?.id === datasetId
      ) {
        this.setMaps({ datasetId, maps });
      }
    } catch (error) {
      logError("Failed to list the dataset's scalar maps:", error);
      if (
        generation === listRequestGeneration &&
        main.dataset?.id === datasetId
      ) {
        this.setError("Could not read the dataset's saved maps.");
      }
    } finally {
      if (generation === listRequestGeneration) {
        this.setLoading(false);
      }
    }
  }

  /** refreshMaps unless this dataset's list is already known. */
  @Action
  async ensureMaps(): Promise<void> {
    const datasetId = main.dataset?.id ?? null;
    if (datasetId !== null && this.mapsDatasetId === datasetId && !this.error) {
      return;
    }
    await this.refreshMaps();
  }

  /** Delete a saved map (WRITE on the item); throws the server's reason. */
  @Action({ rawError: true })
  async deleteMap(itemId: string): Promise<void> {
    await main.scalarMapAPI.deleteMap(itemId);
    this.removeMap(itemId);
  }
}

export default getModule(ScalarMaps);
