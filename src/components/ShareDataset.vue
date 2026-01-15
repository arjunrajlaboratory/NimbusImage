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

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import { IGirderSelectAble } from "@/girder";
import store from "@/store";
import { logError } from "@/utils/log";
import {
  IDatasetAccessUser,
  IDatasetAccessConfiguration,
  IDatasetView,
} from "@/store/model";

@Component
export default class ShareDataset extends Vue {
  readonly store = store;

  @Prop({ required: true }) readonly dataset!: IGirderSelectAble | null;
  @Prop({ default: false }) readonly value!: boolean;

  dialog = false;
  loading = false;
  showError = false;
  errorString = "";

  // Access list data
  isPublic = false;
  users: IDatasetAccessUser[] = [];
  configurations: IDatasetAccessConfiguration[] = [];
  selectedConfigIds: string[] = [];

  // Associated dataset views (needed for API calls)
  associatedViews: IDatasetView[] = [];

  // Loading states
  publicLoading = false;
  userLoading: string | null = null; // User ID being modified
  addUserLoading = false;

  // Add user form
  newUserEmail = "";
  newUserAccessLevel = 0; // Default to READ

  // Confirmation dialog
  confirmDialog = false;
  userToRemove: IDatasetAccessUser | null = null;

  readonly accessLevelItems = [
    { text: "Read", value: 0 },
    { text: "Write", value: 1 },
  ];

  @Watch("value")
  onValueChanged(val: boolean) {
    this.dialog = val;
    if (val && this.dataset) {
      this.fetchAccessInfo(this.dataset._id);
    } else {
      this.resetState();
    }
  }

  @Watch("dialog")
  onDialogChanged(val: boolean) {
    this.$emit("input", val);
  }

  resetState() {
    this.loading = false;
    this.showError = false;
    this.errorString = "";
    this.isPublic = false;
    this.users = [];
    this.configurations = [];
    this.selectedConfigIds = [];
    this.associatedViews = [];
    this.newUserEmail = "";
    this.newUserAccessLevel = 0;
    this.userToRemove = null;
  }

  async fetchAccessInfo(datasetId: string) {
    this.loading = true;
    this.showError = false;
    try {
      // Fetch access list from new endpoint
      const accessList = await this.store.api.getDatasetAccess(datasetId);

      this.isPublic = accessList.public;
      this.users = accessList.users;
      this.configurations = accessList.configurations;
      // Select all configurations by default
      this.selectedConfigIds = accessList.configurations.map((c) => c.id);

      // Also fetch dataset views for the share API calls
      this.associatedViews = await this.store.api.findDatasetViews({
        datasetId,
      });
    } catch (error) {
      logError(`Failed to fetch access info for dataset ${datasetId}`, error);
      this.errorString = "Failed to load access information";
      this.showError = true;
    } finally {
      this.loading = false;
    }
  }

  close() {
    this.dialog = false;
  }

  getSelectedViews(): IDatasetView[] {
    // Filter views to only include those with selected configurations
    return this.associatedViews.filter((view) =>
      this.selectedConfigIds.includes(view.configurationId),
    );
  }

  async togglePublic(newValue: boolean) {
    if (!this.dataset) return;

    this.publicLoading = true;
    this.showError = false;
    try {
      await this.store.api.setDatasetPublic(this.dataset._id, newValue);
      this.isPublic = newValue;
    } catch (error) {
      logError("Failed to toggle public access", error);
      this.errorString = "Failed to update public access";
      this.showError = true;
      // Revert the checkbox
      this.isPublic = !newValue;
    } finally {
      this.publicLoading = false;
    }
  }

  async updateUserAccess(user: IDatasetAccessUser, newLevel: number) {
    const selectedViews = this.getSelectedViews();
    if (selectedViews.length === 0) {
      this.errorString = "Please select at least one collection";
      this.showError = true;
      return;
    }

    this.userLoading = user.id;
    this.showError = false;
    try {
      const response = await this.store.api.shareDatasetView(
        selectedViews,
        user.login,
        newLevel,
      );

      if (typeof response === "string") {
        this.errorString =
          response === "badEmailOrUsername"
            ? "User not found"
            : "An error occurred";
        this.showError = true;
      } else {
        // Update local state
        const userIndex = this.users.findIndex((u) => u.id === user.id);
        if (userIndex >= 0) {
          this.users[userIndex].level = newLevel as 0 | 1 | 2;
        }
      }
    } catch (error) {
      logError("Failed to update user access", error);
      this.errorString = "Failed to update user access";
      this.showError = true;
    } finally {
      this.userLoading = null;
    }
  }

  confirmRemoveUser(user: IDatasetAccessUser) {
    this.userToRemove = user;
    this.confirmDialog = true;
  }

  async removeUser() {
    if (!this.userToRemove) return;

    const user = this.userToRemove;
    this.confirmDialog = false;

    const selectedViews = this.getSelectedViews();
    if (selectedViews.length === 0) {
      this.errorString = "Please select at least one collection";
      this.showError = true;
      return;
    }

    this.userLoading = user.id;
    this.showError = false;
    try {
      const response = await this.store.api.shareDatasetView(
        selectedViews,
        user.login,
        null, // null to remove access
      );

      if (typeof response === "string") {
        this.errorString =
          response === "badEmailOrUsername"
            ? "User not found"
            : "An error occurred";
        this.showError = true;
      } else {
        // Remove user from local state
        this.users = this.users.filter((u) => u.id !== user.id);
      }
    } catch (error) {
      logError("Failed to remove user access", error);
      this.errorString = "Failed to remove user access";
      this.showError = true;
    } finally {
      this.userLoading = null;
      this.userToRemove = null;
    }
  }

  async addUser() {
    if (!this.newUserEmail) return;

    const selectedViews = this.getSelectedViews();
    if (selectedViews.length === 0) {
      this.errorString = "Please select at least one collection";
      this.showError = true;
      return;
    }

    this.addUserLoading = true;
    this.showError = false;
    try {
      const response = await this.store.api.shareDatasetView(
        selectedViews,
        this.newUserEmail,
        this.newUserAccessLevel,
      );

      if (typeof response === "string") {
        this.errorString =
          response === "badEmailOrUsername"
            ? "Unknown user. Please check the username or email."
            : "An error occurred";
        this.showError = true;
      } else {
        // Refresh the access list to show the new user
        if (this.dataset) {
          await this.fetchAccessInfo(this.dataset._id);
        }
        // Clear the form
        this.newUserEmail = "";
        this.newUserAccessLevel = 0;
      }
    } catch (error) {
      logError("Failed to add user", error);
      this.errorString = "Failed to add user";
      this.showError = true;
    } finally {
      this.addUserLoading = false;
    }
  }
}
</script>
