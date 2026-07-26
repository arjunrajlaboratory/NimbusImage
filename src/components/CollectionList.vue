<template>
  <div class="collection-list-wrapper">
    <!-- Scope toggle: the folder being browsed, or every folder at once -->
    <div class="folder-path-display pa-2">
      <div class="d-flex align-center flex-wrap ga-2">
        <v-btn-toggle v-model="scope" mandatory density="compact">
          <v-btn value="folder" size="small">
            <v-icon start size="small">mdi-folder</v-icon>
            This folder
          </v-btn>
          <v-btn value="all" size="small">
            <v-icon start size="small">mdi-file-tree</v-icon>
            All collections
          </v-btn>
        </v-btn-toggle>

        <template v-if="scope === 'folder'">
          <span class="text-body-2 text-medium-emphasis">Collections in:</span>
          <girder-breadcrumb
            v-if="currentFolderLocation"
            :location="currentFolderLocation"
            root-location-disabled
            readonly
            class="folder-breadcrumb"
          />
          <span v-else class="text-body-2 text-medium-emphasis">{{
            fallbackFolderPath
          }}</span>
        </template>
        <span v-else class="text-body-2 text-medium-emphasis">
          Every collection you have access to, across all folders
        </span>
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
          density="compact"
          clearable
        />
      </div>
    </div>

    <!-- The server caps a listing request; tell the user when there is more
         than what search and sorting are currently working over. -->
    <v-alert
      v-if="hasMore"
      type="info"
      variant="tonal"
      density="compact"
      class="mx-2 mb-2"
    >
      <div class="d-flex align-center flex-wrap ga-2">
        <span class="text-body-2">
          Showing the {{ collections.length.toLocaleString() }} most recently
          modified collections. Search and sorting only cover what is loaded.
        </span>
        <v-spacer />
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          :loading="loadingMore"
          :disabled="loadingMore"
          @click="loadMore"
        >
          Load {{ COLLECTION_PAGE_SIZE.toLocaleString() }} more
        </v-btn>
      </div>
    </v-alert>

    <div class="collection-list-content">
      <v-progress-linear v-if="loading" indeterminate />

      <div
        v-if="!loading && filteredCollections.length === 0"
        class="text-center pa-4"
      >
        <v-icon size="64" color="secondary">mdi-file-tree</v-icon>
        <div class="text-body-1 font-weight-medium text-medium-emphasis mt-2">
          No collections found
        </div>
        <div class="text-body-2 text-medium-emphasis">
          {{
            searchQuery
              ? "Try adjusting your search terms"
              : "Create your first collection to get started"
          }}
        </div>
      </div>

      <v-data-table
        v-else-if="!loading"
        :items="filteredCollections"
        :headers="tableHeaders"
        item-value="_id"
        density="compact"
        hover
        v-model:sort-by="sortBy"
        v-model:items-per-page="itemsPerPage"
        :items-per-page-options="[10, 25, 50, 100]"
        class="collection-table"
        @update:current-items="onCurrentItemsChange"
        @click:row="onRowClick"
      >
        <template v-slot:item.name="{ item }">
          <div class="d-flex align-center">
            <v-icon color="collection" size="18" class="mr-2"
              >mdi-file-tree</v-icon
            >
            <span class="collection-title">{{ item.name }}</span>
          </div>
        </template>

        <template v-slot:item.description="{ item }">
          <span class="cell-text text-caption text-medium-emphasis">
            {{ item.description }}
          </span>
        </template>

        <template v-slot:item.folderName="{ item }">
          <span class="cell-text text-caption text-medium-emphasis">
            {{ item.folderName || "…" }}
          </span>
        </template>

        <template v-slot:item.datasets="{ item }">
          <collection-dataset-chips
            :collection-id="item._id"
            :chips-per-collection-id="debouncedChipsPerItemId"
          />
        </template>

        <template v-slot:item.updated="{ item }">
          <span class="cell-text text-caption text-no-wrap">{{
            item.updated ? formatDateString(item.updated) : "Unknown"
          }}</span>
        </template>

        <template v-slot:item.created="{ item }">
          <span class="cell-text text-caption text-no-wrap">{{
            item.created ? formatDateString(item.created) : "Unknown"
          }}</span>
        </template>
      </v-data-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import store from "@/store";
import Persister from "@/store/Persister";
import { ICollectionSummary } from "@/girder";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";
import { formatDateString } from "@/utils/date";
import CollectionDatasetChips from "./CollectionDatasetChips.vue";
import {
  collectionsToDatasetChips,
  IChipsPerItemId,
} from "@/utils/collectionChips";
import { logError } from "@/utils/log";

// Suppress unused import warnings
void GirderBreadcrumb;

// Matches MAX_COLLECTION_LIST_LIMIT on the server. Users with more than this
// many collections page through them with the "Load more" button.
const COLLECTION_PAGE_SIZE = 10000;

// How many folder ids to resolve per batchResources request. Bounds the
// response size, since that endpoint returns whole folder documents.
const FOLDER_BATCH_SIZE = 500;

type TCollectionScope = "folder" | "all";

