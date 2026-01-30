<template>
  <v-container v-if="project">
    <alert-dialog ref="alert" />

    <!-- Header with Delete Button -->
    <v-container class="d-flex align-center">
      <!-- TODO: Export workflow UI - not yet implemented
           Uncomment when Zenodo export integration is ready
      <v-chip :color="statusColor" text-color="white" small class="mr-2">
        {{ project.meta.status }}
      </v-chip>
      -->
      <v-chip v-if="totalProjectSize > 0" outlined small class="mr-2">
        <v-icon left small>mdi-database</v-icon>
        {{ formatSize(totalProjectSize) }} total
      </v-chip>
      <v-spacer />
      <!-- TODO: Export workflow buttons - not yet implemented
           Uncomment when Zenodo export integration is ready
      <v-btn
        v-if="canStartExport"
        color="primary"
        class="mr-2"
        @click="startExport"
      >
        <v-icon left>mdi-export</v-icon>
        Start Export
      </v-btn>
      <v-btn
        v-if="canMarkExported"
        color="success"
        class="mr-2"
        @click="markExported"
      >
        <v-icon left>mdi-check</v-icon>
        Mark as Exported
      </v-btn>
      -->
      <v-dialog v-model="deleteConfirm" max-width="33vw">
        <template #activator="{ on }">
          <v-btn color="red" v-on="on">
            <v-icon left>mdi-delete</v-icon>
            Delete Project
          </v-btn>
        </template>
        <v-card>
          <v-card-title>
            Are you sure you want to delete "{{ project.name }}" forever?
          </v-card-title>
          <v-card-text>
            This will not delete the datasets or collections, only the project
            reference.
          </v-card-text>
          <v-card-actions class="button-bar">
            <v-btn @click="deleteConfirm = false">Cancel</v-btn>
            <v-btn @click="deleteProject" color="error">Delete</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>

    <!-- Editable Name and Description -->
    <v-card class="mb-4">
      <v-card-title>Project Details</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="nameInput"
          label="Name"
          @blur="tryUpdateName"
          @keyup.enter="tryUpdateName"
        />
        <v-textarea
          v-model="descriptionInput"
          label="Description"
          rows="2"
          @blur="tryUpdateDescription"
        />
      </v-card-text>
    </v-card>

    <!-- Datasets Card -->
    <v-card class="mb-4">
      <v-card-title class="d-flex align-center">
        <span>Datasets ({{ filteredDatasetItems.length }})</span>
        <v-spacer />
        <v-text-field
          v-model="datasetFilter"
          placeholder="Filter datasets..."
          prepend-inner-icon="mdi-magnify"
          clearable
          dense
          hide-details
          outlined
          style="max-width: 250px"
          class="ml-2"
        />
      </v-card-title>
      <v-card-text>
        <v-progress-linear v-if="loadingDatasets" indeterminate />
        <div v-else-if="allDatasetItems.length === 0" class="text-center pa-4">
          <v-icon size="48" color="grey">mdi-folder-outline</v-icon>
          <div class="text-body-2 grey--text mt-2">
            No datasets in this project yet.
          </div>
        </div>
        <div
          v-else-if="datasetFilter && filteredDatasetItems.length === 0"
          class="text-center pa-4"
        >
          <v-icon size="48" color="grey">mdi-magnify</v-icon>
          <div class="text-body-2 grey--text mt-2">
            No datasets match "{{ datasetFilter }}"
          </div>
        </div>
        <v-list v-else class="pa-0">
          <template v-for="(item, index) in filteredDatasetItems">
            <v-list-item :key="item.datasetId" class="px-4">
              <v-list-item-content>
                <v-list-item-title
                  class="font-weight-medium d-flex align-center flex-wrap"
                >
                  <span>{{ item.info?.name || "Loading..." }}</span>
                  <span
                    v-if="item.info?.size"
                    class="ml-2 grey--text text-body-2"
                  >
                    ({{ formatSize(item.info.size) }})
                  </span>
                  <v-chip
                    v-for="collId in item.collectionIds"
                    :key="collId"
                    x-small
                    class="ml-2"
                    color="#4baeff"
                    text-color="white"
                    :to="{
                      name: 'configuration',
                      params: { configurationId: collId },
                    }"
                  >
                    {{ collectionInfoCache[collId]?.name || "Collection" }}
                  </v-chip>
                </v-list-item-title>
                <v-list-item-subtitle v-if="item.info?.description">
                  {{ item.info.description }}
                </v-list-item-subtitle>
              </v-list-item-content>
              <v-list-item-action>
                <span class="button-bar">
                  <v-btn
                    v-if="item.source === 'direct'"
                    color="warning"
                    @click="confirmRemoveDataset(item.datasetId)"
                  >
                    <v-icon left>mdi-close</v-icon>remove
                  </v-btn>
                  <v-btn
                    color="primary"
                    :to="{
                      name: 'dataset',
                      params: { datasetId: item.datasetId },
                    }"
                  >
                    <v-icon left>mdi-eye</v-icon>view
                  </v-btn>
                </span>
              </v-list-item-action>
            </v-list-item>
            <v-divider
              v-if="index < filteredDatasetItems.length - 1"
              :key="'divider-' + item.datasetId"
            />
          </template>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-divider />
        <div class="clickable-flex pa-2 body" @click="addDatasetDialog = true">
          <v-icon class="pr-2" color="primary">mdi-plus-circle</v-icon>
          Add dataset to project
        </div>
      </v-card-actions>
    </v-card>

    <!-- Collections Card -->
    <v-card class="mb-4">
      <v-card-title class="d-flex align-center">
        <span>Collections ({{ filteredCollectionItems.length }})</span>
        <v-spacer />
        <v-text-field
          v-model="collectionFilter"
          placeholder="Filter collections..."
          prepend-inner-icon="mdi-magnify"
          clearable
          dense
          hide-details
          outlined
          style="max-width: 250px"
          class="ml-2"
        />
      </v-card-title>
      <v-card-text>
        <v-progress-linear v-if="loadingCollections" indeterminate />
        <div v-else-if="collectionItems.length === 0" class="text-center pa-4">
          <v-icon size="48" color="grey">mdi-folder-multiple-outline</v-icon>
          <div class="text-body-2 grey--text mt-2">
            No collections in this project yet.
          </div>
        </div>
        <div
          v-else-if="collectionFilter && filteredCollectionItems.length === 0"
          class="text-center pa-4"
        >
          <v-icon size="48" color="grey">mdi-magnify</v-icon>
          <div class="text-body-2 grey--text mt-2">
            No collections match "{{ collectionFilter }}"
          </div>
        </div>
        <v-list v-else class="pa-0">
          <template v-for="(item, index) in filteredCollectionItems">
            <v-list-group :key="item.collectionId" no-action>
              <template #activator>
                <v-list-item-content>
                  <v-list-item-title class="font-weight-medium">
                    {{ item.info?.name || "Loading..." }}
                  </v-list-item-title>
                  <v-list-item-subtitle>
                    {{ item.datasetViews.length }} dataset(s)
                    <span v-if="collectionSizes[item.collectionId]">
                      · {{ formatSize(collectionSizes[item.collectionId]) }}
                    </span>
                  </v-list-item-subtitle>
                </v-list-item-content>
                <v-list-item-action>
                  <span class="button-bar">
                    <v-btn
                      color="warning"
                      @click.stop="confirmRemoveCollection(item.collectionId)"
                    >
                      <v-icon left>mdi-close</v-icon>remove
                    </v-btn>
                    <v-btn
                      color="primary"
                      @click.stop="navigateToCollection(item.collectionId)"
                    >
                      <v-icon left>mdi-eye</v-icon>view
                    </v-btn>
                  </span>
                </v-list-item-action>
              </template>
              <!-- Expanded: datasets in this collection -->
              <v-list-item
                v-for="dv in item.datasetViews"
                :key="dv.id"
                class="pl-8"
              >
                <v-list-item-content>
                  <v-list-item-title class="text-body-2">
                    {{ datasetInfoCache[dv.datasetId]?.name || "Loading..." }}
                    <span
                      v-if="datasetInfoCache[dv.datasetId]?.size"
                      class="ml-2 grey--text"
                    >
                      ({{
                        formatSize(datasetInfoCache[dv.datasetId]?.size || 0)
                      }})
                    </span>
                  </v-list-item-title>
                </v-list-item-content>
                <v-list-item-action>
                  <v-btn
                    color="primary"
                    :to="{
                      name: 'dataset',
                      params: { datasetId: dv.datasetId },
                    }"
                  >
                    <v-icon left>mdi-eye</v-icon>view
                  </v-btn>
                </v-list-item-action>
              </v-list-item>
            </v-list-group>
            <v-divider
              v-if="index < filteredCollectionItems.length - 1"
              :key="'divider-' + item.collectionId"
            />
          </template>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-divider />
        <div
          class="clickable-flex pa-2 body"
          @click="addCollectionDialog = true"
        >
          <v-icon class="pr-2" color="primary">mdi-plus-circle</v-icon>
          Add collection to project
        </div>
      </v-card-actions>
    </v-card>

    <!-- Publication Metadata Card -->
    <v-card class="mb-4">
      <v-card-title>Publication Metadata</v-card-title>
      <v-card-text>
        <v-text-field v-model="metadata.title" label="Title" outlined dense />
        <v-textarea
          v-model="metadata.description"
          label="Description"
          outlined
          dense
          rows="2"
        />
        <v-select
          v-model="metadata.license"
          :items="licenseOptions"
          label="License"
          outlined
          dense
        />
        <v-combobox
          v-model="metadata.keywords"
          label="Keywords"
          multiple
          chips
          small-chips
          deletable-chips
          outlined
          dense
          hint="Press Enter to add a keyword"
        />
        <v-text-field
          v-model="metadata.authors"
          label="Authors"
          outlined
          dense
          hint="Comma-separated list of authors"
        />
        <v-text-field
          v-model="metadata.doi"
          label="DOI"
          outlined
          dense
          placeholder="10.xxxx/xxxxx"
        />
        <v-text-field
          v-model="metadata.publicationDate"
          label="Publication Date"
          type="date"
          outlined
          dense
        />
        <v-text-field
          v-model="metadata.funding"
          label="Funding"
          outlined
          dense
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn
          color="primary"
          :loading="savingMetadata"
          :disabled="!hasMetadataChanges"
          @click="saveMetadata"
        >
          Save Metadata
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- Remove Dataset Confirmation Dialog -->
    <v-dialog v-model="removeDatasetConfirm" max-width="33vw">
      <v-card>
        <v-card-title>Remove dataset from project?</v-card-title>
        <v-card-text>
          This will remove the dataset reference from this project. The dataset
          itself will not be deleted.
        </v-card-text>
        <v-card-actions class="button-bar">
          <v-btn @click="removeDatasetConfirm = false">Cancel</v-btn>
          <v-btn @click="removeDataset" color="warning">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Remove Collection Confirmation Dialog -->
    <v-dialog v-model="removeCollectionConfirm" max-width="33vw">
      <v-card>
        <v-card-title>Remove collection from project?</v-card-title>
        <v-card-text>
          This will remove the collection reference from this project. The
          collection itself will not be deleted.
        </v-card-text>
        <v-card-actions class="button-bar">
          <v-btn @click="removeCollectionConfirm = false">Cancel</v-btn>
          <v-btn @click="removeCollection" color="warning">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Add Dataset Dialog -->
    <v-dialog v-model="addDatasetDialog" width="60%">
      <add-dataset-to-project-dialog
        v-if="project"
        :project="project"
        @added="onDatasetAdded"
        @done="addDatasetDialog = false"
      />
    </v-dialog>

    <!-- Add Collection Dialog -->
    <v-dialog v-model="addCollectionDialog" width="60%">
      <add-collection-to-project-filter-dialog
        v-if="project"
        :project="project"
        @added="onCollectionAdded"
        @done="addCollectionDialog = false"
      />
    </v-dialog>
  </v-container>

  <v-container v-else class="text-center">
    <v-progress-circular indeterminate size="64" />
    <div class="mt-4 text-body-1">Loading project...</div>
  </v-container>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import projects from "@/store/projects";
