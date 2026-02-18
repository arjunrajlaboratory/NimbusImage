<template>
  <div class="custom-file-manager-wrapper">
    <div class="d-flex align-center ma-2 search-container">
      <v-icon class="mr-2">mdi-magnify</v-icon>
      <div class="flex-grow-1">
        <girder-search
          @select="searchInput"
          hide-search-icon
          :searchTypes="[
            'user',
            'folder',
            'upenn_collection.upenncontrast_annotation',
          ]"
        >
          <template #searchresult="item">
            <v-icon class="mr-2">{{ iconToMdi(iconFromItem(item)) }}</v-icon>
            <span>{{ item.name }}</span>
            <file-item-row
              :item="item"
              :debouncedChipsPerItemId="debouncedChipsPerItemId"
              :computedChipsIds="computedChipsIds"
            />
          </template>
        </girder-search>
      </div>
    </div>
    <girder-file-manager
      v-if="currentLocation"
      :location.sync="currentLocation"
      new-folder-enabled
      :selectable="menuEnabled || selectable"
      v-model="selected"
      v-bind="$attrs"
      v-on="$listeners"
    >
      <template v-if="menuEnabled" #headerwidget>
        <v-menu v-model="selectedItemsOptionsMenu" bottom offset-y>
          <template v-slot:activator="{ on, attrs }">
            <v-btn
              v-bind="attrs"
              v-on="on"
              :disabled="selected.length === 0"
              outlined
              class="ghost-button"
            >
              Actions
              <v-icon>mdi-dots-vertical</v-icon>
            </v-btn>
          </template>
          <file-manager-options
            @itemsChanged="reloadItems"
            @closeMenu="selectedItemsOptionsMenu = false"
            :items="selected"
          />
        </v-menu>
        <input
          type="file"
          ref="fileInput"
          @change="handleFileUpload"
          style="display: none"
        />
        <v-btn
          class="mx-2 ghost-button"
          @click="fileInput?.click()"
          :disabled="shouldDisableSingleFileUpload"
          outlined
        >
          <v-icon left>mdi-upload</v-icon>
          Upload Non-Image File
        </v-btn>
      </template>
      <template #row-widget="props">
        <span>{{ renderItem(props.item) }}</span>
        <file-item-row
          :item="props.item"
          :debouncedChipsPerItemId="debouncedChipsPerItemId"
          :computedChipsIds="computedChipsIds"
        >
          <template #actions>
            <v-menu v-model="rowOptionsMenu[props.item._id]" v-if="menuEnabled">
              <template v-slot:activator="{ on, attrs }">
                <v-btn icon v-bind="attrs" v-on="on">
                  <v-icon>mdi-dots-vertical</v-icon>
                </v-btn>
              </template>
              <file-manager-options
                @itemsChanged="reloadItems"
                :items="[props.item]"
                @closeMenu="rowOptionsMenu[props.item._id] = false"
              >
                <template #default="optionsSlotAttributes">
                  <slot name="options" v-bind="optionsSlotAttributes"></slot>
                </template>
              </file-manager-options>
            </v-menu>
          </template>
        </file-item-row>
      </template>
    </girder-file-manager>
    <alert-dialog ref="alertDialog"></alert-dialog>
  </div>
</template>

<script lang="ts" setup>
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import store from "@/store";
import { IGirderLocation, IGirderSelectAble } from "@/girder";
import {
  isConfigurationItem,
  isDatasetFolder,
  toConfigurationItem,
  toDatasetFolder,
  unselectableLocations,
} from "@/utils/girderSelectable";
import { RawLocation } from "vue-router";
import FileManagerOptions from "./FileManagerOptions.vue";
import FileItemRow from "./FileItemRow.vue";
import { Search as GirderSearch } from "@/girder/components";
import { FileManager as GirderFileManager } from "@/girder/components";
import { vuetifyConfig } from "@/girder";
import { logError } from "@/utils/log";
import AlertDialog from "@/components/AlertDialog.vue";

interface IChipAttrs {
  text: string;
  color: string;
  to?: RawLocation;
}

interface IChipsPerItemId {
  chips: IChipAttrs[];
  type: string;
}

