<template>
  <v-card class="ma-1">
    <v-card-title> Object Browser </v-card-title>
    <v-card-text class="pa-1">
      <v-expansion-panels hover multiple v-model="expanded">
        <annotation-filters></annotation-filters>
        <annotation-actions></annotation-actions>
        <annotation-properties
          @expand="expandProperties"
        ></annotation-properties>
        <annotation-list @clickedTag="clickedTag"></annotation-list>
      </v-expansion-panels>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from "vue";
import AnnotationFilters from "@/components/AnnotationBrowser/AnnotationFilters.vue";
import AnnotationList from "@/components/AnnotationBrowser/AnnotationList.vue";
import AnnotationActions from "@/components/AnnotationBrowser/AnnotationActions.vue";
import AnnotationProperties from "@/components/AnnotationBrowser/AnnotationProperties.vue";
import filterStore from "@/store/filters";

const expanded = ref<number[]>([2]);

function clickedTag(tag: string) {
  filterStore.addTagToTagFilter(tag);
}

function expandProperties() {
  if (!expanded.value.includes(1)) {
    expanded.value.push(1);
  }
}

defineExpose({ expanded, clickedTag, expandProperties });
</script>
