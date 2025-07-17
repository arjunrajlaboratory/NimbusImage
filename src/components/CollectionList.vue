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

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IUPennCollection } from "@/girder";
import { formatDateString } from "@/utils/date";
import CollectionItemRow from "./CollectionItemRow.vue";
import { RawLocation } from "vue-router";
import { logError, logWarning } from "@/utils/log";
import { IDatasetView } from "@/store/model";

interface IChipAttrs {
  text: string;
  color: string;
  to?: RawLocation;
}

interface IChipsPerItemId {
  chips: IChipAttrs[];
  type: string;
}

@Component({
  components: {
    CollectionItemRow,
    GirderBreadcrumb: () =>
      import("@/girder/components").then((mod) => mod.Breadcrumb),
  },
})
export default class CollectionList extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  collections: IUPennCollection[] = [];
  loading = true;
  searchQuery = "";

  chipsPerItemId: { [itemId: string]: IChipsPerItemId } = {};
  debouncedChipsPerItemId: { [itemId: string]: IChipsPerItemId } = {};
  pendingChips: number = 0;
  lastPendingChip: Promise<any> = Promise.resolve();
  computedChipsIds: Set<string> = new Set();

  formatDateString = formatDateString;

  get currentFolderLocation() {
    const currentFolder = this.store.folderLocation;

    // Return the folder only if it has the properties needed for breadcrumb
    if (currentFolder && "_id" in currentFolder && "name" in currentFolder) {
      return currentFolder;
    }

    return null;
  }

  get fallbackFolderPath() {
    const currentFolder = this.store.folderLocation;

    if (!currentFolder) {
      return "Unknown location";
    }

    // If it's a full folder object with name
    if ("name" in currentFolder) {
      return currentFolder.name;
    }

    // If it's just a type indicator
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

    // If it's a user object
    if ("login" in currentFolder) {
      return `${(currentFolder as any).login}'s folder`;
    }

    return "Current folder";
  }

  async mounted() {
    await this.fetchCollections();
  }

  get filteredCollections() {
    if (!this.searchQuery) {
      return this.collections;
    }

    const query = this.searchQuery.toLowerCase();
    return this.collections.filter(
      (collection) =>
        collection.name.toLowerCase().includes(query) ||
        (collection.description &&
          collection.description.toLowerCase().includes(query)),
    );
  }

  @Watch("filteredCollections")
  async onFilteredCollectionsChange() {
    // Generate chips for filtered collections
    for (const collection of this.filteredCollections) {
      if (!this.computedChipsIds.has(collection._id)) {
        this.computedChipsIds.add(collection._id);
        this.addChipPromise(collection);
      }
    }
  }

  async fetchCollections() {
    this.loading = true;
    try {
      // Use the current folder location from the store
      const currentFolder = this.store.folderLocation;

      // Check if currentFolder is a full folder object with _id, or fallback to user's private folder
      let folderId = null;
      if (currentFolder && "_id" in currentFolder) {
        folderId = currentFolder._id;
      } else {
        // If no current folder with _id, try to get user's private folder
        const privateFolder = await this.store.api.getUserPrivateFolder();
        if (privateFolder) {
          folderId = privateFolder._id;
        }
      }

      if (!folderId) {
        this.collections = [];
        return;
      }

      // First attempt: Try fetching collections with folderId (as per backend API)
      let response;

      try {
        response = await this.store.api.client.get("upenn_collection", {
          params: {
            folderId: folderId,
            limit: 0, // Get all collections
            sort: "updated",
            sortdir: -1,
          },
        });
      } catch (folderError) {
        // Second attempt: Try without folderId
        // TODO: The endpoint currently does not support no folderId, so that should be updated.
        try {
          response = await this.store.api.client.get("upenn_collection", {
            params: {
              limit: 0, // Get all collections
              sort: "updated",
              sortdir: -1,
            },
          });
        } catch (noFolderError) {
          throw noFolderError;
        }
      }

      this.collections = response.data.map((item: any) => ({
        ...item,
        _modelType: "upenn_collection" as const,
      }));
    } catch (error) {
      logError("Failed to fetch collections:", error);
      this.collections = [];
    } finally {
      this.loading = false;
    }
  }

  navigateToCollection(configurationId: string) {
    this.$router.push({
      name: "configuration",
      params: { configurationId },
    });
  }

  addChipPromise(collection: IUPennCollection) {
    // Chain a new chip promise with last pending promise
    this.lastPendingChip = this.lastPendingChip
      .finally()
      .then(() => this.collectionToChips(collection))
      .then((chipAttrs) =>
        Vue.set(this.chipsPerItemId, collection._id, chipAttrs),
      );

    // When done with the last promise, update debouncedChipsPerItemId
    ++this.pendingChips;
    this.lastPendingChip.finally(() => {
      if (--this.pendingChips === 0) {
        this.debouncedChipsPerItemId = { ...this.chipsPerItemId };
      }
    });
  }

  async collectionToChips(collection: IUPennCollection) {
    const ret: IChipAttrs[] = [];

    try {
      // Get all dataset views associated with this collection
      const views = await this.store.api.findDatasetViews({
        configurationId: collection._id,
      });

      // Create chips for each dataset in the collection
      const datasetChips = await Promise.all(
        views.map(async (view: IDatasetView) => {
          try {
            const datasetInfo = await this.girderResources.getFolder(
              view.datasetId,
            );
            if (!datasetInfo) {
              logWarning(
                `Dataset ${view.datasetId} not found for collection ${collection._id} (may have been deleted)`,
              );
              return null;
            }

            const chip: IChipAttrs = {
              text: datasetInfo.name,
              color: "#e57373",
            };

            // Add navigation to dataset
            chip.to = {
              name: "dataset",
              params: { datasetId: view.datasetId },
            };

            return chip;
          } catch (error) {
            logError(
              `Failed to fetch dataset ${view.datasetId} for collection ${collection._id}:`,
              error,
            );
            return null;
          }
        }),
      );

      // Filter out null chips and add to results
      ret.push(
        ...(datasetChips.filter(
          (chip: IChipAttrs | null) => chip !== null,
        ) as IChipAttrs[]),
      );
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
}
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
