<template>
  <div class="collection-list-wrapper">
    <!-- Current folder path display -->
    <div class="folder-path-display pa-2 grey lighten-5">
      <div class="d-flex align-center">
        <v-icon class="mr-2" size="20" color="grey darken-2">mdi-folder</v-icon>
        <span class="text-body-2 mr-2" style="color: #424242"
          >Collections in:</span
        >
        <girder-breadcrumb
          v-if="currentFolderLocation"
          :location="currentFolderLocation"
          root-location-disabled
          readonly
          class="folder-breadcrumb"
        />
        <span v-else class="text-body-2" style="color: #424242">{{
          fallbackFolderPath
        }}</span>
      </div>
    </div>

    <div class="d-flex align-center ma-2">
      <v-icon class="mr-2">mdi-magnify</v-icon>
      <div class="flex-grow-1">
        <v-text-field
          v-model="searchQuery"
          placeholder="Search collections..."
          hide-details
          single-line
          dense
          clearable
        />
      </div>
    </div>

    <div class="collection-list-content">
      <v-progress-linear v-if="loading" indeterminate />

      <div
        v-if="!loading && filteredCollections.length === 0"
        class="text-center pa-4"
      >
        <v-icon size="64" color="grey">mdi-file-tree</v-icon>
        <div class="text-h6 grey--text mt-2">No collections found</div>
        <div class="text-body-2 grey--text">
          {{
            searchQuery
              ? "Try adjusting your search terms"
              : "Create your first collection to get started"
          }}
        </div>
      </div>

      <v-list v-else-if="!loading" class="collection-list">
        <v-list-item
          v-for="collection in filteredCollections"
          :key="collection._id"
          @click="navigateToCollection(collection._id)"
          class="collection-item"
          :class="{ 'collection-item-hover': !loading }"
        >
          <v-list-item-avatar>
            <v-icon color="#4baeff" size="24">mdi-file-tree</v-icon>
          </v-list-item-avatar>

          <v-list-item-content>
            <v-list-item-title class="collection-title">
              {{ collection.name }}
            </v-list-item-title>
            <v-list-item-subtitle v-if="collection.description">
              {{ collection.description }}
            </v-list-item-subtitle>

            <collection-item-row
              :collection="collection"
              :debouncedChipsPerItemId="debouncedChipsPerItemId"
              :computedChipsIds="computedChipsIds"
            />
          </v-list-item-content>
        </v-list-item>
      </v-list>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IUPennCollection } from "@/girder";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";
import { formatDateString } from "@/utils/date";
import CollectionItemRow from "./CollectionItemRow.vue";
import { RawLocation } from "vue-router";
import { logError, logWarning } from "@/utils/log";
import { IDatasetView } from "@/store/model";

// Suppress unused import warnings
void GirderBreadcrumb;
void formatDateString;

interface IChipAttrs {
  text: string;
  color: string;
  to?: RawLocation;
}

interface IChipsPerItemId {
  chips: IChipAttrs[];
  type: string;
}

const vm = getCurrentInstance()!.proxy;

const collections = ref<IUPennCollection[]>([]);
const loading = ref(true);
const searchQuery = ref("");

const chipsPerItemId = ref<{ [itemId: string]: IChipsPerItemId }>({});
const debouncedChipsPerItemId = ref<{ [itemId: string]: IChipsPerItemId }>({});
const pendingChips = ref(0);
let lastPendingChip: Promise<any> = Promise.resolve();
const computedChipsIds = ref<Set<string>>(new Set());

const currentFolderLocation = computed(() => {
  const currentFolder = store.folderLocation;
  if (currentFolder && "_id" in currentFolder && "name" in currentFolder) {
    return currentFolder;
  }
  return null;
});

const fallbackFolderPath = computed(() => {
  const currentFolder = store.folderLocation;
  if (!currentFolder) return "Unknown location";
  if ("name" in currentFolder) return currentFolder.name;
  if ("type" in currentFolder) {
    switch (currentFolder.type) {
      case "root":
        return "Root";
      case "users":
        return "Users";
      case "collections":
        return "Collections";
      default:
        return currentFolder.type;
    }
  }
  if ("login" in currentFolder) {
    return `${(currentFolder as any).login}'s folder`;
  }
  return "Current folder";
});

const filteredCollections = computed(() => {
  if (!searchQuery.value) return collections.value;
  const query = searchQuery.value.toLowerCase();
  return collections.value.filter(
    (collection) =>
      collection.name.toLowerCase().includes(query) ||
      (collection.description &&
        collection.description.toLowerCase().includes(query)),
  );
});

