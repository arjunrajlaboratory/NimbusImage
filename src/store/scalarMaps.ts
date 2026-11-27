import {
  Action,
  Module,
  Mutation,
  VuexModule,
  getModule,
} from "vuex-module-decorators";
import { debounce } from "lodash";
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
// without `force` (showing the palette joins the list its dataset's opening
// started; the opening itself always forces, see App.vue).
let listInFlight: {
  datasetId: string;
  generation: number;
  promise: Promise<void>;
} | null = null;
let colormapStopsRequest: Promise<void> | null = null;
// The DELETE in flight per item id, so a second request for the same map
// (a confirmation closed with Escape and opened again before the first
// settled) shares the first instead of failing on an item it already
// removed. Mirrored in the reactive `deletingMapIds` for the UI.
const deletesInFlight = new Map<string, Promise<void>>();

// A finished list request stops being shareable (only if it is still the
// current one: a newer request may have replaced it).
function forgetListRequest(generation: number) {
  if (listInFlight?.generation === generation) {
    listInFlight = null;
  }
}

/**
 * New item id -> the dropped item id it replaces, for a worker re-run: the
 * two share a non-empty `meta.toolId`, and that tool has exactly one dropped
 * and exactly one new item in this re-list (anything else is ambiguous and
 * gets no carry-over).
 */
