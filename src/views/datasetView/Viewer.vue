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
    <tool-suggestions />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ImageViewer from "@/components/ImageViewer.vue";
import VolumeViewer from "@/components/VolumeViewer.vue";
import ToolSuggestions from "@/components/ToolSuggestions.vue";

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import volumeViewStore from "@/store/volumeView";
import toolSuggestionsStore from "@/store/toolSuggestions";

// How long to wait after the image map appears before capturing the screenshot
// for tool suggestions, giving tiles a moment to render. Rough heuristic — see
// codebaseDocumentation/AUTO_TOOL_SUGGESTIONS.md.
const SUGGESTION_CAPTURE_DELAY_MS = 1500;

const shouldResetMaps = ref(false);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);
const mapsReady = computed(() => (store.maps?.length ?? 0) > 0);
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
function fetchAnnotationData() {
  if (dataset.value && configuration.value) {
    annotationStore.fetchAnnotations();
    propertiesStore.fetchPropertyValues();
  }
}

function handleResetComplete() {
  shouldResetMaps.value = false;
}

// When a fresh collection is opened (2D mode, image rendered), ask the backend
// to suggest tools. The store guards against re-running for the same
// configuration or one that already has tools, so this is safe to call
// whenever the configuration or map readiness changes.
let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
function maybeSuggestTools() {
  if (suggestionTimer) {
    clearTimeout(suggestionTimer);
    suggestionTimer = null;
  }
  if (
    volumeViewMode.value !== "2d" ||
    !dataset.value ||
    !configuration.value ||
    !mapsReady.value
  ) {
    return;
  }
  suggestionTimer = setTimeout(() => {
    toolSuggestionsStore.maybeSuggestForCurrentConfiguration();
  }, SUGGESTION_CAPTURE_DELAY_MS);
}

watch(dataset, datasetChanged);
watch(configuration, configurationChanged);
watch([dataset, configuration], fetchAnnotationData);
watch([configuration, mapsReady, volumeViewMode], maybeSuggestTools);

onMounted(() => {
  datasetChanged();
  configurationChanged();
  fetchAnnotationData();
  maybeSuggestTools();
});

defineExpose({
  shouldResetMaps,
  dataset,
  configuration,
  volumeViewMode,
  mapsReady,
  handleResetComplete,
  maybeSuggestTools,
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
