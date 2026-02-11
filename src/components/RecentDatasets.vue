<template>
  <div class="recent-datasets-container">
    <v-list two-line class="scrollable py-0">
      <div v-for="d in datasetViewItems" :key="d.datasetView.id">
        <v-tooltip
          top
          :disabled="!d.datasetInfo.description && !d.configInfo.description"
        >
          <template v-slot:activator="{ on, attrs }">
            <v-list-item @click="handleDatasetClick(d.datasetView.id)">
              <v-list-item-content v-bind="attrs" v-on="on">
                <v-list-item-title>
                  {{
                    d.datasetInfo.name ? d.datasetInfo.name : "Unnamed dataset"
                  }}
                </v-list-item-title>
                <v-list-item-subtitle>
                  {{
                    d.configInfo.name
                      ? d.configInfo.name
                      : "Unnamed configuration"
                  }}
                  <template v-if="d.datasetInfo.creatorId">
                    <br />
                    <span class="text-caption">
                      Owner:
                      {{ getUserDisplayName(d.datasetInfo.creatorId) }}
                    </span>
                  </template>
                </v-list-item-subtitle>
              </v-list-item-content>
              <v-list-item-action
                class="my-0 d-flex flex-column justify-center"
              >
                <div class="text-caption grey--text text-left">
                  <div>Last accessed:</div>
                  <div style="line-height: 1.1">
                    {{ formatDateNumber(d.datasetView.lastViewed) }}
                  </div>
                </div>
              </v-list-item-action>
            </v-list-item>
          </template>
          <div v-if="d.datasetInfo.description">
            {{ d.datasetInfo.description }}
          </div>
          <v-divider />
          <div v-if="d.configInfo.description">
            {{ d.configInfo.description }}
          </div>
        </v-tooltip>
      </div>
    </v-list>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  datasetViewItems: any[];
  getUserDisplayName: (creatorId: string) => string;
  formatDateNumber: (date: number) => string;
}>();

const emit = defineEmits<{
  (e: "dataset-clicked", datasetViewId: string): void;
}>();

function handleDatasetClick(datasetViewId: string) {
  emit("dataset-clicked", datasetViewId);
}
</script>

<style scoped>
.recent-datasets-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.scrollable {
  overflow-y: auto;
  flex-grow: 1;
  min-height: 0;
}
</style>
