<template>
  <div class="viewer">
    <aside class="side">
      <viewer-toolbar class="toolbar" @image-changed="handleImageChanged">
        <!-- <contrast-panels /> -->
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
<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import ViewerToolbar from "@/components/ViewerToolbar.vue";
import DisplayLayers from "@/components/DisplayLayers.vue";
import ImageViewer from "@/components/ImageViewer.vue";
import ContrastPanels from "@/components/ContrastPanels.vue";

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";

@Component({
  components: {
    ViewerToolbar,
    DisplayLayers,
    ImageViewer,
    ContrastPanels,
  },
})
export default class Viewer extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;
  readonly propertyStore = propertiesStore;

  shouldResetMaps = false;

  mounted() {
    this.datasetChanged();
    this.configurationChanged();
  }

  get dataset() {
    return this.store.dataset;
  }

  get configuration() {
    return this.store.configuration;
  }

  // Fetch annotations for the current dataset
  @Watch("dataset")
  datasetChanged() {
    this.annotationStore.fetchAnnotations();
    this.propertyStore.fetchPropertyValues();

    // Disable timelapse mode if dataset doesn't support it
    if (this.dataset && this.dataset.time.length <= 1) {
      this.store.setShowTimelapseMode(false);
    }
  }

  @Watch("configuration")
  configurationChanged() {
    this.propertyStore.fetchProperties();
  }

  handleImageChanged() {
    this.shouldResetMaps = true;
  }

  handleResetComplete() {
    this.shouldResetMaps = false;
  }
}
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
