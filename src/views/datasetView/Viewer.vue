<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div class="viewer">
    <div class="viewer-mode-toggle">
      <v-btn-toggle
        v-model="volumeViewMode"
        mandatory
        density="compact"
        variant="outlined"
        color="primary"
      >
        <v-btn value="2d" size="small" title="2D">
          <v-icon size="18">mdi-image-outline</v-icon>
        </v-btn>
        <v-btn value="3d" size="small" title="3D">
          <v-icon size="18">mdi-cube-scan</v-icon>
        </v-btn>
      </v-btn-toggle>
    </div>
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
import { TVolumeViewMode } from "@/store/model";

const shouldResetMaps = ref(false);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);
const volumeViewMode = computed<TVolumeViewMode>({
  get: () => volumeViewStore.viewMode,
  set: (value) => volumeViewStore.setViewMode(value),
});

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

.viewer-mode-toggle {
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 1300;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(18, 24, 30, 0.78);
  backdrop-filter: blur(10px);
}
</style>
