<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div class="viewer">
    <image-viewer
      class="main"
      :should-reset-maps="shouldResetMaps"
      @reset-complete="handleResetComplete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ImageViewer from "@/components/ImageViewer.vue";

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";

const shouldResetMaps = ref(false);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);

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
function fetchAnnotationData() {
  if (dataset.value && configuration.value) {
    annotationStore.fetchAnnotations();
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
  handleResetComplete,
});
</script>

<style lang="scss" scoped>
.viewer {
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
