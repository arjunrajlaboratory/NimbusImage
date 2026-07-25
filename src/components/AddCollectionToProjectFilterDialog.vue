<template>
  <v-card class="collection-dialog-card">
    <v-card-title class="flex-shrink-0">
      <span class="text-medium-emphasis">Adding collection to project:</span>
      <span class="text-high-emphasis ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text class="collection-dialog-content">
      <!-- Scope toggle and, when browsing one folder, its chooser -->
      <div class="d-flex align-center flex-wrap ga-2 pa-2 folder-chooser">
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
          <span class="text-body-2">Collections in:</span>
          <girder-breadcrumb
            v-if="currentFolder"
            :location="currentFolder"
            root-location-disabled
            readonly
            class="folder-breadcrumb"
          />
          <span v-else class="text-body-2 text-grey">Loading...</span>
          <v-spacer />
          <girder-location-chooser
            v-model="currentFolder"
            title="Choose a folder"
            :breadcrumb="false"
            :activator-disabled="false"
          >
            <template #activator="{ props: activatorProps }">
              <v-btn
                v-bind="activatorProps"
                variant="outlined"
                color="primary"
                size="small"
                class="ml-2"
              >
                <v-icon start size="small">mdi-folder-open</v-icon>
                Change folder
              </v-btn>
            </template>
          </girder-location-chooser>
        </template>
        <span v-else class="text-body-2 text-medium-emphasis">
          Every collection you have access to, across all folders
        </span>
      </div>

      <!-- Search -->
      <v-text-field
        v-model="searchQuery"
        label="Search collections..."
        prepend-icon="mdi-magnify"
        clearable
        variant="outlined"
        density="compact"
        class="mb-2 mx-2"
      />

      <v-alert
        v-if="hasMore"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-2 mx-2"
      >
        Showing the {{ allCollections.length.toLocaleString() }} most recently
        modified collections; search only covers these. Narrow the scope to a
        folder to find older ones.
      </v-alert>

      <v-progress-linear v-if="loading" indeterminate />

      <div
        v-else-if="filteredCollections.length === 0"
        class="text-center pa-4"
      >
        <v-icon size="48" color="grey">mdi-folder-multiple-outline</v-icon>
        <div class="text-body-2 text-grey mt-2">
          {{
            searchQuery
              ? "No collections match your search"
              : scope === "all"
                ? "You don't have access to any collections yet"
                : "No collections in this folder"
          }}
        </div>
      </div>

      <v-list v-else density="compact" class="collection-list">
        <v-list-item
          v-for="collection in filteredCollections"
          :key="collection._id"
          :disabled="isInProject(collection._id)"
          @click="toggleSelection(collection._id)"
        >
          <template #prepend>
            <v-checkbox
              :model-value="selectedIds.has(collection._id)"
              :disabled="isInProject(collection._id)"
              color="primary"
              density="compact"
              hide-details
              @update:model-value="toggleSelection(collection._id)"
              @click.stop
            />
          </template>
          <v-list-item-title>
            {{ collection.name }}
            <v-chip
              v-if="isInProject(collection._id)"
              size="x-small"
              class="ml-2"
              color="grey"
            >
              Already in project
            </v-chip>
          </v-list-item-title>
          <v-list-item-subtitle v-if="collection.description">
            {{ collection.description }}
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
    </v-card-text>
    <v-card-actions class="ma-2">
      <v-btn variant="text" size="small" @click="$emit('done')">Cancel</v-btn>
      <v-spacer />
      <v-btn
        variant="flat"
        color="primary"
        size="small"
        :disabled="selectedCollections.length === 0"
        :loading="adding"
        @click="confirmAdd"
      >
        Add {{ selectedCollections.length }} Collection(s)
      </v-btn>
    </v-card-actions>

    <!-- Permission propagation confirmation -->
    <v-dialog v-model="showPermissionConfirm" max-width="500" persistent>
      <v-card>
        <v-card-title>Update collection permissions?</v-card-title>
        <v-card-text>
          This project is
          <template v-if="isPublic">
            <strong>public</strong>
          </template>
          <template v-else> <strong>shared with other users</strong> </template
          >. Adding {{ selectedCollections.length }} collection(s) will update
          their permissions to match the project's access settings.
        </v-card-text>
        <v-card-actions class="justify-end" style="gap: 8px">
          <v-btn
            variant="text"
            size="small"
            @click="showPermissionConfirm = false"
            >Cancel</v-btn
          >
          <v-btn
            variant="flat"
            color="primary"
            size="small"
            @click="addCollections"
            >Continue</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { IProject } from "@/store/model";
