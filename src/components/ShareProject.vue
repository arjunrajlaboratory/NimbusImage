<template>
  <v-dialog v-model="dialog" max-width="750px">
    <v-card>
      <v-card-title>
        Share Project: {{ project ? project.name : "" }}
      </v-card-title>
      <v-card-text>
        <!-- Error Alert -->
        <v-alert
          v-model="showError"
          type="error"
          density="compact"
          closable
          class="mb-4"
        >
          {{ errorString }}
        </v-alert>

        <!-- Info Alert -->
        <v-alert type="info" density="compact" class="mb-4">
          Sharing this project will grant access to all datasets and collections
          within it.
        </v-alert>

        <!-- Loading State -->
        <div v-if="loading" class="text-center py-4">
          <v-progress-circular indeterminate color="primary" />
          <div class="mt-2">Loading access information...</div>
        </div>

        <v-container v-else>
          <!-- Public Access Toggle -->
          <v-row>
            <v-col cols="12">
              <v-checkbox
                v-model="isPublic"
                label="Make Public (read-only access for everyone)"
                :loading="publicLoading"
                :disabled="publicLoading"
                hide-details
                density="compact"
                @update:model-value="confirmTogglePublic"
              />
            </v-col>
          </v-row>

          <v-divider class="my-4" />

          <!-- Current Access List -->
          <v-row>
            <v-col cols="12">
              <div class="subtitle-2 mb-2">Current Access:</div>
              <div v-if="users.length === 0" class="text-body-2 text-grey">
                No users have been granted access yet.
              </div>
              <v-table v-else density="compact">
                <template #default>
                  <thead>
                    <tr>
                      <th class="text-left">User</th>
                      <th class="text-left" style="width: 150px">
                        Access Level
                      </th>
                      <th class="text-center" style="width: 80px">Remove</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="user in users" :key="user.id">
                      <td class="text-left">
                        <div class="font-weight-medium">
                          {{ user.name || user.login }}
                        </div>
                        <div class="text-caption text-grey text-left">
                          {{ user.email || user.login }}
                        </div>
                      </td>
                      <td>
                        <span
                          v-if="user.level === 2"
                          class="font-weight-medium"
                        >
                          Admin (Owner)
                        </span>
                        <v-select
                          v-else
                          :model-value="user.level"
                          :items="accessLevelItems"
                          item-title="text"
                          item-value="value"
                          density="compact"
                          hide-details
                          :loading="userLoading === user.id"
                          :disabled="userLoading === user.id"
                          @update:model-value="
                            confirmUpdateUserAccess(user, $event)
                          "
                        />
                      </td>
                      <td class="text-center">
                        <v-btn
                          v-if="user.level !== 2"
                          icon
                          size="small"
                          color="error"
                          :loading="userLoading === user.id"
                          :disabled="userLoading === user.id"
                          @click="confirmRemoveUser(user)"
                        >
                          <v-icon size="small">mdi-close</v-icon>
                        </v-btn>
                        <v-tooltip v-else bottom>
                          <template #activator="{ props: activatorProps }">
                            <v-icon
                              size="small"
                              color="grey-lighten-1"
                              v-bind="activatorProps"
                            >
                              mdi-lock
                            </v-icon>
                          </template>
                          <span>Cannot remove project owner</span>
                        </v-tooltip>
                      </td>
                    </tr>
                  </tbody>
                </template>
              </v-table>
            </v-col>
          </v-row>

          <v-divider class="my-4" />

          <!-- Add User Form -->
          <v-row>
            <v-col cols="12">
              <div class="subtitle-2 mb-2">Add User:</div>
              <v-row dense align="center">
                <v-col cols="5">
                  <v-text-field
                    v-model="newUserEmail"
                    label="Username or Email"
                    density="compact"
                    variant="outlined"
                    hide-details
                    :disabled="addUserLoading"
                  />
                </v-col>
                <v-col cols="4">
                  <v-select
                    v-model="newUserAccessLevel"
                    :items="accessLevelItems"
                    item-title="text"
                    item-value="value"
                    label="Access"
                    density="compact"
                    variant="outlined"
                    hide-details
                    :disabled="addUserLoading"
                  />
                </v-col>
                <v-col cols="3">
                  <v-btn
                    color="primary"
                    :loading="addUserLoading"
                    :disabled="!newUserEmail || addUserLoading"
                    @click="confirmAddUser"
                  >
                    <v-icon start size="small">mdi-plus</v-icon>
                    Add
                  </v-btn>
                </v-col>
              </v-row>
            </v-col>
          </v-row>
        </v-container>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" variant="text" @click="close">Done</v-btn>
      </v-card-actions>
    </v-card>

    <!-- Confirmation Dialog -->
    <v-dialog v-model="confirmDialog" max-width="450px">
      <v-card>
        <v-card-title class="text-h6">{{ confirmTitle }}</v-card-title>
        <v-card-text>
          <div>{{ confirmMessage }}</div>
          <div class="mt-3 text-body-2">
            This will affect
            <strong>{{ datasetCount }}</strong>
            {{ datasetCount === 1 ? "dataset" : "datasets" }}
            and
            <strong>{{ collectionCount }}</strong>
            {{ collectionCount === 1 ? "collection" : "collections" }}
            in this project, along with all associated configurations and views.
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDialog = false">Cancel</v-btn>
          <v-btn
            :color="confirmColor"
            variant="text"
            @click="executeConfirmedAction"
          >
            {{ confirmActionLabel }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { isAxiosError } from "axios";
import store from "@/store";
import { logError } from "@/utils/log";
import { IDatasetAccessUser, IProject } from "@/store/model";

const props = defineProps<{
  project: IProject | null;
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const dialog = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit("update:modelValue", val),
});

