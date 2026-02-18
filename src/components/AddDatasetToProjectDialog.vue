<template>
  <v-card class="dataset-dialog-card">
    <v-card-title class="flex-shrink-0">
      <span class="text--secondary">Adding dataset to project:</span>
      <span class="text--primary ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text class="dataset-dialog-content">
      <custom-file-manager
        title="Choose a dataset or a folder of datasets to add to the project"
        class="file-manager-container"
        :breadcrumb="true"
        :selectable="true"
        @selected="onSelectDataset"
        :location.sync="selectLocation"
        :initial-items-per-page="-1"
        :items-per-page-options="[-1]"
        :menu-enabled="false"
        :more-chips="false"
        :clickable-chips="false"
      />
      <v-alert
        v-for="(warning, index) in warnings"
        :key="index + '-warning'"
        type="warning"
        class="my-2"
        dense
      >
        {{ warning }}
      </v-alert>
      <v-alert
        v-if="selectedDatasets.length > 0"
        type="success"
        class="my-2"
        dense
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
      <v-btn text @click="$emit('done')">Cancel</v-btn>
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
          <v-btn text @click="showPermissionConfirm = false">Cancel</v-btn>
          <v-btn color="primary" @click="addDatasets">Continue</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import { IDataset, IProject } from "@/store/model";
import girderResources from "@/store/girderResources";
import projects from "@/store/projects";
import { isDatasetFolder } from "@/utils/girderSelectable";
import { IGirderSelectAble } from "@/girder";
import CustomFileManager from "@/components/CustomFileManager.vue";

@Component({
  components: { CustomFileManager },
})
export default class AddDatasetToProjectDialog extends Vue {
  readonly girderResources = girderResources;
  readonly projects = projects;

  @Prop({ required: true })
  project!: IProject;

  @Prop({ default: false })
  isShared!: boolean;

  @Prop({ default: false })
  isPublic!: boolean;

  selectLocation: IGirderSelectAble | null = null;
  selectedDatasets: IDataset[] = [];
  warnings: string[] = [];
  adding = false;
  showPermissionConfirm = false;

  get existingDatasetIds(): Set<string> {
    return new Set(this.project.meta.datasets.map((d) => d.datasetId));
  }

  async onSelectDataset(selectedLocations: IGirderSelectAble[]) {
    if (selectedLocations.length === 0) {
      this.selectedDatasets = [];
      this.warnings = [];
      return;
    }

    const currentWarnings: string[] = [];
    const selectedDatasets: IDataset[] = [];

    // Process selected locations
    await Promise.all(
      selectedLocations.map(async (location) => {
        if (!isDatasetFolder(location)) {
          return;
        }
        const dataset = await this.girderResources.getDataset({
          id: location._id,
        });
        if (!dataset) {
          return;
        }
        // Check if already in project
        if (this.existingDatasetIds.has(dataset.id)) {
          currentWarnings.push(`"${dataset.name}" is already in this project`);
          return;
        }
        selectedDatasets.push(dataset);
      }),
    );

    // Count non-dataset selections
    const nonDatasetCount =
      selectedLocations.length -
      selectedDatasets.length -
      currentWarnings.length;
    if (nonDatasetCount > 0) {
      currentWarnings.push(
        `${nonDatasetCount} selected item(s) are not datasets`,
      );
    }

    this.selectedDatasets = selectedDatasets;
    this.warnings = currentWarnings;
  }

  confirmAdd() {
    if (this.selectedDatasets.length === 0) return;
    if (this.isShared || this.isPublic) {
      this.showPermissionConfirm = true;
    } else {
      this.addDatasets();
    }
  }

  async addDatasets() {
    this.showPermissionConfirm = false;
    if (this.selectedDatasets.length === 0) return;

    this.adding = true;
    try {
      for (const dataset of this.selectedDatasets) {
        await this.projects.addDatasetToProject({
          projectId: this.project.id,
          datasetId: dataset.id,
        });
      }
      this.$emit(
        "added",
        this.selectedDatasets.map((d) => d.id),
      );
      this.selectedDatasets = [];
      this.warnings = [];
    } finally {
      this.adding = false;
    }
  }
}
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
  overflow: hidden;
}

// Ensure the girder file manager takes up available space
::v-deep .custom-file-manager-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
</style>
