<template>
  <v-expansion-panel>
    <v-expansion-panel-header
      id="properties-header-tourstep"
      v-tour-trigger="'properties-header-tourtrigger'"
    >
      Properties
      <v-spacer />
      <v-btn
        color="primary"
        dark
        small
        dense
        @click.stop="showAnalyzeDialog = true"
        id="measure-objects-button-tourstep"
        v-tour-trigger="'measure-objects-button-tourtrigger'"
        :disabled="!isLoggedIn"
      >
        Measure objects
      </v-btn>
    </v-expansion-panel-header>

    <v-dialog
      v-model="showAnalyzeDialog"
      min-width="900px"
      max-width="1000px"
      width="80%"
      @input="onDialogClose"
    >
      <v-card>
        <v-card-title>Measure objects</v-card-title>
        <v-card-text>
          <analyze-panel
            :applyToAllDatasets="applyToAllDatasets"
            @compute-property-batch="onComputePropertyBatch"
            @compute-properties-batch="onComputePropertiesBatch"
          />
        </v-card-text>
        <!-- Batch progress display -->
        <div v-if="batchProgress" class="px-6 pb-2">
          <div class="batch-progress-header mb-2">
            <strong>Batch Progress:</strong>
            {{
              batchProgress.completed +
              batchProgress.failed +
              batchProgress.cancelled
            }}
            / {{ batchProgress.total }} datasets
            <span v-if="batchProgress.failed > 0" class="error--text">
              ({{ batchProgress.failed }} failed)
            </span>
            <span v-if="batchProgress.cancelled > 0" class="warning--text">
              ({{ batchProgress.cancelled }} cancelled)
            </span>
          </div>
          <v-progress-linear
            :value="batchProgressPercent"
            color="primary"
            height="20"
            striped
          >
            <template v-slot:default>
              <strong>{{ Math.round(batchProgressPercent) }}%</strong>
            </template>
          </v-progress-linear>
          <div class="batch-current-dataset mt-1">
            <small>Current: {{ batchProgress.currentDatasetName }}</small>
          </div>
        </div>
        <v-card-actions>
          <v-tooltip
            bottom
            :disabled="!batchDisabledReason"
            v-if="canApplyToAllDatasets || batchDisabledReason"
          >
            <template v-slot:activator="{ on, attrs }">
              <div v-bind="attrs" v-on="on">
                <v-checkbox
                  v-model="applyToAllDatasets"
                  :disabled="!canApplyToAllDatasets || !!batchProgress"
                  :label="`Apply to all datasets (${collectionDatasetCount})`"
                  class="mt-0"
                  hide-details
                ></v-checkbox>
              </div>
            </template>
            <span>{{ batchDisabledReason }}</span>
          </v-tooltip>
          <v-btn
            v-if="batchProgress"
            color="orange"
            small
            class="ml-4"
            @click="cancelBatch"
          >
            Cancel All
          </v-btn>
          <v-spacer />
          <v-btn
            @click="onDialogClose(false)"
            id="measure-objects-close-button-tourstep"
            v-tour-trigger="'measure-objects-close-button-tourtrigger'"
          >
            Close
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-expansion-panel-content id="properties-content-tourstep">
      <v-text-field
        v-model="propFilter"
        label="Search properties"
        single-line
        clearable
      />
      <v-tabs v-model="activeTabIndex" grow>
        <v-tab v-for="{ key, text } in tabs" :key="key">{{ text }}</v-tab>
      </v-tabs>
      <div class="miller-columns-container">
        <div
          :class="{
            'miller-column': true,
            dark: $vuetify.theme.dark,
          }"
          v-for="(column, colIndex) in columns"
          :key="colIndex"
        >
          <v-list dense>
            <v-list-item
              v-for="item in column"
              :key="item.path.join('.')"
              @click="selectedPath = item.path"
              :class="{ 'v-list-item--active': item.isSelected }"
            >
              <v-list-item-content>
                <v-list-item-title>
                  {{ item.name }}
                </v-list-item-title>
              </v-list-item-content>
              <v-list-item-action class="my-2">
                <v-simple-checkbox
                  v-if="item.isLeaf"
                  :value="getPropertySettings(item.path)"
                  @input="togglePropertySettings(item.path)"
                />
                <v-icon v-else>mdi-chevron-right</v-icon>
              </v-list-item-action>
            </v-list-item>
          </v-list>
        </div>
      </div>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { findIndexOfPath } from "@/utils/paths";
