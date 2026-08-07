<template>
  <div>
    <v-btn
      variant="outlined"
      color="primary"
      size="small"
      @click="addNewFilter"
    >
      Region filter
    </v-btn>
    <v-alert
      v-if="isListServerMode"
      type="warning"
      variant="tonal"
      density="compact"
      class="mt-2"
    >
      This dataset is too large to browse without server-side paging, so region
      filters will not be applied to the annotation list. They still apply to
      the image view.
    </v-alert>
    <div class="d-flex flex-column">
      <div
        v-for="filter in filters"
        :key="filter.id"
        class="d-flex justify-space-between align-center"
      >
        <v-checkbox
          class="d-inline ml-2"
          :model-value="filter.enabled"
          @click="toggleEnabled(filter.id)"
        />
        {{ filter.id }}
        <v-btn
          class="mx-2"
          variant="text"
          icon
          size="small"
          @click="removeFilter(filter.id)"
        >
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import filterStore from "@/store/filters";
import annotationStore from "@/store/annotation";

const filters = computed(() => filterStore.roiFilters);

// The server-paginated list cannot apply ROI filters (a client-side polygon
// test); warn here — where the filters are created — so the user knows before
// relying on one. The filters still apply to the image view (canvas).
const isListServerMode = computed(() => annotationStore.isListServerMode);

function addNewFilter() {
  filterStore.newROIFilter();
}

function removeFilter(id: string) {
  filterStore.removeROIFilter(id);
}

function toggleEnabled(id: string) {
  filterStore.toggleRoiFilterEnabled(id);
}

defineExpose({ filters, addNewFilter, removeFilter, toggleEnabled });
</script>
