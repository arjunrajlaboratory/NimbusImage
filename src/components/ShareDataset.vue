<template>
  <v-dialog v-model="dialog" max-width="750px">
    <v-card>
      <v-card-title>
        {{ isResourceAdmin ? "Share Dataset:" : "Sharing:" }}
        {{ dataset ? dataset.name : "" }}
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

        <!-- Loading State -->
        <div v-if="loading" class="text-center py-4">
          <v-progress-circular indeterminate color="primary" />
          <div class="mt-2">Loading access information...</div>
        </div>

        <v-container v-else>
          <!-- Collections Selection (admin only) -->
          <v-row v-if="isResourceAdmin && configurations.length > 0">
            <v-col cols="12">
              <div class="subtitle-2 mb-2">
                Select collections to share along with dataset:
              </div>
              <v-checkbox
                v-for="config in configurations"
                :key="config.id"
                v-model="selectedConfigIds"
                :label="config.name"
                :value="config.id"
                :hide-details="true"
                density="compact"
              />
            </v-col>
          </v-row>

          <v-divider v-if="isResourceAdmin" class="my-4" />

          <!-- Public Access Toggle (admin only) -->
          <v-row v-if="isResourceAdmin">
            <v-col cols="12">
              <v-checkbox
                v-model="isPublic"
                label="Make Public (read-only access for everyone)"
                :loading="publicLoading"
                :disabled="publicLoading"
                hide-details
                density="compact"
                @update:model-value="togglePublic"
              />
            </v-col>
          </v-row>

          <!-- Public Status (read-only for non-admin) -->
          <v-row v-else>
            <v-col cols="12">
              <v-chip
                size="small"
                :color="isPublic ? 'green' : 'grey'"
                text-color="white"
              >
                <v-icon start size="small">
                  {{ isPublic ? "mdi-earth" : "mdi-lock" }}
                </v-icon>
                {{ isPublic ? "Public" : "Private" }}
              </v-chip>
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
                      <th
                        v-if="isResourceAdmin"
                        class="text-center"
                        style="width: 80px"
                      >
                        Remove
                      </th>
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
                        <template v-else-if="isResourceAdmin">
                          <v-select
                            :model-value="user.level"
                            :items="accessLevelItems"
                            item-title="text"
                            item-value="value"
                            density="compact"
                            hide-details
                            :loading="userLoading === user.id"
                            :disabled="userLoading === user.id"
                            @update:model-value="updateUserAccess(user, $event)"
                          />
                        </template>
                        <span v-else class="font-weight-medium">
                          {{ accessLevelLabel(user.level) }}
                        </span>
                      </td>
                      <td v-if="isResourceAdmin" class="text-center">
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
                          <span>Cannot remove dataset owner</span>
                        </v-tooltip>
                      </td>
                    </tr>
                  </tbody>
                </template>
              </v-table>
            </v-col>
          </v-row>

          <!-- Add User Form (admin only) -->
          <template v-if="isResourceAdmin">
            <v-divider class="my-4" />
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
                      color="primary"
                      :loading="addUserLoading"
                      :disabled="!newUserEmail || addUserLoading"
                      @click="addUser"
                    >
                      <v-icon start size="small">mdi-plus</v-icon>
                      Add
                    </v-btn>
                  </v-col>
                </v-row>
              </v-col>
            </v-row>
          </template>
        </v-container>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" variant="text" @click="close">Done</v-btn>
      </v-card-actions>
    </v-card>

    <!-- Confirmation Dialog for Remove User -->
    <v-dialog v-model="confirmDialog" max-width="400px">
      <v-card>
        <v-card-title class="text-h6">Remove Access</v-card-title>
        <v-card-text>
          Are you sure you want to remove access for
          <strong>{{ userToRemove?.name || userToRemove?.login }}</strong
          >?
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDialog = false">Cancel</v-btn>
          <v-btn color="error" variant="text" @click="removeUser">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { IGirderSelectAble } from "@/girder";
import store from "@/store";
import { logError } from "@/utils/log";
import { accessLevelLabel } from "@/utils/accessLevel";
import {
  IDatasetAccessUser,
  IDatasetAccessConfiguration,
  IDatasetView,
} from "@/store/model";