import { ICollectionSummary, IGirderLocation } from "@/girder";
import store from "@/store";
import projects from "@/store/projects";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { logError } from "@/utils/log";

// Suppress unused import warning
void GirderBreadcrumb;

const props = defineProps<{
  project: IProject;
  isShared?: boolean;
  isPublic?: boolean;
}>();

const emit = defineEmits<{
  (e: "done"): void;
  (e: "added", collectionIds: string[]): void;
}>();

const searchQuery = ref("");
const loading = ref(false);
const adding = ref(false);
const scope = ref<"folder" | "all">("folder");
const allCollections = ref<ICollectionSummary[]>([]);
const hasMore = ref(false);
const selectedIds = ref<Set<string>>(new Set());
const showPermissionConfirm = ref(false);
const currentFolder = ref<IGirderLocation | null>(null);
let fetchGeneration = 0;

const existingCollectionIds = computed<Set<string>>(() => {
  return new Set(props.project.meta.collections.map((c) => c.collectionId));
});

const filteredCollections = computed<ICollectionSummary[]>(() => {
  if (!searchQuery.value) {
    return allCollections.value;
  }
  const query = searchQuery.value.toLowerCase();
  return allCollections.value.filter(
    (c) =>
      c.name.toLowerCase().includes(query) ||
      (c.description && c.description.toLowerCase().includes(query)),
  );
});

const selectedCollections = computed<ICollectionSummary[]>(() => {
  return allCollections.value.filter(
    (c) => selectedIds.value.has(c._id) && !isInProject(c._id),
  );
});

function isInProject(collectionId: string): boolean {
  return existingCollectionIds.value.has(collectionId);
}

function toggleSelection(collectionId: string) {
  if (isInProject(collectionId)) return;
  const next = new Set(selectedIds.value);
  if (next.has(collectionId)) {
    next.delete(collectionId);
  } else {
    next.add(collectionId);
  }
  selectedIds.value = next;
}

async function fetchCollections() {
  let folderId: string | undefined;
  if (scope.value === "folder") {
    const folder = currentFolder.value;
    folderId = folder && "_id" in folder ? folder._id : undefined;
    if (!folderId) {
      allCollections.value = [];
      hasMore.value = false;
      return;
    }
  }

  const generation = ++fetchGeneration;
  loading.value = true;
  try {
    const page = await store.api.listCollections({ folderId });
    if (generation !== fetchGeneration) return;
    allCollections.value = page.collections;
    hasMore.value = page.hasMore;
  } catch (error) {
    if (generation !== fetchGeneration) return;
    logError("Failed to fetch collections:", error);
    allCollections.value = [];
    hasMore.value = false;
  } finally {
    if (generation === fetchGeneration) {
      loading.value = false;
    }
  }
}

function confirmAdd() {
  if (selectedCollections.value.length === 0) return;
  if (props.isShared || props.isPublic) {
    showPermissionConfirm.value = true;
  } else {
    addCollections();
  }
}

async function addCollections() {
  showPermissionConfirm.value = false;
  if (selectedCollections.value.length === 0) return;

  adding.value = true;
  try {
    for (const collection of selectedCollections.value) {
      await projects.addCollectionToProject({
        projectId: props.project.id,
        collectionId: collection._id,
      });
    }
    emit(
      "added",
      selectedCollections.value.map((c) => c._id),
    );
    selectedIds.value = new Set();
  } finally {
    adding.value = false;
  }
}

watch([currentFolder, scope], () => {
  fetchCollections();
});

watch(
  () => props.project,
  () => {
    selectedIds.value = new Set();
  },
);

onMounted(async () => {
  try {
    const privateFolder = await store.api.getUserPrivateFolder();
    currentFolder.value = privateFolder || store.girderUser;
  } catch {
    currentFolder.value = store.girderUser;
  }
});

defineExpose({
  searchQuery,
  loading,
  adding,
  scope,
  allCollections,
  hasMore,
  selectedIds,
  showPermissionConfirm,
  currentFolder,
  existingCollectionIds,
  filteredCollections,
  selectedCollections,
  isInProject,
  toggleSelection,
  fetchCollections,
  confirmAdd,
  addCollections,
});
</script>

<style lang="scss" scoped>
.collection-dialog-card {
  display: flex;
  flex-direction: column;
  height: 85vh;
  max-height: 800px;
  overflow: hidden;
}

.collection-dialog-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 0;
}

.folder-chooser {
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}

.folder-breadcrumb {
  font-size: 14px;
}

.collection-list {
  max-height: 100%;
  overflow-y: auto;
}
</style>
