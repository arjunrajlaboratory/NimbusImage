import {
  Action,
  Module,
  Mutation,
  VuexModule,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import {
  IScalarMap,
  IScalarMapDisplay,
  TScalarMapThresholdSide,
} from "./model";
import { logError, logWarning } from "@/utils/log";
import {
  displayValueRange,
  isValidScalarMap,
  thresholdForTissueShare,
} from "@/utils/scalarMap";

export const DEFAULT_SCALAR_MAP_OPACITY = 0.7;
// The worker's default threshold: `Top percent of tissue` 20.
export const DEFAULT_SCALAR_MAP_TOP_PERCENT = 20;

// Sequence guard for list responses. Bumped by every list request and by a
// successful delete, so no response captured earlier can land afterwards.
let listRequestGeneration = 0;
// The current list request, shared by callers asking for the same dataset
// (opening a dataset and opening the palette both list it).
let listInFlight: {
  datasetId: string;
  generation: number;
  promise: Promise<void>;
} | null = null;
let colormapStopsRequest: Promise<void> | null = null;

// A finished list request stops being shareable (only if it is still the
// current one: a newer request may have replaced it).
function forgetListRequest(generation: number) {
  if (listInFlight?.generation === generation) {
    listInFlight = null;
  }
}

/** How a map is drawn before the user changes anything. */
export function defaultScalarMapDisplay(map: IScalarMap): IScalarMapDisplay {
  const [min, max] = displayValueRange(map.meta.valueRange);
  return {
    visible: false,
    opacity: DEFAULT_SCALAR_MAP_OPACITY,
    colormap: "viridis",
    min,
    max,
    thresholdEnabled: false,
    threshold: thresholdForTissueShare(
      map.meta.percentiles,
      DEFAULT_SCALAR_MAP_TOP_PERCENT,
      "above",
    ),
    thresholdPercent: DEFAULT_SCALAR_MAP_TOP_PERCENT,
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
 *
 * The list is read again whenever a dataset is opened, when the palette is
 * shown, after a worker job for the dataset succeeds (jobs.ts), and from the
 * palette's Refresh button, so a map a worker saved or replaced appears (and
 * a replaced item id disappears) without a reload.
 */
@Module({ dynamic: true, store, name: "scalarMaps" })
export class ScalarMaps extends VuexModule {
  maps: IScalarMap[] = [];
  mapsDatasetId: string | null = null;
  loading = false;
  error: string | null = null;
  // Keyed by item id; entries for maps no longer listed are dropped.
  display: Record<string, IScalarMapDisplay> = {};
  // Legend gradients, keyed by colormap name: the server's anchor tables
  // (server/helpers/colormaps.py), which the tile route samples, read
  // through color_by_property/options. null until loaded.
  colormapStops: Record<string, string[]> | null = null;

  get currentMaps(): IScalarMap[] {
    return this.mapsDatasetId !== null &&
      this.mapsDatasetId === (main.dataset?.id ?? null)
      ? this.maps
      : [];
  }

  get hasMaps(): boolean {
    return this.currentMaps.length > 0;
  }

  /**
   * Replace the list. Malformed entries are skipped and logged, so one bad
   * map can never throw here and lose the whole list. A map whose file
   * changed (new `revision`) keeps only how it is shown, not its range or
   * threshold, which may not fit the new values.
   */
  @Mutation
  setScalarMaps(payload: { datasetId: string; maps: unknown[] }) {
    const sameDataset = payload.datasetId === this.mapsDatasetId;
    const previous = new Map(this.maps.map((map) => [map.itemId, map]));
    const maps: IScalarMap[] = [];
    const display: Record<string, IScalarMapDisplay> = {};
    for (const map of payload.maps) {
      if (!isValidScalarMap(map)) {
        logWarning("Skipping a malformed saved map:", map);
        continue;
      }
      maps.push(map);
      const kept = sameDataset ? this.display[map.itemId] : undefined;
      if (!kept) {
        display[map.itemId] = defaultScalarMapDisplay(map);
      } else if (previous.get(map.itemId)?.revision === map.revision) {
        display[map.itemId] = kept;
      } else {
        display[map.itemId] = {
          ...defaultScalarMapDisplay(map),
          visible: kept.visible,
          opacity: kept.opacity,
          colormap: kept.colormap,
        };
      }
    }
    this.mapsDatasetId = payload.datasetId;
    this.maps = maps;
    this.display = display;
  }

  @Mutation
  setScalarMapsLoading(loading: boolean) {
    this.loading = loading;
  }

  @Mutation
  setScalarMapsError(error: string | null) {
    this.error = error;
  }

  /** Visibility, opacity, colormap, range and the threshold switch. The
   * threshold itself goes through the setScalarMapThreshold* mutations. */
  @Mutation
  updateScalarMapDisplay(payload: {
    itemId: string;
    changes: Partial<
      Pick<
        IScalarMapDisplay,
        "visible" | "opacity" | "colormap" | "min" | "max" | "thresholdEnabled"
      >
    >;
  }) {
    const current = this.display[payload.itemId];
    if (!current) {
      return;
    }
    const next = { ...current, ...payload.changes };
    next.opacity = Math.min(1, Math.max(0.05, next.opacity));
    this.display[payload.itemId] = next;
  }

  /** Threshold by share of tissue: the share is kept, the value derived. */
  @Mutation
  setScalarMapThresholdPercent(payload: { itemId: string; percent: number }) {
    const map = this.maps.find(
      (candidate) => candidate.itemId === payload.itemId,
    );
    const current = this.display[payload.itemId];
    if (!map || !current) {
      return;
    }
    const percent = Math.min(100, Math.max(0, payload.percent));
    this.display[payload.itemId] = {
      ...current,
      thresholdPercent: percent,
      threshold: thresholdForTissueShare(
        map.meta.percentiles,
        percent,
        current.thresholdSide,
      ),
    };
  }

  /** Threshold by value: the share is then read from the value. */
  @Mutation
  setScalarMapThresholdValue(payload: { itemId: string; value: number }) {
    const current = this.display[payload.itemId];
    if (current) {
      this.display[payload.itemId] = {
        ...current,
        threshold: payload.value,
        thresholdPercent: null,
      };
    }
  }

  /** Switch sides; a share picked in percent mode stays the same share. */
  @Mutation
  setScalarMapThresholdSide(payload: {
    itemId: string;
    side: TScalarMapThresholdSide;
  }) {
    const map = this.maps.find(
      (candidate) => candidate.itemId === payload.itemId,
    );
    const current = this.display[payload.itemId];
    if (!map || !current) {
      return;
    }
    this.display[payload.itemId] = {
      ...current,
      thresholdSide: payload.side,
      threshold:
        current.thresholdPercent === null
          ? current.threshold
          : thresholdForTissueShare(
              map.meta.percentiles,
              current.thresholdPercent,
              payload.side,
            ),
    };
  }

  /** Reset a map's display range to its full (widened if constant) range. */
  @Mutation
  resetScalarMapRange(itemId: string) {
    const map = this.maps.find((candidate) => candidate.itemId === itemId);
    const current = this.display[itemId];
    if (map && current) {
      const [min, max] = displayValueRange(map.meta.valueRange);
      this.display[itemId] = { ...current, min, max };
    }
  }

  @Mutation
  setScalarMapColormapStops(stops: Record<string, string[]>) {
    this.colormapStops = stops;
  }

  /** Load the legend gradients once; on failure the legend is left out and
   * the next call asks again. */
  @Action
  async ensureScalarMapColormapStops(): Promise<void> {
    if (this.colormapStops !== null) {
      return;
    }
    colormapStopsRequest ??= main.annotationsAPI
      .getColorByPropertyOptions()
      .then((options) => this.setScalarMapColormapStops(options.colormaps))
      .catch((error) => {
        logError("Failed to load the colormap tables:", error);
      })
      .finally(() => {
        colormapStopsRequest = null;
      });
    await colormapStopsRequest;
  }

  @Mutation
  removeScalarMap(itemId: string) {
    this.maps = this.maps.filter((map) => map.itemId !== itemId);
    const display = { ...this.display };
    delete display[itemId];
    this.display = display;
  }

  /**
   * List the current dataset's maps. A call for the dataset already being
   * listed shares that request, unless `force`: something may have changed
   * since it was sent (a job finished, the user pressed Refresh).
   */
  @Action
  async refreshScalarMaps(force: boolean = false): Promise<void> {
    const datasetId = main.dataset?.id ?? null;
    if (
      !force &&
      datasetId !== null &&
      listInFlight?.datasetId === datasetId &&
      listInFlight.generation === listRequestGeneration
    ) {
      return listInFlight.promise;
    }
    // Claimed before any early return: a request still in flight for the
    // previous dataset must not land after this one decided anything.
    const generation = ++listRequestGeneration;
    listInFlight = null;
    if (datasetId === null) {
      this.setScalarMaps({ datasetId: "", maps: [] });
      this.setScalarMapsError(null);
      this.setScalarMapsLoading(false);
      return;
    }
    this.setScalarMapsLoading(true);
    this.setScalarMapsError(null);
    const stillCurrent = () =>
      generation === listRequestGeneration && main.dataset?.id === datasetId;
    const promise = (async () => {
      try {
        const maps = await main.scalarMapAPI.listMaps(datasetId);
        if (stillCurrent()) {
          this.setScalarMaps({ datasetId, maps });
        }
      } catch (error) {
        logError("Failed to list the dataset's scalar maps:", error);
        if (stillCurrent()) {
          this.setScalarMapsError("Could not read the dataset's saved maps.");
        }
      } finally {
        if (generation === listRequestGeneration) {
          this.setScalarMapsLoading(false);
        }
        forgetListRequest(generation);
      }
    })();
    listInFlight = { datasetId, generation, promise };
    await promise;
  }

  /** Delete a saved map (WRITE on the item); throws the server's reason. */
  @Action({ rawError: true })
  async deleteScalarMap(itemId: string): Promise<void> {
    await main.scalarMapAPI.deleteMap(itemId);
    // A list response captured before the delete would bring the map back:
    // invalidate it, and list again if one was pending (it may carry a map
    // saved meanwhile).
    const wasListing = listInFlight !== null;
    listRequestGeneration++;
    listInFlight = null;
    this.removeScalarMap(itemId);
    if (wasListing) {
      void this.refreshScalarMaps(true);
    }
  }
}

export default getModule(ScalarMaps);
