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

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import projects from "@/store/projects";
import girderResources from "@/store/girderResources";
import {
  IProject,
  IDatasetView,
  TProjectStatus,
  getProjectStatusColor,
} from "@/store/model";
import { IGirderFolder, IGirderItem, IUPennCollection } from "@/girder";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";
import AddDatasetToProjectDialog from "@/components/AddDatasetToProjectDialog.vue";
import AddCollectionToProjectFilterDialog from "@/components/AddCollectionToProjectFilterDialog.vue";
import { formatSize } from "@/utils/conversion";

// Suppress unused import warnings — auto-registered in <script setup>
void AlertDialog;
void AddDatasetToProjectDialog;
void AddCollectionToProjectFilterDialog;

const vm = getCurrentInstance()!.proxy;

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

// Template ref
const alert = ref<any>(null);

// Dialog state
const deleteConfirm = ref(false);
const removeDatasetConfirm = ref(false);
const removeCollectionConfirm = ref(false);
const addDatasetDialog = ref(false);
const addCollectionDialog = ref(false);

// Edit state
const nameInput = ref("");
const descriptionInput = ref("");
const savingMetadata = ref(false);

// Remove targets
const datasetToRemove = ref<string | null>(null);
const collectionToRemove = ref<string | null>(null);

// Loading state
const loadingDatasets = ref(false);
const loadingCollections = ref(false);

// Filter state
const datasetFilter = ref("");
const collectionFilter = ref("");

// Caches
const datasetInfoCache = ref<{ [datasetId: string]: IGirderFolder }>({});
const collectionInfoCache = ref<{
  [collectionId: string]: IGirderItem | IUPennCollection;
}>({});
const collectionDatasetViewsCache = ref<{
  [collectionId: string]: IDatasetView[];
}>({});

// Metadata form
const metadata = ref<IProjectMetadataForm>({
  title: "",
  description: "",
  license: "CC-BY-4.0",
  keywords: [],
  authors: "",
  doi: "",
  publicationDate: "",
  funding: "",
});

const originalMetadata = ref<IProjectMetadataForm>({
  title: "",
  description: "",
  license: "CC-BY-4.0",
  keywords: [],
  authors: "",
  doi: "",
  publicationDate: "",
  funding: "",
});

const licenseOptions = [
  { text: "CC BY 4.0 (Attribution)", value: "CC-BY-4.0" },
  { text: "CC BY-SA 4.0 (Attribution-ShareAlike)", value: "CC-BY-SA-4.0" },
  { text: "CC BY-NC 4.0 (Attribution-NonCommercial)", value: "CC-BY-NC-4.0" },
  { text: "CC0 (Public Domain)", value: "CC0-1.0" },
  { text: "MIT License", value: "MIT" },
  { text: "Apache 2.0", value: "Apache-2.0" },
  { text: "Other", value: "other" },
];

// Computed
const project = computed((): IProject | null => projects.currentProject);

const statusColor = computed((): string =>
  getProjectStatusColor(project.value?.meta.status),
);

const canStartExport = computed(
  (): boolean => project.value?.meta.status === "draft",
);

const canMarkExported = computed(
  (): boolean => project.value?.meta.status === "exporting",
);

const datasetItems = computed(() => {
  if (!project.value) return [];
  return project.value.meta.datasets.map((d) => ({
    datasetId: d.datasetId,
    addedDate: d.addedDate,
    info: datasetInfoCache.value[d.datasetId],
  }));
});

const collectionItems = computed(() => {
  if (!project.value) return [];
  return project.value.meta.collections.map((c) => ({
    collectionId: c.collectionId,
    addedDate: c.addedDate,
    info: collectionInfoCache.value[c.collectionId],
    datasetViews: collectionDatasetViewsCache.value[c.collectionId] || [],
  }));
});

