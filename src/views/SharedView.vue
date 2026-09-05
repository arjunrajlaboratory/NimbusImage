<template>
  <viewer v-if="ready" />
  <v-container v-else class="shared-view fill-height" fluid>
    <v-row justify="center" align="center">
      <v-col cols="12" sm="6" class="text-center">
        <template v-if="error">
          <v-icon size="48" color="error">mdi-link-off</v-icon>
          <h2 class="text-h6 mt-2">This link does not work</h2>
          <p class="text-body-2 text-medium-emphasis">{{ error }}</p>
        </template>
        <template v-else>
          <v-progress-circular indeterminate color="primary" />
          <p class="text-body-2 mt-3">Opening the shared view…</p>
        </template>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import store from "@/store";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";
import Viewer from "./datasetView/Viewer.vue";

/**
 * `#/shared/<token>` and `#/embed/<token>` (SHARING.md "Share links"): act as
 * the link's bearer and render its dataset view WITHOUT dropping the route's
 * credential. Reload revalidates the link, without persisting a foreign login.
 * App.vue recognizes the embed route and drops its chrome.
 */

const route = useRoute();
const error = ref<string | null>(null);
const ready = ref(false);
let sequence = 0;
onBeforeUnmount(() => sequence++);

watch(
  () => route.params.token,
  async () => {
    const request = ++sequence;
    ready.value = false;
    error.value = null;
    const token = String(route.params.token ?? "");
    if (!token) {
      error.value = "The link carries no token.";
      return;
    }
    try {
      const link = await store.openShareLink(token);
      if (request !== sequence) return;
      await store.setDatasetViewId({
        id: link.datasetViewId,
        routeQuery: route.query,
      });
      if (request === sequence) ready.value = true;
    } catch (caught) {
      logError("Failed to open a share link:", caught);
      if (request === sequence) error.value = extractErrorMessage(caught);
    }
  },
  { immediate: true },
);

defineExpose({ error, ready });
</script>