import girderResources from "@/store/girderResources";
import {
  IProject,
  IDatasetView,
  TProjectStatus,
  getProjectStatusColor,
} from "@/store/model";
import { IGirderFolder, IGirderItem } from "@/girder";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";
import AddDatasetToProjectDialog from "@/components/AddDatasetToProjectDialog.vue";
import AddCollectionToProjectFilterDialog from "@/components/AddCollectionToProjectFilterDialog.vue";
import { formatSize } from "@/utils/conversion";

interface IProjectMetadataForm {
  title: string;
  description: string;
  license: string;
  keywords: string[];
  authors: string;
  doi: string;
  publicationDate: string;
  funding: string;
}

interface IUnifiedDatasetItem {
  datasetId: string;
  addedDate: string;
  info: IGirderFolder | undefined;
  source: "direct" | "collection";
  collectionIds: string[];
}

@Component({
  components: {
    AlertDialog,
    AddDatasetToProjectDialog,
    AddCollectionToProjectFilterDialog,
  },
})
export default class ProjectInfo extends Vue {
  readonly store = store;
  readonly projects = projects;
  readonly girderResources = girderResources;

  // Note: alert uses 'any' due to Vue 2/3 Composition API type incompatibility during migration
  $refs!: {
    alert: any;
  };

  // Dialog state
  deleteConfirm = false;
  removeDatasetConfirm = false;
  removeCollectionConfirm = false;
  addDatasetDialog = false;
  addCollectionDialog = false;