interface ICollectionRow extends ICollectionSummary {
  folderName: string;
}

// Vuetify wraps each row before emitting it from `update:currentItems`. Its own
// emit type is `(value: any) => any`, so nothing here is checked by tsc — this
// interface exists to make the `.raw` hop explicit at the call site.
interface IWrappedDataTableItem {
  raw: ICollectionRow;
}

const router = useRouter();

const scope = ref<TCollectionScope>(
  Persister.get("collectionBrowseScope", "folder") as TCollectionScope,
);
const collections = ref<ICollectionSummary[]>([]);
const folderNames = ref<{ [folderId: string]: string }>({});
const hasMore = ref(false);
const loading = ref(true);
const loadingMore = ref(false);
const searchQuery = ref("");
const sortBy = ref<{ key: string; order: "asc" | "desc" }[]>([
  { key: "updated", order: "desc" },
]);
const itemsPerPage = ref(25);

const chipsPerItemId = ref<{ [itemId: string]: IChipsPerItemId }>({});
const debouncedChipsPerItemId = ref<{ [itemId: string]: IChipsPerItemId }>({});
const requestedChipIds = ref<Set<string>>(new Set());
const pendingChipRequests = ref(0);
let chipQueue: Promise<unknown> = Promise.resolve();

// Bumped on every fetch so a slow response for a scope/folder the user has
// already navigated away from doesn't overwrite the current listing.
let fetchGeneration = 0;
// The folderId the loaded page was fetched with, so "Load more" can page
// without resolving the folder a second time.
let loadedFolderId: string | undefined;

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

const tableHeaders = computed(() => [
  { title: "Name", key: "name", sortable: true },
  { title: "Description", key: "description", sortable: true },
  ...(scope.value === "all"
    ? [{ title: "Folder", key: "folderName", sortable: true }]
    : []),
  { title: "Datasets", key: "datasets", sortable: false },
  { title: "Modified", key: "updated", sortable: true },
  { title: "Created", key: "created", sortable: true },
]);

const collectionRows = computed<ICollectionRow[]>(() =>
  collections.value.map((collection) => ({
    ...collection,
    folderName: folderNames.value[collection.folderId] ?? "",
  })),
);

const filteredCollections = computed(() => {
  if (!searchQuery.value) return collectionRows.value;
  const query = searchQuery.value.toLowerCase();
  return collectionRows.value.filter(
    (collection) =>
      collection.name.toLowerCase().includes(query) ||
      collection.description?.toLowerCase().includes(query) ||
      collection.folderName.toLowerCase().includes(query),
  );
});

// The folder the "This folder" scope lists, falling back to the user's private
// folder when the browser is parked somewhere without an id (root, users, ...).
async function resolveCurrentFolderId(): Promise<string | null> {
  const currentFolder = store.folderLocation;
  if (currentFolder && "_id" in currentFolder) {
    return currentFolder._id;
  }
  return (await store.api.getUserPrivateFolder())?._id ?? null;
}

