<template>
  <div>
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
                <v-tab>Recent Projects</v-tab>
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
                <v-tab-item class="fill-height">
                  <recent-projects
                    :projects="recentProjects"
                    :loading="loadingProjects"
                    :get-user-display-name="getUserDisplayName"
                    @project-clicked="handleProjectClicked"
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
                  <v-btn value="projects" small>
                    <v-icon left small>mdi-folder-star</v-icon>
                    Projects
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

                <!-- Projects View -->
                <project-list v-else-if="browseMode === 'projects'" />
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
    <v-dialog v-model="showUploadDialog" max-width="800px" persistent>
      <v-card>
        <v-card-title class="headline d-flex align-center">
          Create dataset
          <v-btn
            icon
            small
            class="ml-2"
            @click="showUploadInfo = !showUploadInfo"
          >
            <v-icon small>mdi-information-outline</v-icon>
          </v-btn>
        </v-card-title>

        <!-- Info Panel -->
        <v-expand-transition>
          <v-alert
            v-if="showUploadInfo"
            type="info"
            text
            class="mx-4 mb-4 text-body-2"
          >
            <div class="font-weight-bold mb-2">
              Understanding Datasets and Collections
            </div>
            <p>
              A <strong>dataset</strong> is a set of images you want to
              visualize and analyze together. It can come from a single file
              (like a multi-dimensional .nd2 file) or multiple files that belong
              together.
            </p>
            <p>
              By default, when you upload multiple files, they all become part
              of <strong>one dataset</strong>. NimbusImage will automatically
              parse dimensions like channels, Z-stacks, and timepoints from file
              metadata or filenames.
            </p>
            <p>
              If you want each file to be its own separate dataset, check the
              "<strong
                >Upload each file as a separate dataset in a collection</strong
              >" option. This creates a <strong>collection</strong> — a group of
              datasets that share the same visualization settings and tools.
            </p>
            <p class="mb-0">
              Collections are useful when you have similar data from different
              conditions or timepoints that you want to analyze with consistent
              settings.
            </p>
          </v-alert>
        </v-expand-transition>

        <v-card-text>
          <v-text-field
            v-model="datasetName"
            :label="batchMode ? 'Collection Name' : 'Dataset Name'"
            required
            :rules="nameRules"
            :error-messages="nameError"
            class="mb-2"
          />

          <!-- Collection mode toggle -->
          <v-checkbox
            v-model="batchMode"
            label="Upload each file as a separate dataset in a collection"
            :disabled="pendingFiles.length < 2"
            hide-details
            class="mb-4"
          />

          <!-- Show file-to-dataset mapping when in batch mode -->
          <v-card v-if="batchMode" outlined class="mb-4">
            <v-card-subtitle>
              Each file will become a separate dataset:
              <v-progress-circular
                v-if="validatingNames"
                indeterminate
                size="16"
                width="2"
                class="ml-2"
              />
            </v-card-subtitle>
            <v-list dense>
              <v-list-item v-for="(file, idx) in pendingFiles" :key="idx">
                <v-list-item-icon>
                  <v-icon
                    small
                    :color="nameConflicts.includes(idx) ? 'error' : ''"
                  >
                    {{
                      nameConflicts.includes(idx)
                        ? "mdi-alert-circle"
                        : "mdi-file"
                    }}
                  </v-icon>
                </v-list-item-icon>
                <v-list-item-content>
                  <v-text-field
                    v-model="datasetNames[idx]"
                    :error="nameConflicts.includes(idx)"
                    :error-messages="getNameError(idx)"
                    dense
                    hide-details="auto"
                    @input="validateDatasetNamesDebounced"
                  />
                  <v-list-item-subtitle class="text--secondary mt-1">
                    {{ file.name }}
                  </v-list-item-subtitle>
                </v-list-item-content>
              </v-list-item>
            </v-list>
          </v-card>

          <div class="mb-4 text-body-2 text--secondary">
            {{ pendingFiles.length }}
            {{ pendingFiles.length === 1 ? "file" : "files" }} selected
            <template v-if="batchMode">
              → {{ pendingFiles.length }} datasets
            </template>
          </div>

          <v-alert v-if="nameTaken" text type="error" class="mb-4">
            Could not create dataset <strong>{{ datasetName }}</strong
            >. This might happen, for instance, if a dataset by that name
            already exists. Please update the dataset name field and try again.
          </v-alert>

          <v-card class="mb-4">
            <v-card-title class="text-subtitle-1 pa-3">Location:</v-card-title>
            <v-card-text class="pt-0">
              <girder-location-chooser
                v-model="selectedLocation"
                :breadcrumb="true"
                title="Select a Folder to Import the New Dataset"
              />
            </v-card-text>
          </v-card>
        </v-card-text>
        <v-card-actions>
          <v-btn text @click="closeUploadDialog">Cancel</v-btn>
          <v-spacer></v-spacer>
          <v-btn
            id="configure-dataset-button-tourstep"
            outlined
            color="primary"
            v-tour-trigger="'configure-dataset-tourtrigger'"
            :disabled="!isFormValid"
            @click="handleConfigureDataset"
            class="mr-2"
          >
            Advanced Import
          </v-btn>
          <v-btn
            id="accept-defaults-button-tourstep"
            color="primary"
            v-tour-trigger="'accept-defaults-tourtrigger'"
            :disabled="!isFormValid"
            @click="handleAcceptDefaults"
          >
            Quick Import
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
import ProjectList from "@/components/ProjectList.vue";
import RecentProjects from "@/components/RecentProjects.vue";
import projects from "@/store/projects";
import ZenodoImporter from "@/components/ZenodoImporter.vue";
import ZenodoCommunityDisplay from "@/components/ZenodoCommunityDisplay.vue";
import RecentDatasets from "@/components/RecentDatasets.vue";
import { isConfigurationItem, isDatasetFolder } from "@/utils/girderSelectable";
import { formatDateNumber, formatDate } from "@/utils/date";
import { logError } from "@/utils/log";
import Persister from "@/store/Persister";
import { triggersPerCategory } from "@/utils/parsing";