const loading = ref(false);
const showError = ref(false);
const errorString = ref("");

const isPublic = ref(false);
const users = ref<IDatasetAccessUser[]>([]);

const publicLoading = ref(false);
const userLoading = ref<string | null>(null);
const addUserLoading = ref(false);

const newUserEmail = ref("");
const newUserAccessLevel = ref(0);

const confirmDialog = ref(false);
const confirmTitle = ref("");
const confirmMessage = ref("");
const confirmColor = ref("primary");
const confirmActionLabel = ref("Confirm");
const pendingAction = ref<(() => Promise<void>) | null>(null);

const userToRemove = ref<IDatasetAccessUser | null>(null);

const accessLevelItems = [
  { text: "Read", value: 0 },
  { text: "Write", value: 1 },
];

const accessLevelLabels: Record<number, string> = {
  0: "Read",
  1: "Write",
};

const datasetCount = computed((): number => {
  return props.project?.meta.datasets.length ?? 0;
});

const collectionCount = computed((): number => {
  return props.project?.meta.collections.length ?? 0;
});

watch(dialog, (val) => {
  if (val && props.project) {
    fetchAccessInfo(props.project.id);
  } else if (!val) {
    resetState();
  }
});

function resetState() {
  loading.value = false;
  showError.value = false;
  errorString.value = "";
  isPublic.value = false;
  users.value = [];
  newUserEmail.value = "";
  newUserAccessLevel.value = 0;
  userToRemove.value = null;
}

async function fetchAccessInfo(projectId: string) {
  loading.value = true;
  showError.value = false;
  try {
    const accessList = await store.projectsAPI.getProjectAccess(projectId);
    isPublic.value = accessList.public;
    users.value = accessList.users;
  } catch (error) {
    logError(`Failed to fetch access info for project ${projectId}`, error);
    errorString.value = "Failed to load access information";
    showError.value = true;
  } finally {
    loading.value = false;
  }
}

function close() {
  dialog.value = false;
}

// --- Confirmation helpers ---

function showConfirm(
  title: string,
  message: string,
  actionLabel: string,
  color: string,
  action: () => Promise<void>,
) {
  confirmTitle.value = title;
  confirmMessage.value = message;
  confirmActionLabel.value = actionLabel;
  confirmColor.value = color;
  pendingAction.value = action;
  confirmDialog.value = true;
}

async function executeConfirmedAction() {
  confirmDialog.value = false;
  if (pendingAction.value) {
    await pendingAction.value();
    pendingAction.value = null;
  }
}

function shareErrorMessage(error: unknown): string {
  if (
    isAxiosError(error) &&
    error.response?.data?.message === "badEmailOrUsername"
  ) {
    return "Unknown user. Please check the username or email.";
  }
  return "An error occurred while updating sharing";
}

// --- Public toggle ---

function confirmTogglePublic(newValue: boolean) {
  if (newValue) {
    showConfirm(
      "Make Project Public",
      "This will grant read-only access to everyone, including " +
        "anonymous users who are not logged in.",
      "Make Public",
      "primary",
      () => togglePublic(true),
    );
  } else {
    showConfirm(
      "Make Project Private",
      "This will remove public access. Only users explicitly shared " +
        "on this project will retain access.",
      "Make Private",
      "warning",
      () => togglePublic(false),
    );
  }
  // Revert the checkbox until confirmed
  isPublic.value = !newValue;
}

