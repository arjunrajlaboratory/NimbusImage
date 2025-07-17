<template>
  <div>
    <v-alert :value="!store.isLoggedIn" color="info">Login to start</v-alert>
    <template v-if="store.isLoggedIn">
      <v-overlay
        :value="isNavigating"
        absolute
        color="white"
        opacity="0.8"
        z-index="9999"
      >
        <div class="loading-container">
          <v-progress-circular
            indeterminate
            size="128"
            color="primary"
            class="mb-4"
          ></v-progress-circular>
          <div class="loading-text">Loading dataset information...</div>
        </div>
      </v-overlay>
      <v-container class="home-container">
        <v-row class="home-row">
          <v-col class="fill-height">
            <section class="mb-4 home-section">
              <div class="d-flex justify-space-between align-center mb-4">
                <div class="text-h5">Upload dataset</div>
                <v-btn
                  id="try-sample-dataset-tourstep"
                  v-if="Boolean(zenodoCommunityId)"
                  color="success"
                  class="py-2 pulse-btn"
                  @click="showCommunityDisplay = true"
                  v-tour-trigger="'try-sample-dataset-tourtrigger'"
                >
                  <v-icon left size="20">mdi-database-import</v-icon>
                  Try a Sample Dataset
                </v-btn>
              </div>
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
                        @click="navigateToDatasetView(d.datasetView.id)"
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
                            <template v-if="d.datasetInfo.creatorId">
                              <br />
                              <span class="text-caption">
                                Owner:
                                {{
                                  getUserDisplayName(d.datasetInfo.creatorId)
                                }}
                              </span>
                            </template>
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
              <div class="d-flex justify-space-between align-center mb-4">
                <v-subheader class="headline section-title text-h5 pa-0"
                  >Browse</v-subheader
                >
                <v-btn-toggle
                  v-model="browseMode"
                  mandatory
                  dense
                  class="browse-toggle"
                >
                  <v-btn value="files" small>
                    <v-icon left small>mdi-folder</v-icon>
                    Datasets and Files
                  </v-btn>
                  <v-btn value="collections" small>
                    <v-icon left small>mdi-file-tree</v-icon>
                    Collections
                  </v-btn>
                </v-btn-toggle>
              </div>
              <div class="scrollable">
                <v-dialog
                  v-model="showZenodoImporter"
                  max-width="1000px"
                  scrollable
                >
                  <zenodo-importer
                    :dataset="selectedZenodoDataset"
                    @close="showZenodoImporter = false"
                  />
                </v-dialog>

                <!-- File Manager View -->
                <custom-file-manager
                  v-if="browseMode === 'files'"
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

                <!-- Collections View -->
                <collection-list v-else-if="browseMode === 'collections'" />
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

    <v-dialog v-model="showCommunityDisplay" max-width="1000px" scrollable>
      <zenodo-community-display
        :communityId="zenodoCommunityId"
        @close="showCommunityDisplay = false"
        @dataset-selected="handleSampleDatasetSelected"
      />
    </v-dialog>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import {
  IGirderFolder,
  IGirderLocation,
  IGirderSelectAble,
  IUPennCollection,
} from "@/girder";
import girderResources from "@/store/girderResources";
import {
  IDatasetView,
  WelcomeTourNames,
  WelcomeTourTypes,
  WelcomeTourStatus,
} from "@/store/model";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { Upload as GirderUpload } from "@/girder/components";
import FileDropzone from "@/components/Files/FileDropzone.vue";
import CustomFileManager from "@/components/CustomFileManager.vue";
import CollectionList from "@/components/CollectionList.vue";
import ZenodoImporter from "@/components/ZenodoImporter.vue";
import ZenodoCommunityDisplay from "@/components/ZenodoCommunityDisplay.vue";
import { isConfigurationItem, isDatasetFolder } from "@/utils/girderSelectable";
import { formatDateNumber } from "@/utils/date";
import { logError } from "@/utils/log";
import Persister from "@/store/Persister";

