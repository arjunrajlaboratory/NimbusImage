<template>
  <v-dialog
    :model-value="modelValue"
    max-width="500px"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-card>
      <v-card-title>Zenodo API Token</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-4">
          Enter your Zenodo personal access token. You can create one at
          <strong
            >Zenodo &gt; Account Settings &gt; Applications &gt; New
            Token</strong
          >. Required scopes: <code>deposit:write</code> and
          <code>deposit:actions</code>.
        </p>
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
          color="error"
          variant="text"
          :loading="deleting"
          @click="removeToken"
        >
          Remove Token
        </v-btn>
        <v-spacer />
        <v-btn @click="$emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn
          color="primary"
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
import { ref, onMounted, watch } from "vue";
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