async function togglePublic(newValue: boolean) {
  if (!props.project) return;
  publicLoading.value = true;
  showError.value = false;
  try {
    await store.projectsAPI.setProjectPublic(props.project.id, newValue);
    isPublic.value = newValue;
  } catch (error) {
    logError("Failed to toggle public access", error);
    errorString.value = "Failed to update public access";
    showError.value = true;
  } finally {
    publicLoading.value = false;
  }
}

// --- Update user access level ---

function confirmUpdateUserAccess(user: IDatasetAccessUser, newLevel: number) {
  const levelLabel = accessLevelLabels[newLevel] ?? "Unknown";
  showConfirm(
    "Change Access Level",
    `Change access for ${user.name || user.login} to ${levelLabel}? ` +
      "This will update their permissions on all resources in this project.",
    "Change",
    "primary",
    () => updateUserAccess(user, newLevel),
  );
}

async function updateUserAccess(user: IDatasetAccessUser, newLevel: number) {
  if (!props.project) return;
  userLoading.value = user.id;
  showError.value = false;
  try {
    await store.projectsAPI.shareProject(
      props.project.id,
      user.login,
      newLevel,
    );
    const userIndex = users.value.findIndex((u) => u.id === user.id);
    if (userIndex >= 0) {
      users.value[userIndex].level = newLevel as 0 | 1 | 2;
    }
  } catch (error) {
    logError("Failed to update user access", error);
    errorString.value = shareErrorMessage(error);
    showError.value = true;
  } finally {
    userLoading.value = null;
  }
}

// --- Remove user ---

function confirmRemoveUser(user: IDatasetAccessUser) {
  userToRemove.value = user;
  showConfirm(
    "Remove Access",
    `Remove access for ${user.name || user.login}? ` +
      "This will also remove their access to all datasets and " +
      "collections in this project.",
    "Remove",
    "error",
    () => removeUser(),
  );
}

async function removeUser() {
  if (!userToRemove.value || !props.project) return;
  const user = userToRemove.value;
  userLoading.value = user.id;
  showError.value = false;
  try {
    await store.projectsAPI.shareProject(props.project.id, user.login, -1);
    users.value = users.value.filter((u) => u.id !== user.id);
  } catch (error) {
    logError("Failed to remove user access", error);
    errorString.value = shareErrorMessage(error);
    showError.value = true;
  } finally {
    userLoading.value = null;
    userToRemove.value = null;
  }
}

// --- Add user ---

function confirmAddUser() {
  if (!newUserEmail.value) return;
  const levelLabel = accessLevelLabels[newUserAccessLevel.value] ?? "Unknown";
  showConfirm(
    "Share Project",
    `Grant ${levelLabel} access to "${newUserEmail.value}"? ` +
      "This will give them access to all datasets and collections " +
      "in this project.",
    "Share",
    "primary",
    () => addUser(),
  );
}

async function addUser() {
  if (!newUserEmail.value || !props.project) return;
  addUserLoading.value = true;
  showError.value = false;
  try {
    await store.projectsAPI.shareProject(
      props.project.id,
      newUserEmail.value,
      newUserAccessLevel.value,
    );
    await fetchAccessInfo(props.project.id);
    newUserEmail.value = "";
    newUserAccessLevel.value = 0;
  } catch (error) {
    logError("Failed to add user", error);
    errorString.value = shareErrorMessage(error);
    showError.value = true;
  } finally {
    addUserLoading.value = false;
  }
}

defineExpose({
  dialog,
  loading,
  showError,
  errorString,
  isPublic,
  users,
  publicLoading,
  userLoading,
  addUserLoading,
  newUserEmail,
  newUserAccessLevel,
  confirmDialog,
  confirmTitle,
  confirmMessage,
  confirmColor,
  confirmActionLabel,
  pendingAction,
  userToRemove,
  accessLevelItems,
  accessLevelLabels,
  datasetCount,
  collectionCount,
  resetState,
  fetchAccessInfo,
  close,
  showConfirm,
  executeConfirmedAction,
  shareErrorMessage,
  confirmTogglePublic,
  togglePublic,
  confirmUpdateUserAccess,
  updateUserAccess,
  confirmRemoveUser,
  removeUser,
  confirmAddUser,
  addUser,
});
</script>