import { logError } from "@/utils/log";
import AnalyzePanel from "@/components/AnalyzePanel.vue";
import { IAnnotationProperty } from "@/store/model";

interface PropertyItem {
  name: string;
  path: string[];
  isLeaf: boolean;
  isSelected: boolean;
}

const tabs = [
  {
    key: "display",
    text: "Show in list",
  },
  {
    key: "filter",
    text: "Use as filter",
  },
] as const satisfies { key: string; text: string }[];

type TTabKey = (typeof tabs)[number]["key"];

const emit = defineEmits<{ (e: "expand"): void }>();

const propFilter = ref<string | null>(null);
const selectedPath = ref<string[]>([]);
const activeTabKey = ref<TTabKey>("display");
const showAnalyzeDialog = ref(false);

// Batch processing state
const applyToAllDatasets = ref(false);
const batchProgress = ref<{
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  currentDatasetName: string;
} | null>(null);
const batchCancelFunction = ref<(() => void) | null>(null);
const collectionDatasetCount = ref(0);
const loadingDatasetCount = ref(false);
const BATCH_DATASET_LIMIT = 10;

const activeTabIndex = computed({
  get: () => tabs.findIndex(({ key }) => activeTabKey.value === key),
  set: (index: number) => {
    activeTabKey.value = tabs[index].key;
  },
});

const isLoggedIn = computed(() => store.isLoggedIn);

function togglePropertySettings(path: string[]): void {
  switch (activeTabKey.value) {
    case "display":
      toggleList(path);
      break;
    case "filter":
      toggleFilter(path);
      break;
  }
}

function getPropertySettings(path: string[]): boolean {
  switch (activeTabKey.value) {
    case "display":
      return isPropertyDisplayed(path);
    case "filter":
      return isPropertyFiltered(path);
  }
}

const filteredPaths = computed(() => {
  const lowerCaseFilter = propFilter.value?.toLowerCase();
  const allPaths = propertyStore.computedPropertyPaths;
  return lowerCaseFilter
    ? allPaths.filter(
        (path) =>
          propertyStore
            .getFullNameFromPath(path)
            ?.toLowerCase()
            .includes(lowerCaseFilter) ?? true,
      )
    : allPaths;
});

const columns = computed((): PropertyItem[][] => {
  let remainingPaths = filteredPaths.value;
  const cols: PropertyItem[][] = [];
  for (
    let columnIdx = 0;
    columnIdx < selectedPath.value.length + 1;
    ++columnIdx
  ) {
    const currentSelectedPath = selectedPath.value.slice(0, columnIdx);
    remainingPaths = remainingPaths.filter((path) =>
      currentSelectedPath.every(
        (pathSegment, pathSegmentIdx) => pathSegment === path[pathSegmentIdx],
      ),
    );
    const segmentItems: Map<string, PropertyItem> = new Map();
    remainingPaths.forEach((path) => {
      const segment = path[columnIdx];
      if (!segment || segmentItems.has(segment)) {
        return;
      }
      const itemName =
        columnIdx === 0
          ? propertyStore.getPropertyById(segment)?.name ?? segment
          : segment;

      segmentItems.set(segment, {
        name: itemName,
        path: path.slice(0, columnIdx + 1),
        isLeaf: path.length === columnIdx + 1,
        isSelected: segment === selectedPath.value[columnIdx],
      });
    });
    if (segmentItems.size <= 0) {
      break;
    }
    cols.push([...segmentItems.values()]);
  }
  return cols;
});

function isPropertyDisplayed(path: string[]): boolean {
  return findIndexOfPath(path, propertyStore.displayedPropertyPaths) >= 0;
}