  // Edit state
  nameInput = "";
  descriptionInput = "";
  savingMetadata = false;

  // Remove targets
  datasetToRemove: string | null = null;
  collectionToRemove: string | null = null;

  // Loading state
  loadingDatasets = false;
  loadingCollections = false;

  // Filter state
  datasetFilter = "";
  collectionFilter = "";

  // Caches
  datasetInfoCache: { [datasetId: string]: IGirderFolder } = {};
  collectionInfoCache: { [collectionId: string]: IGirderItem } = {};
  collectionDatasetViewsCache: { [collectionId: string]: IDatasetView[] } = {};

  // Metadata form
  metadata: IProjectMetadataForm = {
    title: "",
    description: "",
    license: "CC-BY-4.0",
    keywords: [],
    authors: "",
    doi: "",
    publicationDate: "",
    funding: "",
  };

  // Original metadata for change detection
  originalMetadata: IProjectMetadataForm = {
    title: "",
    description: "",
    license: "CC-BY-4.0",
    keywords: [],
    authors: "",
    doi: "",
    publicationDate: "",
    funding: "",
  };

  licenseOptions = [
    { text: "CC BY 4.0 (Attribution)", value: "CC-BY-4.0" },
    { text: "CC BY-SA 4.0 (Attribution-ShareAlike)", value: "CC-BY-SA-4.0" },
    { text: "CC BY-NC 4.0 (Attribution-NonCommercial)", value: "CC-BY-NC-4.0" },
    { text: "CC0 (Public Domain)", value: "CC0-1.0" },
    { text: "MIT License", value: "MIT" },
    { text: "Apache 2.0", value: "Apache-2.0" },
    { text: "Other", value: "other" },
  ];

