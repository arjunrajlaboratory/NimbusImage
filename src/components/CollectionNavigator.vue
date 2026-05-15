<template>
  <v-card class="collection-navigator-card">
    <v-card-title class="collection-navigator-title">
      {{ title }}
    </v-card-title>

    <v-card-text class="collection-navigator-content">
      <div class="navigator-toolbar">
        <div class="breadcrumb-wrap">
          <girder-breadcrumb
            v-if="currentLocation"
            :location="currentLocation"
            root-location-disabled
            @crumb-click="navigateToLocation"
          />
          <span v-else class="text-medium-emphasis">Loading...</span>
        </div>
      </div>

      <v-text-field
        v-model="search"
        append-icon="mdi-magnify"
        label="Search"
        single-line
        hide-details
        class="mb-2"
      />

      <v-progress-linear v-if="loading" indeterminate />

      <v-alert v-else-if="errorMessage" type="error" density="compact">
        {{ errorMessage }}
      </v-alert>

      <div v-else class="navigator-list-wrap">
        <v-list
          v-if="filteredFolders.length || filteredConfigurations.length"
          class="navigator-list"
          density="compact"
        >
          <v-list-subheader v-if="filteredFolders.length">
            Folders
          </v-list-subheader>
          <v-list-item
            v-for="folder in filteredFolders"
            :key="`folder-${folder._id}`"
            @click="navigateToLocation(folder)"
          >
            <template #prepend>
              <v-icon color="primary">mdi-folder</v-icon>
            </template>
            <v-list-item-title>{{ folder.name }}</v-list-item-title>
            <v-list-item-subtitle v-if="folder.description">
              {{ folder.description }}
            </v-list-item-subtitle>
          </v-list-item>

          <v-list-subheader v-if="filteredConfigurations.length">
            Collections
          </v-list-subheader>
          <v-list-item
            v-for="configuration in filteredConfigurations"
            :key="`configuration-${configuration.id}`"
            :active="selectedConfigurationIds.has(configuration.id)"
            @click="toggleSelection(configuration)"
          >
            <template #prepend>
              <v-checkbox
                :model-value="selectedConfigurationIds.has(configuration.id)"
                hide-details
                density="compact"
                color="primary"
                @click.stop
                @update:model-value="toggleSelection(configuration)"
              />
            </template>
            <v-list-item-title>{{ configuration.name }}</v-list-item-title>
            <v-list-item-subtitle v-if="configuration.description">
              {{ configuration.description }}
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>

        <div v-else class="empty-state text-center pa-6">
          <v-icon size="48" color="grey">mdi-file-tree</v-icon>
          <div class="text-body-1 text-grey mt-2">
            {{
              search
                ? "No folders or compatible collections match your search"
                : "No folders or compatible collections in this folder"
            }}
          </div>
        </div>
      </div>
    </v-card-text>

    <v-card-actions class="collection-navigator-actions">
      <v-btn color="warning" class="mr-4" @click="cancel">Cancel</v-btn>
      <v-spacer />
      <span v-if="selectedConfigurations.length" class="text-caption mr-3">
        Selected {{ selectedConfigurations.length }} collection{{
          selectedConfigurations.length === 1 ? "" : "s"
        }}
      </span>
      <v-btn
        :disabled="selectedConfigurations.length <= 0"
        color="primary"
        class="mr-4"
        @click="submit"
      >
        Submit
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";
import { IGirderFolder, IGirderLocation, IGirderSelectAble } from "@/girder";
import store from "@/store";
import { areCompatibles, IDatasetConfiguration } from "@/store/model";
import { getDatasetCompatibility } from "@/store/GirderAPI";
import { isDatasetFolder } from "@/utils/girderSelectable";
import { logError } from "@/utils/log";

const props = withDefaults(
  defineProps<{
    title?: string;
    location?: IGirderLocation | null;
    useDefaultLocation?: boolean;
  }>(),
  {
    title: "Select collections",
    location: null,
    useDefaultLocation: true,
  },
);

const emit = defineEmits<{
  (e: "update:location", value: IGirderLocation | null): void;
  (e: "submit", configurations: IDatasetConfiguration[]): void;
  (e: "cancel"): void;
}>();

const loading = ref(false);
const errorMessage = ref("");
const search = ref("");
const folders = ref<IGirderFolder[]>([]);
const configurations = ref<IDatasetConfiguration[]>([]);
const selectedConfigurationMap = ref<Map<string, IDatasetConfiguration>>(
  new Map(),
);
let fetchGeneration = 0;

const dataset = computed(() => store.dataset);

const currentLocation = computed(() => props.location ?? null);

const selectedConfigurations = computed(() =>
  Array.from(selectedConfigurationMap.value.values()),
);

const selectedConfigurationIds = computed(
  () => new Set(selectedConfigurationMap.value.keys()),
);

