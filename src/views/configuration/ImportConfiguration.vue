<template>
  <v-container>
    <collection-navigator
      :location="selectedFolder"
      @update:location="onNavigatorLocationUpdate"
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
import { getDefaultGirderLocation } from "@/utils/girderLocation";

const route = useRoute();
const router = useRouter();

const selectedFolder = ref<IGirderLocation | null>(null);
const selectedFolderSource = ref<
  "route" | "dataset" | "default" | "user" | null
>(null);

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

async function initializeSelectedFolder(options = { replaceDefault: false }) {
  if (
    selectedFolder.value &&
    !(options.replaceDefault && selectedFolderSource.value === "default")
  ) {
    return;
  }
  const folderIdQuery = route.query.folderId;
  const targetFolderId = Array.isArray(folderIdQuery)
    ? folderIdQuery[0]
    : folderIdQuery;
  if (targetFolderId) {
    const folder = await girderResources.getFolder(targetFolderId);
    if (folder) {
      selectedFolder.value = folder;
      selectedFolderSource.value = "route";
      return;
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
          selectedFolderSource.value = "dataset";
          return;
        }
      }
    }
  }
  selectedFolder.value = await getDefaultGirderLocation();
  selectedFolderSource.value = "default";
}

watch(dataset, () => {
  initializeSelectedFolder({ replaceDefault: true });
});

onMounted(() => {
  initializeSelectedFolder();
});

function onNavigatorLocationUpdate(location: IGirderLocation | null) {
  selectedFolder.value = location;
  selectedFolderSource.value = "user";
}

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
  selectedFolderSource,
  datasetName,
  dataset,
  initializeSelectedFolder,
  onNavigatorLocationUpdate,
  submit,
  cancel,
});
</script>