const props = withDefaults(
  defineProps<{
    menuEnabled?: boolean;
    selectable?: boolean;
    moreChips?: boolean;
    clickableChips?: boolean;
    location?: IGirderLocation | null;
    useDefaultLocation?: boolean;
  }>(),
  {
    menuEnabled: true,
    selectable: false,
    moreChips: true,
    clickableChips: true,
    location: null,
    useDefaultLocation: true,
  },
);

const emit = defineEmits<{
  (e: "update:location", value: IGirderLocation | null): void;
  (e: "selected", value: IGirderSelectAble[]): void;
  (e: "rowclick", value: IGirderSelectAble): void;
}>();

// Template refs
const fileInput = ref<HTMLInputElement>();
const alertDialog = ref<InstanceType<typeof AlertDialog>>();

// Reactive state
const overridingLocation = ref<IGirderLocation | null>(null);
const defaultLocation = ref<IGirderLocation | null>(null);
const debouncedChipsPerItemId = ref<Record<string, IChipsPerItemId>>({});
const selected = ref<IGirderSelectAble[]>([]);
const selectedItemsOptionsMenu = ref(false);
const rowOptionsMenu = ref<Record<string, boolean>>({});

// Non-reactive internal state
let chipsPerItemId: Record<string, IChipsPerItemId> = {};
let pendingChips = 0;
let lastPendingChip: Promise<any> = Promise.resolve();
let computedChipsIds = new Set<string>();
let batchQueueDatasetIds = new Set<string>();
let batchQueueConfigurationIds = new Set<string>();
let batchTimer: number | null = null;

// Computed
const isLoggedIn = computed(() => store.isLoggedIn);

const currentLocation = computed({
  get() {
    if (overridingLocation.value) {
      return overridingLocation.value;
    }
    if (props.useDefaultLocation && props.location === null) {
      emit("update:location", defaultLocation.value);
      return defaultLocation.value;
    }
    return props.location;
  },
  set(value: IGirderLocation | null) {
    emit("update:location", value);
  },
});

const shouldDisableSingleFileUpload = computed(() => {
  return (
    !currentLocation.value ||
    ("_modelType" in currentLocation.value &&
      unselectableLocations.includes(currentLocation.value._modelType)) ||
    ("type" in currentLocation.value &&
      unselectableLocations.includes(currentLocation.value.type))
  );
});

// Methods
async function reloadItems() {
  try {
    overridingLocation.value = { type: "root" };
    await nextTick();
  } finally {
    overridingLocation.value = null;
  }
}

async function fetchLocation() {
  const privateFolder = await store.api.getUserPrivateFolder();
  defaultLocation.value = privateFolder || store.girderUser;
}

function emitSelected() {
  if (props.selectable) {
    emit("selected", selected.value);
  }
}

function searchInput(value: IGirderSelectAble) {
  if (
    value._modelType === "upenn_collection" ||
    value._modelType === "file" ||
    value._modelType === "item"
  ) {
    return;
  }
  currentLocation.value = value;
  emit("rowclick", value);
}

function iconToMdi(icon: string) {
  return vuetifyConfig.icons.values[icon] || `mdi-${icon}`;
}

function iconFromItem(selectable: IGirderSelectAble) {
  if (isDatasetFolder(selectable)) {
    return "box_com";
  }
  if (isConfigurationItem(selectable)) {
    return "collection";
  }
  switch (selectable._modelType) {
    case "file":
    case "item":
    case "upenn_collection":
      return "file";
    case "folder":
      return "folder";
    case "user":
      return "user";
    default:
      return "file";
  }
}

function renderItem(selectable: IGirderSelectAble) {
  const datasetFolder = toDatasetFolder(selectable);
  const configurationItem = toConfigurationItem(selectable);
  selectable.icon = iconFromItem(selectable);
  const folderOrItem = datasetFolder || configurationItem;
  if (folderOrItem && !computedChipsIds.has(selectable._id)) {
    computedChipsIds.add(selectable._id);
    addChipPromise(selectable);
  }
}

