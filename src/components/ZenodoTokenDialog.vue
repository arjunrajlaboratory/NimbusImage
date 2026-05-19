<template>
  <v-dialog
    :model-value="modelValue"
    max-width="500px"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card>
      <v-card-title>Zenodo API Token</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-2">
          Paste a Zenodo personal access token. NimbusImage uses it to upload
          this project on your behalf.
        </p>
        <v-alert
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4 zenodo-instructions"
        >
          <div class="text-body-2 mb-1">
            <strong
              >How to create a token on
              <a :href="zenodoBaseUrl" target="_blank" rel="noopener">{{
                zenodoHost
              }}</a></strong
            >
          </div>
          <ol class="zenodo-steps">
            <li>
              Click your username (top-right) →
              <strong>Applications</strong>
            </li>
            <li>
              Under <strong>Personal access tokens</strong>, click
              <strong>+ New Token</strong>
              (or
              <a :href="tokensUrl" target="_blank" rel="noopener"
                >open the token page directly</a
              >)
            </li>
            <li>Give the token a name (e.g., <em>NimbusImage</em>)</li>
            <li>
              Check
              <strong>all</strong>
              of these scopes:
              <code>deposit:actions</code>, <code>deposit:write</code>,
              <code>user:email</code>
            </li>
            <li>
              Click <strong>Create</strong>, then copy the token —
              <strong>Zenodo only shows it once</strong>, so save a copy in your
              password manager before pasting it below.
            </li>
          </ol>
        </v-alert>
        <v-text-field
          v-model="token"
          label="API Token"
          :type="showToken ? 'text' : 'password'"
          :append-inner-icon="showToken ? 'mdi-eye-off' : 'mdi-eye'"
          variant="outlined"
          density="compact"
          @click:append-inner="showToken = !showToken"
        />
        <v-checkbox
          v-model="sandbox"
          label="Use Zenodo Sandbox (for testing)"
          density="compact"
          hint="Sandbox uses test DOIs and data may be wiped"
          persistent-hint
        />
      </v-card-text>
      <v-card-actions class="d-flex justify-end gap-2">
        <v-btn
          v-if="hasExistingToken"
          variant="text"
          color="error"
          size="small"
          :loading="deleting"
          @click="removeToken"
        >
          <v-icon start>mdi-delete</v-icon>
          Remove Token
        </v-btn>
        <v-spacer />
        <v-btn
          variant="text"
          size="small"
          @click="$emit('update:modelValue', false)"
          >Cancel</v-btn
        >
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :loading="saving"
          :disabled="!token"
          @click="saveToken"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import store from "@/store";
import { logError } from "@/utils/log";

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();

const token = ref("");
const sandbox = ref(false);
const showToken = ref(false);
const saving = ref(false);
const deleting = ref(false);
const hasExistingToken = ref(false);

const zenodoBaseUrl = computed(() =>
  sandbox.value ? "https://sandbox.zenodo.org" : "https://zenodo.org",
);
const zenodoHost = computed(() =>
  sandbox.value ? "sandbox.zenodo.org" : "zenodo.org",
);
const tokensUrl = computed(
  () => `${zenodoBaseUrl.value}/account/settings/applications/tokens/new/`,
);

async function checkExistingToken() {
  try {
    const status = await store.zenodoAPI.getCredentials();
    hasExistingToken.value = status.hasToken;
    sandbox.value = status.sandbox;
  } catch {
    hasExistingToken.value = false;
  }
}

async function saveToken() {
  saving.value = true;
  try {
    await store.zenodoAPI.setCredentials(token.value, sandbox.value);
    hasExistingToken.value = true;
    token.value = "";
    emit("saved");
    emit("update:modelValue", false);
  } catch (error) {
    logError("Failed to save Zenodo token", error);
  } finally {
    saving.value = false;
  }
}

async function removeToken() {
  deleting.value = true;
  try {
    await store.zenodoAPI.deleteCredentials();
    hasExistingToken.value = false;
    token.value = "";
    sandbox.value = false;
    emit("saved");
    emit("update:modelValue", false);
  } catch (error) {
    logError("Failed to remove Zenodo token", error);
  } finally {
    deleting.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      checkExistingToken();
      token.value = "";
      showToken.value = false;
    }
  },
);

onMounted(() => {
  if (props.modelValue) {
    checkExistingToken();
  }
});
</script>

<style lang="scss" scoped>
.zenodo-instructions {
  .zenodo-steps {
    margin: 0 0 0 1.25rem;
    padding: 0;

    li {
      margin-bottom: 4px;
      line-height: 1.4;

      &:last-child {
        margin-bottom: 0;
      }
    }

    code {
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.85em;
      background: rgba(127, 127, 127, 0.15);
    }
  }
}
</style>
