<template>
  <v-dialog
    v-model="dialogOpen"
    min-width="1150px"
    max-width="1300px"
    width="85%"
    class="wide-dialog"
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
      <div v-if="batchProgress" class="px-6 pb-2">
        <div class="batch-progress-header mb-2">
          <strong>Batch Progress:</strong>
          {{
            batchProgress.completed +
            batchProgress.failed +
            batchProgress.cancelled
          }}
          / {{ batchProgress.total }} datasets
          <span v-if="batchProgress.failed > 0" class="text-error">
            ({{ batchProgress.failed }} failed)
          </span>
          <span v-if="batchProgress.cancelled > 0" class="text-warning">
            ({{ batchProgress.cancelled }} cancelled)
          </span>
        </div>
        <v-progress-linear
          :model-value="batchProgressPercent"
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
          location="bottom"
          :disabled="!batchDisabledReason"
          v-if="canApplyToAllDatasets || batchDisabledReason"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <div v-bind="activatorProps">
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
          variant="outlined"
          color="warning"
          size="small"
          class="ml-4"
          @click="cancelBatch"
        >
          Cancel All
        </v-btn>
        <v-spacer />
        <property-picker ref="pickerRef" @done="onPickerDone">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              variant="flat"
              color="primary"
              size="small"
              prepend-icon="mdi-table-column-plus-after"
              :disabled="!hasComputedProperties"
              class="mr-2"
            >
              Show in annotation list…
            </v-btn>
          </template>
        </property-picker>
        <v-btn variant="text" size="small" @click="dialogOpen = false">
          Close
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import { logError } from "@/utils/log";
import AnalyzePanel from "@/components/AnalyzePanel.vue";
import PropertyPicker from "@/components/PropertyPicker.vue";
import { IAnnotationProperty } from "@/store/model";

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "show-in-list"): void;
}>();

const dialogOpen = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

const pickerRef = ref<InstanceType<typeof PropertyPicker> | null>(null);

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
const BATCH_DATASET_LIMIT = 50;

const hasComputedProperties = computed(
  () => propertyStore.computedPropertyPaths.length > 0,
);

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

function onPickerDone() {
  dialogOpen.value = false;
  emit("show-in-list");
}

watch(
  () => store.selectedConfigurationId,
  () => fetchCollectionDatasetCount(),
);

watch(
  dialogOpen,
  (open) => {
    if (open) {
      fetchCollectionDatasetCount();
    }
  },
  { immediate: true },
);

defineExpose({
  applyToAllDatasets,
  batchProgress,
  collectionDatasetCount,
  canApplyToAllDatasets,
  batchDisabledReason,
  batchProgressPercent,
  hasComputedProperties,
  onComputePropertyBatch,
  onComputePropertiesBatch,
  cancelBatch,
  onPickerDone,
});
</script>