const allDatasetItems = computed((): IUnifiedDatasetItem[] => {
  const datasetMap = new Map<string, IUnifiedDatasetItem>();

  for (const d of project.value?.meta.datasets || []) {
    datasetMap.set(d.datasetId, {
      datasetId: d.datasetId,
      addedDate: d.addedDate,
      info: datasetInfoCache.value[d.datasetId],
      source: "direct",
      collectionIds: [],
    });
  }

  for (const c of project.value?.meta.collections || []) {
    const views = collectionDatasetViewsCache.value[c.collectionId] || [];
    for (const v of views) {
      const existing = datasetMap.get(v.datasetId);
      if (existing) {
        existing.collectionIds.push(c.collectionId);
      } else {
        datasetMap.set(v.datasetId, {
          datasetId: v.datasetId,
          addedDate: "",
          info: datasetInfoCache.value[v.datasetId],
          source: "collection",
          collectionIds: [c.collectionId],
        });
      }
    }
  }

  return Array.from(datasetMap.values());
});

const filteredDatasetItems = computed((): IUnifiedDatasetItem[] => {
  if (!datasetFilter.value.trim()) {
    return allDatasetItems.value;
  }
  const filter = datasetFilter.value.toLowerCase();
  return allDatasetItems.value.filter((item) =>
    item.info?.name?.toLowerCase().includes(filter),
  );
});

const filteredCollectionItems = computed(() => {
  if (!collectionFilter.value.trim()) {
    return collectionItems.value;
  }
  const filter = collectionFilter.value.toLowerCase();
  return collectionItems.value.filter((item) =>
    item.info?.name?.toLowerCase().includes(filter),
  );
});

const hasMetadataChanges = computed((): boolean => {
  return (
    metadata.value.title !== originalMetadata.value.title ||
    metadata.value.description !== originalMetadata.value.description ||
    metadata.value.license !== originalMetadata.value.license ||
    metadata.value.authors !== originalMetadata.value.authors ||
    metadata.value.doi !== originalMetadata.value.doi ||
    metadata.value.publicationDate !== originalMetadata.value.publicationDate ||
    metadata.value.funding !== originalMetadata.value.funding ||
    JSON.stringify(metadata.value.keywords) !==
      JSON.stringify(originalMetadata.value.keywords)
  );
});

const collectionSizes = computed((): { [collectionId: string]: number } => {
  const sizes: { [collectionId: string]: number } = {};
  for (const c of project.value?.meta.collections || []) {
    const datasetViews =
      collectionDatasetViewsCache.value[c.collectionId] || [];
    let totalSize = 0;
    for (const dv of datasetViews) {
      const folder = datasetInfoCache.value[dv.datasetId];
      if (folder?.size) {
        totalSize += folder.size;
      }
    }
    sizes[c.collectionId] = totalSize;
  }
  return sizes;
});

const totalProjectSize = computed((): number => {
  const seenDatasetIds = new Set<string>();
  let total = 0;

  for (const d of project.value?.meta.datasets || []) {
    if (!seenDatasetIds.has(d.datasetId)) {
      seenDatasetIds.add(d.datasetId);
      const folder = datasetInfoCache.value[d.datasetId];
      if (folder?.size) {
        total += folder.size;
      }
    }
  }

  for (const c of project.value?.meta.collections || []) {
    const datasetViews =
      collectionDatasetViewsCache.value[c.collectionId] || [];
    for (const dv of datasetViews) {
      if (!seenDatasetIds.has(dv.datasetId)) {
        seenDatasetIds.add(dv.datasetId);
        const folder = datasetInfoCache.value[dv.datasetId];
        if (folder?.size) {
          total += folder.size;
        }
      }
    }
  }

  return total;
});

// Methods
function initializeFromProject() {
  if (project.value) {
    nameInput.value = project.value.name;
    descriptionInput.value = project.value.description;
    initializeMetadata();
    fetchDatasetInfo();
    fetchCollectionInfo();
  }
}

function initializeMetadata() {
  if (!project.value) return;
  const meta = project.value.meta.metadata;
  const metadataValues: IProjectMetadataForm = {
    title: meta.title || project.value.name,
    description: meta.description || project.value.description,
    license: meta.license || "CC-BY-4.0",
    keywords: [...(meta.keywords || [])],
    authors: (meta as any).authors || "",
    doi: (meta as any).doi || "",
    publicationDate: (meta as any).publicationDate || "",
    funding: (meta as any).funding || "",
  };
  metadata.value = {
    ...metadataValues,
    keywords: [...metadataValues.keywords],
  };
  originalMetadata.value = {
    ...metadataValues,
    keywords: [...metadataValues.keywords],
  };
}