async function fetchCollections() {
  loading.value = true;
  try {
    const currentFolder = store.folderLocation;
    let folderId = null;
    if (currentFolder && "_id" in currentFolder) {
      folderId = currentFolder._id;
    } else {
      const privateFolder = await store.api.getUserPrivateFolder();
      if (privateFolder) {
        folderId = privateFolder._id;
      }
    }

    if (!folderId) {
      collections.value = [];
      return;
    }

    let response;
    try {
      response = await store.api.client.get("upenn_collection", {
        params: {
          folderId: folderId,
          limit: 0,
          sort: "updated",
          sortdir: -1,
        },
      });
    } catch (folderError) {
      try {
        response = await store.api.client.get("upenn_collection", {
          params: {
            limit: 0,
            sort: "updated",
            sortdir: -1,
          },
        });
      } catch (noFolderError) {
        throw noFolderError;
      }
    }

    collections.value = response.data.map((item: any) => ({
      ...item,
      _modelType: "upenn_collection" as const,
    }));
  } catch (error) {
    logError("Failed to fetch collections:", error);
    collections.value = [];
  } finally {
    loading.value = false;
  }
}

function navigateToCollection(configurationId: string) {
  vm.$router.push({
    name: "configuration",
    params: { configurationId },
  });
}

function addChipPromise(collection: IUPennCollection) {
  lastPendingChip = lastPendingChip
    .finally()
    .then(() => collectionToChips(collection))
    .then((chipAttrs) => {
      chipsPerItemId.value = {
        ...chipsPerItemId.value,
        [collection._id]: chipAttrs,
      };
    });

  ++pendingChips.value;
  lastPendingChip.finally(() => {
    if (--pendingChips.value === 0) {
      debouncedChipsPerItemId.value = { ...chipsPerItemId.value };
    }
  });
}

function addBulkChipPromise(bulkCollections: IUPennCollection[]) {
  lastPendingChip = lastPendingChip
    .finally()
    .then(() => bulkCollectionsToChips(bulkCollections))
    .then((allChipAttrs) => {
      let updated = { ...chipsPerItemId.value };
      for (const [collectionId, chipAttrs] of Object.entries(allChipAttrs)) {
        updated[collectionId] = chipAttrs;
      }
      chipsPerItemId.value = updated;
    })
    .catch((error) => {
      logError("Error in bulkCollectionsToChips:", error);
    });

  ++pendingChips.value;
  lastPendingChip.finally(() => {
    if (--pendingChips.value === 0) {
      debouncedChipsPerItemId.value = { ...chipsPerItemId.value };
    }
  });
}

async function collectionToChips(collection: IUPennCollection) {
  const ret: IChipAttrs[] = [];

  try {
    const views = await store.api.findDatasetViews({
      configurationId: collection._id,
    });

    if (views.length === 0) {
      return { chips: ret, type: "collection" };
    }

    const datasetIds: string[] = Array.from(
      new Set(views.map((view: IDatasetView) => String(view.datasetId))),
    );

    let folderInfoMap: { [id: string]: any } = {};
    try {
      const batchResponse = await store.api.batchResources({
        folder: datasetIds,
      });
      folderInfoMap = batchResponse.folder || {};
    } catch (error) {
      logError("Failed to batch fetch folder info:", error);
      for (const datasetId of datasetIds as string[]) {
        try {
          const folderInfo = await girderResources.getFolder(datasetId);
          if (folderInfo) {
            folderInfoMap[datasetId] = folderInfo;
          }
        } catch (individualError) {
          logError(`Failed to fetch folder ${datasetId}:`, individualError);
        }
      }
    }

    const datasetChips: IChipAttrs[] = [];
    for (const view of views) {
      const datasetInfo = folderInfoMap[String(view.datasetId)];
      if (!datasetInfo) {
        logWarning(
          `Dataset ${view.datasetId} not found for collection ${collection._id} (may have been deleted)`,
        );
        continue;
      }

      const chip: IChipAttrs = {
        text: datasetInfo.name,
        color: "#e57373",
      };

      chip.to = {
        name: "dataset",
        params: { datasetId: String(view.datasetId) },
      };

      datasetChips.push(chip);
    }

    ret.push(...datasetChips);
  } catch (error) {
    logError(
      "Failed to fetch dataset views for collection:",
      collection._id,
      error,
    );
  }

  return {
    chips: ret,
    type: "collection",
  };
}

