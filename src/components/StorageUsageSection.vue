<template>
  <div class="mb-3" v-if="storageInfo">
    <div class="panel-section-title mb-1">Storage</div>
    <p>
      {{ formatSize(storageInfo.used) }}
      <template v-if="storageInfo.quota != null">
        of {{ formatSize(storageInfo.quota) }} used
      </template>
      <template v-else> used (no storage limit) </template>
    </p>
    <template v-if="usagePercentage != null">
      <v-progress-linear
        :model-value="Math.min(usagePercentage, 100)"
        :color="usageColor"
        height="8"
        rounded
        class="my-1"
      />
      <p :class="`text-${usageColor}`">
        {{ usagePercentage.toFixed(1) }}% of storage limit used
      </p>
      <p
        v-if="usageSeverity !== 'ok'"
        class="text-caption text-medium-emphasis"
      >
        <v-icon size="small" :color="usageColor" class="mr-1">
          mdi-alert-circle-outline
        </v-icon>
        Some operations may not work properly when this close to the storage
        limit
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";
import { formatSize } from "@/utils/conversion";
import { storageSeverityColor } from "@/utils/storage";

const storageInfo = computed(() => store.userStorageInfo);
const usagePercentage = computed(() => store.storageUsagePercentage);

const usageSeverity = computed(() => store.storageSeverity);
const usageColor = computed(() => storageSeverityColor(usageSeverity.value));
</script>
