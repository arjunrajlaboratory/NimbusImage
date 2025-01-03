<template>
  <div>
    <v-alert :value="!store.isLoggedIn" color="info">Login to start</v-alert>
    <template v-if="store.isLoggedIn">
      <v-container class="home-container">
        <v-row class="home-row">
          <v-col class="fill-height">
            <section class="mb-4 home-section">
              <v-subheader class="headline mb-4">Upload dataset</v-subheader>
              <v-card>
                <v-tabs v-model="uploadTab">
                  <span
                    id="quick-upload-tab-tourstep"
                    v-tooltip="
                      'Directly upload a file using all default options and then go straight to the image viewer'
                    "
                    style="display: flex"
                  >
                    <v-tab> Quick upload/view </v-tab>
                  </span>
                  <span
                    id="advanced-upload-tab-tourstep"
                    v-tooltip="
                      'Upload a dataset with the option to assign variables to files, composite tiles, and more'
                    "
                    style="display: flex"
                  >
                    <v-tab v-tour-trigger="'advanced-upload-tab-tourtrigger'">
                      Advanced upload
                    </v-tab>
                  </span>
                </v-tabs>
              </v-card>
              <v-tabs-items v-model="uploadTab" class="flex-window-items">
                <v-tab-item>
                  <file-dropzone @input="quickUpload">
                    <template #afterMessage>
                      <span class="caption d-flex">
                        <div>
                          Dataset will be uploaded to:
                          <strong>{{ locationName }}</strong>
                          <br />
                          Collection will be created in same folder as dataset
                        </div>
                      </span>
                    </template>
                  </file-dropzone>
                </v-tab-item>
                <v-tab-item>
                  <file-dropzone @input="comprehensiveUpload" />
                </v-tab-item>
              </v-tabs-items>
            </section>
          </v-col>
          <v-col class="fill-height recent-dataset">
            <section class="mb-4 home-section">
              <v-subheader class="headline mb-4">Recent datasets</v-subheader>
              <v-list two-line class="scrollable py-0">
                <div v-for="d in datasetViewItems" :key="d.datasetView.id">
                  <v-tooltip
                    top
                    :disabled="
                      !d.datasetInfo.description && !d.configInfo.description
                    "
                  >
                    <template v-slot:activator="{ on, attrs }">
                      <v-list-item
                        @click="
                          $router.push({
                            name: 'datasetview',
                            params: {
                              datasetViewId: d.datasetView.id,
                            },
                          })
                        "
                      >
                        <v-list-item-content v-bind="attrs" v-on="on">
                          <v-list-item-title>
                            {{
                              d.datasetInfo.name
                                ? d.datasetInfo.name
                                : "Unnamed dataset"
                            }}
                          </v-list-item-title>
                          <v-list-item-subtitle>
                            {{
                              d.configInfo.name
                                ? d.configInfo.name
                                : "Unnamed configuration"
                            }}
                          </v-list-item-subtitle>
                        </v-list-item-content>
                      </v-list-item>
                    </template>
                    <div v-if="d.datasetInfo.description">
                      {{ d.datasetInfo.description }}
                    </div>
                    <v-divider />
                    <div v-if="d.configInfo.description">
                      {{ d.configInfo.description }}
                    </div>
                  </v-tooltip>
                </div>
              </v-list>
            </section>
          </v-col>
        </v-row>
        <v-row class="home-row">
          <v-col class="fill-height">
            <section class="mb-4 home-section">
              <v-subheader class="headline mb-4">Browse</v-subheader>
              <custom-file-manager
                :location="location"
                @update:location="onLocationUpdate"
                :initial-items-per-page="100"
                :items-per-page-options="[10, 20, 50, 100, -1]"
              >
                <template #options="{ items }">
                  <!--
                    Add an option to open the dataset folder in the file browser.
                    When clicking the dataset, the user is taken to the dataset route.
                  -->
                  <template
                    v-if="items.length === 1 && isDatasetFolder(items[0])"
                  >
                    <v-list-item @click="location = items[0]">
                      <v-list-item-title> Browse </v-list-item-title>
                    </v-list-item>
                  </template>
                </template>
              </custom-file-manager>
            </section>
          </v-col>
        </v-row>
      </v-container>
    </template>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import {
  IGirderFolder,
  IGirderItem,
  IGirderLocation,
  IGirderSelectAble,
} from "@/girder";
import girderResources from "@/store/girderResources";
import { IDatasetView } from "@/store/model";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { Upload as GirderUpload } from "@/girder/components";
import FileDropzone from "@/components/Files/FileDropzone.vue";
import CustomFileManager from "@/components/CustomFileManager.vue";
import { isConfigurationItem, isDatasetFolder } from "@/utils/girderSelectable";
import { logError } from "@/utils/log";