async function fetchDatasetInfo() {
  if (!project.value) return;
  loadingDatasets.value = true;
  try {
    const datasetIds = project.value.meta.datasets
      .map((d) => d.datasetId)
      .filter((id) => !datasetInfoCache.value[id]);

    if (datasetIds.length > 0) {
      await girderResources.batchFetchResources({
        folderIds: datasetIds,
      });
    }

    for (const d of project.value.meta.datasets) {
      if (!datasetInfoCache.value[d.datasetId]) {
        const folder = girderResources.watchFolder(d.datasetId);
        if (folder) {
          datasetInfoCache.value = {
            ...datasetInfoCache.value,
            [d.datasetId]: folder,
          };
        }
      }
    }
  } finally {
    loadingDatasets.value = false;
  }
}

async function fetchCollectionInfo() {
  if (!project.value) return;
  loadingCollections.value = true;
  try {
    // Step 1: Batch fetch all collections at once
    const collectionIds = project.value.meta.collections
      .map((c) => c.collectionId)
      .filter((id) => !collectionInfoCache.value[id]);

    if (collectionIds.length > 0) {
      await girderResources.batchFetchResources({
        collectionIds: collectionIds,
      });

      for (const c of project.value.meta.collections) {
        if (!collectionInfoCache.value[c.collectionId]) {
          const collection = girderResources.watchCollection(c.collectionId);
          if (collection) {
            collectionInfoCache.value = {
              ...collectionInfoCache.value,
              [c.collectionId]: collection,
            };
          }
        }
      }
    }

    // Step 2: Batch fetch dataset views for all collections at once
    const uncachedCollectionIds = project.value.meta.collections
      .map((c) => c.collectionId)
      .filter((id) => !collectionDatasetViewsCache.value[id]);

    if (uncachedCollectionIds.length > 0) {
      const allViews = await store.api.findDatasetViews({
        configurationIds: uncachedCollectionIds,
      });

      const viewsByCollection = new Map<string, IDatasetView[]>();
      for (const view of allViews) {
        const views = viewsByCollection.get(view.configurationId) || [];
        views.push(view);
        viewsByCollection.set(view.configurationId, views);
      }

      for (const collectionId of uncachedCollectionIds) {
        collectionDatasetViewsCache.value = {
          ...collectionDatasetViewsCache.value,
          [collectionId]: viewsByCollection.get(collectionId) || [],
        };
      }
    }

    // Step 3: Batch fetch all datasets from all collections at once
    const allDatasetIds = new Set<string>();
    for (const c of project.value.meta.collections) {
      const views = collectionDatasetViewsCache.value[c.collectionId] || [];
      for (const view of views) {
        if (!datasetInfoCache.value[view.datasetId]) {
          allDatasetIds.add(view.datasetId);
        }
      }
    }

    if (allDatasetIds.size > 0) {
      await girderResources.batchFetchResources({
        folderIds: Array.from(allDatasetIds),
      });

      for (const datasetId of allDatasetIds) {
        const folder = girderResources.watchFolder(datasetId);
        if (folder) {
          datasetInfoCache.value = {
            ...datasetInfoCache.value,
            [datasetId]: folder,
          };
        }
      }
    }
  } finally {
    loadingCollections.value = false;
  }
}

function openAlert(alertData: IAlert) {
  alert.value.openAlert(alertData);
}

async function tryUpdateName() {
  if (!project.value) return;
  const trimmed = (nameInput.value || "").trim();
  if (trimmed.length === 0 || trimmed === project.value.name) {
    nameInput.value = project.value.name;
    return;
  }
  await projects.updateProject({
    projectId: project.value.id,
    name: trimmed,
  });
}

async function tryUpdateDescription() {
  if (!project.value) return;
  const trimmed = (descriptionInput.value || "").trim();
  if (trimmed === project.value.description) return;
  await projects.updateProject({
    projectId: project.value.id,
    description: trimmed,
  });
}

