<template>
  <v-dialog v-model="dialog" max-width="500px">
    <template v-slot:activator="{ props: activatorProps }">
      <v-btn v-bind="activatorProps" class="filter-element" size="small">
        Add property value filter
      </v-btn>
    </template>
    <v-card>
      <v-card-title>Filter by properties</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="searchQuery"
          label="Search properties"
          clearable
          density="compact"
          single-line
        />
        <v-list density="compact">
          <v-list-item
            v-for="propertyPath in filteredPropertyPaths"
            :key="propertyPath.join('.')"
          >
              <v-checkbox
                :model-value="isPropertyPathFiltered(propertyPath)"
                @change="togglePropertyPathFiltering(propertyPath)"
                density="compact"
                hide-details
              />
              <v-list-item-title>
                {{ getPropertyFullName(propertyPath) }}
              </v-list-item-title>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="dialog = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";

const dialog = ref(false);
const searchQuery = ref("");

const allPropertyPaths = computed(() => propertyStore.computedPropertyPaths);

const filteredPropertyPaths = computed(() => {
  const query = searchQuery.value.toLowerCase();
  return allPropertyPaths.value.filter((path: string[]) => {
    const fullName = getPropertyFullName(path)?.toLowerCase();
    return !query || (fullName && fullName.includes(query));
  });
});

function getPropertyFullName(path: string[]) {
  return propertyStore.getFullNameFromPath(path);
}

function isPropertyPathFiltered(path: string[]) {
  return filterStore.filterPaths.some(
    (filterPath: string[]) =>
      filterPath.length === path.length &&
      filterPath.every((segment, i) => segment === path[i]),
  );
}

function togglePropertyPathFiltering(path: string[]) {
  filterStore.togglePropertyPathFiltering(path);
}

defineExpose({
  dialog,
  searchQuery,
  allPropertyPaths,
  filteredPropertyPaths,
  getPropertyFullName,
  isPropertyPathFiltered,
  togglePropertyPathFiltering,
});
</script>
