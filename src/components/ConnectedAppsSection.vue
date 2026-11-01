<template>
  <div
    class="mb-3"
    v-if="!isShareLink && (status === 'ready' || status === 'error')"
  >
    <div class="panel-section-title mb-1">Connected apps</div>
    <p class="text-caption text-medium-emphasis mb-1">
      Apps such as Claude that you have allowed to use NimbusImage for you.
      Disconnecting one stops it at once.
    </p>
    <p v-if="status === 'error'" class="text-caption text-error">
      {{ errorMessage }}
    </p>
    <template v-else>
      <p v-if="grants.length === 0" class="text-caption">No connected apps.</p>
      <div
        v-for="grant in grants"
        :key="grant.id"
        class="d-flex align-center mb-2 connected-app"
      >
        <div class="flex-grow-1">
          <div>{{ grant.clientName }}</div>
          <div class="text-caption text-medium-emphasis">
            {{ grant.redirectHost }} · connected
            {{ formatDay(grant.created) }} · last used
            {{ formatDay(grant.lastUsed) }}
          </div>
        </div>
        <v-btn
          variant="text"
          color="error"
          size="small"
          :loading="disconnecting.has(grant.id)"
          :disabled="disconnecting.has(grant.id)"
          @click="disconnect(grant)"
        >
          Disconnect
        </v-btn>
      </div>
      <p v-if="disconnectError" class="text-caption text-error">
        {{ disconnectError }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { isAxiosError } from "axios";
import store from "@/store";
import type { IMcpOAuthGrant } from "@/store/McpOAuthAPI";
import { formatDayShort } from "@/utils/date";
import { logError } from "@/utils/log";

// The profile menu stays mounted once opened, so load on each open rather
// than on mount.
const props = defineProps<{ visible: boolean }>();

// "off": the server answers 404 because the OAuth plugin is switched off,
// so there is nothing to show. "error" is a failed load, never shown as an
// empty list. A reload keeps the last status until it settles, so the
// section does not blink each time the menu opens.
const status = ref<"idle" | "off" | "ready" | "error">("idle");
const grants = ref<IMcpOAuthGrant[]>([]);
const errorMessage = "Could not load your connected apps.";
const disconnectError = ref("");
const disconnecting = reactive(new Set<string>());
let loadToken = 0;

// Opening a share link swaps the session to the link's read-only user
// without unmounting the menu. That user has no connections to manage, and
// what was loaded for the previous user must not stay on screen.
const userId = computed(() => store.girderUser?._id);
const isShareLink = computed(() => !!store.girderUser?.shareLink);

watch(userId, () => {
  ++loadToken;
  status.value = "idle";
  grants.value = [];
  disconnectError.value = "";
});

async function load() {
  if (isShareLink.value) return;
  const token = ++loadToken;
  try {
    const result = await store.mcpOAuthAPI.listGrants();
    if (token !== loadToken) return;
    grants.value = result;
    status.value = "ready";
  } catch (error) {
    if (token !== loadToken) return;
    if (isAxiosError(error) && error.response?.status === 404) {
      status.value = "off";
    } else {
      logError("Loading connected apps failed", error);
      status.value = "error";
    }
  }
}

async function disconnect(grant: IMcpOAuthGrant) {
  const owner = userId.value;
  disconnecting.add(grant.id);
  disconnectError.value = "";
  try {
    await store.mcpOAuthAPI.deleteGrant(grant.id);
  } catch (error) {
    if (userId.value !== owner) return;
    // 404: already gone (expired, or disconnected elsewhere).
    if (!(isAxiosError(error) && error.response?.status === 404)) {
      logError("Disconnecting an app failed", error);
      disconnectError.value = `Could not disconnect ${grant.clientName}.`;
      return;
    }
  } finally {
    disconnecting.delete(grant.id);
  }
  if (userId.value !== owner) return;
  // A load already in flight may have listed this grant; its result is
  // dropped in favor of this one.
  grants.value = grants.value.filter(({ id }) => id !== grant.id);
  load();
}

function formatDay(isoDate: string) {
  return formatDayShort(Date.parse(isoDate));
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    disconnectError.value = "";
    load();
  },
  { immediate: true },
);
</script>

<style scoped>
.connected-app {
  gap: 8px;
}
</style>
