<template>
  <v-container>
    <alert-dialog ref="alert" />
    <v-container class="d-flex">
      <v-spacer />
      <v-dialog v-model="removeConfirm" max-width="33vw">
        <template #activator="{ on }">
          <v-btn color="red" v-on="on" :disabled="!store.configuration">
            <v-icon left>mdi-close</v-icon>
            Delete Collection
          </v-btn>
        </template>
        <v-card>
          <v-card-title>
            Are you sure you want to delete "{{ name }}" forever?
          </v-card-title>
          <v-card-actions class="button-bar">
            <v-btn @click="removeConfirm = false">Cancel</v-btn>
            <v-btn @click="remove" color="warning">Remove</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
    <v-text-field
      v-model="nameInput"
      label="Name"
      :disabled="!store.configuration"
      @blur="onNameBlur"
      @keyup.enter="onNameEnter"
    />
    <v-textarea :value="description" label="Description" readonly />
    <v-card class="mb-4">
      <v-card-title> Datasets </v-card-title>
      <v-card-text>
        <v-dialog
          v-model="removeDatasetViewConfirm"
          max-width="33vw"
          v-if="viewToRemove"
        >
          <v-card>
            <v-card-title>
              Are you sure you want to remove the view for dataset "{{
                datasetInfoCache[viewToRemove.datasetId]
                  ? datasetInfoCache[viewToRemove.datasetId].name
                  : "Unnamed dataset"
              }}"?
            </v-card-title>
            <v-card-actions class="button-bar">
              <v-btn @click="closeRemoveDatasetDialog()"> Cancel </v-btn>
              <v-btn @click="removeDatasetView()" color="warning">
                Remove
              </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
        <v-list>
          <v-list-item v-for="d in datasetViewItems" :key="d.datasetView.id">
            <v-list-item-content>
              <v-list-item-title>
                {{ d.datasetInfo ? d.datasetInfo.name : "Unnamed dataset" }}
              </v-list-item-title>
              <v-list-item-subtitle>
                {{
                  d.datasetInfo ? d.datasetInfo.description : "No description"
                }}
              </v-list-item-subtitle>
              <div
                v-if="
                  datasetCompatibilityWarnings[d.datasetView.datasetId] &&
                  datasetCompatibilityWarnings[d.datasetView.datasetId].length >
                    0
                "
                class="compatibility-warnings mt-1"
              >
                <v-chip
                  v-for="(warning, index) in datasetCompatibilityWarnings[
                    d.datasetView.datasetId
                  ]"
                  :key="index"
                  small
                  color="warning"
                  text-color="white"
                  class="mr-1 mb-1"
                >
                  <v-icon small left>mdi-alert</v-icon>
                  {{ warning }}
                </v-chip>
              </div>
            </v-list-item-content>
            <v-list-item-action>
              <span class="button-bar">
                <v-btn
                  color="warning"
                  v-on:click.stop="openRemoveDatasetDialog(d.datasetView)"
                >
                  <v-icon left>mdi-close</v-icon>remove
                </v-btn>
                <v-btn color="primary" :to="toRoute(d.datasetView)">
                  <v-icon left>mdi-eye</v-icon>
                  view
                </v-btn>
              </span>
            </v-list-item-action>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions class="d-block">
        <v-divider />
        <div class="clickable-flex pa-2 body" @click="addDatasetDialog = true">
          <v-icon class="pr-2" color="primary">mdi-plus-circle</v-icon>
          Add dataset to current collection
        </div>
        <v-dialog
          content-class="smart-overflow"
          v-model="addDatasetDialog"
          width="60%"
        >
          <add-dataset-to-collection
            v-if="configuration"
            :collection="configuration"
            @addedDatasets="addedDatasets"
            @done="addDatasetDialog = false"
            @warning="openAlert({ type: 'warning', message: $event })"
            @error="openAlert({ type: 'error', message: $event })"
          />
        </v-dialog>
      </v-card-actions>
    </v-card>
    <v-card class="mb-4">
      <v-card-title> Layers </v-card-title>
      <v-card-text>
        <v-list two-line>
          <v-list-item v-for="l in layers" :key="l.name">
            <v-list-item-avatar>
              <v-icon :color="l.color">mdi-circle</v-icon>
            </v-list-item-avatar>
            <v-list-item-content>
              <v-list-item-title>
                {{ l.name }}{{ !l.visible ? "(hidden)" : "" }}
              </v-list-item-title>
              <v-list-item-subtitle>
                Channel: <code class="code">{{ l.channel }}</code> Z-Slice:
                <code class="code">{{ toSlice(l.z) }}</code> Time-Slice:
                <code class="code">{{ toSlice(l.time) }}</code>
              </v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
    <v-card class="mb-4">
      <v-card-title> Scale </v-card-title>
      <v-card-text>
        <scale-settings :configuration-only="true" />
      </v-card-text>
    </v-card>
  </v-container>
