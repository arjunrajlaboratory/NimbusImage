<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div class="viewer">
    <aside class="side">
      <viewer-toolbar class="toolbar" @image-changed="handleImageChanged">
        <display-layers />
      </viewer-toolbar>
    </aside>
    <image-viewer
      class="main"
      :should-reset-maps="shouldResetMaps"
      @reset-complete="handleResetComplete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ViewerToolbar from "@/components/ViewerToolbar.vue";
import DisplayLayers from "@/components/DisplayLayers.vue";
import ImageViewer from "@/components/ImageViewer.vue";

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";

const shouldResetMaps = ref(false);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);

function datasetChanged() {
  annotationStore.fetchAnnotations();
  propertiesStore.fetchPropertyValues();

  if (dataset.value && dataset.value.time.length <= 1) {
    store.setShowTimelapseMode(false);
  }
}

function configurationChanged() {
  propertiesStore.fetchProperties();
}

function handleImageChanged() {
  shouldResetMaps.value = true;
}

function handleResetComplete() {
  shouldResetMaps.value = false;
}

watch(dataset, datasetChanged);
watch(configuration, configurationChanged);

onMounted(() => {
  datasetChanged();
  configurationChanged();
});

defineExpose({
  shouldResetMaps,
  dataset,
  configuration,
  handleImageChanged,
  handleResetComplete,
});
</script>

<style lang="scss" scoped>
.viewer {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
}

.side {
  width: 20em;
}

.toolbar {
  padding: 0.5em;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding-bottom: 0;
}

.main {
  flex: 1 1 0;
}
</style>
<style>
.toolbar .v-expansion-panel-content__wrap,
.toolbar .v-expansion-panel-header {
  padding-left: 1px;
  padding-right: 5px;
}
</style>
