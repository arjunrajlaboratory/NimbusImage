<template>
  <div class="annotation-browser">
    <v-tabs v-model="activeTab" density="compact" class="browser-tabs">
      <v-tab value="objects">
        Objects
        <v-chip v-if="objectCount > 0" size="x-small" class="ml-2">
          {{ objectCount.toLocaleString() }}
        </v-chip>
      </v-tab>
      <v-tab value="connections">
        Connections
        <v-chip v-if="connectionCount > 0" size="x-small" class="ml-2">
          {{ connectionCount.toLocaleString() }}
        </v-chip>
      </v-tab>
    </v-tabs>
    <!-- Both tabs stay mounted: the Objects list holds page/scroll/sort state
         that is expensive to rebuild, and the Connections tab is cheap. -->
    <v-window v-model="activeTab" class="browser-window">
      <v-window-item value="objects" class="browser-window-item">
        <annotation-list @clickedTag="clickedTag" />
      </v-window-item>
      <v-window-item value="connections" class="browser-window-item">
        <!-- is-active drives the reveal-on-show retry: this component mounts
             lazily on first activation and is hidden (not unmounted) after, so
             a viewer click made while the tab was never opened — or while it
             was hidden and unlaid-out — must be re-revealed when it shows. -->
        <connection-list
          :is-active="activeTab === 'connections'"
          @clickedTag="clickedTag"
        />
      </v-window-item>
    </v-window>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import AnnotationList from "@/components/AnnotationBrowser/AnnotationList.vue";
import ConnectionList from "@/components/AnnotationBrowser/ConnectionList.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import filterStore from "@/store/filters";
import { TAnnotationBrowserTab } from "@/store/model";

// In the store rather than a local ref so other panels can route here — the
// Timelapse panel's "Show tracks" opens the browser AND picks this tab.
const activeTab = computed({
  get: () => store.annotationBrowserTab,
  set: (value: TAnnotationBrowserTab) => store.setAnnotationBrowserTab(value),
});

// Both badges are dataset-wide totals, not the scoped/filtered counts shown
// inside each tab — they answer "does this dataset have any?" at a glance.
const objectCount = computed(() => annotationStore.annotationCount);
const connectionCount = computed(
  () => annotationStore.annotationConnections.length,
);

function clickedTag(tag: string) {
  filterStore.addTagToTagFilter(tag);
}

defineExpose({ clickedTag, activeTab, connectionCount, objectCount });
</script>

<style lang="scss" scoped>
.annotation-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.browser-tabs {
  flex: 0 0 auto;
}

.browser-window {
  flex: 1 1 auto;
  min-height: 0;
}

.browser-window-item {
  height: 100%;
}
</style>
