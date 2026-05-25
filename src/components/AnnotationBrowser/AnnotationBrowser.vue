<template>
  <v-card class="ma-1">
    <v-card-text class="pa-1">
      <v-expansion-panels hover multiple v-model="expanded">
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
import AnnotationList from "@/components/AnnotationBrowser/AnnotationList.vue";
import AnnotationActions from "@/components/AnnotationBrowser/AnnotationActions.vue";
import AnnotationProperties from "@/components/AnnotationBrowser/AnnotationProperties.vue";
import filterStore from "@/store/filters";

const expanded = ref<number[]>([1]);

function clickedTag(tag: string) {
  filterStore.addTagToTagFilter(tag);
}

function expandProperties() {
  if (!expanded.value.includes(0)) {
    expanded.value.push(0);
  }
}

defineExpose({ expanded, clickedTag, expandProperties });
</script>