  get project(): IProject | null {
    return this.projects.currentProject;
  }

  get statusColor(): string {
    return getProjectStatusColor(this.project?.meta.status);
  }

  get canStartExport(): boolean {
    return this.project?.meta.status === "draft";
  }

  get canMarkExported(): boolean {
    return this.project?.meta.status === "exporting";
  }

  get datasetItems() {
    if (!this.project) return [];
    return this.project.meta.datasets.map((d) => ({
      datasetId: d.datasetId,
      addedDate: d.addedDate,
      info: this.datasetInfoCache[d.datasetId],
    }));
  }

  get collectionItems() {
    if (!this.project) return [];
    return this.project.meta.collections.map((c) => ({
      collectionId: c.collectionId,
      addedDate: c.addedDate,
      info: this.collectionInfoCache[c.collectionId],
      datasetViews: this.collectionDatasetViewsCache[c.collectionId] || [],
    }));
  }

  get allDatasetItems(): IUnifiedDatasetItem[] {
    const datasetMap = new Map<string, IUnifiedDatasetItem>();

    // Add direct datasets
    for (const d of this.project?.meta.datasets || []) {
      datasetMap.set(d.datasetId, {
        datasetId: d.datasetId,
        addedDate: d.addedDate,
        info: this.datasetInfoCache[d.datasetId],
        source: "direct",
        collectionIds: [],
      });
    }

    // Add/update with collection datasets
    for (const c of this.project?.meta.collections || []) {
      const views = this.collectionDatasetViewsCache[c.collectionId] || [];
      for (const v of views) {
        const existing = datasetMap.get(v.datasetId);
        if (existing) {
          existing.collectionIds.push(c.collectionId);
        } else {
          datasetMap.set(v.datasetId, {
            datasetId: v.datasetId,
            addedDate: "",
            info: this.datasetInfoCache[v.datasetId],
            source: "collection",
            collectionIds: [c.collectionId],
          });
        }
      }
    }

    return Array.from(datasetMap.values());
  }