function addChipPromise(item: IGirderSelectAble) {
  // Chain a new chip promise with last pending promise
  lastPendingChip = lastPendingChip
    .finally()
    .then(() => itemToChips(item))
    .then((chipAttrs) => {
      chipsPerItemId[item._id] = chipAttrs;
    });
  // When done with the last promise, update debouncedChipsPerItemId
  ++pendingChips;
  lastPendingChip.finally(() => {
    if (--pendingChips === 0) {
      debouncedChipsPerItemId.value = { ...chipsPerItemId };
    }
  });
}

async function itemToChips(selectable: IGirderSelectAble) {
  const ret: IChipAttrs[] = [];

  // Determine type first
  const isDataset = isDatasetFolder(selectable);
  const isConfig = isConfigurationItem(selectable);

  if (!isDataset && !isConfig) {
    return { chips: ret, type: null as any };
  }

  const type = isDataset ? "dataset" : "configuration";

  // First chip (type indicator)
  const chipOptions = {
    dataset: {
      text: "Dataset",
      to_name: "dataset",
      to_params: { datasetId: selectable._id },
    },
    configuration: {
      text: "Collection",
      to_name: "configuration",
      to_params: { configurationId: selectable._id },
    },
  };

  const chipOption = chipOptions[type];
  const headerChip: IChipAttrs = {
    text: chipOption.text,
    color: "grey darken-1",
  };
  if (props.clickableChips) {
    headerChip.to = {
      name: chipOption.to_name,
      params: chipOption.to_params,
    };
  }
  ret.push(headerChip);

  // If we don't show more chips, return early
  if (!props.moreChips) {
    return { chips: ret, type };
  }

  // Enqueue for batch resolution and return header-only chips for now
  if (isDataset) {
    batchQueueDatasetIds.add(selectable._id);
  } else {
    batchQueueConfigurationIds.add(selectable._id);
  }
  scheduleBatchResolve();

  return { chips: ret, type };
}

function scheduleBatchResolve() {
  // Clear any existing timer to restart the debounce period
  if (batchTimer !== null) {
    window.clearTimeout(batchTimer);
    batchTimer = null;
  }

  // Debounce mechanism: Wait 50ms to collect IDs from multiple itemToChips calls
  // This allows Vue's rendering cycle to call itemToChips() many times
  // (once per item being rendered), accumulating dataset/configuration IDs
  // in batchQueueDatasetIds and batchQueueConfigurationIds sets.
  // After 50ms of no new calls, flushBatchResolve() fires a single
  // bulk API request to resolve all collected IDs at once.
  batchTimer = window.setTimeout(() => flushBatchResolve(), 50);
}

