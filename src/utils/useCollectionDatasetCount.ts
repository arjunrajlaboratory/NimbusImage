import { computed, ref } from "vue";
import store from "@/store";
import { logError } from "@/utils/log";
import { BATCH_DATASET_LIMIT } from "@/store/constants";

export { BATCH_DATASET_LIMIT };

// State + helpers for "Apply to all datasets in collection (N)" checkboxes.
// Callers decide when to (re)fetch: typically on mount, on dialog open, and
// when store.selectedConfigurationId changes.
export function useCollectionDatasetCount() {
  const collectionDatasetCount = ref(0);
  const loadingDatasetCount = ref(false);
  let latestRequest = 0;

  async function fetchCollectionDatasetCount() {
    const request = ++latestRequest;
    const configurationId = store.selectedConfigurationId;
    // Never authorize a batch from the previous configuration while the new
    // count is in flight.
    collectionDatasetCount.value = 0;
    loadingDatasetCount.value = true;
    if (!configurationId) {
      loadingDatasetCount.value = false;
      return;
    }
    try {
      const count = await store.getCollectionDatasetCount(configurationId);
      if (
        request === latestRequest &&
        store.selectedConfigurationId === configurationId
      ) {
        collectionDatasetCount.value = count;
      }
    } catch (error) {
      if (request === latestRequest) {
        logError("Failed to fetch collection dataset count:", error);
        collectionDatasetCount.value = 0;
      }
    } finally {
      if (request === latestRequest) {
        loadingDatasetCount.value = false;
      }
    }
  }

  const canApplyToAllDatasets = computed(
    () =>
      !loadingDatasetCount.value &&
      store.selectedConfigurationId !== null &&
      collectionDatasetCount.value > 1 &&
      collectionDatasetCount.value <= BATCH_DATASET_LIMIT,
  );

  const batchDisabledReason = computed<string | null>(() => {
    if (!store.selectedConfigurationId) {
      return null;
    }
    if (loadingDatasetCount.value) {
      return null;
    }
    if (collectionDatasetCount.value <= 1) {
      return null;
    }
    if (collectionDatasetCount.value > BATCH_DATASET_LIMIT) {
      return `Collection has more than ${BATCH_DATASET_LIMIT} datasets`;
    }
    return null;
  });

  return {
    collectionDatasetCount,
    loadingDatasetCount,
    fetchCollectionDatasetCount,
    canApplyToAllDatasets,
    batchDisabledReason,
  };
}
