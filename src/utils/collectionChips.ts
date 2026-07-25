import type { RouteLocationRaw } from "vue-router";
import store from "@/store";
import { IDatasetView } from "@/store/model";
import { logError, logWarning } from "@/utils/log";

export interface IChipAttrs {
  text: string;
  color: string;
  to?: RouteLocationRaw;
}

export interface IChipsPerItemId {
  chips: IChipAttrs[];
  type: string;
}

/**
 * Resolve the datasets attached to each of the given collections into chips
 * suitable for CollectionDatasetChips.vue.
 *
 * Costs two batch requests in total no matter how many collections are passed,
 * so callers should hand over a whole page of collections at once rather than
 * calling this per row.
 */
export async function collectionsToDatasetChips(
  collectionIds: string[],
): Promise<{ [collectionId: string]: IChipsPerItemId }> {
  const chipsByCollectionId: { [collectionId: string]: IChipsPerItemId } = {};
  if (collectionIds.length === 0) {
    return chipsByCollectionId;
  }
  // Seed every requested collection so the caller can tell "resolved, but has
  // no datasets" apart from "not resolved yet", even if a request fails.
  for (const collectionId of collectionIds) {
    chipsByCollectionId[collectionId] = { chips: [], type: "collection" };
  }

  try {
    const views: IDatasetView[] = await store.api.findDatasetViews({
      configurationIds: collectionIds,
    });

    const datasetIds = Array.from(
      new Set(views.map((view) => String(view.datasetId))),
    );
    const datasetsById = datasetIds.length
      ? (await store.api.batchResources({ folder: datasetIds })).folder ?? {}
      : {};

    for (const view of views) {
      const datasetId = String(view.datasetId);
      const collectionId = String(view.configurationId);
      const dataset = datasetsById[datasetId];
      if (!dataset) {
        logWarning(
          `Dataset ${datasetId} not found for collection ${collectionId} (may have been deleted)`,
        );
        continue;
      }
      chipsByCollectionId[collectionId]?.chips.push({
        text: dataset.name,
        color: "dataset",
        to: { name: "dataset", params: { datasetId } },
      });
    }
  } catch (error) {
    logError("Failed to resolve dataset chips for collections:", error);
  }

  return chipsByCollectionId;
}
