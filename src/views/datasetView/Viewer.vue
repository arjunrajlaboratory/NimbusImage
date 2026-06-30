<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div class="viewer">
    <image-viewer
      v-if="volumeViewMode === '2d'"
      class="main"
      :should-reset-maps="shouldResetMaps"
      @reset-complete="handleResetComplete"
    />
    <volume-viewer v-else class="main" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ImageViewer from "@/components/ImageViewer.vue";
import VolumeViewer from "@/components/VolumeViewer.vue";

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import volumeViewStore from "@/store/volumeView";

const shouldResetMaps = ref(false);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);
// Read-only: the 2D/3D toggle lives in the top app bar (App.vue).
const volumeViewMode = computed(() => volumeViewStore.viewMode);

function datasetChanged() {
  if (dataset.value && dataset.value.time.length <= 1) {
    store.setShowTimelapseMode(false);
  }
}

function configurationChanged() {
  propertiesStore.fetchProperties();
}

// Fetch annotations whenever dataset or configuration changes, but only when
// both are loaded. This avoids a race condition where the dataset watcher fires
// before the configuration has finished loading, causing fetchAnnotations to
// bail out early due to the missing configuration guard check.
async function fetchAnnotationData() {
  if (dataset.value && configuration.value) {
    // Await fetchAnnotations first: it determines stub-only (lazy) mode, which
    // fetchPropertyValues reads to decide between viewport-scoped lazy loading
    // and the wholesale load. Without the await, the property fetch races ahead
    // while stubOnlyMode is still false and loads every value into memory.
    await annotationStore.fetchAnnotations();
    propertiesStore.fetchPropertyValues();
  }
}

function handleResetComplete() {
  shouldResetMaps.value = false;
}

watch(dataset, datasetChanged);
watch(configuration, configurationChanged);
watch([dataset, configuration], fetchAnnotationData);

onMounted(() => {
  datasetChanged();
  configurationChanged();
  fetchAnnotationData();
});

defineExpose({
  shouldResetMaps,
  dataset,
  configuration,
  volumeViewMode,
  handleResetComplete,
});
</script>

<style lang="scss" scoped>
.viewer {
  position: relative;
  width: 100%;
  /* Fill the viewport — the glass app bar floats over the full-bleed image
     canvas; the tool palettes float over it rather than pushing it. */
  height: 100vh;
  display: flex;
}

.main {
  flex: 1 1 0;
}
</style>
