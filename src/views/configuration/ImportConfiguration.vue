<template>
  <v-container>
    <collection-navigator
      v-model:location="selectedFolder"
      @submit="submit"
      @cancel="cancel"
      :title="`Add dataset ${datasetName} to one or several existing collections`"
      :use-default-location="false"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import store from "@/store";
import girderResources from "@/store/girderResources";
import CollectionNavigator from "@/components/CollectionNavigator.vue";
import { IDatasetConfiguration } from "@/store/model";
import { IGirderLocation } from "@/girder";
import { useRouteMapper } from "@/utils/useRouteMapper";

const route = useRoute();
const router = useRouter();

const selectedFolder = ref<IGirderLocation | null>(null);
const currentFolderName = ref("");

useRouteMapper(
  {},
  {
    datasetId: {
      parse: String,
      get: () => store.selectedDatasetId,
      set: (value: string) => store.setSelectedDataset(value),
    },
  },
);

const dataset = computed(() => store.dataset);
const datasetName = computed(() => store.dataset?.name || "");

const folderId = computed((): string | undefined => {
  const folder = selectedFolder.value as any;
  if (folder && folder._modelType === "folder") {
    return folder._id;
  }
  // Fallback to route query if folder not yet loaded
  const folderIdQuery = route.query.folderId;
  if (Array.isArray(folderIdQuery)) {
    return folderIdQuery[0] || undefined;
  }
  if (folderIdQuery === null) {
    return undefined;
  }
  return folderIdQuery;
});

watch(selectedFolder, async () => {
  const sel = selectedFolder.value as any;
  if (sel && sel._modelType === "folder") {
    currentFolderName.value = sel.name || "";
    if (!currentFolderName.value) {
      const folder = await girderResources.getFolder(sel._id);
      currentFolderName.value = folder?.name || "Unknown folder";
    }
  } else {
    currentFolderName.value = "";
  }
});

async function initializeSelectedFolder() {
  const folderIdQuery = route.query.folderId;
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
    if (dataset.value) {
      const datasetFolder = await girderResources.getFolder(dataset.value.id);
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
    if (!selectedFolder.value) {
      const privateFolder = await store.api.getUserPrivateFolder();
      selectedFolder.value = privateFolder || store.girderUser;
    }
  }
}

watch(dataset, initializeSelectedFolder);

onMounted(() => {
  initializeSelectedFolder();
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

  router.back();
}

function cancel() {
  router.back();
}

defineExpose({
  selectedFolder,
  currentFolderName,
  datasetName,
  dataset,
  folderId,
  initializeSelectedFolder,
  submit,
  cancel,
});
</script>
