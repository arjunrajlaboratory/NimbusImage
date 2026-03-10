<template>
  <v-card>
    <v-card-title>
      <span class="text-medium-emphasis">Adding collection to project:</span>
      <span class="text-high-emphasis ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text>
      <v-text-field
        v-model="searchQuery"
        label="Search collections..."
        prepend-icon="mdi-magnify"
        clearable
        variant="outlined"
        density="compact"
        class="mb-2"
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
              : "No collections available"
          }}
        </div>
      </div>

      <v-list v-else density="compact" class="collection-list">
        <v-list-item
          v-for="collection in filteredCollections"
          :key="collection.id"
          :disabled="isInProject(collection.id)"
          @click="toggleSelection(collection.id)"
        >
          <template #prepend>
            <v-checkbox
              :model-value="selectedIds.has(collection.id)"
              :disabled="isInProject(collection.id)"
              color="primary"
              density="compact"
              hide-details
              @update:model-value="toggleSelection(collection.id)"
              @click.stop
            />
          </template>
          <v-list-item-title>
            {{ collection.name }}
            <v-chip
              v-if="isInProject(collection.id)"
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
    <v-card-actions>
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
import { IProject, IDatasetConfiguration } from "@/store/model";
import store from "@/store";
import projects from "@/store/projects";

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
const allCollections = ref<IDatasetConfiguration[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const showPermissionConfirm = ref(false);

const existingCollectionIds = computed<Set<string>>(() => {
  return new Set(props.project.meta.collections.map((c) => c.collectionId));
});

const filteredCollections = computed<IDatasetConfiguration[]>(() => {
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

const selectedCollections = computed<IDatasetConfiguration[]>(() => {
  return allCollections.value.filter(
    (c) => selectedIds.value.has(c.id) && !isInProject(c.id),
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
  loading.value = true;
  try {
    allCollections.value = await store.api.getAllConfigurations();
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
        collectionId: collection.id,
      });
    }
    emit(
      "added",
      selectedCollections.value.map((c) => c.id),
    );
    selectedIds.value = new Set();
  } finally {
    adding.value = false;
  }
}

watch(
  () => props.project,
  () => {
    selectedIds.value = new Set();
  },
);

onMounted(() => {
  fetchCollections();
});

defineExpose({
  searchQuery,
  loading,
  adding,
  allCollections,
  selectedIds,
  showPermissionConfirm,
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
.collection-list {
  max-height: 400px;
  overflow-y: auto;
}
</style>
