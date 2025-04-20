<template>
  <v-dialog v-model="dialog" max-width="600px">
    <v-card>
      <v-card-title>Share Dataset</v-card-title>
      <v-card-text>
        <v-alert
          v-model="showUserError"
          type="error"
          dense
          dismissible
          class="mb-4"
        >
          Unknown user
        </v-alert>
        <v-container>
          <v-row>
            <v-col cols="4">
              <strong>Dataset:</strong>
              <div>{{ dataset ? dataset.name : "" }}</div>
            </v-col>
            <v-col cols="8">
              <div v-if="loading">Loading collections...</div>
              <div v-else>
                <div v-if="associatedCollections.length === 0">
                  No associated collections found.
                </div>
                <div v-else>
                  <p>Select collections to share with:</p>
                  <v-checkbox
                    v-for="collection in associatedCollections"
                    :key="collection.id"
                    v-model="selectedCollections"
                    :label="collection.name"
                    :value="collection.id"
                    :hide-details="true"
                    :dense="true"
                  ></v-checkbox>
                </div>
              </div>
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12">
              <v-text-field
                v-model="usernameOrEmail"
                label="Username or Email to share with"
                class="mt-2"
                dense
                outlined
                hide-details
              ></v-text-field>
              <v-radio-group
                v-model="accessLevel"
                row
                class="mt-2"
                hide-details
              >
                <v-radio label="Private" value="private"></v-radio>
                <v-radio label="View access" value="view"></v-radio>
                <v-radio label="Write access" value="write"></v-radio>
              </v-radio-group>
            </v-col>
          </v-row>
        </v-container>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn color="grey darken-1" text @click="close">Cancel</v-btn>
        <v-btn
          color="blue darken-1"
          text
          @click="share"
          :loading="isSharing"
          :disabled="
            selectedCollections.length === 0 || !usernameOrEmail || isSharing
          "
        >
          Share
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import { IGirderSelectAble } from "@/girder";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { logError } from "@/utils/log";

interface CollectionInfo {
  id: string;
  name: string;
}

@Component
export default class ShareDataset extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  @Prop({ required: true }) readonly dataset!: IGirderSelectAble | null;
  @Prop({ default: false }) readonly value!: boolean;

  dialog = false;
  loading = false;
  associatedCollections: CollectionInfo[] = [];
  selectedCollections: string[] = [];
  usernameOrEmail: string = "";
  isSharing: boolean = false;
  showUserError: boolean = false;
  accessLevel: string = "private";

  @Watch("value")
  onValueChanged(val: boolean) {
    this.dialog = val;
    if (val && this.dataset) {
      this.fetchAssociatedCollections(this.dataset._id);
    } else {
      // Reset when dialog closes
      this.associatedCollections = [];
      this.selectedCollections = [];
      this.usernameOrEmail = "";
      this.showUserError = false;
      this.isSharing = false;
      this.accessLevel = "private";
    }
  }

  @Watch("dialog")
  onDialogChanged(val: boolean) {
    this.$emit("input", val);
  }

  async fetchAssociatedCollections(datasetId: string) {
    this.loading = true;
    this.associatedCollections = [];
    this.selectedCollections = [];
    try {
      const views = await this.store.api.findDatasetViews({ datasetId });
      const collectionPromises = views.map(async (view) => {
        try {
          const configInfo = await this.girderResources.getItem(
            view.configurationId,
          );
          if (configInfo) {
            return { id: configInfo._id, name: configInfo.name };
          }
        } catch (error) {
          logError(
            `Failed to fetch collection info for ID: ${view.configurationId}`,
            error,
          );
        }
        return null;
      });
      const collections = (await Promise.all(collectionPromises)).filter(
        (c) => c !== null,
      ) as CollectionInfo[];
      this.associatedCollections = collections;
      // Select all collections by default
      this.selectedCollections = collections.map((c) => c.id);
    } catch (error) {
      logError(
        `Failed to fetch associated collections for dataset ${datasetId}`,
        error,
      );
      // Optionally show an error message to the user
    } finally {
      this.loading = false;
    }
  }

  close() {
    this.dialog = false;
  }

  async share() {
    this.showUserError = false; // Reset error on new attempt

    // Custom validation: fail if username is 'fail'
    const isValidUser = this.usernameOrEmail.toLowerCase() !== "fail";

    if (!isValidUser) {
      this.showUserError = true;
      return;
    }

    this.isSharing = true;

    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1000));

    this.isSharing = false;

    // Placeholder for actual share logic
    console.log(
      `Sharing dataset ${this.dataset?.name} (ID: ${this.dataset?._id}) with collections: ${this.selectedCollections.join(", ")} to user ${this.usernameOrEmail} with ${this.accessLevel} access`,
    );
    this.close(); // Close dialog on successful share
  }
}
</script>
