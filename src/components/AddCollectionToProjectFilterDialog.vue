<template>
  <v-card>
    <v-card-title>
      <span class="text--secondary">Adding collection to project:</span>
      <span class="text--primary ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text>
      <v-text-field
        v-model="searchQuery"
        label="Search collections..."
        prepend-icon="mdi-magnify"
        clearable
        outlined
        dense
        class="mb-2"
      />

      <v-progress-linear v-if="loading" indeterminate />

      <div
        v-else-if="filteredCollections.length === 0"
        class="text-center pa-4"
      >
        <v-icon size="48" color="grey">mdi-folder-multiple-outline</v-icon>
        <div class="text-body-2 grey--text mt-2">
          {{
            searchQuery
              ? "No collections match your search"
              : "No collections available"
          }}
        </div>
      </div>

      <v-list v-else dense class="collection-list">
        <v-list-item-group v-model="selectedIndices" multiple>
          <v-list-item
            v-for="(collection, index) in filteredCollections"
            :key="collection.id"
            :disabled="isInProject(collection.id)"
          >
            <v-list-item-action>
              <v-checkbox
                :input-value="selectedIndices.includes(index)"
                :disabled="isInProject(collection.id)"
                color="primary"
              />
            </v-list-item-action>
            <v-list-item-content>
              <v-list-item-title>
                {{ collection.name }}
                <v-chip
                  v-if="isInProject(collection.id)"
                  x-small
                  class="ml-2"
                  color="grey"
                >
                  Already in project
                </v-chip>
              </v-list-item-title>
              <v-list-item-subtitle v-if="collection.description">
                {{ collection.description }}
              </v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </v-list-item-group>
      </v-list>
    </v-card-text>
    <v-card-actions>
      <v-btn text @click="$emit('done')">Cancel</v-btn>
      <v-spacer />
      <v-btn
        color="primary"
        :disabled="selectedCollections.length === 0"
        :loading="adding"
        @click="addCollections"
      >
        Add {{ selectedCollections.length }} Collection(s)
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { IProject, IDatasetConfiguration } from "@/store/model";
import store from "@/store";
import projects from "@/store/projects";

const props = defineProps<{
  project: IProject;
}>();

const emit = defineEmits<{
  (e: "done"): void;
  (e: "added", collectionIds: string[]): void;
}>();

const searchQuery = ref("");
const loading = ref(false);
const adding = ref(false);
const allCollections = ref<IDatasetConfiguration[]>([]);
const selectedIndices = ref<number[]>([]);

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
  return selectedIndices.value
    .map((index) => filteredCollections.value[index])
    .filter((c) => c && !isInProject(c.id));
});

function isInProject(collectionId: string): boolean {
  return existingCollectionIds.value.has(collectionId);
}

async function fetchCollections() {
  loading.value = true;
  try {
    allCollections.value = await store.api.getAllConfigurations();
  } finally {
    loading.value = false;
  }
}

async function addCollections() {
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
    selectedIndices.value = [];
  } finally {
    adding.value = false;
  }
}

watch(
  () => props.project,
  () => {
    selectedIndices.value = [];
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
  selectedIndices,
  existingCollectionIds,
  filteredCollections,
  selectedCollections,
  isInProject,
  fetchCollections,
  addCollections,
});
</script>

<style lang="scss" scoped>
.collection-list {
  max-height: 400px;
  overflow-y: auto;
}
</style>
