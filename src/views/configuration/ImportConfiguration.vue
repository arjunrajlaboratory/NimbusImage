<template>
  <v-container>
    <v-card class="mb-4">
      <v-card-title>Search Location</v-card-title>
      <v-card-text>
        <div class="d-flex align-center">
          <span class="mr-4">
            <strong>Current folder:</strong>
            {{ currentFolderName || "Loading..." }}
          </span>
          <girder-location-chooser
            v-model="selectedFolder"
            :breadcrumb="true"
            title="Select a folder to search for collections"
          />
        </div>
      </v-card-text>
    </v-card>
    <configuration-select
      @submit="submit"
      @cancel="cancel"
      :title="`Add dataset ${datasetName} to one or several existing collections`"
      :folderId="folderId"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import ConfigurationSelect from "@/components/ConfigurationSelect.vue";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { IDatasetConfiguration } from "@/store/model";
import { IGirderSelectAble } from "@/girder";

const vm = getCurrentInstance()!.proxy;

const selectedFolder = ref<IGirderSelectAble | null>(null);
const currentFolderName = ref("");

const datasetName = computed(() => store.dataset?.name || "");

const folderId = computed((): string | undefined => {
  if (selectedFolder.value && selectedFolder.value._modelType === "folder") {
    return selectedFolder.value._id;
  }
  // Fallback to route query if folder not yet loaded
  const folderIdQuery = vm.$route.query.folderId;
  if (Array.isArray(folderIdQuery)) {
    return folderIdQuery[0] || undefined;
  }
  if (folderIdQuery === null) {
    return undefined;
  }
  return folderIdQuery;
});

watch(selectedFolder, async () => {
  if (selectedFolder.value && selectedFolder.value._modelType === "folder") {
    const folder = await girderResources.getFolder(selectedFolder.value._id);
    currentFolderName.value = folder?.name || "Unknown folder";
  } else {
    currentFolderName.value = "";
  }
});

onMounted(async () => {
  // Initialize selectedFolder from route query
  const folderIdQuery = vm.$route.query.folderId;
  const targetFolderId = Array.isArray(folderIdQuery)
    ? folderIdQuery[0]
    : folderIdQuery;
  if (targetFolderId) {
    const folder = await girderResources.getFolder(targetFolderId);
    if (folder) {
      selectedFolder.value = folder;
      currentFolderName.value = folder.name;
    }
  } else {
    // If no folderId in query, try to get dataset's parent folder
    if (store.dataset) {
      const datasetFolder = await girderResources.getFolder(store.dataset.id);
      if (datasetFolder?.parentId) {
        const parentFolder = await girderResources.getFolder(
          datasetFolder.parentId,
        );
        if (parentFolder) {
          selectedFolder.value = parentFolder;
          currentFolderName.value = parentFolder.name;
        }
      }
    }
  }
});

async function submit(configurations: IDatasetConfiguration[]) {
  const dataset = store.dataset;
  if (!dataset) {
    return;
  }

  await Promise.all(
    configurations.map((configuration) =>
      store.createDatasetView({
        configurationId: configuration.id,
        datasetId: dataset.id,
      }),
    ),
  );

  vm.$router.back();
}

function cancel() {
  vm.$router.back();
}

defineExpose({
  selectedFolder,
  currentFolderName,
  datasetName,
  folderId,
  submit,
  cancel,
});
</script>
