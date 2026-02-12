<!-- eslint-disable vue/multi-word-component-names -->
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

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import sync from "@/store/sync";
import { logError } from "@/utils/log";

const vm = getCurrentInstance()!.proxy;

const isReady = ref(false);

const isLoading = computed(() => {
  return sync.datasetLoading || !isReady.value;
});

const datasetReady = computed(() => {
  return store.dataset && isReady.value;
});

async function loadDataset() {
  const datasetId = vm.$route.params.datasetId;
  if (datasetId) {
    try {
      await store.setSelectedDataset(datasetId);
      isReady.value = true;
    } catch (error) {
      logError("Failed to load dataset:", error);
      isReady.value = false;
    }
  }
}

watch(
  () => vm.$route,
  () => {
    isReady.value = false;
    loadDataset();
  },
);

onMounted(() => {
  loadDataset();
});

defineExpose({ isReady, isLoading, datasetReady, loadDataset });
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
