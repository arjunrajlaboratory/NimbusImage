<template>
  <v-container class="filter-main-container">
    <tag-filter-editor
      class="filter-element"
      v-model="tagFilter"
      style="flex-basis: content"
    />
    <v-switch
      class="filter-element"
      label="Current frame only"
      v-model="onlyCurrentFrame"
      dense
      hide-details
    />
    <v-switch
      class="filter-element"
      label="Show annotations from hidden layers"
      v-model="showAnnotationsFromHiddenLayers"
      dense
      hide-details
    />
    <property-filter-selector class="filter-element" />
    <property-filter-histogram
      v-for="(propertyPath, idx) in propertyPaths"
      :key="'property ' + idx"
      :propertyPath="propertyPath"
    />
    <annotation-id-filters class="filter-element" />
    <roi-filters class="filter-element" />
  </v-container>
</template>

<script setup lang="ts">
import { computed } from "vue";
import filterStore from "@/store/filters";
import store from "@/store";
import { ITagAnnotationFilter } from "@/store/model";
import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import PropertyFilterHistogram from "@/components/AnnotationBrowser/AnnotationProperties/PropertyFilterHistogram.vue";
import RoiFilters from "@/components/AnnotationBrowser/ROIFilters.vue";
import AnnotationIdFilters from "@/components/AnnotationBrowser/AnnotationIdFilters.vue";
import PropertyFilterSelector from "@/components/AnnotationBrowser/PropertyFilterSelector.vue";

defineProps<{
  additionalTags?: string[];
}>();

const tagFilter = computed({
  get() {
    return filterStore.tagFilter;
  },
  set(filter: ITagAnnotationFilter) {
    filterStore.setTagFilter(filter);
  },
});

const onlyCurrentFrame = computed({
  get() {
    return filterStore.onlyCurrentFrame;
  },
  set(value: boolean) {
    filterStore.setOnlyCurrentFrame(value);
  },
});

const propertyPaths = computed(() => filterStore.filterPaths);

const showAnnotationsFromHiddenLayers = computed({
  get() {
    return store.showAnnotationsFromHiddenLayers;
  },
  set(value: boolean) {
    store.setShowAnnotationsFromHiddenLayers(value);
  },
});

defineExpose({
  tagFilter,
  onlyCurrentFrame,
  propertyPaths,
  showAnnotationsFromHiddenLayers,
});
</script>

<style lang="scss">
.filter-main-container {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  justify-content: space-between;
}

.filter-main-container .v-text-field {
  margin: 0;
}

.filter-element {
  display: flex;
  align-items: center;
  align-content: center;
  flex: 1;
  max-width: fit-content;
  margin-top: 12px;
  margin-bottom: 12px;
  margin-left: 10px;
  margin-right: 10px;
}

#shape-filter .v-select__slot {
  max-width: 70px;
}
</style>