</template>
<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IDatasetView, IDisplaySlice, areCompatibles } from "@/store/model";
import { getDatasetCompatibility } from "@/store/GirderAPI";
import { IGirderFolder } from "@/girder";
import ScaleSettings from "@/components/ScaleSettings.vue";
import AddDatasetToCollection from "@/components/AddDatasetToCollection.vue";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";

@Component({
  components: { AddDatasetToCollection, AlertDialog, ScaleSettings },
})
export default class ConfigurationInfo extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  readonly $refs!: {
    alert: AlertDialog;
  };

  removeConfirm = false;

  removeDatasetViewConfirm = false;
  viewToRemove: IDatasetView | null = null;

  datasetViews: IDatasetView[] = [];
  datasetInfoCache: { [datasetId: string]: IGirderFolder } = {};
  datasetCompatibilityWarnings: { [datasetId: string]: string[] } = {};

  addDatasetDialog: boolean = false;

  nameInput: string = "";

  get name() {
    if (!store.configuration) return "";
    // Use reactive cache to get latest name after rename
    const cached = girderResources.watchCollection(store.configuration.id);
    return cached?.name ?? store.configuration.name;
  }

  get description() {
    return this.store.configuration ? this.store.configuration.description : "";
  }

  get layers() {
    return this.store.layers;
  }

  get configuration() {
    return this.store.configuration;
  }

  mounted() {
    this.updateConfigurationViews();
    this.nameInput = this.name;
  }

  openAlert(alert: IAlert) {
    this.addDatasetDialog = false;
    this.$refs.alert.openAlert(alert);
  }

  addedDatasets() {
    this.addDatasetDialog = false;
    this.updateConfigurationViews();
  }

  @Watch("configuration")
  async updateConfigurationViews() {
    if (this.configuration) {
      this.datasetViews = await this.store.api.findDatasetViews({
        configurationId: this.configuration.id,
      });
    } else {
      this.datasetViews = [];
    }
    return this.datasetViews;
  }

  @Watch("name")
  syncNameInput() {
    this.nameInput = this.name;
  }

  onNameBlur() {
    this.tryRename();
  }

  onNameEnter() {
    this.tryRename();
  }

  tryRename() {
    const trimmed = (this.nameInput || "").trim();
    if (!this.store.configuration) return;
    if (trimmed.length === 0 || trimmed === this.name) return;
    this.store.renameConfiguration(trimmed);
  }

  get datasetViewItems(): {
    datasetView: IDatasetView;
    datasetInfo: IGirderFolder | undefined;
  }[] {
    return this.datasetViews.map((datasetView) => ({
      datasetView,
      datasetInfo: this.datasetInfoCache[datasetView.datasetId],
    }));
  }

  @Watch("datasetViews")
  fetchDatasetsInfo() {
    for (const datasetView of this.datasetViews) {
      this.girderResources
        .getFolder(datasetView.datasetId)
        .then((folder) =>
          Vue.set(this.datasetInfoCache, datasetView.datasetId, folder),
        );
    }
    this.checkDatasetsCompatibility();
  }

  async checkDatasetsCompatibility() {
    if (!this.configuration) {
      return;
    }
    const configCompat = this.configuration.compatibility;
    if (!configCompat) {
      return;
    }

    // Clear old warnings
    this.datasetCompatibilityWarnings = {};

    for (const datasetView of this.datasetViews) {
      try {
        const dataset = await this.girderResources.getDataset({
          id: datasetView.datasetId,
        });
        if (!dataset) {
          continue;
        }

        const datasetCompat = getDatasetCompatibility(dataset);
        if (!areCompatibles(configCompat, datasetCompat)) {
          const warnings: string[] = [];

          if (configCompat.xyDimensions !== datasetCompat.xyDimensions) {
            warnings.push(
              `XY: Dataset has ${datasetCompat.xyDimensions}, collection expects ${configCompat.xyDimensions}`,
            );
          }
          if (configCompat.zDimensions !== datasetCompat.zDimensions) {
            warnings.push(
              `Z: Dataset has ${datasetCompat.zDimensions}, collection expects ${configCompat.zDimensions}`,
            );
          }
          if (configCompat.tDimensions !== datasetCompat.tDimensions) {
            warnings.push(
              `T: Dataset has ${datasetCompat.tDimensions}, collection expects ${configCompat.tDimensions}`,
            );
          }

          // Check channel differences
          const configChannelKeys = Object.keys(configCompat.channels).sort();
          const datasetChannelKeys = Object.keys(datasetCompat.channels).sort();
          if (configChannelKeys.join(",") !== datasetChannelKeys.join(",")) {
            const datasetCount = datasetChannelKeys.length;
            const configCount = configChannelKeys.length;
            if (datasetCount !== configCount) {
              warnings.push(
                `Channels: Dataset has ${datasetCount}, collection expects ${configCount}`,
              );
            } else {
              // Same count but different channel indices
              const datasetNames = datasetChannelKeys
                .map((k) => datasetCompat.channels[parseInt(k)])
                .join(", ");
              const configNames = configChannelKeys
                .map((k) => configCompat.channels[parseInt(k)])
                .join(", ");
              warnings.push(
                `Channels: Dataset has [${datasetNames}], collection expects [${configNames}]`,
              );
            }
          }

          if (warnings.length > 0) {
            Vue.set(
              this.datasetCompatibilityWarnings,
              datasetView.datasetId,
              warnings,
            );
          }
        }
      } catch (err) {
        // Silently skip datasets that fail to load
      }
    }
  }

  toRoute(datasetView: IDatasetView) {
    return {
      name: "datasetview",
      params: Object.assign({}, this.$route.params, {
        datasetViewId: datasetView.id,
      }),
    };
  }

  openRemoveDatasetDialog(datasetView: IDatasetView) {
    this.removeDatasetViewConfirm = true;
    this.viewToRemove = datasetView;
  }

  closeRemoveDatasetDialog() {
    this.removeDatasetViewConfirm = false;
    this.viewToRemove = null;
  }

  removeDatasetView() {
    if (!this.viewToRemove) {
      return;
    }
    const promise = this.store.deleteDatasetView(this.viewToRemove);
    if (promise) {
      promise.then(() => {
        this.removeDatasetViewConfirm = false;
        this.viewToRemove = null;
        this.updateConfigurationViews();
      });
    }
  }

  toSlice(slice: IDisplaySlice) {
    switch (slice.type) {
      case "constant":
        return String(slice.value);
      case "max-merge":
        return "Max Merge";
      case "offset":
        return `Offset by ${slice.value}`;
      default:
        return "Current";
    }
  }

  remove() {
    this.store.deleteConfiguration(this.store.configuration!).then(() => {
      this.removeConfirm = false;
      this.$router.back();
    });
  }
}
</script>

<style lang="scss" scoped>
.code {
  margin: 0 1em 0 0.5em;
}

.compatibility-warnings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
</style>

<style lang="scss">
.clickable-flex {
  display: flex;
  align-items: center;
  cursor: pointer;
}
</style>
