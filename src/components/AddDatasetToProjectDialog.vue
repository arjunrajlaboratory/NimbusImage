<template>
  <v-card class="dataset-dialog-card">
    <v-card-title class="flex-shrink-0">
      <span class="text-medium-emphasis">Adding dataset to project:</span>
      <span class="text-high-emphasis ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text class="dataset-dialog-content">
      <custom-file-manager
        title="Choose a dataset or a folder of datasets to add to the project"
        class="file-manager-container"
        :breadcrumb="true"
        :selectable="true"
        :prevent-dataset-navigation="true"
        @selected="onSelectDataset"
        v-model:location="selectLocation"
        :initial-items-per-page="-1"
        :items-per-page-options="[-1]"
        :menu-enabled="false"
        :clickable-chips="false"
      />
      <v-alert
        v-for="(warning, index) in warnings"
        :key="index + '-warning'"
        type="warning"
        class="my-2"
        density="compact"
      >
        {{ warning }}
      </v-alert>
      <v-alert
        v-if="selectedDatasets.length > 0"
        type="success"
        class="my-2"
        density="compact"
      >
        Selected {{ selectedDatasets.length }} dataset(s):
        <v-divider />
        <div
          v-for="dataset in selectedDatasets"
          :key="'selected-' + dataset.id"
        >
          {{ dataset.name }}
          <v-divider />
        </div>
      </v-alert>
    </v-card-text>
    <v-card-actions class="ma-2">
      <v-btn variant="text" @click="$emit('done')">Cancel</v-btn>
      <v-spacer />
      <v-btn
        color="primary"
        :disabled="selectedDatasets.length === 0"
        :loading="adding"
        @click="confirmAdd"
      >
        Add {{ selectedDatasets.length }} Dataset(s)
      </v-btn>
    </v-card-actions>

    <!-- Permission propagation confirmation -->
    <v-dialog v-model="showPermissionConfirm" max-width="500" persistent>
      <v-card>
        <v-card-title>Update dataset permissions?</v-card-title>
        <v-card-text>
          This project is
          <template v-if="isPublic">
            <strong>public</strong>
          </template>
          <template v-else> <strong>shared with other users</strong> </template
          >. Adding {{ selectedDatasets.length }} dataset(s) will update their
          permissions to match the project's access settings.
        </v-card-text>
        <v-card-actions class="justify-end" style="gap: 8px">
          <v-btn variant="text" @click="showPermissionConfirm = false"
            >Cancel</v-btn
          >
          <v-btn color="primary" @click="addDatasets">Continue</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { IDataset, IProject } from "@/store/model";
import girderResources from "@/store/girderResources";
import projects from "@/store/projects";
import { isDatasetFolder } from "@/utils/girderSelectable";
import { IGirderSelectAble, IGirderLocation } from "@/girder";
import CustomFileManager from "@/components/CustomFileManager.vue";

const props = defineProps<{
  project: IProject;
  isShared?: boolean;
  isPublic?: boolean;
}>();

const emit = defineEmits<{
  (e: "done"): void;
  (e: "added", datasetIds: string[]): void;
}>();

const selectLocation = ref<IGirderLocation | null>(null);
const selectedDatasets = ref<IDataset[]>([]);
const warnings = ref<string[]>([]);
const adding = ref(false);
const showPermissionConfirm = ref(false);

const existingDatasetIds = computed<Set<string>>(() => {
  return new Set(props.project.meta.datasets.map((d) => d.datasetId));
});

async function onSelectDataset(selectedLocations: IGirderSelectAble[]) {
  if (selectedLocations.length === 0) {
    selectedDatasets.value = [];
    warnings.value = [];
    return;
  }

  const currentWarnings: string[] = [];
  const newSelectedDatasets: IDataset[] = [];

  // Process selected locations
  await Promise.all(
    selectedLocations.map(async (location) => {
      if (!isDatasetFolder(location)) {
        return;
      }
      const dataset = await girderResources.getDataset({
        id: location._id,
      });
      if (!dataset) {
        return;
      }
      // Check if already in project
      if (existingDatasetIds.value.has(dataset.id)) {
        currentWarnings.push(`"${dataset.name}" is already in this project`);
        return;
      }
      newSelectedDatasets.push(dataset);
    }),
  );

  // Count non-dataset selections
  const nonDatasetCount =
    selectedLocations.length -
    newSelectedDatasets.length -
    currentWarnings.length;
  if (nonDatasetCount > 0) {
    currentWarnings.push(
      `${nonDatasetCount} selected item(s) are not datasets`,
    );
  }

  selectedDatasets.value = newSelectedDatasets;
  warnings.value = currentWarnings;
}

function confirmAdd() {
  if (selectedDatasets.value.length === 0) return;
  if (props.isShared || props.isPublic) {
    showPermissionConfirm.value = true;
  } else {
    addDatasets();
  }
}

async function addDatasets() {
  showPermissionConfirm.value = false;
  if (selectedDatasets.value.length === 0) return;

  adding.value = true;
  try {
    for (const dataset of selectedDatasets.value) {
      await projects.addDatasetToProject({
        projectId: props.project.id,
        datasetId: dataset.id,
      });
    }
    emit(
      "added",
      selectedDatasets.value.map((d) => d.id),
    );
    selectedDatasets.value = [];
    warnings.value = [];
  } finally {
    adding.value = false;
  }
}

defineExpose({
  selectLocation,
  selectedDatasets,
  warnings,
  adding,
  showPermissionConfirm,
  existingDatasetIds,
  onSelectDataset,
  confirmAdd,
  addDatasets,
});
</script>

<style lang="scss" scoped>
.dataset-dialog-card {
  display: flex;
  flex-direction: column;
  height: 85vh;
  max-height: 800px;
  overflow: hidden;
}

.dataset-dialog-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 0;
}

.file-manager-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

// Ensure the girder file manager takes up available space
:deep(.custom-file-manager-wrapper) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

// Override GirderFileManager's internal v-card overflow: hidden
:deep(.file-manager) {
  overflow: auto !important;
  flex: 1;
  min-height: 0;
}
</style>
