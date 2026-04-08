<template>
  <v-card class="collection-dialog-card">
    <v-card-title class="flex-shrink-0">
      <span class="text-medium-emphasis">Adding collection to project:</span>
      <span class="text-high-emphasis ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text class="collection-dialog-content">
      <!-- Folder chooser -->
      <div class="d-flex align-center pa-2 folder-chooser">
        <v-icon class="mr-2" size="20" color="grey-darken-2">mdi-folder</v-icon>
        <span class="text-body-2 mr-2">Collections in:</span>
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
              size="small"
              class="ml-2"
            >
              <v-icon start size="small">mdi-folder-open</v-icon>
              Change folder
            </v-btn>
          </template>
        </girder-location-chooser>
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
      <v-btn variant="text" @click="$emit('done')">Cancel</v-btn>
      <v-spacer />
      <v-btn
        color="primary"
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
          <v-btn variant="text" @click="showPermissionConfirm = false"
            >Cancel</v-btn
          >
          <v-btn color="primary" @click="addCollections">Continue</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { IProject } from "@/store/model";
import { IGirderLocation, IUPennCollection } from "@/girder";
import store from "@/store";
import projects from "@/store/projects";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";

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
const allCollections = ref<IUPennCollection[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const showPermissionConfirm = ref(false);
const currentFolder = ref<IGirderLocation | null>(null);

const existingCollectionIds = computed<Set<string>>(() => {
  return new Set(props.project.meta.collections.map((c) => c.collectionId));
});

const filteredCollections = computed<IUPennCollection[]>(() => {
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

const selectedCollections = computed<IUPennCollection[]>(() => {
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
  const folder = currentFolder.value;
  let folderId: string | null = null;
  if (folder && "_id" in folder) {
    folderId = folder._id;
  }
  if (!folderId) {
    allCollections.value = [];
    return;
  }

  loading.value = true;
  try {
    const response = await store.api.client.get("upenn_collection", {
      params: {
        folderId,
        limit: 0,
        sort: "updated",
        sortdir: -1,
      },
    });
    allCollections.value = response.data.map((item: any) => ({
      ...item,
      _modelType: "upenn_collection" as const,
    }));
  } catch (error) {
    allCollections.value = [];
  } finally {
    loading.value = false;
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

watch(currentFolder, () => {
  fetchCollections();
});

watch(
  () => props.project,
  () => {
    selectedIds.value = new Set();
  },
);

onMounted(async () => {
  const privateFolder = await store.api.getUserPrivateFolder();
  currentFolder.value = privateFolder || store.girderUser;
});

defineExpose({
  searchQuery,
  loading,
  adding,
  allCollections,
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
