<template>
  <div>
    <v-btn small @click="addNewFilter"> Region filter </v-btn>
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
        {{ filter.id }}
        <v-btn class="mx-2" icon small @click="removeFilter(filter.id)">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import filterStore from "@/store/filters";

const filters = computed(() => filterStore.roiFilters);

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