export function replacementsByTool(
  before: readonly IScalarMap[],
  after: readonly IScalarMap[],
): Map<string, string> {
  const beforeIds = new Set(before.map((map) => map.itemId));
  const afterIds = new Set(after.map((map) => map.itemId));
  const byTool = (maps: IScalarMap[]) => {
    const groups = new Map<string, string[]>();
    for (const map of maps) {
      const toolId = map.meta.toolId;
      if (typeof toolId === "string" && toolId !== "") {
        groups.set(toolId, [...(groups.get(toolId) ?? []), map.itemId]);
      }
    }
    return groups;
  };
  const dropped = byTool(before.filter((map) => !afterIds.has(map.itemId)));
  const added = byTool(after.filter((map) => !beforeIds.has(map.itemId)));
  const replacements = new Map<string, string>();
  added.forEach((newIds, toolId) => {
    const oldIds = dropped.get(toolId);
    if (newIds.length === 1 && oldIds?.length === 1) {
      replacements.set(newIds[0], oldIds[0]);
    }
  });
  return replacements;
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
 * "could not ask" (`scalarMapsError`) stay distinct so a network blip does
 * not hide the feature. The error is tagged with its dataset too: another
 * dataset's failure never shows over this one's list.
 *
 * The list is read again whenever a dataset is opened, when the palette is
 * shown, shortly after any job on the dataset ends (jobs.ts, debounced), and
 * from the palette's Refresh button, so a map a worker saved or replaced
 * appears (and a replaced item id disappears) without a reload. A failed
 * re-list keeps the last good list.
 */
@Module({ dynamic: true, store, name: "scalarMaps" })
export class ScalarMaps extends VuexModule {
  maps: IScalarMap[] = [];
  mapsDatasetId: string | null = null;
  loading = false;
  // The last list failure and the dataset it was for; read it through
  // `scalarMapsError`, which is null for any other dataset.
  listError: string | null = null;
  listErrorDatasetId: string | null = null;
  // Keyed by item id; entries for maps no longer listed are dropped.
  display: Record<string, IScalarMapDisplay> = {};
  // Legend gradients, keyed by colormap name: the server's anchor tables
  // (server/helpers/colormaps.py), which the tile route samples, read
  // through color_by_property/options. null until loaded.
  colormapStops: Record<string, string[]> | null = null;
  // Item ids with a DELETE in flight. A state per item: absent (idle) or
  // present (deleting). Only `deleteScalarMap` writes it: added when the
  // request is sent, removed when it settles (success or failure). Nothing
  // else ends it: closing the confirmation, hiding the palette or switching
  // datasets does not cancel the request, so the map stays "deleting" until
  // the server answers. Several maps may be deleting at once; a second
  // delete of the same map joins the first.
  deletingMapIds: string[] = [];
  // Item ids whose overlay layer had a tile request fail. GeoJS keeps a
  // rejected tile in its cache and never asks for it again, so the map stays
  // blank there until the layer's cache is reset. A state per item: absent
  // (no failure known) or present (some tile of the layer now on the map
  // failed). Written only through `setScalarMapTilesFailed`:
  // - set by ScalarMapOverlay when a tile of the map's CURRENT layer and URL
  //   rejects (a late failure from a layer or URL already replaced is
  //   ignored there);
  // - cleared by ScalarMapOverlay whenever that layer's cache is emptied: a
  //   retry (`requestScalarMapTileRetry`, the palette's Refresh), a new tile
  //   URL (slider, location, revision, token), and the layer being deleted
  //   (map hidden, deleted, unlisted, another dataset, disabled, unmount);
  // - pruned here when a re-list or a delete drops the item.
  // So it lives exactly as long as the GeoJS layer whose tiles failed.
  tileFailedMapIds: string[] = [];
  // Bumped by `requestScalarMapTileRetry`; ScalarMapOverlay watches it and
  // resets the tile cache of every layer listed in `tileFailedMapIds`.
  tileRetryRequests = 0;

  get currentMaps(): IScalarMap[] {
    return this.mapsDatasetId !== null &&
      this.mapsDatasetId === (main.dataset?.id ?? null)
      ? this.maps
      : [];
  }

  get hasMaps(): boolean {
    return this.currentMaps.length > 0;
  }

  /** Whether a list for the open dataset has landed (empty or not). */
  get scalarMapsListed(): boolean {
    return (
      this.mapsDatasetId !== null &&
      this.mapsDatasetId === (main.dataset?.id ?? null)
    );
  }

  /** The open dataset's list failure, or null (also for another dataset's). */
  get scalarMapsError(): string | null {
    return this.listErrorDatasetId !== null &&
      this.listErrorDatasetId === (main.dataset?.id ?? null)
      ? this.listError
      : null;
  }

  /**
   * Whether to offer the Map Layers palette (app-bar button and command):
   * with maps, after a failed lookup (so a network blip does not hide the
   * feature), and while the FIRST list for this dataset loads. A re-list of
   * a dataset already known to have no maps does not count, or the button
   * would appear and vanish on every dataset open and finished job.
   */
  get scalarMapsAvailable(): boolean {
    return (
      this.hasMaps ||
      this.scalarMapsError !== null ||
      (this.loading && !this.scalarMapsListed)
    );
  }

  /**
   * Replace the list. Malformed entries are skipped and logged, so one bad
   * map can never throw here and lose the whole list.
   *
   * How each map is shown carries over a re-list of the same dataset:
   * - same item, same `revision`: everything;
   * - same item, new `revision` (its file or any metadata changed): how it
   *   is shown (visible, opacity, colormap); range and threshold are derived
   *   again, since they may not fit the new values;
   * - a worker re-run, which deletes the item and uploads a new one: the
   *   same three settings pass from the dropped item to the new one, when
   *   both share `meta.toolId` and the match is unambiguous (exactly one
   *   dropped and one new item for that tool). Without this, every
   *   iteration (tweak the radius, re-run, look again) came back hidden.
   */
  @Mutation
  setScalarMaps(payload: { datasetId: string; maps: unknown[] }) {
    const sameDataset = payload.datasetId === this.mapsDatasetId;
    const previous = new Map(this.maps.map((map) => [map.itemId, map]));
    const maps: IScalarMap[] = [];
    for (const map of payload.maps) {
      if (isValidScalarMap(map)) {
        maps.push(map);
      } else {
        logWarning("Skipping a malformed saved map:", map);
      }
    }
    const replacedBy = sameDataset
      ? replacementsByTool(this.maps, maps)
      : new Map<string, string>();
    const display: Record<string, IScalarMapDisplay> = {};
    for (const map of maps) {
      const kept = sameDataset
        ? this.display[map.itemId] ??
          this.display[replacedBy.get(map.itemId) ?? ""]
        : undefined;
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
    this.tileFailedMapIds = sameDataset
      ? this.tileFailedMapIds.filter((itemId) => itemId in display)
      : [];
  }

  @Mutation
  setScalarMapsLoading(loading: boolean) {
    this.loading = loading;
  }

  @Mutation
  setScalarMapsError(payload: {
    datasetId: string | null;
    error: string | null;
  }) {
    this.listError = payload.error;
    this.listErrorDatasetId = payload.error === null ? null : payload.datasetId;
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
  setScalarMapDeleting(payload: { itemId: string; deleting: boolean }) {
    const others = this.deletingMapIds.filter((id) => id !== payload.itemId);
    this.deletingMapIds = payload.deleting
      ? [...others, payload.itemId]
      : others;
  }

  @Mutation
  removeScalarMap(itemId: string) {
    this.maps = this.maps.filter((map) => map.itemId !== itemId);
    const display = { ...this.display };
    delete display[itemId];
    this.display = display;
    this.tileFailedMapIds = this.tileFailedMapIds.filter((id) => id !== itemId);
  }

  /** Mark or clear a map's failed tiles (see `tileFailedMapIds`). */
  @Mutation
  setScalarMapTilesFailed(payload: { itemId: string; failed: boolean }) {
    const listed = this.tileFailedMapIds.includes(payload.itemId);
    if (payload.failed && !listed) {
      this.tileFailedMapIds = [...this.tileFailedMapIds, payload.itemId];
    } else if (!payload.failed && listed) {
      this.tileFailedMapIds = this.tileFailedMapIds.filter(
        (id) => id !== payload.itemId,
      );
    }
  }

  /** Ask the overlay to request every failed tile again. */
  @Mutation
  requestScalarMapTileRetry() {
    this.tileRetryRequests++;
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
      this.setScalarMapsError({ datasetId: null, error: null });
      this.setScalarMapsLoading(false);
      return;
    }
    this.setScalarMapsLoading(true);
    // The error is not cleared here: this dataset's failure stays until the
    // answer lands, so the palette stays offered through a retry (a dataset
    // listed with no maps does not count `loading` as available), and
    // another dataset's failure is already hidden by `scalarMapsError`.
    const stillCurrent = () =>
      generation === listRequestGeneration && main.dataset?.id === datasetId;
    const promise = (async () => {
      try {
        const maps = await main.scalarMapAPI.listMaps(datasetId);
        if (stillCurrent()) {
          this.setScalarMaps({ datasetId, maps });
          this.setScalarMapsError({ datasetId, error: null });
        }
      } catch (error) {
        logError("Failed to list the dataset's scalar maps:", error);
        if (stillCurrent()) {
          this.setScalarMapsError({
            datasetId,
            error: "Could not read the dataset's saved maps.",
          });
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

  /**
   * Delete a saved map (WRITE on the item); throws the server's reason. A
   * call for a map whose DELETE is still in flight joins that request (and
   * its outcome) instead of sending another.
   */
  @Action({ rawError: true })
  async deleteScalarMap(itemId: string): Promise<void> {
    const pending = deletesInFlight.get(itemId);
    if (pending) {
      return pending;
    }
    const request = (async () => {
      this.setScalarMapDeleting({ itemId, deleting: true });
      try {
        await main.scalarMapAPI.deleteMap(itemId);
      } finally {
        deletesInFlight.delete(itemId);
        this.setScalarMapDeleting({ itemId, deleting: false });
      }
      // A list response captured before the delete would bring the map
      // back: invalidate it, and list again if one was pending (it may
      // carry a map saved meanwhile).
      const wasListing = listInFlight !== null;
      listRequestGeneration++;
      listInFlight = null;
      this.removeScalarMap(itemId);
      if (wasListing) {
        void this.refreshScalarMaps(true);
      }
    })();
    deletesInFlight.set(itemId, request);
    await request;
  }
}

const scalarMapsStore = getModule(ScalarMaps);
export default scalarMapsStore;

// A burst of jobs (a batch run) finishing together is one list request.
export const SCALAR_MAPS_JOB_REFRESH_DELAY_MS = 1000;

const refreshAfterJobs = debounce(() => {
  void scalarMapsStore.refreshScalarMaps(true);
}, SCALAR_MAPS_JOB_REFRESH_DELAY_MS);

/**
 * List the maps again shortly after a job on the open dataset ends, in ANY
 * terminal state: the worker deletes the previous map before uploading the
 * new one, so a job that fails or is canceled in between has still removed a
 * listed map. Called by jobs.ts. A plain function, not an action: it needs
 * no store name, and a debounce cannot live in the module state.
 */
export function scheduleScalarMapsRefresh(): void {
  refreshAfterJobs();
}
