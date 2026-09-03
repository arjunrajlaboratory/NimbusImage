<template>
  <v-dialog v-model="dialog" max-width="820px" scrollable>
    <template v-slot:activator="activatorBinding">
      <slot name="activator" v-bind="activatorBinding">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          v-bind="{ ...activatorBinding.props, ...$attrs }"
          prepend-icon="mdi-scale-balance"
        >
          Compare expression
        </v-btn>
      </slot>
    </template>
    <v-card>
      <v-card-title>Compare expression</v-card-title>
      <v-card-subtitle>
        Genes ranked by how differently they are expressed in group A versus
        group B (Welch t-test over every gene in the spatial table)
      </v-card-subtitle>
      <v-card-text>
        <div class="group-line mb-2">
          <strong>Group A:</strong> {{ groupALabel }}
        </div>
        <v-radio-group v-model="groupB" class="mt-0 mb-1" hide-details inline>
          <v-radio value="rest" label="B: everything else" />
          <v-radio value="tag" label="B: objects with any of these tags" />
        </v-radio-group>
        <tag-picker v-if="groupB === 'tag'" v-model="groupBTags" class="mb-3" />
        <div class="d-flex align-center mb-3">
          <v-text-field
            v-model.number="maxFeatures"
            type="number"
            label="Genes to list"
            density="compact"
            variant="outlined"
            hide-details
            min="1"
            :max="MAX_FEATURES"
            style="max-width: 160px"
          />
          <v-spacer />
          <v-btn
            variant="flat"
            color="primary"
            size="small"
            :disabled="!canRun"
            :loading="running"
            @click="run"
          >
            <v-icon start>mdi-play</v-icon>
            Compare
          </v-btn>
        </div>

        <v-alert v-if="error" type="error" variant="tonal" class="mb-2">
          {{ error }}
        </v-alert>
        <div v-if="running" class="d-flex align-center running mb-2">
          <v-progress-circular indeterminate size="18" width="2" class="mr-2" />
          {{ runningMessage }}
        </div>

        <template v-if="result">
          <div class="result-facts mb-2">
            {{ result.nA.toLocaleString() }} cells in A,
            {{ result.nB.toLocaleString() }} in B,
            {{ result.featuresTested.toLocaleString() }} genes tested. Positive
            log₂ fold change means higher in A.
          </div>
          <v-data-table
            :headers="headers"
            :items="result.features"
            :items-per-page="-1"
            density="compact"
            class="de-table"
            hide-default-footer
          >
            <template #[`item.log2FoldChange`]="{ value }">
              {{ format(value) }}
            </template>
            <template #[`item.meanA`]="{ value }">{{ format(value) }}</template>
            <template #[`item.meanB`]="{ value }">{{ format(value) }}</template>
            <template #[`item.fractionA`]="{ value }">
              {{ percent(value) }}
            </template>
            <template #[`item.fractionB`]="{ value }">
              {{ percent(value) }}
            </template>
            <template #[`item.t`]="{ value }">{{ format(value) }}</template>
            <template #[`item.pValue`]="{ value }">
              {{ value.toExponential(2) }}
            </template>
          </v-data-table>
        </template>
      </v-card-text>
      <v-card-actions class="button-bar">
        <v-spacer />
        <v-btn variant="text" size="small" @click="dialog = false">
          Close
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :disabled="!result || running"
          @click="download"
        >
          <v-icon start>mdi-content-save</v-icon>
          Download CSV
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Papa from "papaparse";
import store from "@/store";
import TagPicker from "@/components/TagPicker.vue";
import {
  IAnnotationListFilters,
  ISpatialDifferentialResult,
} from "@/store/model";
import { jobStates } from "@/store/jobConstants";
import { downloadToClient } from "@/utils/download";
import { extractErrorMessage } from "@/utils/errors";
import { logError } from "@/utils/log";

const MAX_FEATURES = 500;
const JOB_POLL_MS = 2000;

const props = defineProps<{
  // Group A: the list-filter object of the scope being compared.
  filtersA: IAnnotationListFilters;
  groupALabel: string;
}>();

