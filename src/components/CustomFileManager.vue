<template>
  <div class="custom-file-manager-wrapper">
    <div class="d-flex align-center ma-2">
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
              Selected Items Actions
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
          @click="$refs.fileInput.click()"
          :disabled="shouldDisableSingleFileUpload"
          outlined
        >
          <v-icon left>mdi-upload</v-icon>
          Upload Individual File
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
    <alert-dialog ref="alert"></alert-dialog>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderLocation, IGirderSelectAble } from "@/girder";
import {
  isConfigurationItem,
  isDatasetFolder,
  toConfigurationItem,
  toDatasetFolder,
} from "@/utils/girderSelectable";
import { RawLocation } from "vue-router";
import FileManagerOptions from "./FileManagerOptions.vue";
import FileItemRow from "./FileItemRow.vue";
import { Search as GirderSearch } from "@/girder/components";
import { formatDateString } from "@/utils/date";
import { vuetifyConfig } from "@/girder";
import { logError } from "@/utils/log";
import AlertDialog from "@/components/AlertDialog.vue";
import { unselectableLocations } from "@/utils/girderSelectable";

interface IChipAttrs {
  text: string;
  color: string;
  to?: RawLocation;
}

interface IChipsPerItemId {
  chips: IChipAttrs[];
  type: string;
}