async function startExport() {
  if (!project.value) return;
  await projects.updateProjectStatus({
    projectId: project.value.id,
    status: "exporting" as TProjectStatus,
  });
}

async function markExported() {
  if (!project.value) return;
  await projects.updateProjectStatus({
    projectId: project.value.id,
    status: "exported" as TProjectStatus,
  });
}

async function deleteProject() {
  if (!project.value) return;
  const success = await projects.deleteProject(project.value.id);
  if (success) {
    deleteConfirm.value = false;
    vm.$router.push({ name: "home" });
  }
}

function confirmRemoveDataset(datasetId: string) {
  datasetToRemove.value = datasetId;
  removeDatasetConfirm.value = true;
}

async function removeDataset() {
  if (!project.value || !datasetToRemove.value) return;
  await projects.removeDatasetFromProject({
    projectId: project.value.id,
    datasetId: datasetToRemove.value,
  });
  removeDatasetConfirm.value = false;
  datasetToRemove.value = null;
}

function confirmRemoveCollection(collectionId: string) {
  collectionToRemove.value = collectionId;
  removeCollectionConfirm.value = true;
}

async function removeCollection() {
  if (!project.value || !collectionToRemove.value) return;
  await projects.removeCollectionFromProject({
    projectId: project.value.id,
    collectionId: collectionToRemove.value,
  });
  removeCollectionConfirm.value = false;
  collectionToRemove.value = null;
}

function navigateToCollection(collectionId: string) {
  vm.$router.push({
    name: "configuration",
    params: { configurationId: collectionId },
  });
}

function onDatasetAdded() {
  addDatasetDialog.value = false;
  fetchDatasetInfo();
}

function onCollectionAdded() {
  addCollectionDialog.value = false;
  fetchCollectionInfo();
}

async function saveMetadata() {
  if (!project.value) return;
  savingMetadata.value = true;
  try {
    await projects.updateProjectMetadata({
      projectId: project.value.id,
      metadata: {
        title: metadata.value.title,
        description: metadata.value.description,
        license: metadata.value.license,
        keywords: metadata.value.keywords,
        authors: metadata.value.authors,
        doi: metadata.value.doi,
        publicationDate: metadata.value.publicationDate,
        funding: metadata.value.funding,
      },
    });
    originalMetadata.value = {
      ...metadata.value,
      keywords: [...metadata.value.keywords],
    };
    openAlert({
      type: "success",
      message: "Metadata saved successfully",
    });
  } catch (error) {
    openAlert({ type: "error", message: "Failed to save metadata" });
  } finally {
    savingMetadata.value = false;
  }
}

// Watchers
watch(project, () => {
  initializeFromProject();
});

// Lifecycle
onMounted(() => {
  initializeFromProject();
});

defineExpose({
  project,
  statusColor,
  canStartExport,
  canMarkExported,
  datasetItems,
  collectionItems,
  allDatasetItems,
  filteredDatasetItems,
  filteredCollectionItems,
  hasMetadataChanges,
  collectionSizes,
  totalProjectSize,
  formatSize,
  deleteConfirm,
  removeDatasetConfirm,
  removeCollectionConfirm,
  addDatasetDialog,
  addCollectionDialog,
  nameInput,
  descriptionInput,
  savingMetadata,
  datasetToRemove,
  collectionToRemove,
  loadingDatasets,
  loadingCollections,
  datasetFilter,
  collectionFilter,
  datasetInfoCache,
  collectionInfoCache,
  collectionDatasetViewsCache,
  metadata,
  originalMetadata,
  licenseOptions,
  initializeFromProject,
  initializeMetadata,
  fetchDatasetInfo,
  fetchCollectionInfo,
  openAlert,
  tryUpdateName,
  tryUpdateDescription,
  startExport,
  markExported,
  deleteProject,
  confirmRemoveDataset,
  removeDataset,
  confirmRemoveCollection,
  removeCollection,
  navigateToCollection,
  onDatasetAdded,
  onCollectionAdded,
  saveMetadata,
});
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