const filteredFolders = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) {
    return folders.value;
  }
  return folders.value.filter(
    (folder) =>
      folder.name.toLowerCase().includes(query) ||
      folder.description?.toLowerCase().includes(query),
  );
});

const filteredConfigurations = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) {
    return configurations.value;
  }
  return configurations.value.filter(
    (configuration) =>
      configuration.name.toLowerCase().includes(query) ||
      configuration.description?.toLowerCase().includes(query),
  );
});

function folderId(location: IGirderLocation): string | null {
  if ("_modelType" in location && location._modelType === "folder") {
    return location._id;
  }
  return null;
}

function sortedFolders(items: IGirderFolder[]) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

async function initializeDefaultLocation() {
  if (!props.useDefaultLocation || currentLocation.value) {
    return;
  }
  try {
    const privateFolder = await store.api.getUserPrivateFolder();
    emit("update:location", privateFolder || store.girderUser);
  } catch (error) {
    logError("Failed to initialize collection navigator location:", error);
    emit("update:location", store.girderUser);
  }
}

async function refreshRows() {
  const location = currentLocation.value;
  if (!location) {
    folders.value = [];
    configurations.value = [];
    loading.value = false;
    return;
  }

  const generation = ++fetchGeneration;
  loading.value = true;
  errorMessage.value = "";

  try {
    const currentFolderId = folderId(location);

    const foldersPromise =
      "_modelType" in location &&
      (location._modelType === "folder" || location._modelType === "user")
        ? store.api.getFolders(location._id, location._modelType)
        : Promise.resolve([]);

    const configurationsPromise =
      currentFolderId && dataset.value
        ? store.api.getAllConfigurations(currentFolderId)
        : Promise.resolve([]);

    const linkedViewsPromise = dataset.value
      ? store.api.findDatasetViews({ datasetId: dataset.value.id })
      : Promise.resolve([]);

    const [childFolders, folderConfigurations, linkedViews] = await Promise.all(
      [foldersPromise, configurationsPromise, linkedViewsPromise],
    );

    if (generation !== fetchGeneration) {
      return;
    }

    folders.value = sortedFolders(
      childFolders.filter(
        (folder) => !isDatasetFolder(folder as IGirderSelectAble),
      ),
    );

    const linkedConfigurationIds = new Set<string>(
      linkedViews.map((view: any) => String(view.configurationId)),
    );
    const nextSelected = new Map(selectedConfigurationMap.value);
    linkedConfigurationIds.forEach((id) => nextSelected.delete(id));
    selectedConfigurationMap.value = nextSelected;

    if (!dataset.value) {
      configurations.value = [];
      return;
    }

    const datasetCompatibility = getDatasetCompatibility(dataset.value);
    configurations.value = folderConfigurations.filter(
      (configuration) =>
        !linkedConfigurationIds.has(configuration.id) &&
        areCompatibles(configuration.compatibility, datasetCompatibility),
    );
  } catch (error) {
    if (generation !== fetchGeneration) {
      return;
    }
    logError("Failed to fetch collection navigator rows:", error);
    folders.value = [];
    configurations.value = [];
    errorMessage.value = "Could not load collections for this folder.";
  } finally {
    if (generation === fetchGeneration) {
      loading.value = false;
    }
  }
}

function navigateToLocation(location: IGirderLocation) {
  emit("update:location", location);
}

function toggleSelection(configuration: IDatasetConfiguration) {
  const nextSelected = new Map(selectedConfigurationMap.value);
  if (nextSelected.has(configuration.id)) {
    nextSelected.delete(configuration.id);
  } else {
    nextSelected.set(configuration.id, configuration);
  }
  selectedConfigurationMap.value = nextSelected;
}

function submit() {
  emit("submit", selectedConfigurations.value);
}

function cancel() {
  emit("cancel");
}

watch([currentLocation, dataset], refreshRows, { immediate: true });

onMounted(() => {
  initializeDefaultLocation();
});

defineExpose({
  loading,
  errorMessage,
  search,
  folders,
  configurations,
  selectedConfigurationMap,
  dataset,
  currentLocation,
  selectedConfigurations,
  selectedConfigurationIds,
  filteredFolders,
  filteredConfigurations,
  refreshRows,
  navigateToLocation,
  toggleSelection,
  submit,
  cancel,
});
</script>

<style scoped lang="scss">
.collection-navigator-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.collection-navigator-title {
  flex-shrink: 0;
}

.collection-navigator-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.navigator-toolbar {
  align-items: center;
  display: flex;
  margin-bottom: 12px;
  min-height: 32px;
}

.breadcrumb-wrap {
  min-width: 0;
  overflow-x: auto;
}

.navigator-list-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.navigator-list {
  padding: 0;
}

.collection-navigator-actions {
  flex-shrink: 0;
}
</style>
