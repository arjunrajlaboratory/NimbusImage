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

        <!-- Partial-result notice (resources the caller doesn't own) -->
        <v-alert
          v-if="noticeString"
          type="warning"
          density="compact"
          closable
          class="mb-4"
          @click:close="noticeString = ''"
        >
          {{ noticeString }}
        </v-alert>

        <!-- Info Alert -->
        <v-alert type="info" density="compact" class="mb-4">
          Sharing this project also shares the datasets and collections in it
          that you can edit, with their views and configurations, up to your own
          access level. Anything else keeps its own sharing settings.
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
                          :loading="isUserPending(user.id)"
                          :disabled="isUserPending(user.id)"
                          @update:model-value="
                            confirmUpdateUserAccess(user, $event)
                          "
                        />
                      </td>
                      <td class="text-center">
                        <v-btn
                          v-if="user.level !== 2"
                          variant="text"
                          icon
                          size="small"
                          color="error"
                          :loading="isUserPending(user.id)"
                          :disabled="isUserPending(user.id)"
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
              <v-row density="comfortable" align="center">
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
                    variant="flat"
                    color="primary"
                    size="small"
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
        <copy-link-button
          v-if="project"
          :route-path="`/project/${project.id}`"
          tooltip="Copy shareable link to this project"
        />
        <v-spacer />
        <v-btn variant="text" size="small" @click="close">Done</v-btn>
      </v-card-actions>
    </v-card>

    <!-- Confirmation Dialog -->
    <v-dialog v-model="confirmDialog" max-width="450px">
      <v-card>
        <v-card-title class="text-h6">{{ confirmTitle }}</v-card-title>
        <v-card-text>
          <div>{{ confirmMessage }}</div>
          <div class="mt-3 text-body-2">{{ impactSummary }}</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" size="small" @click="confirmDialog = false">
            Cancel
          </v-btn>
          <v-btn
            :color="confirmColor"
            variant="flat"
            size="small"
            @click="executeConfirmedAction"
          >
            {{ confirmActionLabel }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-dialog>
</template>

<script lang="ts">
import { reactive } from "vue";

// Sharing changes in flight on the server, keyed by what they change. Kept at
// module level, like ShareDataset's utils/pendingMutations: a request keeps
// running after its dialog closes, reopens or remounts, so the guard that
// stops a second, overlapping change has to outlive the dialog session.
const pendingChanges = reactive(new Set<string>());
const changeKeys = {
  public: (projectId: string) => `public:${projectId}`,
  user: (projectId: string, userId: string) => `user:${projectId}:${userId}`,
  addUser: (projectId: string) => `addUser:${projectId}`,
};
</script>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { isAxiosError } from "axios";
import store from "@/store";
import { logError } from "@/utils/log";
import { IDatasetAccessUser, IProject } from "@/store/model";
import CopyLinkButton from "@/components/CopyLinkButton.vue";

// Suppress unused import warnings — auto-registered in <script setup>
void CopyLinkButton;

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
const noticeString = ref("");

const isPublic = ref(false);
const users = ref<IDatasetAccessUser[]>([]);

// In-progress state follows the requests (pendingChanges), not the dialog
// session: resetState does not clear it.
const publicLoading = computed(
  () =>
    !!props.project && pendingChanges.has(changeKeys.public(props.project.id)),
);
const addUserLoading = computed(
  () =>
    !!props.project && pendingChanges.has(changeKeys.addUser(props.project.id)),
);
function isUserPending(userId: string): boolean {
  return (
    !!props.project &&
    pendingChanges.has(changeKeys.user(props.project.id, userId))
  );
}

const newUserEmail = ref("");
const newUserAccessLevel = ref(0);

const confirmDialog = ref(false);
const confirmTitle = ref("");
const confirmMessage = ref("");
const confirmColor = ref("primary");
const confirmActionLabel = ref("Confirm");
const pendingAction = ref<(() => Promise<void>) | null>(null);

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

// The client doesn't know which of these the caller can edit or owns, so it
// states the totals and the rules rather than a count of what will change.
const impactSummary = computed((): string => {
  const datasets = `${datasetCount.value} ${
    datasetCount.value === 1 ? "dataset" : "datasets"
  }`;
  const collections = `${collectionCount.value} ${
    collectionCount.value === 1 ? "collection" : "collections"
  }`;
  return (
    `This project has ${datasets} and ${collections}. Sharing changes the ` +
    "ones you can edit, with the views and configurations of those " +
    "datasets, and is refused if it would grant more than your own access; " +
    "publishing changes only what you own. Everything " +
    "else keeps its own settings."
  );
});

watch(dialog, (val) => {
  if (val && props.project) {
    fetchAccessInfo(props.project.id);
  } else if (!val) {
    resetState();
  }
});

// The dialog's session, bumped by every reset (closing the dialog). Every
// async handler captures claimDialog() when it starts and writes its result,
// error or loading flag back only while the dialog still shows that session
// and project: a late response must not land in a reopened dialog.
let dialogGeneration = 0;

function claimDialog(): () => boolean {
  const generation = dialogGeneration;
  const id = props.project?.id;
  return () => generation === dialogGeneration && props.project?.id === id;
}

// Bumped per fetch and by every reset: only the latest fetch may write.
let accessRequest = 0;

function resetState() {
  dialogGeneration++;
  accessRequest++;
  loading.value = false;
  showError.value = false;
  errorString.value = "";
  noticeString.value = "";
  isPublic.value = false;
  users.value = [];
  newUserEmail.value = "";
  newUserAccessLevel.value = 0;
  confirmDialog.value = false;
  pendingAction.value = null;
  // In-progress flags are not reset here: they follow the requests
  // themselves (pendingChanges), which keep running on the server.
}

async function fetchAccessInfo(projectId: string) {
  const request = ++accessRequest;
  const isCurrent = claimDialog();
  const isLatest = () => request === accessRequest && isCurrent();
  loading.value = true;
  showError.value = false;
  try {
    const accessList = await store.projectsAPI.getProjectAccess(projectId);
    if (!isLatest()) return;
    isPublic.value = accessList.public;
    users.value = accessList.users;
  } catch (error) {
    logError(`Failed to fetch access info for project ${projectId}`, error);
    if (!isLatest()) return;
    errorString.value = "Failed to load access information";
    showError.value = true;
  } finally {
    if (isLatest()) {
      loading.value = false;
    }
  }
}

// Runs a sharing change under its pending key. When the change settles after
// its session ended (its result was dropped) and the dialog is open on the
// same project, reload: the reopened dialog may have loaded mid-change.
async function runChange(
  key: string,
  projectId: string,
  change: (isCurrent: () => boolean) => Promise<void>,
) {
  if (pendingChanges.has(key)) return;
  const isCurrent = claimDialog();
  pendingChanges.add(key);
  try {
    await change(isCurrent);
  } finally {
    pendingChanges.delete(key);
    if (!isCurrent() && dialog.value && props.project?.id === projectId) {
      fetchAccessInfo(projectId);
    }
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
  // Consume the confirmation now: it is this click's, and another one may be
  // confirmed while this action runs.
  const action = pendingAction.value;
  pendingAction.value = null;
  confirmDialog.value = false;
  if (action) {
    await action();
  }
}

function shareErrorMessage(error: unknown): string {
  if (
    isAxiosError(error) &&
    error.response?.data?.message === "badEmailOrUsername"
  ) {
    return "Unknown user. Please check the username or email.";
  }
  // A refusal (e.g. a level above your own on a dataset in the project)
  // carries the server's reason; show it rather than a generic message.
  if (isAxiosError(error) && error.response?.data?.message) {
    return error.response.data.message;
  }
  return "An error occurred while updating sharing";
}

// --- Public toggle ---

function confirmTogglePublic(newValue: boolean | null) {
  if (newValue) {
    showConfirm(
      "Make Project Public",
      "This will grant read-only access to everyone, including " +
        "anonymous users who are not logged in, to the project and the " +
        "datasets and collections in it that you own.",
      "Make Public",
      "primary",
      () => togglePublic(true),
    );
  } else {
    showConfirm(
      "Make Project Private",
      "This will remove public access from the project and the " +
        "resources in it that you own. Only users explicitly shared on " +
        "this project will retain access to them.",
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
  const projectId = props.project.id;
  await runChange(
    changeKeys.public(projectId),
    projectId,
    async (isCurrent) => {
      showError.value = false;
      try {
        const { skipped } = await store.projectsAPI.setProjectPublic(
          projectId,
          newValue,
        );
        if (!isCurrent()) return;
        isPublic.value = newValue;
        noticeString.value =
          skipped === 1
            ? "1 dataset, collection or view in this project that you don't " +
              "own kept its own visibility."
            : skipped > 1
              ? `${skipped} datasets, collections or views in this project ` +
                "that you don't own kept their own visibility."
              : "";
      } catch (error) {
        logError("Failed to toggle public access", error);
        if (!isCurrent()) return;
        errorString.value = "Failed to update public access";
        showError.value = true;
      }
    },
  );
}

// --- Update user access level ---

function confirmUpdateUserAccess(user: IDatasetAccessUser, newLevel: number) {
  const levelLabel = accessLevelLabels[newLevel] ?? "Unknown";
  showConfirm(
    "Change Access Level",
    `Change access for ${user.name || user.login} to ${levelLabel}? ` +
      "This will update their permissions on the resources in this project " +
      "that you can share.",
    "Change",
    "primary",
    () => updateUserAccess(user, newLevel),
  );
}

async function updateUserAccess(user: IDatasetAccessUser, newLevel: number) {
  if (!props.project) return;
  const projectId = props.project.id;
  const key = changeKeys.user(projectId, user.id);
  await runChange(key, projectId, async (isCurrent) => {
    showError.value = false;
    try {
      await store.projectsAPI.shareProject(projectId, user.login, newLevel);
      if (!isCurrent()) return;
      const userIndex = users.value.findIndex((u) => u.id === user.id);
      if (userIndex >= 0) {
        users.value[userIndex].level = newLevel as 0 | 1 | 2;
      }
    } catch (error) {
      logError("Failed to update user access", error);
      if (!isCurrent()) return;
      errorString.value = shareErrorMessage(error);
      showError.value = true;
    }
  });
}

// --- Remove user ---

function confirmRemoveUser(user: IDatasetAccessUser) {
  showConfirm(
    "Remove Access",
    `Remove access for ${user.name || user.login}? ` +
      "This will also remove their access to the datasets and " +
      "collections in this project that you can share.",
    "Remove",
    "error",
    () => removeUser(user),
  );
}

async function removeUser(user: IDatasetAccessUser) {
  if (!props.project) return;
  const projectId = props.project.id;
  // Same key as an access change: both rewrite this user's access.
  const key = changeKeys.user(projectId, user.id);
  await runChange(key, projectId, async (isCurrent) => {
    showError.value = false;
    try {
      await store.projectsAPI.shareProject(projectId, user.login, -1);
      if (!isCurrent()) return;
      users.value = users.value.filter((u) => u.id !== user.id);
    } catch (error) {
      logError("Failed to remove user access", error);
      if (!isCurrent()) return;
      errorString.value = shareErrorMessage(error);
      showError.value = true;
    }
  });
}

// --- Add user ---

function confirmAddUser() {
  if (!newUserEmail.value) return;
  const levelLabel = accessLevelLabels[newUserAccessLevel.value] ?? "Unknown";
  showConfirm(
    "Share Project",
    `Grant ${levelLabel} access to "${newUserEmail.value}"? ` +
      "This will also give them access to the datasets and " +
      "collections you can edit in this project.",
    "Share",
    "primary",
    () => addUser(),
  );
}

async function addUser() {
  if (!newUserEmail.value || !props.project) return;
  const projectId = props.project.id;
  const login = newUserEmail.value;
  const level = newUserAccessLevel.value;
  await runChange(
    changeKeys.addUser(projectId),
    projectId,
    async (isCurrent) => {
      showError.value = false;
      try {
        await store.projectsAPI.shareProject(projectId, login, level);
        if (!isCurrent()) return;
        newUserEmail.value = "";
        newUserAccessLevel.value = 0;
        await fetchAccessInfo(projectId);
      } catch (error) {
        logError("Failed to add user", error);
        if (!isCurrent()) return;
        errorString.value = shareErrorMessage(error);
        showError.value = true;
      }
    },
  );
}

defineExpose({
  dialog,
  loading,
  showError,
  errorString,
  noticeString,
  isPublic,
  users,
  publicLoading,
  isUserPending,
  addUserLoading,
  newUserEmail,
  newUserAccessLevel,
  confirmDialog,
  confirmTitle,
  confirmMessage,
  confirmColor,
  confirmActionLabel,
  pendingAction,
  accessLevelItems,
  accessLevelLabels,
  datasetCount,
  collectionCount,
  impactSummary,
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
