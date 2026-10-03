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
        <storage-usage-section />
        <v-btn variant="flat" color="error" size="small" @click="logout">
          Logout
        </v-btn>
      </v-container>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";
import store, { girderUrlFromApiRoot } from "@/store";
import StorageUsageSection from "@/components/StorageUsageSection.vue";

const router = useRouter();

async function logout() {
  await store.logout();
  router.push({ name: "root" });
}
</script>
