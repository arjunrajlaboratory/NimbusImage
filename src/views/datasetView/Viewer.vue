<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div class="viewer">
    <image-viewer
      v-if="volumeViewMode === '2d'"
      class="main"
      :should-reset-maps="shouldResetMaps"
      @reset-complete="handleResetComplete"
      @layers-ready="handleLayersReady"
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

const shouldResetMaps = ref(false);
// Whether the image for the current configuration has finished rendering at
// least once (ImageViewer emitted layers-ready). Reset when the configuration
// changes. Used to re-attempt tool suggestions if their prerequisites only
// become ready after the image already rendered (see suggestPrerequisitesReady).
const layersHaveRendered = ref(false);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);
// Read-only: the 2D/3D toggle lives in the top app bar (App.vue).
const volumeViewMode = computed(() => volumeViewStore.viewMode);

// Auto tool-suggestions need the user logged in (worker catalog) and the tool
// templates loaded. Both load asynchronously at startup and can arrive after
// the first layers-ready on a direct datasetView load, so track readiness to
// re-trigger once it flips true.
const suggestPrerequisitesReady = computed(
  () => store.isLoggedIn && store.toolTemplateList.length > 0,
);

function datasetChanged() {
  if (dataset.value && dataset.value.time.length <= 1) {
    store.setShowTimelapseMode(false);
  }
}

function configurationChanged() {
  toolSuggestionsStore.clear();
  // New configuration: its image hasn't rendered yet.
  layersHaveRendered.value = false;
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

// When the image finishes rendering (ImageViewer emits layers-ready, driven by
// the layers' onIdle callbacks), ask the backend to suggest tools. The store
// guards against re-running for a configuration that already has tools or that
// we've already suggested for this session, so acting on every layers-ready is
// safe.
function handleLayersReady() {
  layersHaveRendered.value = true;
  toolSuggestionsStore.maybeSuggestForCurrentConfiguration();
}

// If the suggestion prerequisites (login, tool templates) only become ready
// AFTER the image already rendered, the layers-ready that would have triggered
// suggestions has already passed and won't fire again on its own. Re-attempt
// here. maybeSuggest is self-guarding and idempotent, so a redundant call when
// already suggested/persisted is a no-op.
function retrySuggestWhenReady(ready: boolean) {
  if (ready && layersHaveRendered.value) {
    toolSuggestionsStore.maybeSuggestForCurrentConfiguration();
  }
}

watch(dataset, datasetChanged);
watch(configuration, configurationChanged);
watch([dataset, configuration], fetchAnnotationData);
watch(suggestPrerequisitesReady, retrySuggestWhenReady);

onMounted(() => {
  datasetChanged();
  configurationChanged();
  fetchAnnotationData();
});

defineExpose({
  shouldResetMaps,
  layersHaveRendered,
  dataset,
  configuration,
  volumeViewMode,
  suggestPrerequisitesReady,
  configurationChanged,
  handleResetComplete,
  handleLayersReady,
  retrySuggestWhenReady,
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
