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
          {{ userErrorString }}
        </v-alert>
        <v-alert
          v-if="isDatasetPublic"
          type="info"
          dense
          dismissible
          class="mb-4"
        >
          This dataset is already public and accessible to everyone without
          login.
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
                <div v-if="associatedViews.length === 0">
                  No associated collections found.
                </div>
                <div v-else>
                  <p>Select collections to share with:</p>
                  <v-checkbox
                    v-for="view in associatedViews"
                    :key="view.id"
                    v-model="selectedDatasetViews"
                    :label="view.configurationName"
                    :value="view.id"
                    :hide-details="true"
                    :dense="true"
                  ></v-checkbox>
                </div>
              </div>
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12">
              <v-checkbox
                v-model="isPublicSelected"
                label="Make Public (accessible to everyone without login)"
                class="mt-2"
                dense
                hide-details
              ></v-checkbox>
              <v-text-field
                v-model="usernameOrEmail"
                label="Username or Email to share with"
                class="mt-2"
                dense
                outlined
                hide-details
                :disabled="isPublicSelected"
                :required="!isPublicSelected"
              ></v-text-field>
              <v-radio-group
                v-model="accessLevel"
                row
                class="mt-2"
                hide-details
                :disabled="isPublicSelected"
              >
                <v-radio label="Private" :value="-1"></v-radio>
                <v-radio label="View access" :value="0"></v-radio>
                <v-radio label="Write access" :value="1"></v-radio>
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
            selectedDatasetViews.length === 0 ||
            (!isPublicSelected && !usernameOrEmail) ||
            isSharing
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
import { IDatasetView } from "@/store/model";
import { toDatasetFolder } from "@/utils/girderSelectable";

interface DatasetViewAndConfigurationName extends IDatasetView {
  configurationName: string;
}

@Component
export default class ShareDataset extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  @Prop({ required: true }) readonly dataset!: IGirderSelectAble | null;
  @Prop({ default: false }) readonly value!: boolean;

  dialog = false;
  loading = false;
  selectedDatasetViews: string[] = [];
  usernameOrEmail: string = "";
  isSharing: boolean = false;
  userErrorString: string = "";
  showUserError: boolean = false;
  accessLevel: number = -1;
  isPublicSelected: boolean = false;
  associatedViews: DatasetViewAndConfigurationName[] = [];

  get isDatasetPublic(): boolean {
    if (!this.dataset) {
      return false;
    }
    const folder = toDatasetFolder(this.dataset);
    return folder?.public === true;
  }

  @Watch("value")
  onValueChanged(val: boolean) {
    this.dialog = val;
    if (val && this.dataset) {
      this.fetchCollectionInfos(this.dataset._id);
      // Sync isPublicSelected checkbox with actual public status
      const folder = toDatasetFolder(this.dataset);
      this.isPublicSelected = folder?.public === true;
    } else {
      // Reset when dialog closes
      this.selectedDatasetViews = [];
      this.usernameOrEmail = "";
      this.userErrorString = "";
      this.showUserError = false;
      this.isSharing = false;
      this.accessLevel = -1;
      this.isPublicSelected = false;
      this.associatedViews = [];
    }
  }

  @Watch("dialog")
  onDialogChanged(val: boolean) {
    this.$emit("input", val);
  }

  async fetchCollectionInfos(datasetId: string) {
    this.loading = true;
    this.selectedDatasetViews = [];
    this.associatedViews = [];
    try {
      const views = await this.store.api.findDatasetViews({ datasetId });
      views.map(async (view: IDatasetView) => {
        try {
          const configInfo = await this.girderResources.getCollection(
            view.configurationId,
          );
          if (configInfo) {
            this.associatedViews.push(
              Object.assign(view, {
                configurationName: configInfo.name,
              }),
            );
            this.selectedDatasetViews.push(view.id);
          }
        } catch (error) {
          logError(
            `Failed to fetch collection info for ID: ${view.configurationId}`,
            error,
          );
        }
        return null;
      });
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
    this.isSharing = true;
    this.showUserError = false;
    this.userErrorString = "";

    try {
      if (this.isPublicSelected) {
        // Use the dedicated setDatasetPublic endpoint
        if (!this.dataset) {
          throw new Error("Dataset not found");
        }
        await this.store.api.setDatasetPublic(this.dataset._id, true);
        this.close();
      } else {
        // Use the shareDatasetView endpoint for user sharing
        const response = await this.store.api.shareDatasetView(
          this.associatedViews.filter((datasetView) =>
            this.selectedDatasetViews.includes(datasetView.id),
          ),
          this.usernameOrEmail,
          this.accessLevel,
          false,
        );

        if (typeof response === "string") {
          this.userErrorString =
            response === "badEmailOrUsername"
              ? "Unknown user"
              : "An unknown error occurred";
          this.showUserError = true;
        } else {
          this.close();
        }
      }
    } catch (error) {
      logError("Failed to share dataset", error);
      this.userErrorString = "An error occurred while sharing the dataset";
      this.showUserError = true;
    } finally {
      this.isSharing = false;
    }
  }
}
</script>
