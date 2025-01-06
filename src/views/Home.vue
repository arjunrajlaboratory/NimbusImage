<template>
  <div>
    <v-alert :value="!store.isLoggedIn" color="info">Login to start</v-alert>
    <template v-if="store.isLoggedIn">
      <v-container class="home-container">
        <v-row class="home-row">
          <v-col class="fill-height">
            <section class="mb-4 home-section">
              <v-subheader class="headline mb-4 section-title text-h5"
                >Upload dataset</v-subheader
              >
              <v-row class="flex-column">
                <!-- Quick Upload -->
                <v-card
                  id="quick-upload-tab-tourstep"
                  class="mb-4 upload-card"
                  height="140"
                  :class="{ 'drag-active': isDraggingQuick }"
                  @click="openFileSelector('quick')"
                  @dragenter.prevent="isDraggingQuick = true"
                  @dragleave.prevent="onDragLeave('quick', $event)"
                  @dragover.prevent
                  @drop.prevent="handleQuickDrop"
                >
                  <v-overlay
                    :value="isDraggingQuick"
                    absolute
                    opacity="0.8"
                    class="d-flex align-center justify-center"
                  >
                    <div class="text-h6 white--text text-center">
                      Drop files here for quick upload
                    </div>
                  </v-overlay>

                  <v-card-text class="d-flex align-center fill-height">
                    <v-icon size="48" color="primary" class="mr-4"
                      >mdi-upload</v-icon
                    >
                    <div class="flex-grow-1">
                      <div class="text-h6 mb-1">Quick Upload</div>
                      <div class="text-body-2">
                        Click or drag here to directly upload files using
                        default options and go straight to the image viewer.
                      </div>
                      <div class="text-caption mt-2">
                        Dataset will be uploaded to folder:
                        <strong>{{ locationName }}</strong>
                        <br />
                        Collection will be created in same folder as dataset
                      </div>
                    </div>
                  </v-card-text>
                </v-card>

                <!-- Advanced Upload -->
                <v-card
                  id="advanced-upload-tab-tourstep"
                  class="upload-card"
                  height="140"
                  :class="{ 'drag-active': isDraggingAdvanced }"
                  @click="openFileSelector('advanced')"
                  @dragenter.prevent="isDraggingAdvanced = true"
                  @dragleave.prevent="onDragLeave('advanced', $event)"
                  @dragover.prevent
                  @drop.prevent="handleAdvancedDrop"
                >
                  <v-overlay
                    :value="isDraggingAdvanced"
                    absolute
                    opacity="0.8"
                    class="d-flex align-center justify-center"
                  >
                    <div class="text-h6 white--text text-center">
                      Drop files here for advanced upload
                    </div>
                  </v-overlay>

                  <v-card-text class="d-flex align-center fill-height">
                    <v-icon size="48" color="primary" class="mr-4"
                      >mdi-cog</v-icon
                    >
                    <div class="flex-grow-1">
                      <div class="text-h6 mb-1">Advanced Upload</div>
                      <div class="text-body-2">
                        Click or drag here to upload with custom options for
                        assigning variables, compositing tiles, and more.
                      </div>
                    </div>
                  </v-card-text>
                </v-card>
              </v-row>
            </section>
          </v-col>
          <v-col class="fill-height recent-dataset">
            <section class="mb-4 home-section">
              <v-subheader class="headline mb-4 section-title text-h5"
                >Recent datasets</v-subheader
              >
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
                        <v-list-item-action
                          class="my-0 d-flex flex-column justify-center"
                        >
                          <div class="text-caption grey--text text-left">
                            <div>Last accessed:</div>
                            <div style="line-height: 1.1">
                              {{ formatDateNumber(d.datasetView.lastViewed) }}
                            </div>
                          </div>
                        </v-list-item-action>
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
              <v-subheader class="headline mb-4 section-title text-h5"
                >Browse</v-subheader
              >
              <div class="scrollable">
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
              </div>
            </section>
          </v-col>
        </v-row>
      </v-container>
    </template>

    <!-- Hidden file input that enables native file selection when clicking upload cards -->
    <input
      type="file"
      ref="fileInput"
      multiple
      style="display: none"
      @change="handleFileSelect"
    />
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
import { formatDateNumber } from "@/utils/date";
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

  formatDateNumber = formatDateNumber; // Import function from utils/date.ts for use in template

  get location() {
    return this.store.folderLocation;
  }

  set location(location: IGirderLocation) {
    this.store.setFolderLocation(location);
  }

  isDraggingQuick: boolean = false;
  isDraggingAdvanced: boolean = false;

  private activeUploadType: "quick" | "advanced" | null = null;

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
    this.store.recentDatasetViews.forEach((datasetView: IDatasetView) => {
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

  handleQuickDrop(event: DragEvent) {
    this.isDraggingQuick = false;
    const files = Array.from(event.dataTransfer?.files || []);
    this.quickUpload(files);
  }

  handleAdvancedDrop(event: DragEvent) {
    this.isDraggingAdvanced = false;
    const files = Array.from(event.dataTransfer?.files || []);
    this.comprehensiveUpload(files);
  }

  openFileSelector(type: "quick" | "advanced") {
    this.activeUploadType = type;
    const input = this.$refs.fileInput as HTMLInputElement;
    input.click();
  }

  handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);

    if (this.activeUploadType === "quick") {
      this.quickUpload(files);
    } else {
      this.comprehensiveUpload(files);
    }

    // Reset the input
    input.value = "";
    this.activeUploadType = null;
  }

  onDragLeave(type: "quick" | "advanced", event: DragEvent) {
    // Check if we're leaving the card and not entering a child element
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;

    // Check if the mouse has actually left the card boundaries
    if (
      x <= rect.left ||
      x >= rect.right ||
      y <= rect.top ||
      y >= rect.bottom
    ) {
      if (type === "quick") {
        this.isDraggingQuick = false;
      } else {
        this.isDraggingAdvanced = false;
      }
    }
  }
}
</script>

<style lang="scss" scoped>
.home-container {
  height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
}

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

.home-section {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.scrollable {
  overflow-y: auto;
  flex-grow: 1;
  min-height: 0;
}

.drag-active {
  border: 2px dashed white;
}

.upload-card {
  cursor: pointer;
  border: 2px dashed rgba(255, 255, 255, 0.3);

  &.drag-active {
    border: 2px dashed var(--v-primary-base);
    background-color: rgba(var(--v-primary-base), 0.1);
  }
}

.section-title {
  padding: 0;
  height: auto;
  display: block;
}
</style>

<style lang="scss">
.flex-window-items,
.flex-window-items .v-window-item {
  height: inherit;
}
</style>
