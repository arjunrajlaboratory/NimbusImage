<template>
  <div>
    <v-btn small @click="openNewFilterDialog">Annotation ID filter</v-btn>
    <div class="d-flex flex-column">
      <div
        v-for="filter in filters"
        :key="filter.id"
        class="d-flex justify-space-between align-center"
      >
        <v-simple-checkbox
          class="d-inline ml-2"
          :value="filter.enabled"
          :input-value="filter.enabled"
          @click="toggleEnabled(filter.id)"
        />
        <v-btn text @click="editFilter(filter)">
          {{ filter.id }} ({{ filter.annotationIds.length }} IDs)
        </v-btn>
        <v-btn class="mx-2" icon small @click="removeFilter(filter.id)">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </div>
    </div>

    <v-dialog v-model="dialog" max-width="500px">
      <v-card>
        <v-card-title>
          {{ editingFilter ? "Edit Filter" : "New Annotation List Filter" }}
        </v-card-title>
        <v-card-text>
          <v-textarea
            v-model="annotationIdsInput"
            label="Enter annotation IDs (separated by commas, spaces, or newlines)"
            rows="5"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="dialog = false">Cancel</v-btn>
          <v-btn color="primary" text @click="saveFilter">
            {{ editingFilter ? "Update" : "Add Filter" }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import filterStore from "@/store/filters";
import { IIdAnnotationFilter } from "@/store/model";

const dialog = ref(false);
const annotationIdsInput = ref("");
const editingFilter = ref<IIdAnnotationFilter | null>(null);

const filters = computed(() => filterStore.annotationIdFilters);

function openNewFilterDialog() {
  editingFilter.value = null;
  annotationIdsInput.value = "";
  dialog.value = true;
}

function editFilter(filter: IIdAnnotationFilter) {
  editingFilter.value = filter;
  annotationIdsInput.value = filter.annotationIds.join("\n");
  dialog.value = true;
}

function saveFilter() {
  const annotationIds = annotationIdsInput.value
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (editingFilter.value) {
    filterStore.updateAnnotationIdFilter({
      id: editingFilter.value.id,
      annotationIds: annotationIds,
    });
  } else {
    filterStore.newAnnotationIdFilter(annotationIds);
  }

  dialog.value = false;
  annotationIdsInput.value = "";
  editingFilter.value = null;
}

function removeFilter(id: string) {
  filterStore.removeAnnotationIdFilter(id);
}

function toggleEnabled(id: string) {
  filterStore.toggleAnnotationIdFilterEnabled(id);
}

defineExpose({
  filters,
  dialog,
  annotationIdsInput,
  editingFilter,
  openNewFilterDialog,
  editFilter,
  saveFilter,
  removeFilter,
  toggleEnabled,
});
</script>
