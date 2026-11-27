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
        <connected-apps-section :visible="visible" />
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
import ConnectedAppsSection from "@/components/ConnectedAppsSection.vue";
import aiPanelStore from "@/store/aiPanel";
import { restartAfterLogout } from "@/utils/logoutRestart";
import { logError } from "@/utils/log";

// Whether the menu holding these settings is open.
defineProps<{ visible: boolean }>();

const router = useRouter();

// Logout ends in a page reload (see logoutRestart.ts), so nothing the
// previous account left in memory reaches the next one.
async function logout() {
  await store.logout();
  // The reload would cut short the wipe that the logged-in-user watcher in
  // App.vue starts, and the same account logging back in would get its
  // conversation back.
  try {
    await aiPanelStore.clearConversationAndStorage();
  } catch (error) {
    logError("Could not clear the stored AI conversation:", error);
  }
  try {
    await router.push({ name: "root" });
  } catch (error) {
    logError("Could not go to the home page after logout:", error);
  }
  restartAfterLogout();
}
</script>