async function flushBatchResolve() {
  const datasetIds = Array.from(batchQueueDatasetIds);
  const configurationIds = Array.from(batchQueueConfigurationIds);
  batchQueueDatasetIds.clear();
  batchQueueConfigurationIds.clear();
  batchTimer = null;

  if (datasetIds.length === 0 && configurationIds.length === 0) {
    return;
  }

  // Query mapping with names
  let pairs: Array<{
    datasetId: string;
    configurationId: string;
    datasetName?: string;
    configurationName?: string;
  }> = [];
  try {
    pairs = await store.api.mapDatasetViews({
      datasetIds: datasetIds.length ? datasetIds : undefined,
      configurationIds: configurationIds.length ? configurationIds : undefined,
      includeNames: true,
    } as any);
  } catch (e) {
    // If endpoint not available, fall back silently
    logError("Failed to map dataset views:", e);
    return;
  }

  // Build additional chips per item
  const addChip = (
    id: string,
    chipText: string,
    type: "dataset" | "configuration",
    relatedId: string,
  ) => {
    const current = chipsPerItemId[id];
    if (!current) return;

    const extra: IChipAttrs = {
      color: type === "dataset" ? "#4baeff" : "#e57373",
      text: chipText,
      to: props.clickableChips
        ? {
            name: type === "dataset" ? "configuration" : "dataset",
            params:
              type === "dataset"
                ? { configurationId: relatedId }
                : { datasetId: relatedId },
          }
        : undefined,
    };
    const chips = [...current.chips, extra];
    chipsPerItemId[id] = { chips, type };
  };

  // Track missing names to optionally resolve via batchResources
  const missingDatasetIds = new Set<string>();
  const missingConfigIds = new Set<string>();

  for (const p of pairs) {
    if (datasetIds.includes(p.datasetId)) {
      if (!p.configurationName) missingConfigIds.add(p.configurationId);
      addChip(
        p.datasetId,
        p.configurationName || p.configurationId,
        "dataset",
        p.configurationId,
      );
    }
    if (configurationIds.includes(p.configurationId)) {
      if (!p.datasetName) missingDatasetIds.add(p.datasetId);
      addChip(
        p.configurationId,
        p.datasetName || p.datasetId,
        "configuration",
        p.datasetId,
      );
    }
  }

  if (missingDatasetIds.size || missingConfigIds.size) {
    try {
      const batch = await store.api.batchResources({
        folder: missingDatasetIds.size
          ? Array.from(missingDatasetIds)
          : undefined,
        upenn_collection: missingConfigIds.size
          ? Array.from(missingConfigIds)
          : undefined,
      });
      for (const p of pairs) {
        if (datasetIds.includes(p.datasetId) && !p.configurationName) {
          const name = batch.upenn_collection?.[p.configurationId]?.name;
          if (name) addChip(p.datasetId, name, "dataset", p.configurationId);
        }
        if (configurationIds.includes(p.configurationId) && !p.datasetName) {
          const name = batch.folder?.[p.datasetId]?.name;
          if (name)
            addChip(p.configurationId, name, "configuration", p.datasetId);
        }
      }
    } catch (e) {
      // Ignore if batch endpoint unavailable
      logError("Failed to batch resolve resources:", e);
    }
  }

  // Refresh debounced copy after batch update
  debouncedChipsPerItemId.value = { ...chipsPerItemId };
}

async function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) {
    return;
  }

  const file = input.files[0];
  // Check file size (500MB = 500 * 1024 * 1024 bytes)
  if (file.size > 500 * 1024 * 1024) {
    alertDialog.value?.openAlert({
      type: "error",
      message: "File size exceeds 500MB limit",
    });
    // Reset the input so the same file can be selected again
    input.value = "";
    return;
  }

  const location = currentLocation.value;
  if (!location) return;
  // Check if location is a folder or user (has _id and _modelType)
  if ("_id" in location && "_modelType" in location) {
    try {
      await store.api.uploadFile(file, location._id, location._modelType);
      // Reload the current folder to show new file
      await reloadItems();
    } catch (error) {
      logError("Upload failed:", error);
    }
  }
}

defineExpose({
  currentLocation,
  shouldDisableSingleFileUpload,
  isLoggedIn,
  defaultLocation,
  overridingLocation,
  selected,
  computedChipsIds,
  searchInput,
  iconFromItem,
  iconToMdi,
  renderItem,
  reloadItems,
  handleFileUpload,
  itemToChips,
});

// Watchers
watch(isLoggedIn, fetchLocation);
watch([selected, () => props.selectable], emitSelected);

// Lifecycle
onMounted(fetchLocation);
onBeforeUnmount(() => {
  if (batchTimer !== null) {
    window.clearTimeout(batchTimer);
  }
});
</script>

<style lang="scss" scoped>
.custom-file-manager-wrapper,
.custom-file-manager-wrapper > .girder-data-browser-snippet,
.custom-file-manager-wrapper
  > .girder-data-browser-snippet
  > .girder-file-browser,
