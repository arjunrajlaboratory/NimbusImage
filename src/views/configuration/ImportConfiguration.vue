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
<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import ConfigurationSelect from "@/components/ConfigurationSelect.vue";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { IDatasetConfiguration } from "@/store/model";
import { IGirderSelectAble } from "@/girder";

@Component({
  components: { ConfigurationSelect, GirderLocationChooser },
})
export default class ImportConfiguration extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  selectedFolder: IGirderSelectAble | null = null;
  currentFolderName: string = "";

  get datasetName() {
    return this.store.dataset?.name || "";
  }

  get folderId(): string | undefined {
    if (this.selectedFolder && this.selectedFolder._modelType === "folder") {
      return this.selectedFolder._id;
    }
    // Fallback to route query if folder not yet loaded
    const folderId = this.$route.query.folderId;
    if (Array.isArray(folderId)) {
      return folderId[0] || undefined;
    }
    if (folderId === null) {
      return undefined;
    }
    return folderId;
  }

  @Watch("selectedFolder")
  async updateFolderName() {
    if (this.selectedFolder && this.selectedFolder._modelType === "folder") {
      const folder = await this.girderResources.getFolder(
        this.selectedFolder._id,
      );
      this.currentFolderName = folder?.name || "Unknown folder";
    } else {
      this.currentFolderName = "";
    }
  }

  async mounted() {
    // Initialize selectedFolder from route query
    const folderId = this.$route.query.folderId;
    const targetFolderId = Array.isArray(folderId) ? folderId[0] : folderId;
    if (targetFolderId) {
      const folder = await this.girderResources.getFolder(targetFolderId);
      if (folder) {
        this.selectedFolder = folder;
        this.currentFolderName = folder.name;
      }
    } else {
      // If no folderId in query, try to get dataset's parent folder
      if (this.store.dataset) {
        const datasetFolder = await this.girderResources.getFolder(
          this.store.dataset.id,
        );
        if (datasetFolder?.parentId) {
          const parentFolder = await this.girderResources.getFolder(
            datasetFolder.parentId,
          );
          if (parentFolder) {
            this.selectedFolder = parentFolder;
            this.currentFolderName = parentFolder.name;
          }
        }
      }
    }
  }

  async submit(configurations: IDatasetConfiguration[]) {
    const dataset = this.store.dataset;
    if (!dataset) {
      return;
    }

    // Create a view for each configuration
    await Promise.all(
      configurations.map((configuration) =>
        this.store.createDatasetView({
          configurationId: configuration.id,
          datasetId: dataset.id,
        }),
      ),
    );

    this.$router.back();
  }

  cancel() {
    this.$router.back();
  }
}
</script>