@Component({
  components: {
    GirderUpload,
    FileDropzone,
    GirderLocationChooser,
    CustomFileManager,
    CollectionList,
    ZenodoImporter,
    ZenodoCommunityDisplay,
  },
})
export default class Home extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;
  readonly isDatasetFolder = isDatasetFolder;
  // Normally, this environment variable would be set:
  // export VITE_ZENODO_SAMPLES="nimbusimagesampledatasets"
  readonly zenodoCommunityId = import.meta.env.VITE_ZENODO_SAMPLES || null;

  formatDateNumber = formatDateNumber; // Import function from utils/date.ts for use in template

  isNavigating: boolean = false;

  get location() {
    return this.store.folderLocation;
  }

  set location(location: IGirderLocation) {
    this.store.setFolderLocation(location);
  }

  isDraggingQuick: boolean = false;
  isDraggingAdvanced: boolean = false;
  showZenodoImporter: boolean = false;
  showCommunityDisplay: boolean = false;
  browseMode: "files" | "collections" = "files";

  private activeUploadType: "quick" | "advanced" | null = null;

  userDisplayNames: { [key: string]: string } = {};

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
      [configId: string]: IUPennCollection | null;
    } = {};
    for (const datasetView of this.datasetViews) {
      const id = datasetView.configurationId;
      const item = this.girderResources.watchCollection(id);
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

  async getUsernameFromId(
    creatorId: string,
  ): Promise<{ fullname: string; username: string }> {
    const user = await this.girderResources.getUser(creatorId);
    if (!user) {
      return { fullname: "Unknown User", username: "unknown" };
    }
    const fullname = `${user.firstName} ${user.lastName}`.trim();
    return {
      fullname: fullname || user.email, // fallback to email if no name set
      username: user.email,
    };
  }

  getUserDisplayName(creatorId: string): string {
    if (!this.userDisplayNames[creatorId]) {
      this.userDisplayNames[creatorId] = "Loading...";
      this.getUsernameFromId(creatorId).then((user) => {
        this.userDisplayNames[creatorId] =
          `${user.fullname} (${user.username})`;
      });
    }
    return this.userDisplayNames[creatorId];
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
      this.girderResources.getCollection(d.configurationId);
    }
  }

  mounted() {
    this.initializeRecentViews();
    this.refreshRecentDatasetDetails();
    this.initializeWelcomeTour();
    this.isNavigating = false; // Reset navigation state on mount
  }

  @Watch("store.isLoggedIn")
  onLoginStatusChange(isLoggedIn: boolean) {
    if (isLoggedIn) {
      // User has just logged in, try initializing the tour
      this.initializeWelcomeTour();
    }
  }

  async initializeWelcomeTour() {
    // Only proceed if the user is logged in
    if (!this.store.isLoggedIn) {
      return;
    }

    // Check if tour status exists, returns default of "notYetRun" if not
    // Note that currently, the value will never actually be NOT_YET_RUN, but
    // if we want to capture multiple statuses in the future, it might be useful.
    const tourStatus = Persister.get(
      WelcomeTourTypes.HOME,
      WelcomeTourStatus.NOT_YET_RUN,
    );

    // If it was the default value of NOT_YET_RUN, then update the status and start tour
    if (tourStatus === WelcomeTourStatus.NOT_YET_RUN) {
      Persister.set(WelcomeTourTypes.HOME, WelcomeTourStatus.ALREADY_RUN);
      this.$startTour(WelcomeTourNames[WelcomeTourTypes.HOME]);
    }
  }

  // Add a navigation guard for route changes
  @Watch("$route")
  onRouteChange() {
    this.isNavigating = false;
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
      this.girderResources.getCollection(d.configurationId);
    }
  }

  onLocationUpdate(selectable: IGirderSelectAble) {
    if (selectable._modelType === "upenn_collection") {
      return;
    }
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

  toggleZenodoImporter(): void {
    this.showZenodoImporter = true;
    // Scroll to the Browse section where the ZenodoImporter is displayed
    this.$nextTick(() => {
      const browseSection = document.querySelector(".home-row:nth-of-type(2)");
      if (browseSection) {
        browseSection.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  handleSampleDatasetSelected(dataset: any) {
    this.selectedZenodoDataset = dataset;
    this.showCommunityDisplay = false;
    this.showZenodoImporter = true;
  }

  selectedZenodoDataset: any = null;

  navigateToDatasetView(datasetViewId: string) {
    this.isNavigating = true;
    this.$router.push({
      name: "datasetview",
      params: {
        datasetViewId: datasetViewId,
      },
    });
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

.browse-toggle {
  .v-btn {
    text-transform: none;
    font-weight: 500;
    letter-spacing: 0;
  }
}

.section-title {
  padding: 0;
  height: auto;
  display: block;
}

.pulse-btn {
  animation: subtle-pulse 0.75s 1 ease-in-out;
  transition: all 0.3s ease;
  position: relative; /* Needed for the pseudo-element */
}

/* Use a pseudo-element for the pulsing effect to avoid affecting the button content */
.pulse-btn::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: inherit;
  box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.5);
  animation: subtle-pulse-shadow 9s 3 ease-in-out;
}

@keyframes subtle-pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes subtle-pulse-shadow {
  0% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.5);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(76, 175, 80, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0);
  }
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.loading-text {
  color: #424242; /* Dark gray text for contrast on white background */
  font-size: 1.5rem; /* Medium weight for better visibility */
  font-weight: 500; /* Medium weight for better visibility */
  margin-top: 16px; /* Space between spinner and text */
  text-align: center;
}
</style>

<style lang="scss">
.flex-window-items,
.flex-window-items .v-window-item {
  height: inherit;
}
</style>