.custom-file-manager-wrapper
  > .girder-data-browser-snippet
  > .girder-file-browser
  > .v-data-table__wrapper {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.custom-file-manager-wrapper
  > .girder-data-browser-snippet
  > .girder-file-browser
  > .v-data-table__wrapper {
  overflow-y: auto;
}

// Search bar styling for dark mode - using unscoped styles to penetrate component boundaries
</style>

<style lang="scss">
// Unscoped styles for search bar in dark mode
.theme--dark {
  .custom-file-manager-wrapper {
    .search-container {
      // Target v-autocomplete (girder-search likely uses this)
      .v-autocomplete,
      .v-text-field {
        .v-input__control {
          .v-input__slot {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 4px !important;

            &::before,
            &::after {
              display: none !important;
            }

            .v-text-field__slot,
            .v-autocomplete__slot {
              input {
                background-color: transparent !important;
                color: rgba(255, 255, 255, 0.87) !important;
                border: none !important;
                box-shadow: none !important;

                &::placeholder {
                  color: rgba(255, 255, 255, 0.38) !important;
                }
              }
            }

            .v-input__append-inner,
            .v-input__prepend-inner {
              .v-icon {
                color: rgba(255, 255, 255, 0.6) !important;
              }
            }
          }

          .v-text-field__details,
          .v-autocomplete__details {
            .v-messages {
              color: rgba(255, 255, 255, 0.6) !important;
            }
          }
        }

        &.v-input--is-focused {
          .v-input__control {
            .v-input__slot {
              background-color: rgba(255, 255, 255, 0.08) !important;
              border-color: rgba(255, 255, 255, 0.24) !important;
            }
          }
        }
      }

      // Fallback for direct input elements
      input[type="text"],
      input[type="search"] {
        background-color: rgba(255, 255, 255, 0.05) !important;
        border: 1px solid rgba(255, 255, 255, 0.12) !important;
        border-radius: 4px !important;
        color: rgba(255, 255, 255, 0.87) !important;

        &::placeholder {
          color: rgba(255, 255, 255, 0.38) !important;
        }

        &:focus {
          background-color: rgba(255, 255, 255, 0.08) !important;
          border-color: rgba(255, 255, 255, 0.24) !important;
          outline: none !important;
        }
      }
    }
  }

  // More aggressive selector to catch any input in the search container
  .custom-file-manager-wrapper .search-container * {
    .v-input__slot {
      background-color: rgba(255, 255, 255, 0.05) !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;

      input {
        background-color: transparent !important;
        color: rgba(255, 255, 255, 0.87) !important;
        border: none !important;
        box-shadow: none !important;

        &::placeholder {
          color: rgba(255, 255, 255, 0.38) !important;
        }
      }
    }
  }
}

// Icon color styles (unscoped to penetrate child components)
.itemRow .v-icon.mdi-package {
  // targets box_com icon (datasets)
  color: #e57373;
}
.itemRow .v-icon.mdi-file-tree {
  // targets collection icon (configurations)
  color: #4baeff;
}
.itemRow .v-icon.mdi-file {
  // targets regular files
  color: #ee8bff;
}
.itemRow .v-icon.mdi-folder {
  // targets folders
  color: #b0a69a;
}
</style>

<style lang="scss" scoped>
.type-indicator {
  border-radius: 4px !important; // More rectangular
  font-family: "Roboto Mono", monospace !important; // Monospace font
  font-size: 9px !important;
  letter-spacing: 0.5px !important;
  height: 16px !important;
  padding: 0 4px !important;
  font-weight: 500 !important;
}

.chip-label {
  font-size: 0.9em;
}

.ghost-button {
  background-color: transparent !important;

  .v-icon {
    color: inherit !important;
  }

  &.v-btn--disabled {
    opacity: 0.38;
  }
}

// Dark mode styles
.theme--dark {
  .ghost-button {
    border-color: rgba(255, 255, 255, 0.12) !important;
    color: rgba(255, 255, 255, 0.7) !important;

    &:hover:not(.v-btn--disabled) {
      background-color: rgba(255, 255, 255, 0.08) !important;
      border-color: rgba(255, 255, 255, 0.24) !important;
      color: rgba(255, 255, 255, 0.87) !important;
    }
  }
}

// Light mode styles
.theme--light {
  .ghost-button {
    border-color: rgba(0, 0, 0, 0.12) !important;
    color: rgba(0, 0, 0, 0.7) !important;

    &:hover:not(.v-btn--disabled) {
      background-color: rgba(0, 0, 0, 0.04) !important;
      border-color: rgba(0, 0, 0, 0.24) !important;
      color: rgba(0, 0, 0, 0.87) !important;
    }
  }
}
</style>