  get filteredDatasetItems(): IUnifiedDatasetItem[] {
    if (!this.datasetFilter.trim()) {
      return this.allDatasetItems;
    }
    const filter = this.datasetFilter.toLowerCase();
    return this.allDatasetItems.filter((item) =>
      item.info?.name?.toLowerCase().includes(filter),
    );
  }

  get filteredCollectionItems() {
    if (!this.collectionFilter.trim()) {
      return this.collectionItems;
    }
    const filter = this.collectionFilter.toLowerCase();
    return this.collectionItems.filter((item) =>
      item.info?.name?.toLowerCase().includes(filter),
    );
  }

  get hasMetadataChanges(): boolean {
    return (
      this.metadata.title !== this.originalMetadata.title ||
      this.metadata.description !== this.originalMetadata.description ||
      this.metadata.license !== this.originalMetadata.license ||
      this.metadata.authors !== this.originalMetadata.authors ||
      this.metadata.doi !== this.originalMetadata.doi ||
      this.metadata.publicationDate !== this.originalMetadata.publicationDate ||
      this.metadata.funding !== this.originalMetadata.funding ||
      JSON.stringify(this.metadata.keywords) !==
        JSON.stringify(this.originalMetadata.keywords)
    );
  }

  get collectionSizes(): { [collectionId: string]: number } {
    const sizes: { [collectionId: string]: number } = {};
    for (const c of this.project?.meta.collections || []) {
      const datasetViews =
        this.collectionDatasetViewsCache[c.collectionId] || [];
      let totalSize = 0;
      for (const dv of datasetViews) {
        const folder = this.datasetInfoCache[dv.datasetId];
        if (folder?.size) {
          totalSize += folder.size;
        }
      }
      sizes[c.collectionId] = totalSize;
    }
    return sizes;
  }

  get totalProjectSize(): number {
    const seenDatasetIds = new Set<string>();
    let total = 0;

    // Add sizes from direct datasets
    for (const d of this.project?.meta.datasets || []) {
      if (!seenDatasetIds.has(d.datasetId)) {
        seenDatasetIds.add(d.datasetId);
        const folder = this.datasetInfoCache[d.datasetId];
        if (folder?.size) {
          total += folder.size;
        }
      }
    }

    // Add sizes from collection datasets (only if not already counted)
    for (const c of this.project?.meta.collections || []) {
      const datasetViews =
        this.collectionDatasetViewsCache[c.collectionId] || [];
      for (const dv of datasetViews) {
        if (!seenDatasetIds.has(dv.datasetId)) {
          seenDatasetIds.add(dv.datasetId);
          const folder = this.datasetInfoCache[dv.datasetId];
          if (folder?.size) {
            total += folder.size;
          }
        }
      }
    }

    return total;
  }

  formatSize = formatSize;

  mounted() {
    this.initializeFromProject();
  }

  @Watch("project")
  onProjectChange() {
    this.initializeFromProject();
  }

