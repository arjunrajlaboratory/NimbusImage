<template>
  <v-container class="shared-view fill-height" fluid>
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
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import store from "@/store";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";

/**
 * `#/shared/<token>` and `#/embed/<token>` (SHARING.md "Share links"): act as
 * the link's bearer, find out which dataset view the link opens, and go
 * there. The embed variant carries `?embed=1`, which App.vue reads to drop
 * the chrome.
 */

const route = useRoute();
const router = useRouter();
const error = ref<string | null>(null);

onMounted(async () => {
  const token = String(route.params.token ?? "");
  if (!token) {
    error.value = "The link carries no token.";
    return;
  }
  try {
    const link = await store.openShareLink(token);
    await router.replace({
      name: "datasetview",
      params: { datasetViewId: link.datasetViewId },
      query: route.name === "embed" ? { embed: "1" } : {},
    });
  } catch (caught) {
    logError("Failed to open a share link:", caught);
    error.value = extractErrorMessage(caught);
  }
});

defineExpose({ error });
</script>
