<template>
  <div>
    <v-overlay
      :value="isLoading"
      absolute
      color="white"
      opacity="0.8"
      z-index="9999"
    >
      <div class="loading-container">
        <v-progress-circular
          indeterminate
          size="128"
          color="primary"
          class="mb-4"
        ></v-progress-circular>
        <div class="loading-text">Loading dataset information...</div>
      </div>
    </v-overlay>
    <router-view v-if="datasetReady"></router-view>
    <v-container v-else>
      <v-skeleton-loader
        type="card, list-item-three-line, image"
        :loading="true"
      ></v-skeleton-loader>
    </v-container>
  </div>
</template>

<script lang="ts">
import store from "@/store";
import sync from "@/store/sync";
import { Component, Vue, Watch } from "vue-property-decorator";

@Component
export default class Dataset extends Vue {
  isReady = false;

  get isLoading() {
    return sync.datasetLoading || !this.isReady;
  }

  get datasetReady() {
    return store.dataset && this.isReady;
  }

  mounted() {
    this.loadDataset();
  }

  @Watch("$route")
  onRouteChange() {
    this.isReady = false;
    this.loadDataset();
  }

  async loadDataset() {
    const datasetId = this.$route.params.datasetId;
    if (datasetId) {
      await store.setSelectedDataset(datasetId);
      this.isReady = true;
    }
  }
}
</script>

<style scoped>
.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.loading-text {
  color: #424242; /* Dark gray text for contrast on white background */
  font-size: 1.5rem; /* Larger text */
  font-weight: 500; /* Medium weight for better visibility */
  margin-top: 16px; /* Space between spinner and text */
  text-align: center;
}
</style>