  initializeFromProject() {
    if (this.project) {
      this.nameInput = this.project.name;
      this.descriptionInput = this.project.description;
      this.initializeMetadata();
      this.fetchDatasetInfo();
      this.fetchCollectionInfo();
    }
  }

  initializeMetadata() {
    if (!this.project) return;
    const meta = this.project.meta.metadata;
    const metadataValues: IProjectMetadataForm = {
      title: meta.title || this.project.name,
      description: meta.description || this.project.description,
      license: meta.license || "CC-BY-4.0",
      keywords: [...(meta.keywords || [])],
      authors: (meta as any).authors || "",
      doi: (meta as any).doi || "",
      publicationDate: (meta as any).publicationDate || "",
      funding: (meta as any).funding || "",
    };
    this.metadata = {
      ...metadataValues,
      keywords: [...metadataValues.keywords],
    };
    this.originalMetadata = {
      ...metadataValues,
      keywords: [...metadataValues.keywords],
    };
  }

  async fetchDatasetInfo() {
    if (!this.project) return;
    this.loadingDatasets = true;
    try {
      // Collect all dataset IDs that aren't already cached
      const datasetIds = this.project.meta.datasets
        .map((d) => d.datasetId)
        .filter((id) => !this.datasetInfoCache[id]);

      if (datasetIds.length > 0) {
        // Batch fetch all folders at once
        await this.girderResources.batchFetchResources({
          folderIds: datasetIds,
        });
      }

      // Populate local cache from the store's resources
      for (const d of this.project.meta.datasets) {
        if (!this.datasetInfoCache[d.datasetId]) {
          const folder = this.girderResources.watchFolder(d.datasetId);
          if (folder) {
            Vue.set(this.datasetInfoCache, d.datasetId, folder);
          }
        }
      }
    } finally {
      this.loadingDatasets = false;
    }
  }

  async fetchCollectionInfo() {
    if (!this.project) return;
    this.loadingCollections = true;
    try {
      // Step 1: Batch fetch all collections at once
      const collectionIds = this.project.meta.collections
        .map((c) => c.collectionId)
        .filter((id) => !this.collectionInfoCache[id]);

      if (collectionIds.length > 0) {
        await this.girderResources.batchFetchResources({
          collectionIds: collectionIds,
        });

        // Populate local collection cache from the store's resources
        for (const c of this.project.meta.collections) {
          if (!this.collectionInfoCache[c.collectionId]) {
            const collection = this.girderResources.watchCollection(
              c.collectionId,
            );
            if (collection) {
              Vue.set(this.collectionInfoCache, c.collectionId, collection);
            }
          }
        }
      }

      // Step 2: Batch fetch dataset views for all collections at once
      const uncachedCollectionIds = this.project.meta.collections
        .map((c) => c.collectionId)
        .filter((id) => !this.collectionDatasetViewsCache[id]);

      if (uncachedCollectionIds.length > 0) {
        const allViews = await this.store.api.findDatasetViews({
          configurationIds: uncachedCollectionIds,
        });

        // Group views by configurationId and populate cache
        const viewsByCollection = new Map<string, IDatasetView[]>();
        for (const view of allViews) {
          const views = viewsByCollection.get(view.configurationId) || [];
          views.push(view);
          viewsByCollection.set(view.configurationId, views);
        }

        // Populate cache (including empty arrays for collections with no views)
        for (const collectionId of uncachedCollectionIds) {
          Vue.set(
            this.collectionDatasetViewsCache,
            collectionId,
            viewsByCollection.get(collectionId) || [],
          );
        }
      }

      // Step 3: Batch fetch all datasets from all collections at once
      const allDatasetIds = new Set<string>();
      for (const c of this.project.meta.collections) {
        const views = this.collectionDatasetViewsCache[c.collectionId] || [];
        for (const view of views) {
          if (!this.datasetInfoCache[view.datasetId]) {
            allDatasetIds.add(view.datasetId);
          }
        }
      }

      if (allDatasetIds.size > 0) {
        await this.girderResources.batchFetchResources({
          folderIds: Array.from(allDatasetIds),
        });

        // Populate local dataset cache from the store's resources
        for (const datasetId of allDatasetIds) {
          const folder = this.girderResources.watchFolder(datasetId);
          if (folder) {
            Vue.set(this.datasetInfoCache, datasetId, folder);
          }
        }
      }
    } finally {
      this.loadingCollections = false;
    }
  }