const props = defineProps<{
  dataset: IGirderSelectAble | null;
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

// Access list data
const isPublic = ref(false);
const users = ref<IDatasetAccessUser[]>([]);
const configurations = ref<IDatasetAccessConfiguration[]>([]);
const selectedConfigIds = ref<string[]>([]);

// Associated dataset views (needed for API calls)
const associatedViews = ref<IDatasetView[]>([]);

// Loading states
const publicLoading = ref(false);
const userLoading = ref<string | null>(null);
const addUserLoading = ref(false);

// Add user form
const newUserEmail = ref("");
const newUserAccessLevel = ref(0); // Default to READ

// Confirmation dialog
const confirmDialog = ref(false);
const userToRemove = ref<IDatasetAccessUser | null>(null);

const accessLevelItems = [
  { text: "Read", value: 0 },
  { text: "Write", value: 1 },
];

const isResourceAdmin = computed((): boolean => {
  const userId = store.girderUser?._id;
  if (!userId) return false;
  return users.value.some((u) => u.id === userId && u.level === 2);
});

watch(dialog, (val) => {
  if (val && props.dataset) {
    fetchAccessInfo(props.dataset._id);
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
  configurations.value = [];
  selectedConfigIds.value = [];
  associatedViews.value = [];
  newUserEmail.value = "";
  newUserAccessLevel.value = 0;
  userToRemove.value = null;
}

async function fetchAccessInfo(datasetId: string) {
  loading.value = true;
  showError.value = false;
  try {
    // Fetch access list from new endpoint
    const accessList = await store.api.getDatasetAccess(datasetId);

    isPublic.value = accessList.public;
    users.value = accessList.users;
    configurations.value = accessList.configurations;
    // Select all configurations by default
    selectedConfigIds.value = accessList.configurations.map((c) => c.id);

    // Also fetch dataset views for the share API calls
    associatedViews.value = await store.api.findDatasetViews({
      datasetId,
    });
  } catch (error) {
    logError(`Failed to fetch access info for dataset ${datasetId}`, error);
    errorString.value = "Failed to load access information";
    showError.value = true;
  } finally {
    loading.value = false;
  }
}

function close() {
  dialog.value = false;
}

function getSelectedViews(): IDatasetView[] {
  // Filter views to only include those with selected configurations
  return associatedViews.value.filter((view) =>
    selectedConfigIds.value.includes(view.configurationId),
  );
}

async function togglePublic(newValue: boolean | null) {
  if (!props.dataset) return;
  const value = !!newValue;

  publicLoading.value = true;
  showError.value = false;
  try {
    await store.api.setDatasetPublic(props.dataset._id, value);
    isPublic.value = value;
  } catch (error) {
    logError("Failed to toggle public access", error);
    errorString.value = "Failed to update public access";
    showError.value = true;
    // Revert the checkbox
    isPublic.value = !value;
  } finally {
    publicLoading.value = false;
  }
}

async function updateUserAccess(user: IDatasetAccessUser, newLevel: number) {
  const selectedViews = getSelectedViews();
  if (selectedViews.length === 0) {
    errorString.value = "Please select at least one collection";
    showError.value = true;
    return;
  }

  userLoading.value = user.id;
  showError.value = false;
  try {
    const response = await store.api.shareDatasetView(
      selectedViews,
      user.login,
      newLevel,
    );

    if (typeof response === "string") {
      errorString.value =
        response === "badEmailOrUsername"
          ? "User not found"
          : "An error occurred";
      showError.value = true;
    } else {
      // Update local state
      const userIndex = users.value.findIndex((u) => u.id === user.id);
      if (userIndex >= 0) {
        users.value[userIndex].level = newLevel as 0 | 1 | 2;
      }
    }
  } catch (error) {
    logError("Failed to update user access", error);
    errorString.value = "Failed to update user access";
    showError.value = true;
  } finally {
    userLoading.value = null;
  }
}

function confirmRemoveUser(user: IDatasetAccessUser) {
  userToRemove.value = user;
  confirmDialog.value = true;
}

async function removeUser() {
  if (!userToRemove.value) return;

  const user = userToRemove.value;
  confirmDialog.value = false;

  const selectedViews = getSelectedViews();
  if (selectedViews.length === 0) {
    errorString.value = "Please select at least one collection";
    showError.value = true;
    return;
  }

  userLoading.value = user.id;
  showError.value = false;
  try {
    const response = await store.api.shareDatasetView(
      selectedViews,
      user.login,
      -1, // -1 to remove access (Girder convention)
    );

    if (typeof response === "string") {
      errorString.value =
        response === "badEmailOrUsername"
          ? "User not found"
          : "An error occurred";
      showError.value = true;
    } else {
      // Remove user from local state
      users.value = users.value.filter((u) => u.id !== user.id);
    }
  } catch (error) {
    logError("Failed to remove user access", error);
    errorString.value = "Failed to remove user access";
    showError.value = true;
  } finally {
    userLoading.value = null;
    userToRemove.value = null;
  }
}

async function addUser() {
  if (!newUserEmail.value) return;

  const selectedViews = getSelectedViews();
  if (selectedViews.length === 0) {
    errorString.value = "Please select at least one collection";
    showError.value = true;
    return;
  }

  addUserLoading.value = true;
  showError.value = false;
  try {
    const response = await store.api.shareDatasetView(
      selectedViews,
      newUserEmail.value,
      newUserAccessLevel.value,
    );

    if (typeof response === "string") {
      errorString.value =
        response === "badEmailOrUsername"
          ? "Unknown user. Please check the username or email."
          : "An error occurred";
      showError.value = true;
    } else {
      // Refresh the access list to show the new user
      if (props.dataset) {
        await fetchAccessInfo(props.dataset._id);
      }
      // Clear the form
      newUserEmail.value = "";
      newUserAccessLevel.value = 0;
    }
  } catch (error) {
    logError("Failed to add user", error);
    errorString.value = "Failed to add user";
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
  configurations,
  selectedConfigIds,
  associatedViews,
  publicLoading,
  userLoading,
  addUserLoading,
  newUserEmail,
  newUserAccessLevel,
  confirmDialog,
  userToRemove,
  accessLevelItems,
  isResourceAdmin,
  resetState,
  fetchAccessInfo,
  close,
  getSelectedViews,
  togglePublic,
  updateUserAccess,
  confirmRemoveUser,
  removeUser,
  addUser,
});
</script>