const allTriggers = Object.values(triggersPerCategory).flat();

function basename(filename: string): string {
  const components = filename.split(".");
  return components.length > 1
    ? components.slice(0, -1).join(".")
    : components[0];
}

function findCommonPrefix(strings: string[]): string {
  // Handle special cases
  if (strings.length === 0) {
    return "";
  } else if (strings.length === 1) {
    return strings[0];
  }

  // For filenames that are purely numeric at the start, use first filename + "_multi"
  if (strings.every((s) => /^\d+/.test(s))) {
    return basename(strings[0]) + "_multi";
  }

  // For non-numeric prefixes:
  // Extract the non-metadata prefix of each filename. Note that because of the
  // way the regex is constructed, the first match group will never be `null`.
  const triggerAndDigit = allTriggers.map(
    (trigger) => `\\d${trigger}|${trigger}\\d`,
  );
  const re = new RegExp(`(.*?)(?:_|-|${triggerAndDigit.join("|")})`);
  const matches = strings.map((s) => s.match(re)![1]);

  // Get the minimum length of all the strings; the common prefix cannot be
  // longer than this.
  const minLength = matches.reduce(
    (acc, cur) => Math.min(acc, cur.length),
    Infinity,
  );

  // Sweep through the first string, and compare the letter found in each
  // position with the letter at that position for all the strings. Stop when an
  // inequality occurs.
  let result = [];
  for (let i = 0; i < minLength; i++) {
    const ch = matches[0].charAt(i);

    if (!matches.map((s) => s.charAt(i)).every((c) => c === ch)) {
      break;
    }
    result.push(ch);
  }

  return result.join("");
}