async function fetchCollections() {
  const generation = ++fetchGeneration;
  loading.value = true;
  try {
    let folderId: string | undefined;
    if (scope.value === "folder") {
      folderId = (await resolveCurrentFolderId()) ?? undefined;
      if (generation !== fetchGeneration) return;
      if (!folderId) {
        collections.value = [];
        hasMore.value = false;
        return;
      }
    }

    const page = await store.api.listCollections({
      folderId,
      limit: COLLECTION_PAGE_SIZE,
    });
    if (generation !== fetchGeneration) return;
    loadedFolderId = folderId;
    collections.value = page.collections;
    hasMore.value = page.hasMore;
    await resolveFolderNames();
  } catch (error) {
    if (generation !== fetchGeneration) return;
    logError("Failed to fetch collections:", error);
    collections.value = [];
    hasMore.value = false;
  } finally {
    if (generation === fetchGeneration) {
      loading.value = false;
    }
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  const generation = fetchGeneration;
  loadingMore.value = true;
  try {
    const page = await store.api.listCollections({
      folderId: loadedFolderId,
      limit: COLLECTION_PAGE_SIZE,
      offset: collections.value.length,
    });
    if (generation !== fetchGeneration) return;
    collections.value = [...collections.value, ...page.collections];
    hasMore.value = page.hasMore;
    await resolveFolderNames();
  } catch (error) {
    if (generation !== fetchGeneration) return;
    logError("Failed to load more collections:", error);
  } finally {
    loadingMore.value = false;
  }
}

// The Folder column needs names, and sorting and searching on it need them for
// every loaded row rather than just the visible page. Only the all-folders
// scope renders that column, so folder-scope listings skip the work entirely.
async function resolveFolderNames() {
  if (scope.value !== "all") return;

  const unresolvedIds = Array.from(
    new Set(
      collections.value
        .map((collection) => collection.folderId)
        .filter((folderId) => folderId && !(folderId in folderNames.value)),
    ),
  );
  if (unresolvedIds.length === 0) return;

  // batchResources returns whole folder documents, so a user whose
  // collections each live in their own dataset folder would otherwise pull
  // thousands of them in a single response. Chunk the ids instead: still one
  // query per request on the backend, just bounded in size.
  try {
    const resolved = { ...folderNames.value };
    for (let i = 0; i < unresolvedIds.length; i += FOLDER_BATCH_SIZE) {
      const batchIds = unresolvedIds.slice(i, i + FOLDER_BATCH_SIZE);
      const folders =
        (await store.api.batchResources({ folder: batchIds })).folder ?? {};
      for (const folderId of batchIds) {
        resolved[folderId] = folders[folderId]?.name ?? "Unknown folder";
      }
    }
    folderNames.value = resolved;
  } catch (error) {
    logError("Failed to resolve collection folder names:", error);
  }
}

// Dataset chips are resolved for the rows the table is actually showing, so a
// listing of thousands of collections doesn't fan out into thousands of
// dataset lookups up front.
//
// `update:currentItems` emits Vuetify's INTERNAL wrapped items, not the rows we
// passed in: the row is under `.raw`. (VDataTable.js draws the same distinction
// between `items: …map(i => i.raw)` and `internalItems`.) Reading `item._id`
// here yields `undefined` for every row, so nothing ever resolves. Note the
// asymmetry with `onRowClick` below, whose payload IS the raw row.
function onCurrentItemsChange(items: IWrappedDataTableItem[]) {
  const collectionIds = items
    .map((item) => item.raw._id)
    .filter((collectionId) => !requestedChipIds.value.has(collectionId));
  if (collectionIds.length === 0) return;

  collectionIds.forEach((collectionId) =>
    requestedChipIds.value.add(collectionId),
  );

  ++pendingChipRequests.value;
  // The catch terminates the chain so it can never settle rejected: a link
  // that rejected with no later page change would otherwise sit unhandled
  // until the next call happened to attach a handler to it.
  chipQueue = chipQueue
    .then(() => collectionsToDatasetChips(collectionIds))
    .then((chipsById) => {
      chipsPerItemId.value = { ...chipsPerItemId.value, ...chipsById };
    })
    .catch((error) => {
      // Release the ids again, otherwise one failed burst leaves those rows on
      // "Loading datasets..." for the lifetime of the component: they stay
      // marked as requested, so paging back to them never retries.
      collectionIds.forEach((collectionId) =>
        requestedChipIds.value.delete(collectionId),
      );
      logError("Failed to resolve dataset chips:", error);
    })
    .finally(() => {
      // Publish once the whole burst has settled, so rows don't pop in one by
      // one while the user is scanning the page.
      if (--pendingChipRequests.value === 0) {
        debouncedChipsPerItemId.value = { ...chipsPerItemId.value };
      }
    });
}

function onRowClick(_event: Event, { item }: { item: ICollectionRow }) {
  navigateToCollection(item._id);
}

function navigateToCollection(configurationId: string) {
  router.push({
    name: "configuration",
    params: { configurationId },
  });
}

watch(scope, (newScope) => {
  Persister.set("collectionBrowseScope", newScope);
  fetchCollections();
});

watch(
  () => store.folderLocation,
  () => {
    if (scope.value === "folder") {
      fetchCollections();
    }
  },
);

onMounted(async () => {
  await fetchCollections();
});

defineExpose({
  COLLECTION_PAGE_SIZE,
  scope,
  collections,
  folderNames,
  collectionRows,
  hasMore,
  loading,
  loadingMore,
  searchQuery,
  sortBy,
  itemsPerPage,
  tableHeaders,
  chipsPerItemId,
  debouncedChipsPerItemId,
  requestedChipIds,
  pendingChipRequests,
  currentFolderLocation,
  fallbackFolderPath,
  filteredCollections,
  fetchCollections,
  loadMore,
  resolveFolderNames,
  onCurrentItemsChange,
  onRowClick,
  navigateToCollection,
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

.collection-table :deep(tbody tr) {
  cursor: pointer;
}

.collection-title {
  font-weight: 500;
  color: rgb(var(--v-theme-collection));
}

/* AnnotationBrowser/AnnotationList.vue ships an UNLAYERED, non-scoped
   `td span { display: block; text-align: center; margin: auto; }`, which leaks
   into every table in the app and centers these cells under their left-aligned
   headers. Vuetify 4 puts its utilities in a cascade layer and unlayered rules
   beat layered ones outright, so `text-left`/`ma-0` utilities cannot undo it —
   these scoped rules can, being unlayered themselves. The chips column is
   handled the same way inside CollectionDatasetChips.vue. */
.collection-title,
.cell-text {
  text-align: left;
  margin: 0;
}

.folder-path-display {
  margin-bottom: 4px;
  background: var(--nimbus-glass);
  border-radius: var(--nimbus-radius-sm);
}

.folder-breadcrumb {
  font-size: 14px;
}

.folder-breadcrumb :deep(.v-breadcrumbs__item) {
  font-size: 14px;
  color: var(--nimbus-text-secondary);
}

.folder-breadcrumb :deep(.v-breadcrumbs__divider) {
  color: var(--nimbus-text-faint);
}
</style>
