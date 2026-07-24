<template>
  <v-card>
    <v-card-title>
      Profile settings:&nbsp;<b> {{ store.userName }} </b>
    </v-card-title>
    <v-card-text>
      <v-container>
        <div class="mb-3">
          <div class="panel-section-title mb-1">Username</div>
          <p>{{ store.userName }}</p>
        </div>
        <div class="mb-3">
          <div class="panel-section-title mb-1">Girder domain</div>
          <p>{{ girderUrlFromApiRoot(store.girderRest.apiRoot) }}</p>
        </div>
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
              v-if="usagePercentage > 90"
              class="text-caption text-medium-emphasis"
            >
              <v-icon size="small" :color="usageColor" class="mr-1">
                mdi-alert-circle-outline
              </v-icon>
              Some operations may not work properly when this close to the
              storage limit
            </p>
          </template>
        </div>
        <v-btn variant="flat" color="error" size="small" @click="logout">
          Logout
        </v-btn>
      </v-container>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import store, { girderUrlFromApiRoot } from "@/store";
import { formatSize } from "@/utils/conversion";

const router = useRouter();

const storageInfo = computed(() => store.userStorageInfo);
const usagePercentage = computed(() => store.storageUsagePercentage);

const usageColor = computed(() => {
  const percentage = usagePercentage.value ?? 0;
  if (percentage > 95) {
    return "error";
  }
  if (percentage > 90) {
    return "warning";
  }
  return "primary";
});

async function logout() {
  await store.logout();
  router.push({ name: "root" });
}
</script>
