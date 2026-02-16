<template>
  <v-dialog v-model="dialog" max-width="750px">
    <v-card>
      <v-card-title>
        Share Dataset: {{ dataset ? dataset.name : "" }}
      </v-card-title>
      <v-card-text>
        <!-- Error Alert -->
        <v-alert
          v-model="showError"
          type="error"
          dense
          dismissible
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
          <!-- Collections Selection -->
          <v-row v-if="configurations.length > 0">
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
                :dense="true"
              />
            </v-col>
          </v-row>

          <v-divider class="my-4" />

          <!-- Public Access Toggle -->
          <v-row>
            <v-col cols="12">
              <v-checkbox
                v-model="isPublic"
                label="Make Public (read-only access for everyone)"
                :loading="publicLoading"
                :disabled="publicLoading"
                hide-details
                dense
                @change="togglePublic"
              />
            </v-col>
          </v-row>

          <v-divider class="my-4" />

          <!-- Current Access List -->
          <v-row>
            <v-col cols="12">
              <div class="subtitle-2 mb-2">Current Access:</div>
              <div v-if="users.length === 0" class="text-body-2 grey--text">
                No users have been granted access yet.
              </div>
              <v-simple-table v-else dense>
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
                        <div class="text-caption grey--text text-left">
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
                          :value="user.level"
                          :items="accessLevelItems"
                          dense
                          hide-details
                          :loading="userLoading === user.id"
                          :disabled="userLoading === user.id"
                          @change="updateUserAccess(user, $event)"
                        />
                      </td>
                      <td class="text-center">
                        <v-btn
                          v-if="user.level !== 2"
                          icon
                          small
                          color="error"
                          :loading="userLoading === user.id"
                          :disabled="userLoading === user.id"
                          @click="confirmRemoveUser(user)"
                        >
                          <v-icon small>mdi-close</v-icon>
                        </v-btn>
                        <v-tooltip v-else bottom>
                          <template #activator="{ on, attrs }">
                            <v-icon
                              small
                              color="grey lighten-1"
                              v-bind="attrs"
                              v-on="on"
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
              </v-simple-table>
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
                    dense
                    outlined
                    hide-details
                    :disabled="addUserLoading"
                  />
                </v-col>
                <v-col cols="4">
                  <v-select
                    v-model="newUserAccessLevel"
                    :items="accessLevelItems"
                    label="Access"
                    dense
                    outlined
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
                    <v-icon left small>mdi-plus</v-icon>
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
        <v-btn color="primary" text @click="close">Done</v-btn>
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
          <v-btn text @click="confirmDialog = false">Cancel</v-btn>
          <v-btn color="error" text @click="removeUser">Remove</v-btn>
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
import {
  IDatasetAccessUser,
  IDatasetAccessConfiguration,
  IDatasetView,
} from "@/store/model";

const props = defineProps<{
  dataset: IGirderSelectAble | null;
  value: boolean;
}>();

const emit = defineEmits<{
  (e: "input", value: boolean): void;
}>();

const dialog = computed({
  get: () => props.value,
  set: (val: boolean) => emit("input", val),
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

async function togglePublic(newValue: boolean) {
  if (!props.dataset) return;

  publicLoading.value = true;
  showError.value = false;
  try {
    await store.api.setDatasetPublic(props.dataset._id, newValue);
    isPublic.value = newValue;
  } catch (error) {
    logError("Failed to toggle public access", error);
    errorString.value = "Failed to update public access";
    showError.value = true;
    // Revert the checkbox
    isPublic.value = !newValue;
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
</script>