@Component({
  components: {
    FileManagerOptions,
    GirderSearch,
    AlertDialog,
    FileItemRow,
    GirderFileManager: () =>
      import("@/girder/components").then((mod) => mod.FileManager),
  },
})
export default class CustomFileManager extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  @Prop({
    default: true,
  })
  menuEnabled!: boolean;

  @Prop({
    default: false,
  })
  selectable!: boolean;

  @Prop({
    default: true,
  })
  moreChips!: boolean;

  @Prop({
    default: true,
  })
  clickableChips!: boolean;

  @Prop({
    default: null,
  })
  location!: IGirderLocation | null;

  @Prop({
    default: true,
  })
  useDefaultLocation!: boolean;

  overridingLocation: IGirderLocation | null = null;
  defaultLocation: IGirderLocation | null = null;
  chipsPerItemId: { [itemId: string]: IChipsPerItemId } = {};
  debouncedChipsPerItemId: { [itemId: string]: IChipsPerItemId } = {};
  pendingChips: number = 0;
  lastPendingChip: Promise<any> = Promise.resolve();
  computedChipsIds: Set<string> = new Set();
  selected: IGirderSelectAble[] = [];

  // Batch mapping queues
  batchQueueDatasetIds: Set<string> = new Set();
  batchQueueConfigurationIds: Set<string> = new Set();
  batchTimer: number | null = null;

  selectedItemsOptionsMenu: boolean = false;
  rowOptionsMenu: { [itemId: string]: boolean } = {};

  formatDateString = formatDateString; // Import function from utils/date.ts for use in template

  $refs!: {
    fileInput: HTMLInputElement;
    alert: AlertDialog;
  };

  async reloadItems() {
    try {
      this.overridingLocation = { type: "root" };
      await Vue.nextTick();
    } finally {
      this.overridingLocation = null;
    }
  }

  get shouldDisableSingleFileUpload() {
    return (
      !this.currentLocation ||
      ("_modelType" in this.currentLocation &&
        unselectableLocations.includes(this.currentLocation._modelType)) ||
      ("type" in this.currentLocation &&
        unselectableLocations.includes(this.currentLocation.type))
    );
  }

  get currentLocation() {
    if (this.overridingLocation) {
      return this.overridingLocation;
    }
    if (this.useDefaultLocation && this.location === null) {
      this.$emit("update:location", this.defaultLocation);
      return this.defaultLocation;
    }
    return this.location;
  }

  set currentLocation(value: IGirderLocation | null) {
    this.$emit("update:location", value);
  }

  mounted() {
    this.fetchLocation();
  }

  get isLoggedIn() {
    return this.store.isLoggedIn;
  }

  @Watch("isLoggedIn")
  async fetchLocation() {
    const privateFolder = await this.store.api.getUserPrivateFolder();
    this.defaultLocation = privateFolder || this.store.girderUser;
  }

  @Watch("selected")
  @Watch("selectable")
  emitSelected() {
    if (this.selectable) {
      this.$emit("selected", this.selected);
    }
  }

  searchInput(value: IGirderSelectAble) {
    if (
      value._modelType === "upenn_collection" ||
      value._modelType === "file" ||
      value._modelType === "item"
    ) {
      return;
    }
    this.currentLocation = value;
    this.$emit("rowclick", value);
  }

  iconToMdi(icon: string) {
    return vuetifyConfig.icons.values[icon] || `mdi-${icon}`;
  }

  iconFromItem(selectable: IGirderSelectAble) {
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

  renderItem(selectable: IGirderSelectAble) {
    const datasetFolder = toDatasetFolder(selectable);
    const configurationItem = toConfigurationItem(selectable);
    selectable.icon = this.iconFromItem(selectable);
    const folderOrItem = datasetFolder || configurationItem;
    if (folderOrItem && !this.computedChipsIds.has(selectable._id)) {
      this.computedChipsIds.add(selectable._id);
      this.addChipPromise(selectable);
    }
  }

  addChipPromise(item: IGirderSelectAble) {
    // Chain a new chip promise with last pending promise
    this.lastPendingChip = this.lastPendingChip
      .finally()
      .then(() => this.itemToChips(item))
      .then((chipAttrs) => Vue.set(this.chipsPerItemId, item._id, chipAttrs));
    // When done with the last promise, update debouncedChipsPerItemId
    ++this.pendingChips;
    this.lastPendingChip.finally(() => {
      if (--this.pendingChips === 0) {
        this.debouncedChipsPerItemId = { ...this.chipsPerItemId };
      }
    });
  }

  async itemToChips(selectable: IGirderSelectAble) {
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
    if (this.clickableChips) {
      headerChip.to = {
        name: chipOption.to_name,
        params: chipOption.to_params,
      };
    }
    ret.push(headerChip);

    // If we don't show more chips, return early
    if (!this.moreChips) {
      return { chips: ret, type };
    }

    // Enqueue for batch resolution and return header-only chips for now
    if (isDataset) {
      this.batchQueueDatasetIds.add(selectable._id);
    } else {
      this.batchQueueConfigurationIds.add(selectable._id);
    }
    this.scheduleBatchResolve();

    return { chips: ret, type };
  }

  scheduleBatchResolve() {
    // Clear any existing timer to restart the debounce period
    if (this.batchTimer !== null) {
      window.clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Debounce mechanism: Wait 50ms to collect IDs from multiple itemToChips calls
    // This allows Vue's rendering cycle to call itemToChips() many times
    // (once per item being rendered), accumulating dataset/configuration IDs
    // in batchQueueDatasetIds and batchQueueConfigurationIds sets.
    // After 50ms of no new calls, flushBatchResolve() fires a single
    // bulk API request to resolve all collected IDs at once.
    this.batchTimer = window.setTimeout(() => this.flushBatchResolve(), 50);
  }

  async flushBatchResolve() {
    const datasetIds = Array.from(this.batchQueueDatasetIds);
    const configurationIds = Array.from(this.batchQueueConfigurationIds);
    this.batchQueueDatasetIds.clear();
    this.batchQueueConfigurationIds.clear();
    this.batchTimer = null;

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
      pairs = await this.store.api.mapDatasetViews({
        datasetIds: datasetIds.length ? datasetIds : undefined,
        configurationIds: configurationIds.length
          ? configurationIds
          : undefined,
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
      const current = this.chipsPerItemId[id];
      if (!current) return;

      const extra: IChipAttrs = {
        color: type === "dataset" ? "#4baeff" : "#e57373",
        text: chipText,
        to: this.clickableChips
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
      Vue.set(this.chipsPerItemId, id, { chips, type });
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
        const batch = await this.store.api.batchResources({
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
    this.debouncedChipsPerItemId = { ...this.chipsPerItemId };
  }

  async handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) {
      return;
    }

    const file = input.files[0];
    // Check file size (500MB = 500 * 1024 * 1024 bytes)
    if (file.size > 500 * 1024 * 1024) {
      this.$refs.alert.openAlert({
        type: "error",
        message: "File size exceeds 500MB limit",
      });
      // Reset the input so the same file can be selected again
      input.value = "";
      return;
    }

    const location = this.currentLocation;
    if (!location) return;
    // Check if location is a folder or user (has _id and _modelType)
    if ("_id" in location && "_modelType" in location) {
      try {
        await this.store.api.uploadFile(
          file,
          location._id,
          location._modelType,
        );
        // Reload the current folder to show new file
        await this.reloadItems();
      } catch (error) {
        logError("Upload failed:", error);
      }
    }
  }
}
</script>

<style lang="scss">
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
