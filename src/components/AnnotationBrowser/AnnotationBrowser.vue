<template>
  <annotation-list @clickedTag="clickedTag" />
</template>

<script setup lang="ts">
import AnnotationList from "@/components/AnnotationBrowser/AnnotationList.vue";
import filterStore from "@/store/filters";

function clickedTag(tag: string) {
  filterStore.addTagToTagFilter(tag);
}

defineExpose({ clickedTag });
</script>
