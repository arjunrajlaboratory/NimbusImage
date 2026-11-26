<template>
  <v-container class="oauth-consent fill-height" fluid>
    <v-row justify="center" align="center">
      <v-col cols="12" sm="8" md="6" lg="4">
        <v-card v-if="framed" class="pa-4">
          <v-card-title>Open this page in its own tab</v-card-title>
          <v-card-text>
            For your safety, connecting an app to NimbusImage only works when
            this page is not inside another site.
          </v-card-text>
        </v-card>
        <v-card v-else-if="error" class="pa-4">
          <v-card-title class="d-flex align-center">
            <v-icon color="error" class="mr-2">mdi-link-off</v-icon>
            This sign-in can't continue
          </v-card-title>
          <v-card-text>{{ error }}</v-card-text>
        </v-card>
        <v-card v-else-if="request" class="pa-4">
          <v-card-title class="text-wrap">
            Connect {{ request.clientName }} to NimbusImage?
          </v-card-title>
          <v-card-text>
            <p class="mb-3">
              <strong>{{ request.clientName }}</strong> wants to use NimbusImage
              as <strong>{{ login }}</strong
              >. It will have full access to your account: it can see and change
              your datasets, annotations and measurements, and run analyses.
            </p>
            <p class="mb-3">
              Afterwards you will go back to
              <strong>{{ request.redirectHost }}</strong
              >.
            </p>
            <v-alert
              v-if="isAdmin"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-3 admin-warning"
            >
              You are a site administrator. This connection could do anything
              your administrator account can, including administrative changes.
              Consider connecting with an account that is not an administrator.
            </v-alert>
            <v-alert
              v-if="request.localRedirect"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-3"
            >
              This sends you back to a program on this computer, such as Claude
              Code.
            </v-alert>
            <p class="text-body-2 text-medium-emphasis">
              Only continue if you just started connecting from Claude. You can
              disconnect it at any time.
            </p>
          </v-card-text>
          <v-card-actions class="button-bar">
            <v-btn
              variant="text"
              size="small"
              :disabled="busy"
              @click="decide(false)"
            >
              Cancel
            </v-btn>
            <v-btn
              variant="flat"
              color="primary"
              size="small"
              :loading="busy"
              :disabled="busy"
              @click="decide(true)"
            >
              Allow
            </v-btn>
          </v-card-actions>
        </v-card>
        <div v-else class="text-center">
          <v-progress-circular indeterminate color="primary" />
        </div>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import store from "@/store";
import type { IMcpOAuthRequest } from "@/store/McpOAuthAPI";
import { saveReturnTo } from "@/utils/returnAfterLogin";
import { leaveApp } from "@/utils/navigation";
import { extractErrorMessage } from "@/utils/errors";
import { logError } from "@/utils/log";

/**
 * `#/oauth/consent?request=<id>`: a Claude connector asks to act as the
 * user (MCP OAuth, NIMBUSIMAGE_MCP_SERVER.md §6.3). The user approves with
 * their own Girder login; the server answers with the client's callback URL.
 * A logged-out user is sent to the root page's login and brought back
 * (returnAfterLogin.ts).
 */

const route = useRoute();
const router = useRouter();

// Inside another site's frame the Allow button could be clicked by trickery.
const framed = window.top !== window.self;
const request = ref<IMcpOAuthRequest | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
let loadedKey: string | null = null;

const requestId = computed(() => {
  const value = route.query.request;
  return typeof value === "string" ? value : "";
});
const login = computed(() => store.girderUser?.login ?? "");
// The connection carries the account's full powers (§6.3 of the MCP plan).
const isAdmin = computed(() => store.girderUser?.admin === true);
// A share link's hidden user is not a login that can approve (its token
// lacks the user scope); treat it as not logged in yet.
const userId = computed(() =>
  store.isLoggedIn && !store.girderUser?.shareLink
    ? String(store.girderUser?._id ?? "")
    : null,
);

// Arriving here from a share link ends that session (SharedView unmounts
// and restores the real login, or none): wait for it, whatever
// authRestored says.
const inShareSession = computed(() => !!store.girderUser?.shareLink);

watch(
  [() => store.authRestored, userId, requestId, inShareSession],
  async ([restored, user, id, sharing]) => {
    // authRestored only matters for deciding the user is logged OUT; a
    // logged-in user (however they got there) can go ahead.
    if (framed || sharing || (!restored && user === null)) return;
    if (!id) {
      error.value = "The link is missing its request. Start again from Claude.";
      return;
    }
    if (user === null) {
      saveReturnTo(route.fullPath);
      router.replace({ name: "root" });
      return;
    }
    // Load once per request and user: a change of login reloads it.
    const key = `${user}:${id}`;
    if (loadedKey === key) return;
    loadedKey = key;
    request.value = null;
    error.value = null;
    try {
      const loaded = await store.mcpOAuthAPI.getRequest(id);
      if (loadedKey === key) request.value = loaded;
    } catch (caught) {
      if (loadedKey !== key) return;
      logError("Failed to load the sign-in request:", caught);
      error.value = extractErrorMessage(caught);
    }
  },
  { immediate: true },
);

async function decide(allow: boolean) {
  if (busy.value || !request.value) return;
  busy.value = true;
  try {
    const id = requestId.value;
    const url = allow
      ? await store.mcpOAuthAPI.approve(id)
      : await store.mcpOAuthAPI.deny(id);
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("The server returned an unexpected address.");
    }
    leaveApp(url);
  } catch (caught) {
    logError("Failed to answer the sign-in request:", caught);
    error.value = extractErrorMessage(caught);
    busy.value = false;
  }
}

defineExpose({ request, error, busy, decide, framed });
</script>

<style lang="scss" scoped>
.oauth-consent {
  max-width: 100%;
}
</style>
