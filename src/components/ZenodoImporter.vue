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
              >{{ filteredFiles.length }} image files out of
              {{ selectedDataset.files.length }} total dataset files
            </v-subheader>
            <v-list dense>
              <v-list-item v-for="file in filteredFiles" :key="file.id">
                <v-list-item-content>
                  <v-list-item-title>{{ file.key }}</v-list-item-title>
                  <v-list-item-subtitle
                    >{{ formatSize(file.size) }}
                  </v-list-item-subtitle>
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
          id="zenodo-importer-import-dataset-tourstep"
          v-tour-trigger="'zenodo-importer-import-dataset-tourtrigger'"
        >
          Import Dataset
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { IGirderLocation, IGirderSelectAble } from "@/girder";
import { logError } from "@/utils/log";
import ZenodoAPI, { IZenodoRecord, IZenodoFile } from "@/store/ZenodoAPI";
import { stripHtml } from "@/utils/strings";

const props = withDefaults(
  defineProps<{
    dataset?: IZenodoRecord | null;
  }>(),
  {
    dataset: null,
  },
);

defineEmits<{
  (e: "close"): void;
}>();

const instance = getCurrentInstance();
const zenodoApi = new ZenodoAPI(store.girderRestProxy);

// Reactive state
const selectedDataset = ref<IZenodoRecord | null>(null);
const _path = ref<IGirderSelectAble | null>(null);
const importing = ref(false);
const importProgress = ref(0);
const currentFile = ref("");
const error = ref("");

// Computed get/set for path
const path = computed({
  get: () => _path.value,
  set: (value: IGirderSelectAble | null) => {
    _path.value = value;
    if (value) {
      store.setFolderLocation(value as IGirderLocation);
    }
  },
});

const filteredFiles = computed<IZenodoFile[]>(() => {
  if (!selectedDataset.value) return [];
  return zenodoApi.filterImageFiles(selectedDataset.value.files);
});

const canImport = computed<boolean>(() => {
  return (
    !!selectedDataset.value &&
    filteredFiles.value.length > 0 &&
    !!path.value &&
    !importing.value
  );
});

onMounted(() => {
  // Initialize path from store's folder location
  _path.value = store.folderLocation as IGirderSelectAble | null;

  // Set the selected dataset from the prop
  if (props.dataset) {
    selectedDataset.value = props.dataset;
  }
});

watch(
  () => props.dataset,
  (val: IZenodoRecord | null) => {
    if (val) {
      selectedDataset.value = val;
      error.value = "";
    }
  },
);

async function downloadFile(
  file: IZenodoFile,
  fileIndex: number,
  totalFiles: number,
): Promise<File> {
  currentFile.value = `Downloading ${file.key}...`;
  importProgress.value = (fileIndex / totalFiles) * 100;

  const blob = await zenodoApi.downloadFile(
    file.links.self,
    (loaded, total) => {
      const completedProgress = (fileIndex / totalFiles) * 100;
      const currentFileProgress = (loaded / total / totalFiles) * 100;
      importProgress.value = completedProgress + currentFileProgress;
      currentFile.value = `Downloading ${file.key}... (${Math.round(loaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`;
    },
  );

  return new File([blob], file.key);
}

async function importSelectedDataset(): Promise<void> {
  if (!canImport.value || !path.value || !selectedDataset.value) return;

  importing.value = true;
  error.value = "";
  importProgress.value = 0;

  try {
    // Get only the image files from Zenodo
    const imageFiles = filteredFiles.value;
    const downloadedImageFiles: File[] = [];

    const nonImageFiles = selectedDataset.value.files.filter(
      (file) => !filteredFiles.value.includes(file),
    );

    const downloadedNonImageFiles: File[] = [];

    // Download each file from Zenodo
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const downloadedImageFile = await downloadFile(
        file,
        i,
        imageFiles.length,
      );
      downloadedImageFiles.push(downloadedImageFile);
    }

    // Download non-image files
    for (let i = 0; i < nonImageFiles.length; i++) {
      const file = nonImageFiles[i];
      const downloadedNonImageFile = await downloadFile(
        file,
        i,
        nonImageFiles.length,
      );
      downloadedNonImageFiles.push(downloadedNonImageFile);

      if (file.key.endsWith("annotations.json")) {
        await datasetMetadataImport.storeAnnotationFile(downloadedNonImageFile);
      } else if (file.key.endsWith("collection.json")) {
        await datasetMetadataImport.storeCollectionFile(downloadedNonImageFile);
      } else {
        logError("unknown file type", file.key);
      }
    }

    // All files downloaded successfully
    currentFile.value = "Preparing upload...";
    importProgress.value = 100;

    // Pass the downloaded files to NewDataset.vue using the same approach as Home.vue
    instance?.proxy?.$router.push({
      name: "newdataset",
      params: {
        quickupload: true,
        defaultFiles: downloadedImageFiles,
        initialUploadLocation: path.value,
        initialName: selectedDataset.value.title,
        initialDescription: stripHtml(
          selectedDataset.value.metadata.description || "",
        ),
      } as any,
    });
  } catch (err) {
    error.value = "Failed to download files from Zenodo. Please try again.";
    logError("Zenodo download error", err);
    importing.value = false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

defineExpose({
  selectedDataset,
  path,
  importing,
  importProgress,
  currentFile,
  error,
  filteredFiles,
  canImport,
  importSelectedDataset,
  formatSize,
  downloadFile,
});
</script>

<style scoped>
.v-data-table tr {
  cursor: pointer;
}
</style>