  openAlert(alert: IAlert) {
    this.$refs.alert.openAlert(alert);
  }

  async tryUpdateName() {
    if (!this.project) return;
    const trimmed = (this.nameInput || "").trim();
    if (trimmed.length === 0 || trimmed === this.project.name) {
      this.nameInput = this.project.name;
      return;
    }
    await this.projects.updateProject({
      projectId: this.project.id,
      name: trimmed,
    });
  }

  async tryUpdateDescription() {
    if (!this.project) return;
    const trimmed = (this.descriptionInput || "").trim();
    if (trimmed === this.project.description) return;
    await this.projects.updateProject({
      projectId: this.project.id,
      description: trimmed,
    });
  }

  async startExport() {
    if (!this.project) return;
    await this.projects.updateProjectStatus({
      projectId: this.project.id,
      status: "exporting" as TProjectStatus,
    });
  }

  async markExported() {
    if (!this.project) return;
    await this.projects.updateProjectStatus({
      projectId: this.project.id,
      status: "exported" as TProjectStatus,
    });
  }

  async deleteProject() {
    if (!this.project) return;
    const success = await this.projects.deleteProject(this.project.id);
    if (success) {
      this.deleteConfirm = false;
      this.$router.push({ name: "home" });
    }
  }

  confirmRemoveDataset(datasetId: string) {
    this.datasetToRemove = datasetId;
    this.removeDatasetConfirm = true;
  }

  async removeDataset() {
    if (!this.project || !this.datasetToRemove) return;
    await this.projects.removeDatasetFromProject({
      projectId: this.project.id,
      datasetId: this.datasetToRemove,
    });
    this.removeDatasetConfirm = false;
    this.datasetToRemove = null;
  }

  confirmRemoveCollection(collectionId: string) {
    this.collectionToRemove = collectionId;
    this.removeCollectionConfirm = true;
  }

  async removeCollection() {
    if (!this.project || !this.collectionToRemove) return;
    await this.projects.removeCollectionFromProject({
      projectId: this.project.id,
      collectionId: this.collectionToRemove,
    });
    this.removeCollectionConfirm = false;
    this.collectionToRemove = null;
  }

  navigateToCollection(collectionId: string) {
    this.$router.push({
      name: "configuration",
      params: { configurationId: collectionId },
    });
  }

  onDatasetAdded() {
    this.addDatasetDialog = false;
    this.fetchDatasetInfo();
  }

  onCollectionAdded() {
    this.addCollectionDialog = false;
    this.fetchCollectionInfo();
  }

  async saveMetadata() {
    if (!this.project) return;
    this.savingMetadata = true;
    try {
      await this.projects.updateProjectMetadata({
        projectId: this.project.id,
        metadata: {
          title: this.metadata.title,
          description: this.metadata.description,
          license: this.metadata.license,
          keywords: this.metadata.keywords,
          authors: this.metadata.authors,
          doi: this.metadata.doi,
          publicationDate: this.metadata.publicationDate,
          funding: this.metadata.funding,
        },
      });
      // Update originalMetadata to match current values after successful save
      this.originalMetadata = {
        ...this.metadata,
        keywords: [...this.metadata.keywords],
      };
      this.openAlert({
        type: "success",
        message: "Metadata saved successfully",
      });
    } catch (error) {
      this.openAlert({ type: "error", message: "Failed to save metadata" });
    } finally {
      this.savingMetadata = false;
    }
  }
}
</script>

<style lang="scss" scoped>
.clickable-flex {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.button-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

// Only add hover effect to group headers as they are clickable
::v-deep .v-list-group__header:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

// Ensure list item actions align properly with content
::v-deep .v-list-item__action {
  align-self: center;
}

// Fix alignment in list groups
::v-deep .v-list-group__header {
  align-items: center;
}
</style>