const dialog = ref(false);
const groupB = ref<"rest" | "tag">("rest");
const groupBTags = ref<string[]>([]);
const maxFeatures = ref(50);
const running = ref(false);
const runningMessage = ref("");
const error = ref("");
const result = ref<ISpatialDifferentialResult | null>(null);

const canRun = computed(
  () =>
    !running.value &&
    maxFeatures.value >= 1 &&
    (groupB.value === "rest" || groupBTags.value.length > 0),
);

const headers = [
  { title: "Gene", key: "symbol" },
  { title: "log₂ FC", key: "log2FoldChange", align: "end" as const },
  { title: "Mean A", key: "meanA", align: "end" as const },
  { title: "Mean B", key: "meanB", align: "end" as const },
  { title: "% A", key: "fractionA", align: "end" as const },
  { title: "% B", key: "fractionB", align: "end" as const },
  { title: "t", key: "t", align: "end" as const },
  { title: "p", key: "pValue", align: "end" as const },
];

function filtersB(): IAnnotationListFilters | null {
  if (groupB.value === "rest") {
    return null;
  }
  return { tags: { values: [...groupBTags.value], exclusive: false } };
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let requestSequence = 0;

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function pollJob(jobId: string, sequence: number) {
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (sequence !== requestSequence || !dialog.value) {
      return;
    }
    try {
      const job = await store.spatialAPI.fetchJob(jobId);
      if (sequence !== requestSequence) {
        return;
      }
      if (job.status === jobStates.success && job.spatialResult) {
        // The job document is shared with the recompute job; this dialog
        // only ever polls jobs it scheduled, so the table is the DE one.
        result.value = job.spatialResult as ISpatialDifferentialResult;
        running.value = false;
        return;
      }
      if (
        job.status === jobStates.error ||
        job.status === jobStates.cancelled
      ) {
        error.value = "The comparison job failed; see the job log.";
        running.value = false;
        return;
      }
    } catch (err) {
      logError("Failed to poll the differential expression job:", err);
    }
    pollJob(jobId, sequence);
  }, JOB_POLL_MS);
}

async function run() {
  const datasetId = store.dataset?.id;
  if (!datasetId || !canRun.value) {
    return;
  }
  const sequence = ++requestSequence;
  stopPolling();
  running.value = true;
  error.value = "";
  result.value = null;
  runningMessage.value = "Comparing every gene in a server job…";
  try {
    const { jobId } = await store.spatialAPI.differential(
      datasetId,
      props.filtersA,
      filtersB(),
      Math.min(MAX_FEATURES, Math.max(1, Math.round(maxFeatures.value))),
    );
    if (sequence === requestSequence) {
      pollJob(jobId, sequence);
    }
  } catch (err) {
    if (sequence === requestSequence) {
      error.value = extractErrorMessage(err);
      running.value = false;
    }
  }
}

function format(value: number): string {
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumSignificantDigits: 3 })
    : "–";
}

function percent(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function buildCsv(table: ISpatialDifferentialResult): string {
  return Papa.unparse({
    fields: [
      "Gene",
      "log2FoldChange",
      "MeanA",
      "MeanB",
      "FractionA",
      "FractionB",
      "t",
      "pValue",
    ],
    data: table.features.map((row) => [
      row.symbol,
      row.log2FoldChange,
      row.meanA,
      row.meanB,
      row.fractionA,
      row.fractionB,
      row.t,
      row.pValue,
    ]),
  });
}

function download() {
  if (!result.value) {
    return;
  }
  downloadToClient({
    href:
      "data:text/csv;charset=utf-8," +
      encodeURIComponent(buildCsv(result.value)),
    download: `${store.dataset?.name ?? "dataset"}-differential-expression.csv`,
  });
}

watch(dialog, (open) => {
  if (!open) {
    stopPolling();
    requestSequence++;
    running.value = false;
  }
});

onBeforeUnmount(stopPolling);

defineExpose({
  dialog,
  groupB,
  groupBTags,
  maxFeatures,
  running,
  error,
  result,
  run,
  buildCsv,
  download,
  filtersB,
});
</script>

<style lang="scss" scoped>
.group-line,
.result-facts,
.running {
  font-size: 13px;
  opacity: 0.85;
}

.de-table :deep(td),
.de-table :deep(th) {
  font-size: 12px;
}
</style>