async function bulkCollectionsToChips(
  bulkCollections: IUPennCollection[],
): Promise<{ [collectionId: string]: IChipsPerItemId }> {
  const result: { [collectionId: string]: IChipsPerItemId } = {};

  if (bulkCollections.length === 0) return result;

  try {
    const configurationIds = bulkCollections.map((c) => c._id);
    const allViews = await store.api.findDatasetViews({
      configurationIds: configurationIds,
    });

    const viewsByConfigId: { [configId: string]: IDatasetView[] } = {};
    for (const view of allViews) {
      const configId = String(view.configurationId);
      if (!viewsByConfigId[configId]) {
        viewsByConfigId[configId] = [];
      }
      viewsByConfigId[configId].push(view);
    }

    const allDatasetIds: string[] = Array.from(
      new Set(allViews.map((view: IDatasetView) => String(view.datasetId))),
    );

    let folderInfoMap: { [id: string]: any } = {};
    if (allDatasetIds.length > 0) {
      try {
        const batchResponse = await store.api.batchResources({
          folder: allDatasetIds,
        });
        folderInfoMap = batchResponse.folder || {};
      } catch (error) {
        logError("Failed to batch fetch folder info:", error);
        for (const datasetId of allDatasetIds as string[]) {
          try {
            const folderInfo = await girderResources.getFolder(datasetId);
            if (folderInfo) {
              folderInfoMap[datasetId] = folderInfo;
            }
          } catch (individualError) {
            logError(`Failed to fetch folder ${datasetId}:`, individualError);
          }
        }
      }
    }

    for (const collection of bulkCollections) {
      const views = viewsByConfigId[collection._id] || [];
      const chips: IChipAttrs[] = [];

      for (const view of views) {
        const datasetInfo = folderInfoMap[String(view.datasetId)];
        if (!datasetInfo) {
          logWarning(
            `Dataset ${view.datasetId} not found for collection ${collection._id} (may have been deleted)`,
          );
          continue;
        }

        const chip: IChipAttrs = {
          text: datasetInfo.name,
          color: "#e57373",
          to: {
            name: "dataset",
            params: { datasetId: String(view.datasetId) },
          },
        };

        chips.push(chip);
      }

      result[collection._id] = {
        chips,
        type: "collection",
      };
    }
  } catch (error) {
    logError("Failed to bulk fetch dataset views:", error);

    for (const collection of bulkCollections) {
      try {
        result[collection._id] = await collectionToChips(collection);
      } catch (individualError) {
        logError(
          `Failed to process collection ${collection._id}:`,
          individualError,
        );
        result[collection._id] = { chips: [], type: "collection" };
      }
    }
  }

  return result;
}

async function onFilteredCollectionsChange() {
  const collectionsNeedingChips = filteredCollections.value.filter(
    (collection) => !computedChipsIds.value.has(collection._id),
  );

  if (collectionsNeedingChips.length === 0) return;

  collectionsNeedingChips.forEach((collection) => {
    computedChipsIds.value.add(collection._id);
  });

  addBulkChipPromise(collectionsNeedingChips);
}

watch(filteredCollections, () => onFilteredCollectionsChange());

onMounted(async () => {
  await fetchCollections();
});

defineExpose({
  collections,
  loading,
  searchQuery,
  chipsPerItemId,
  debouncedChipsPerItemId,
  pendingChips,
  computedChipsIds,
  currentFolderLocation,
  fallbackFolderPath,
  filteredCollections,
  fetchCollections,
  navigateToCollection,
  addChipPromise,
  addBulkChipPromise,
  collectionToChips,
  bulkCollectionsToChips,
});
</script>

<style lang="scss" scoped>
.collection-list-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.collection-list-content {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.collection-list {
  padding: 0;
}

.collection-item {
  border-bottom: 1px solid #e0e0e0;
  transition: background-color 0.2s;
  cursor: pointer;

  &:hover.collection-item-hover {
    background-color: #f5f5f5;
  }
}

.collection-title {
  font-weight: 500;
  color: #1976d2;
}

.collection-item-hover:hover .collection-title {
  color: #1565c0;
}

.folder-path-display {
  margin-bottom: 4px;
}

.folder-breadcrumb {
  font-size: 14px;
}

.folder-breadcrumb ::v-deep .v-breadcrumbs__item {
  font-size: 14px;
}

.folder-breadcrumb ::v-deep .v-breadcrumbs__divider {
  color: #999;
}

.folder-breadcrumb ::v-deep .v-breadcrumbs__item {
  color: #424242 !important;
}
</style>
