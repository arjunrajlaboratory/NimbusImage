<template>
  <v-container>
    <v-card>
      <v-card-title class="d-flex justify-space-between align-center">
        Import Sample Dataset
        <v-btn icon @click="$emit('close')">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </v-card-title>
      <v-card-text>
        <!-- Selected Dataset Details -->
        <v-card v-if="selectedDataset" class="my-4" outlined>
          <v-card-title>{{ selectedDataset.title }}</v-card-title>
          <v-card-subtitle>
            <a
              :href="selectedDataset.links.latest_html"
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Zenodo
            </a>
          </v-card-subtitle>
          <v-card-text>
            <p v-html="selectedDataset.metadata.description"></p>

            <v-subheader
              >Files ({{ filteredFiles.length }} image files out of
              {{ selectedDataset.files.length }} total)</v-subheader
            >
            <v-list dense>
              <v-list-item v-for="file in filteredFiles" :key="file.id">
                <v-list-item-content>
                  <v-list-item-title>{{ file.key }}</v-list-item-title>
                  <v-list-item-subtitle>{{
                    formatSize(file.size)
                  }}</v-list-item-subtitle>
                </v-list-item-content>
              </v-list-item>
            </v-list>

            <v-card class="mb-2">
              <v-card-title>Location:</v-card-title>
              <v-card-text>
                <girder-location-chooser
                  v-model="path"
                  :breadcrumb="true"
                  title="Select a Folder to Import the New Dataset"
                  :disabled="importing"
                />
              </v-card-text>
            </v-card>
          </v-card-text>
        </v-card>

        <!-- Import Progress -->
        <v-card v-if="importing" class="my-4">
          <v-card-title>Importing Dataset</v-card-title>
          <v-card-text>
            <v-progress-linear
              :value="importProgress"
              height="25"
              color="primary"
              striped
            >
              <template v-slot:default>
                {{ currentFile }} ({{ importProgress.toFixed(0) }}%)
              </template>
            </v-progress-linear>
          </v-card-text>
        </v-card>

        <!-- Error Display -->
        <v-alert v-if="error" type="error" class="mt-4">
          {{ error }}
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn
          color="primary"
          :disabled="!canImport || importing"
          @click="importSelectedDataset"
        >
          Import Dataset
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { IGirderLocation } from "@/girder";
import { logError } from "@/utils/log";
import ZenodoAPI, { IZenodoRecord, IZenodoFile } from "@/store/ZenodoAPI";
import { stripHtml } from "@/utils/strings";

@Component({
  components: {
    GirderLocationChooser,
  },
})
export default class ZenodoImporter extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;
  readonly datasetMetadataImport = datasetMetadataImport;
  private zenodoApi = new ZenodoAPI(store.girderRestProxy);

  @Prop({ type: Object, default: null })
  readonly dataset!: IZenodoRecord | null;

  // Selected dataset
  selectedDataset: IZenodoRecord | null = null;
  private _path: IGirderLocation | null = null;

  // Import progress
  importing = false;
  importProgress = 0;
  currentFile = "";
  error = "";

  get path(): IGirderLocation | null {
    return this._path;
  }

  set path(value: IGirderLocation | null) {
    this._path = value;
    if (value) {
      this.store.setFolderLocation(value);
    }
  }

  get filteredFiles(): IZenodoFile[] {
    if (!this.selectedDataset) return [];
    return this.zenodoApi.filterImageFiles(this.selectedDataset.files);
  }

  get canImport(): boolean {
    return (
      !!this.selectedDataset &&
      this.filteredFiles.length > 0 &&
      !!this.path &&
      !this.importing
    );
  }

  mounted() {
    // Initialize path from store's folder location
    this._path = this.store.folderLocation;

    // Set the selected dataset from the prop
    if (this.dataset) {
      this.selectedDataset = this.dataset;
    }
  }

  @Watch("dataset")
  onDatasetChanged(val: IZenodoRecord | null) {
    if (val) {
      this.selectedDataset = val;
      this.error = "";
    }
  }

  async importSelectedDataset(): Promise<void> {
    if (!this.canImport || !this.path || !this.selectedDataset) return;

    this.importing = true;
    this.error = "";
    this.importProgress = 0;

    try {
      // Get only the image files from Zenodo
      const imageFiles = this.filteredFiles;
      const downloadedImageFiles: File[] = [];

      const nonImageFiles = this.selectedDataset.files.filter(
        (file) => !this.filteredFiles.includes(file),
      );

      const downloadedNonImageFiles: File[] = [];

      // Download each file from Zenodo
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        this.currentFile = `Downloading ${file.key}...`;

        // Set initial progress for this file
        this.importProgress = (i / imageFiles.length) * 100;

        const fileIndex = i; // Capture the current index in a closure

        // Download the file with progress updates
        const blob = await this.zenodoApi.downloadFile(
          file.links.self,
          (loaded, total) => {
            // Calculate overall progress:
            // - Completed files: (fileIndex / totalFiles) * 100
            // - Current file: (loaded / total) / totalFiles * 100
            const completedProgress = (fileIndex / imageFiles.length) * 100;
            const currentFileProgress =
              (loaded / total / imageFiles.length) * 100;
            this.importProgress = completedProgress + currentFileProgress;

            // Update status message
            this.currentFile = `Downloading ${file.key}... (${Math.round(loaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`;
          },
        );

        const downloadedImageFile = new File([blob], file.key);
        downloadedImageFiles.push(downloadedImageFile);
      }

      // Download non-image files
      for (let i = 0; i < nonImageFiles.length; i++) {
        const file = nonImageFiles[i];
        this.currentFile = `Downloading ${file.key}...`;

        this.importProgress = (i / nonImageFiles.length) * 100;

        const fileIndex = i; // Capture the current index in a closure

        const blob = await this.zenodoApi.downloadFile(
          file.links.self,
          (loaded, total) => {
            // Calculate overall progress:
            // - Completed files: (fileIndex / totalFiles) * 100
            // - Current file: (loaded / total) / totalFiles * 100
            const completedProgress = (fileIndex / nonImageFiles.length) * 100;
            const currentFileProgress =
              (loaded / total / nonImageFiles.length) * 100;
            this.importProgress = completedProgress + currentFileProgress;

            // Update status message
            this.currentFile = `Downloading ${file.key}... (${Math.round(loaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`;
          },
        );

        const downloadedNonImageFile = new File([blob], file.key);
        downloadedNonImageFiles.push(downloadedNonImageFile);

        if (file.key.endsWith("annotations.json")) {
          await this.datasetMetadataImport.storeAnnotationFile(
            downloadedNonImageFile,
          );
        } else if (file.key.endsWith("collection.json")) {
          await this.datasetMetadataImport.storeCollectionFile(
            downloadedNonImageFile,
          );
        } else {
          logError("unknown file type", file.key);
        }
      }

      // All files downloaded successfully
      this.currentFile = "Preparing upload...";
      this.importProgress = 100;

      // Pass the downloaded files to NewDataset.vue using the same approach as Home.vue
      this.$router.push({
        name: "newdataset",
        params: {
          quickupload: true, // Use quickupload for automatic processing
          defaultFiles: downloadedImageFiles,
          initialUploadLocation: this.path,
          initialName: this.selectedDataset.title,
          initialDescription: stripHtml(
            this.selectedDataset.metadata.description || "",
          ),
        } as any,
      });
    } catch (err) {
      this.error = "Failed to download files from Zenodo. Please try again.";
      logError("Zenodo download error", err);
      this.importing = false;
    }
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
}
</script>

<style scoped>
.v-data-table tr {
  cursor: pointer;
}
</style>