function isPropertyFiltered(path: string[]): boolean {
  return findIndexOfPath(path, filterStore.filterPaths) >= 0;
}

function toggleList(propertyPath: string[]) {
  propertyStore.togglePropertyPathVisibility(propertyPath);
}

function toggleFilter(propertyPath: string[]) {
  filterStore.togglePropertyPathFiltering(propertyPath);
}

const canApplyToAllDatasets = computed(
  () =>
    store.selectedConfigurationId !== null &&
    collectionDatasetCount.value > 1 &&
    collectionDatasetCount.value <= BATCH_DATASET_LIMIT,
);

const batchDisabledReason = computed((): string | null => {
  if (!store.selectedConfigurationId) return null;
  if (loadingDatasetCount.value) return null;
  if (collectionDatasetCount.value <= 1) return null;
  if (collectionDatasetCount.value > BATCH_DATASET_LIMIT) {
    return `Collection has more than ${BATCH_DATASET_LIMIT} datasets`;
  }
  return null;
});

const batchProgressPercent = computed(() => {
  if (!batchProgress.value || batchProgress.value.total === 0) return 0;
  const { completed, failed, cancelled, total } = batchProgress.value;
  return ((completed + failed + cancelled) / total) * 100;
});

async function fetchCollectionDatasetCount() {
  loadingDatasetCount.value = true;
  try {
    collectionDatasetCount.value = await store.getCollectionDatasetCount();
  } catch (error) {
    logError("Failed to fetch collection dataset count:", error);
    collectionDatasetCount.value = 0;
  } finally {
    loadingDatasetCount.value = false;
  }
}

async function onComputePropertyBatch(property: IAnnotationProperty) {
  const configurationId = store.selectedConfigurationId;
  if (!configurationId) return;

  batchProgress.value = {
    total: collectionDatasetCount.value,
    completed: 0,
    failed: 0,
    cancelled: 0,
    currentDatasetName: "Starting...",
  };

  await propertyStore.computePropertyBatch({
    property,
    configurationId,
    onBatchProgress: (status) => {
      batchProgress.value = status;
    },
    onCancel: (cancel) => {
      batchCancelFunction.value = cancel;
    },
    onComplete: () => {
      batchCancelFunction.value = null;
      setTimeout(() => {
        batchProgress.value = null;
      }, 3000);
    },
  });
}

async function onComputePropertiesBatch(properties: IAnnotationProperty[]) {
  for (const property of properties) {
    await onComputePropertyBatch(property);
  }
}

function cancelBatch() {
  if (batchCancelFunction.value) {
    batchCancelFunction.value();
  }
}

function onDialogClose(value: boolean) {
  if (!value) {
    showAnalyzeDialog.value = false;
    emit("expand");
  }
}

watch(
  () => store.selectedConfigurationId,
  () => fetchCollectionDatasetCount(),
);

onMounted(() => {
  fetchCollectionDatasetCount();
});

defineExpose({
  propFilter,
  selectedPath,
  activeTabKey,
  activeTabIndex,
  showAnalyzeDialog,
  applyToAllDatasets,
  batchProgress,
  batchCancelFunction,
  collectionDatasetCount,
  loadingDatasetCount,
  isLoggedIn,
  filteredPaths,
  columns,
  canApplyToAllDatasets,
  batchDisabledReason,
  batchProgressPercent,
  togglePropertySettings,
  getPropertySettings,
  fetchCollectionDatasetCount,
  onComputePropertyBatch,
  onComputePropertiesBatch,
  cancelBatch,
  onDialogClose,
});
</script>

<style lang="scss" scoped>
.miller-columns-container {
  display: flex;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
}

.miller-column {
  flex: 0 1 auto;
  min-width: 150px;
  max-width: 300px;
  padding: 0px 2px;
  border-right: 1px solid;

  border-color: rgba(0, 0, 0, 0.12);
  &.dark {
    border-color: rgba(255, 255, 255, 0.12);
  }
}
</style>