@Component({
  components: {
    GirderUpload,
    FileDropzone,
    GirderLocationChooser,
    CustomFileManager,
    CollectionList,
    ProjectList,
    RecentProjects,
    ZenodoImporter,
    ZenodoCommunityDisplay,
    RecentDatasets,
  },
})
export default class Home extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;
  readonly projectsStore = projects;
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
  showUploadInfo: boolean = false;
  browseMode: "files" | "collections" | "projects" = "files";
  datasetsTab: number = 0;
  loadingProjects: boolean = false;

  pendingFiles: File[] = [];
  datasetName: string = "";
  selectedLocation: IGirderLocation | null = null;
  nameTaken: boolean = false;
  checkingName: boolean = false;
  nameError: string = "";
  batchMode: boolean = false;

  // Batch mode dataset name editing
  datasetNames: string[] = [];
  nameConflicts: number[] = []; // Array instead of Set for Vue 2 reactivity
  validatingNames: boolean = false;
  validateNamesDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  get recommendedName() {
    const { pendingFiles } = this;

    // If there aren't any files selected yet, return a blank string.
    if (pendingFiles.length === 0) {
      return "";
    }

    // If there is only one file, return its name with the extension struck off.
    if (pendingFiles.length === 1) {
      return basename(pendingFiles[0].name);
    }

    // For more than one file, search for the longest prefix common to all, and
    // use that as the name if it's nonblank; otherwise use the name of the
    // first file.
    const prefix = findCommonPrefix(pendingFiles.map((d) => d.name));
    if (prefix.length > 0) {
      return prefix;
    } else {
      return basename(pendingFiles[0].name);
    }
  }

  get fileGroups(): File[][] {
    if (this.batchMode) {
      // Each file becomes its own dataset
      return this.pendingFiles.map((file) => [file]);
    } else {
      // All files go into one dataset
      return [this.pendingFiles];
    }
  }

  getDatasetNameForFile(file: File): string {
    return basename(file.name);
  }

  initializeDatasetNames() {
    this.datasetNames = this.pendingFiles.map((file) =>
      this.getDatasetNameForFile(file),
    );
    this.nameConflicts = [];
  }

  validateDatasetNamesDebounced() {
    // Debounce to avoid interfering with button clicks
    if (this.validateNamesDebounceTimer) {
      clearTimeout(this.validateNamesDebounceTimer);
    }
    this.validateNamesDebounceTimer = setTimeout(() => {
      this.validateDatasetNames();
    }, 300);
  }

  async validateDatasetNames() {
    if (
      !this.batchMode ||
      !this.selectedLocation ||
      !("_id" in this.selectedLocation)
    ) {
      return;
    }

    this.validatingNames = true;
    const conflicts: number[] = [];

    try {
      // Check for internal duplicates first
      const nameCounts = new Map<string, number[]>();
      this.datasetNames.forEach((name, idx) => {
        const lower = name.trim().toLowerCase();
        if (!nameCounts.has(lower)) {
          nameCounts.set(lower, []);
        }
        nameCounts.get(lower)!.push(idx);
      });

      // Mark all indices that have duplicate names
      nameCounts.forEach((indices) => {
        if (indices.length > 1) {
          indices.forEach((idx) => {
            if (!conflicts.includes(idx)) {
              conflicts.push(idx);
            }
          });
        }
      });

      // Check each unique name against existing datasets
      const uniqueNames = [...new Set(this.datasetNames.map((n) => n.trim()))];
      for (const name of uniqueNames) {
        if (!name) continue;
        const exists = await this.store.api.checkDatasetNameExists(
          name,
          this.selectedLocation,
        );
        if (exists) {
          // Mark all indices with this name as conflicts
          this.datasetNames.forEach((n, idx) => {
            if (n.trim().toLowerCase() === name.toLowerCase()) {
              if (!conflicts.includes(idx)) {
                conflicts.push(idx);
              }
            }
          });
        }
      }
    } finally {
      this.nameConflicts = conflicts;
      this.validatingNames = false;
    }
  }

  getNameError(idx: number): string {
    if (!this.nameConflicts.includes(idx)) return "";
    const name = this.datasetNames[idx]?.trim().toLowerCase();

    // Check if it's a duplicate within the batch
    const duplicateCount = this.datasetNames.filter(
      (n) => n.trim().toLowerCase() === name,
    ).length;

    if (duplicateCount > 1) {
      return "Duplicate name in batch";
    }
    return "Dataset already exists in this location";
  }

  get nameRules() {
    return [(v: string) => v.trim().length > 0 || "Dataset name is required"];
  }

  get isFormValid() {
    const baseValid =
      this.datasetName.trim().length > 0 &&
      this.selectedLocation !== null &&
      "_id" in this.selectedLocation &&
      !this.nameTaken &&
      !this.checkingName;

    // Additional validation for batch mode
    if (this.batchMode) {
      const hasEmptyNames = this.datasetNames.some((n) => !n?.trim());
      const hasConflicts = this.nameConflicts.length > 0;
      return (
        baseValid && !hasEmptyNames && !hasConflicts && !this.validatingNames
      );
    }

    return baseValid;
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

  get recentProjects() {
    return this.projectsStore.recentProjects;
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
    this.fetchRecentProjects();
    this.isNavigating = false; // Reset navigation state on mount
  }

  @Watch("store.isLoggedIn")
  onLoginStatusChange(isLoggedIn: boolean) {
    if (isLoggedIn) {
      // User has just logged in, try initializing the tour
      this.initializeWelcomeTour();
      // Fetch recent projects
      this.fetchRecentProjects();
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

  @Watch("selectedLocation")
  onLocationChange() {
    // Clear name validation state when location changes
    // The validation rule will re-run automatically
    if (this.nameTaken) {
      this.nameTaken = false;
      this.nameError = "";
    }
    // Validate batch mode dataset names when location changes
    if (this.batchMode && this.pendingFiles.length > 0) {
      this.validateDatasetNames();
    }
  }

  @Watch("pendingFiles")
  onPendingFilesChange() {
    this.initializeDatasetNames();
    if (this.batchMode && this.selectedLocation) {
      this.validateDatasetNames();
    }
  }

  @Watch("batchMode")
  onBatchModeChange(newVal: boolean) {
    if (newVal) {
      this.initializeDatasetNames();
      if (this.selectedLocation) {
        this.validateDatasetNames();
      }
    }
  }

  @Watch("datasetName")
  async onDatasetNameChange(newName: string) {
    // Skip validation in batch mode - collection names are checked differently
    if (this.batchMode) {
      return;
    }

    if (!newName || !newName.trim()) {
      this.nameTaken = false;
      this.nameError = "";
      return;
    }

    if (!this.selectedLocation || !("_id" in this.selectedLocation)) {
      return;
    }

    this.checkingName = true;
    this.nameTaken = false;
    this.nameError = "";

    try {
      const exists = await this.store.api.checkDatasetNameExists(
        newName.trim(),
        this.selectedLocation,
      );
      if (exists) {
        this.nameTaken = true;
        this.nameError =
          "A dataset with this name already exists in the selected location";
      } else {
        this.nameTaken = false;
        this.nameError = "";
      }
    } catch (error) {
      // If check fails, don't block submission - let the server handle it
      this.nameError = "";
    } finally {
      this.checkingName = false;
    }
  }

  private async initializeRecentViews() {
    try {
      await this.store.fetchRecentDatasetViews();
    } catch (error) {
      logError("Failed to initialize recent views:", error);
    }
  }

  private async fetchRecentProjects() {
    this.loadingProjects = true;
    try {
      await this.projectsStore.fetchProjects();
    } catch (error) {
      logError("Failed to fetch recent projects:", error);
    } finally {
      this.loadingProjects = false;
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

  quickUpload(files: File[], name?: string, location?: IGirderLocation) {
    // Initialize upload workflow in store
    this.store.initializeUploadWorkflow({
      quickupload: true,
      batchMode: this.batchMode,
      batchName: this.batchMode ? name || this.datasetName || "" : "",
      fileGroups: this.batchMode ? this.fileGroups : [files],
      datasetNames: this.batchMode ? [...this.datasetNames] : [],
      initialUploadLocation: location || this.location,
      initialName: this.batchMode ? "" : name || "",
      initialDescription: "",
    });

    // Navigate without complex params
    this.$router.push({ name: "newdataset" });
  }

  comprehensiveUpload(
    files: File[],
    name?: string,
    location?: IGirderLocation,
  ) {
    this.store.initializeUploadWorkflow({
      quickupload: false,
      batchMode: this.batchMode,
      batchName: this.batchMode ? name || this.datasetName || "" : "",
      fileGroups: this.batchMode ? this.fileGroups : [files],
      datasetNames: this.batchMode ? [...this.datasetNames] : [],
      initialUploadLocation: location || this.location,
      initialName: this.batchMode ? "" : name || "",
      initialDescription: "",
    });

    this.$router.push({ name: "newdataset" });
  }

  handleDrop(event: DragEvent) {
    this.isDragging = false;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      this.pendingFiles = files;
      this.initializeUploadDialog();
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
      this.initializeUploadDialog();
      this.showUploadDialog = true;
    }

    // Reset the input
    input.value = "";
  }

  initializeUploadDialog() {
    // Set the default name based on recommended name
    this.datasetName = this.recommendedName + " - " + formatDate(new Date());
    // Set the default location to current location
    this.selectedLocation = this.location;
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
    if (!this.isFormValid) {
      return;
    }
    this.quickUpload(
      this.pendingFiles,
      this.datasetName,
      this.selectedLocation || undefined,
    );
    this.closeUploadDialog();
  }

  handleConfigureDataset() {
    if (!this.isFormValid) {
      return;
    }
    this.comprehensiveUpload(
      this.pendingFiles,
      this.datasetName,
      this.selectedLocation || undefined,
    );
    this.closeUploadDialog();
  }

  closeUploadDialog() {
    this.showUploadDialog = false;
    this.showUploadInfo = false;
    this.pendingFiles = [];
    this.datasetName = "";
    this.selectedLocation = null;
    this.nameTaken = false;
    this.nameError = "";
    this.checkingName = false;
    this.batchMode = false;
    // Reset batch mode name validation state
    this.datasetNames = [];
    this.nameConflicts = [];
    this.validatingNames = false;
    if (this.validateNamesDebounceTimer) {
      clearTimeout(this.validateNamesDebounceTimer);
      this.validateNamesDebounceTimer = null;
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
    this.showZenodoImporter = true;
  }

  handleProjectClicked() {
    // Switch to Projects browse mode when clicking a project
    this.browseMode = "projects";
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
