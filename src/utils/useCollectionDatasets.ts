import { ref, computed, watch, Ref } from "vue";
import store from "@/store";
import { IBulkExportDataset } from "@/store/ExportAPI";
import { IDatasetView } from "@/store/model";

/**
 * Composable for loading all datasets in a collection via configuration.
 * Shared between CSV and JSON export dialogs.
 */
export function useCollectionDatasets(
  dialog: Ref<boolean>,
  exportScope: Ref<"current" | "all">,
) {
  const loadingDatasets = ref(false);
  const collectionDatasets = ref<IBulkExportDataset[]>([]);

  const configuration = computed(() => store.configuration);

  const allDatasetsLabel = computed(() => {
    if (loadingDatasets.value) {
      return "All datasets in collection (loading...)";
    }
    if (collectionDatasets.value.length > 0) {
      return `All datasets in collection (${collectionDatasets.value.length})`;
    }
    return "All datasets in collection";
  });

  async function loadCollectionDatasets() {
    if (!configuration.value) return;

    loadingDatasets.value = true;
    collectionDatasets.value = [];

    try {
      const datasetViews = await store.api.findDatasetViews({
        configurationId: configuration.value.id,
      });

      const datasetIds = datasetViews.map((dv: IDatasetView) => dv.datasetId);

      if (datasetIds.length > 0) {
        await store.girderResources.batchFetchResources({
          folderIds: datasetIds,
        });

        collectionDatasets.value = datasetViews.map((dv: IDatasetView) => {
          const folder = store.girderResources.watchFolder(dv.datasetId);
          return {
            datasetId: dv.datasetId,
            datasetName: folder?.name || dv.datasetId,
          };
        });
      }
    } finally {
      loadingDatasets.value = false;
    }
  }

  watch(dialog, (open) => {
    if (open && exportScope.value === "all") {
      loadCollectionDatasets();
    }
  });

  watch(exportScope, (scope) => {
    if (
      scope === "all" &&
      dialog.value &&
      collectionDatasets.value.length === 0
    ) {
      loadCollectionDatasets();
    }
  });

  return {
    loadingDatasets,
    collectionDatasets,
    configuration,
    allDatasetsLabel,
    loadCollectionDatasets,
  };
}