@Component({
  components: {
    GirderUpload,
    FileDropzone,
    GirderLocationChooser,
    CustomFileManager,
  },
})
export default class Home extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;
  readonly isDatasetFolder = isDatasetFolder;

  get location() {
    return this.store.folderLocation;
  }

  set location(location: IGirderLocation) {
    this.store.setFolderLocation(location);
  }

  uploadTab: number = 0;

  get locationName() {
    // @ts-ignore: name or login may be undefined, but this case is checked
    const name: string = this.location.name || this.location.login;
    if (name) {
      return name;
    }
    // @ts-ignore: same reason as for name and login
    const alternative: string = this.location.type || this.location._modelType;
    if (alternative) {
      // Capitalize first letter
      return alternative[0].toUpperCase() + alternative.slice(1);
    }
    return "Unknown location name";
  }

  get datasetViews() {
    const result: IDatasetView[] = [];
    const used: Set<string> = new Set();
    this.store.recentDatasetViews.forEach((datasetView) => {
      if (!used.has(datasetView.id)) {
        used.add(datasetView.id);
        result.push(datasetView);
      }
    });
    return result;
  }

  get datasetInfo() {
    const infos: {
      [datasetId: string]: IGirderFolder | null;
    } = {};
    for (const datasetView of this.datasetViews) {
      const id = datasetView.datasetId;
      const folder = this.girderResources.watchFolder(id);
      infos[id] = folder || null;
    }
    return infos;
  }

  get configInfo() {
    const infos: {
      [configId: string]: IGirderItem | null;
    } = {};
    for (const datasetView of this.datasetViews) {
      const id = datasetView.configurationId;
      const item = this.girderResources.watchItem(id);
      infos[id] = item || null;
    }
    return infos;
  }

  get datasetViewItems() {
    const items = [];
    for (const datasetView of this.datasetViews) {
      const configInfo = this.configInfo[datasetView.configurationId];
      const datasetInfo = this.datasetInfo[datasetView.datasetId];
      if (!configInfo || !datasetInfo) {
        continue;
      }
      items.push({ datasetView, configInfo, datasetInfo });
    }
    return items;
  }

  @Watch("datasetViews")
  @Watch("girderResources.resources")
  fetchDatasetsAndConfigurations() {
    if (Object.keys(girderResources.resourcesLocks).length > 0) {
      // Some resources will be set later, don't spam getFolder and getItem
      return;
    }
    for (const d of this.datasetViews) {
      this.girderResources.getFolder(d.datasetId);
      this.girderResources.getItem(d.configurationId);
    }
  }

  mounted() {
    this.initializeRecentViews();
    this.refreshRecentDatasetDetails();
  }

  private async initializeRecentViews() {
    try {
      await this.store.fetchRecentDatasetViews();
    } catch (error) {
      logError("Failed to initialize recent views:", error);
    }
  }

  refreshRecentDatasetDetails() {
    for (const d of this.datasetViews) {
      this.girderResources.getFolder(d.datasetId);
      this.girderResources.getItem(d.configurationId);
    }
  }

  onLocationUpdate(selectable: IGirderSelectAble) {
    if (isDatasetFolder(selectable)) {
      this.$router.push({
        name: "dataset",
        params: { datasetId: selectable._id },
      });
    } else if (isConfigurationItem(selectable)) {
      this.$router.push({
        name: "configuration",
        params: { configurationId: selectable._id },
      });
    } else if (
      selectable._modelType !== "file" &&
      selectable._modelType !== "item"
    ) {
      this.location = selectable;
    }
  }

  quickUpload(files: File[]) {
    // Use params to pass props to NewDataset component
    // RouteConfig in src/view/dataset/index.ts has to support it
    this.$router.push({
      name: "newdataset",
      params: {
        quickupload: true,
        defaultFiles: files,
        initialUploadLocation: this.location,
      } as any,
    });
  }

  comprehensiveUpload(files: File[]) {
    // Use params to pass props to NewDataset component
    // RouteConfig in src/view/dataset/index.ts has to support it
    this.$router.push({
      name: "newdataset",
      params: {
        defaultFiles: files,
        initialUploadLocation: this.location,
      } as any,
    });
  }
}
</script>

<style lang="scss" scoped>
.home-row {
  flex-wrap: nowrap;
}

.home-row:nth-of-type(1) {
  height: 40%;
}

.home-row:nth-of-type(2) {
  height: 60%;
}

.recent-dataset {
  max-width: 60%;
}

.home-container {
  height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
}

.home-section {
  display: flex;
  flex-direction: column;
  height: inherit;
}

.scrollable {
  overflow-y: auto;
  min-height: 0;
  height: inherit;
}
</style>

<style lang="scss">
.flex-window-items,
.flex-window-items .v-window-item {
  height: inherit;
}
</style>
