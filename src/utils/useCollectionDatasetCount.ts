import { computed, ref } from "vue";
import store from "@/store";
import { logError } from "@/utils/log";

// Guard against accidental server overload when applying an operation to every
// dataset in a collection. Shared by the property-compute dialog, the worker
// menu, and the pipeline run panel.
export const BATCH_DATASET_LIMIT = 50;

// State + helpers for "Apply to all datasets in collection (N)" checkboxes.
// Callers decide when to (re)fetch: typically on mount, on dialog open, and
// when store.selectedConfigurationId changes.
export function useCollectionDatasetCount() {
  const collectionDatasetCount = ref(0);
  const loadingDatasetCount = ref(false);

  async function fetchCollectionDatasetCount() {
    loadingDatasetCount.value = true;
    try {
      collectionDatasetCount.value = await store.getCollectionDatasetCount();
    } catch (error) {
      logError("Failed to fetch collection dataset count:", error);
      collectionDatasetCount.value = 0;
    } finally {
      loadingDatasetCount.value = false;
    }
  }

  const canApplyToAllDatasets = computed(
    () =>
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
