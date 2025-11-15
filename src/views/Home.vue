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
        <header class="home-header mb-3">
          <h1 class="text-h4 font-weight-bold">NimbusImage</h1>
        </header>
        <v-row class="home-row">
          <v-col class="fill-height">
            <section class="mb-4 home-section">
              <!-- Upload Files -->
              <v-card
                id="upload-files-tourstep"
                class="upload-card fill-height"
                :class="{ 'drag-active': isDragging }"
                @click="openFileSelector"
                @dragenter.prevent="isDragging = true"
                @dragleave.prevent="onDragLeave($event)"
                @dragover.prevent
                @drop.prevent="handleDrop"
              >
                <v-overlay
                  :value="isDragging"
                  absolute
                  opacity="0.8"
                  class="d-flex align-center justify-center"
                >
                  <div class="text-h6 white--text text-center">
                    Drop files here to upload
                  </div>
                </v-overlay>

                <v-card-text
                  class="d-flex flex-column align-center justify-center fill-height"
                >
                  <v-icon size="64" color="primary" class="mb-4"
                    >mdi-upload</v-icon
                  >
                  <div class="text-center">
                    <div class="text-h6 mb-2">Upload files</div>
                    <div class="text-body-2 mb-2">
                      Click or drag here to upload files. You can choose to
                      accept default settings or configure advanced options
                      after selecting files.
                    </div>
                    <div class="text-caption">
                      Dataset will be uploaded to folder:
                      <strong>{{ locationName }}</strong>
                    </div>
                  </div>
                </v-card-text>
              </v-card>
            </section>
          </v-col>
          <v-col class="fill-height recent-dataset">
            <section class="mb-4 home-section">
              <v-tabs v-model="datasetsTab">
                <v-tab>Recent Datasets</v-tab>
                <v-tab
                  v-if="Boolean(zenodoCommunityId)"
                  id="try-sample-dataset-tourstep"
                  v-tour-trigger="'try-sample-dataset-tourtrigger'"
                >
                  Sample Datasets
                </v-tab>
              </v-tabs>
              <v-tabs-items v-model="datasetsTab" class="fill-height">
                <v-tab-item class="fill-height">
                  <recent-datasets
                    :dataset-view-items="datasetViewItems"
                    :get-user-display-name="getUserDisplayName"
                    :format-date-number="formatDateNumber"
                    @dataset-clicked="navigateToDatasetView"
                    class="fill-height"
                  />
                </v-tab-item>
                <v-tab-item
                  v-if="Boolean(zenodoCommunityId)"
                  class="fill-height"
                >
                  <zenodo-community-display
                    :communityId="zenodoCommunityId"
                    :embedded="true"
                    @dataset-selected="handleSampleDatasetSelected"
                    class="fill-height"
                  />
                </v-tab-item>
              </v-tabs-items>
            </section>
          </v-col>
        </v-row>
        <v-divider class="my-4"></v-divider>
        <v-row class="home-row">
          <v-col class="fill-height">
            <section class="mb-4 home-section">
              <div class="d-flex align-center mb-4">
                <v-subheader class="headline section-title text-h5 pa-0 mr-4"
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

    <!-- Upload Choice Dialog -->
    <v-dialog v-model="showUploadDialog" max-width="500px" persistent>
      <v-card>
        <v-card-title class="headline">Upload Files</v-card-title>
        <v-card-text>
          <div class="mb-4">
            <v-icon color="primary" class="mr-2">mdi-file-multiple</v-icon>
            <span class="text-body-1">
              {{ pendingFiles.length }}
              {{ pendingFiles.length === 1 ? "file" : "files" }} selected
            </span>
          </div>
          <v-alert type="info" text class="mb-4">
            <strong>Accept defaults</strong> to let NimbusImage try to
            automatically read and configure your files for viewing and
            analysis. <br /><br />
            <strong>Configure dataset</strong> if you want to adjust how your
            dataset is configured, including adjusting how dimensions are
            configured and file transcoding options.
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn text @click="closeUploadDialog">Cancel</v-btn>
          <v-btn
            id="accept-defaults-button-tourstep"
            color="primary"
            v-tour-trigger="'accept-defaults-tourtrigger'"
            @click="handleAcceptDefaults"
          >
            Accept defaults
          </v-btn>
          <v-btn
            id="configure-dataset-button-tourstep"
            color="primary"
            v-tour-trigger="'configure-dataset-tourtrigger'"
            @click="handleConfigureDataset"
          >
            Configure dataset
          </v-btn>
        </v-card-actions>
      </v-card>
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
import RecentDatasets from "@/components/RecentDatasets.vue";
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
    RecentDatasets,
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

  isDragging: boolean = false;
  showZenodoImporter: boolean = false;
  showUploadDialog: boolean = false;
  browseMode: "files" | "collections" = "files";
  datasetsTab: number = 0;

  pendingFiles: File[] = [];

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
      Vue.set(this.userDisplayNames, creatorId, "Loading...");
      this.getUsernameFromId(creatorId).then((user) => {
        Vue.set(
          this.userDisplayNames,
          creatorId,
          `${user.fullname} (${user.username})`,
        );
      });
    }
    return this.userDisplayNames[creatorId];
  }

  async fetchUsersForDatasets() {
    const userIds = new Set<string>();

    for (const view of this.datasetViewItems) {
      if (view.datasetInfo.creatorId) {
        userIds.add(view.datasetInfo.creatorId);
      }
    }

    if (userIds.size > 0) {
      await this.girderResources.batchFetchResources({
        userIds: Array.from(userIds),
      });

      // Update display names
      for (const userId of userIds) {
        const user = this.girderResources.watchUser(userId);
        if (user) {
          const fullname = `${user.firstName} ${user.lastName}`.trim();
          this.userDisplayNames[userId] =
            `${fullname || user.email} (${user.email})`;
        }
      }
    }
  }

  @Watch("datasetViews")
  @Watch("girderResources.resources")
  async fetchDatasetsAndConfigurations() {
    // Don't proceed if resources are being locked (loaded individually)
    if (Object.keys(girderResources.resourcesLocks).length > 0) {
      return;
    }

    // Collect IDs that aren't already in cache
    const datasetIds: string[] = [];
    const configIds: string[] = [];

    for (const view of this.datasetViews) {
      // Check if dataset is not in cache
      if (!this.girderResources.watchFolder(view.datasetId)) {
        datasetIds.push(view.datasetId);
      }
      // Check if configuration is not in cache
      if (!this.girderResources.watchCollection(view.configurationId)) {
        configIds.push(view.configurationId);
      }
    }

    // Batch fetch all missing resources
    if (datasetIds.length > 0 || configIds.length > 0) {
      await this.girderResources.batchFetchResources({
        folderIds: datasetIds,
        collectionIds: configIds,
      });
    }
  }

  @Watch("datasetViewItems")
  async fetchUsersForDatasetsWatcher() {
    await this.fetchUsersForDatasets();
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

  async refreshRecentDatasetDetails() {
    const datasetIds = this.datasetViews.map((d) => d.datasetId);
    const configIds = this.datasetViews.map((d) => d.configurationId);

    await this.girderResources.batchFetchResources({
      folderIds: datasetIds,
      collectionIds: configIds,
    });
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

  handleDrop(event: DragEvent) {
    this.isDragging = false;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      this.pendingFiles = files;
      this.showUploadDialog = true;
    }
  }

  openFileSelector() {
    const input = this.$refs.fileInput as HTMLInputElement;
    input.click();
  }

  handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);

    if (files.length > 0) {
      this.pendingFiles = files;
      this.showUploadDialog = true;
    }

    // Reset the input
    input.value = "";
  }

  onDragLeave(event: DragEvent) {
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
      this.isDragging = false;
    }
  }

  handleAcceptDefaults() {
    this.quickUpload(this.pendingFiles);
    this.closeUploadDialog();
  }

  handleConfigureDataset() {
    this.comprehensiveUpload(this.pendingFiles);
    this.closeUploadDialog();
  }

  closeUploadDialog() {
    this.showUploadDialog = false;
    this.pendingFiles = [];
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
.home-header {
  flex-shrink: 0;
}

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

.recent-dataset .v-tabs-items {
  height: calc(100%);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.recent-dataset .v-tab-item {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.recent-dataset .v-tab-item > div {
  height: 100%;
  overflow-y: auto;
}

.recent-dataset .v-tab-item > zenodo-community-display {
  height: 100%;
  display: flex;
  flex-direction: column;
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
