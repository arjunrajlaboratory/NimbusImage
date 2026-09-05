<template>
  <v-dialog v-model="dialog" max-width="760px" scrollable>
    <template v-slot:activator="activatorBinding">
      <slot name="activator" v-bind="activatorBinding">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          v-bind="{ ...activatorBinding.props, ...$attrs }"
          v-description="{
            section: 'Object list actions',
            title: 'Selection summary',
            description:
              'Tag composition and property statistics for the current selection, filtered objects, or the whole dataset',
          }"
        >
          <v-icon>mdi-chart-box-outline</v-icon>
          Selection summary
        </v-btn>
      </slot>
    </template>
    <v-card>
      <v-card-title>Selection summary</v-card-title>
      <v-card-subtitle>
        Composition by tag and statistics of property values, computed on the
        server over every matching object
      </v-card-subtitle>

      <v-card-text>
        <v-list-subheader>Objects to summarize</v-list-subheader>
        <v-radio-group v-model="scope" class="mt-0 mb-2" hide-details inline>
          <v-radio
            value="all"
            :label="`All objects (${allCount.toLocaleString()})`"
          />
          <v-radio
            value="filtered"
            label="Filtered objects"
            :disabled="!hasActiveFilter"
          />
          <v-radio
            value="selected"
            :label="`Selected objects (${selectedCount.toLocaleString()})`"
            :disabled="selectedCount === 0"
          />
        </v-radio-group>

        <v-select
          v-model="selectedPathStrings"
          :items="propertyItems"
          label="Properties to summarize"
          multiple
          chips
          closable-chips
          clearable
          density="compact"
          variant="outlined"
          hide-details
          class="mb-4"
        />

        <v-alert v-if="error" type="error" variant="tonal" class="mb-4">
          {{ error }}
        </v-alert>

        <div v-if="loading" class="d-flex align-center summary-loading">
          <v-progress-circular indeterminate size="20" width="2" class="mr-2" />
          Summarizing…
        </div>

        <template v-else-if="summary">
          <div class="summary-total mb-3">
            {{ summary.total.toLocaleString() }} object{{
              summary.total === 1 ? "" : "s"
            }}
          </div>

          <v-list-subheader>Composition by tag</v-list-subheader>
          <div v-if="summary.tags.length === 0" class="summary-empty mb-4">
            No tags on the summarized objects.
          </div>
          <v-table v-else density="compact" class="mb-4 summary-table">
            <thead>
              <tr>
                <th>Tag</th>
                <th class="text-right">Count</th>
                <th class="text-right">% of objects</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in summary.tags" :key="row.tag">
                <td>{{ row.tag }}</td>
                <td class="text-right">{{ row.count.toLocaleString() }}</td>
                <td class="text-right">
                  {{ formatPercent(row.count / summary.total) }}
                </td>
              </tr>
            </tbody>
          </v-table>

          <div class="d-flex align-center">
            <v-list-subheader>Spatial statistics</v-list-subheader>
            <v-spacer />
            <neighborhood-dialog>
              <template v-slot:activator="{ props: activatorProps }">
                <v-btn
                  v-bind="activatorProps"
                  variant="text"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-graph-outline"
                >
                  Neighborhood…
                </v-btn>
              </template>
            </neighborhood-dialog>
            <region-summary-dialog>
              <template v-slot:activator="{ props: activatorProps }">
                <v-btn
                  v-bind="activatorProps"
                  variant="text"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-vector-polygon"
                >
                  Regions…
                </v-btn>
              </template>
            </region-summary-dialog>
          </div>

          <template v-if="spatialStore.hasTable">
            <div class="d-flex align-center">
              <v-list-subheader>Expression</v-list-subheader>
              <v-spacer />
              <differential-expression-dialog
                :filters-a="requestFilters"
                :group-a-label="scopeLabel"
              >
                <template v-slot:activator="{ props: activatorProps }">
                  <v-btn
                    v-bind="activatorProps"
                    variant="text"
                    color="primary"
                    size="small"
                    prepend-icon="mdi-scale-balance"
                    :disabled="scope === 'all'"
                  >
                    Compare expression…
                  </v-btn>
                </template>
              </differential-expression-dialog>
            </div>
            <spatial-feature-picker
              v-model="expressionSymbols"
              label="Genes from the spatial table"
              class="mb-2"
            />
            <div
              v-if="expressionLoading"
              class="d-flex align-center summary-loading"
            >
              <v-progress-circular
                indeterminate
                size="16"
                width="2"
                class="mr-2"
              />
              Aggregating…
            </div>
            <v-alert
              v-else-if="expressionError"
              type="error"
              variant="tonal"
              density="compact"
              class="mb-3"
            >
              {{ expressionError }}
            </v-alert>
            <v-table
              v-else-if="expression && expression.features.length > 0"
              density="compact"
              class="mb-1 summary-table"
            >
              <thead>
                <tr>
                  <th>Gene</th>
                  <th class="text-right">Mean count</th>
                  <th class="text-right">% expressing</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in expression.features" :key="row.symbol">
                  <td>{{ row.symbol }}</td>
                  <td class="text-right">{{ formatNumber(row.mean) }}</td>
                  <td class="text-right">
                    {{
                      row.fractionExpressing === null
                        ? "–"
                        : formatPercent(row.fractionExpressing)
                    }}
                  </td>
                </tr>
              </tbody>
            </v-table>
            <div
              v-if="expression && expression.unmatched > 0"
              class="summary-empty"
            >
              {{ expression.unmatched.toLocaleString() }} of the summarized
              objects have no row in the spatial table.
            </div>
          </template>

          <v-list-subheader>Property statistics</v-list-subheader>
          <div v-if="summary.properties.length === 0" class="summary-empty">
            Pick properties above to see their statistics.
          </div>
          <v-table v-else density="compact" class="summary-table">
            <thead>
              <tr>
                <th>Property</th>
                <th class="text-right">n</th>
                <th class="text-right">Mean</th>
                <th class="text-right">SD</th>
                <th class="text-right">Min</th>
                <th class="text-right">Max</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in summary.properties" :key="row.path.join('.')">
                <td>{{ propertyName(row.path) }}</td>
                <td class="text-right">{{ row.count.toLocaleString() }}</td>
                <td class="text-right">{{ formatNumber(row.mean) }}</td>
                <td class="text-right">{{ formatNumber(row.std) }}</td>
                <td class="text-right">{{ formatNumber(row.min) }}</td>
                <td class="text-right">{{ formatNumber(row.max) }}</td>
              </tr>
            </tbody>
          </v-table>
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
          :disabled="!summary || loading"
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
import { ref, computed, watch } from "vue";
import Papa from "papaparse";
import store from "@/store";
import annotationStore from "@/store/annotation";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import annotationListServer from "@/store/annotationListServer";
import spatialStore from "@/store/spatial";
import SpatialFeaturePicker from "@/components/AnnotationBrowser/SpatialFeaturePicker.vue";
import DifferentialExpressionDialog from "@/components/AnnotationBrowser/DifferentialExpressionDialog.vue";
import NeighborhoodDialog from "@/components/AnnotationBrowser/NeighborhoodDialog.vue";
import RegionSummaryDialog from "@/components/AnnotationBrowser/RegionSummaryDialog.vue";
import {
  IAnnotationListFilters,
  IAnnotationSummary,
  ISpatialAggregate,
} from "@/store/model";
import { downloadToClient } from "@/utils/download";
import { extractErrorMessage } from "@/utils/errors";
import { logError } from "@/utils/log";
import { deserializePropertyPath, serializePropertyPath } from "@/utils/paths";

type TScope = "all" | "filtered" | "selected";

const dialog = ref(false);
const scope = ref<TScope>("all");
const selectedPathStrings = ref<string[]>([]);
const summary = ref<IAnnotationSummary | null>(null);
const loading = ref(false);
const error = ref("");

const allCount = computed(() => annotationStore.annotationCount);
const selectedCount = computed(
  () => annotationStore.resolvedSelectedAnnotationIds.length,
);
// Same reading as the CSV export dialog: the filtered population is smaller
// than the dataset. In stub-only mode filteredAnnotations is built from stubs,
// so the comparison holds at any dataset size.
const hasActiveFilter = computed(
  () => filterStore.filteredAnnotations.length < allCount.value,
);

const propertyItems = computed(() =>
  propertyStore.computedPropertyPaths.map((path) => ({
    title: propertyName(path),
    value: serializePropertyPath(path),
  })),
);

// Human name of the summarized scope, for the comparison dialog.
const scopeLabel = computed(() => {
  if (scope.value === "selected") {
    return `the ${selectedCount.value.toLocaleString()} selected objects`;
  }
  if (scope.value === "filtered") {
    return "the filtered objects";
  }
  return "all objects";
});

const selectedPaths = computed(() =>
  selectedPathStrings.value.map(deserializePropertyPath),
);

// The filters object the server resolves. "selected" uses the store's
// stale-free selection (shared with the CSV export) so a stale id never widens
// the summary; an emptied selection becomes an empty constraint, which the
// API client answers locally with zeros.
const requestFilters = computed((): IAnnotationListFilters => {
  if (scope.value === "selected") {
    return {
      idConstraints: [annotationStore.resolvedSelectedAnnotationIds],
    };
  }
  if (scope.value === "filtered") {
    return annotationListServer.currentFilters;
  }
  return {};
});

let requestSequence = 0;

// Expression over the same scope, from the spatial table (when the dataset
// has one). Its own request and sequence: it depends on the picked genes as
// well as the scope, and a gene change must not refetch the tag summary.
const expressionSymbols = ref<string[]>([]);
const expression = ref<ISpatialAggregate | null>(null);
const expressionLoading = ref(false);
const expressionError = ref("");
let expressionSequence = 0;

async function refreshExpression() {
  const sequence = ++expressionSequence;
  const datasetId = store.dataset?.id;
  if (
    !datasetId ||
    !spatialStore.hasTable ||
    expressionSymbols.value.length === 0
  ) {
    expression.value = null;
    expressionLoading.value = false;
    return;
  }
  expressionLoading.value = true;
  expressionError.value = "";
  try {
    const result = await store.spatialAPI.aggregate(
      datasetId,
      requestFilters.value,
      expressionSymbols.value,
    );
    if (sequence === expressionSequence) {
      expression.value = result;
    }
  } catch (err) {
    if (sequence === expressionSequence) {
      logError("Failed to aggregate expression:", err);
      expressionError.value = extractErrorMessage(err);
      expression.value = null;
    }
  } finally {
    if (sequence === expressionSequence) {
      expressionLoading.value = false;
    }
  }
}

async function refresh() {
  // Claim the token before any early return: a bail-out must also retire the
  // request in flight, or its late answer reinstates a summary for inputs
  // that no longer apply.
  const sequence = ++requestSequence;
  const datasetId = store.dataset?.id;
  if (!datasetId) {
    summary.value = null;
    loading.value = false;
    return;
  }
  const filters = requestFilters.value;
  loading.value = true;
  error.value = "";
  try {
    const result = await store.annotationsAPI.fetchAnnotationSummary(
      datasetId,
      filters,
      selectedPaths.value,
    );
    if (sequence === requestSequence) {
      summary.value = result;
    }
  } catch (err) {
    if (sequence === requestSequence) {
      logError("Failed to fetch the selection summary:", err);
      error.value = extractErrorMessage(err);
      summary.value = null;
    }
  } finally {
    if (sequence === requestSequence) {
      loading.value = false;
    }
  }
}

watch(dialog, (open) => {
  if (!open) {
    return;
  }
  // Start from the columns the Objects tab shows, and from the narrowest
  // scope that has something in it.
  selectedPathStrings.value = propertyStore.displayedPropertyPaths.map(
    serializePropertyPath,
  );
  scope.value =
    selectedCount.value > 0
      ? "selected"
      : hasActiveFilter.value
        ? "filtered"
        : "all";
  spatialStore.ensureInfo();
});

watch(
  () => [
    dialog.value,
    scope.value,
    expressionSymbols.value.join("|"),
    spatialStore.hasTable,
    scope.value === "filtered"
      ? annotationListServer.currentFiltersSignature
      : "",
  ],
  () => {
    if (dialog.value) {
      refreshExpression();
    }
  },
);

// One request per change of the request's inputs — opening (which may or may
// not change scope and paths above; both land in the same flush), the scope,
// the paths, and for "filtered" the filter content. currentFilters rebuilds
// its object on every read, so its signature is compared, not the object.
watch(
  () => [
    dialog.value,
    scope.value,
    selectedPathStrings.value.join("|"),
    scope.value === "filtered"
      ? annotationListServer.currentFiltersSignature
      : "",
  ],
  () => {
    if (dialog.value) {
      refresh();
    }
  },
);

function propertyName(path: string[]): string {
  return propertyStore.getFullNameFromPath(path) ?? path.join(" / ");
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "–";
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  return value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

function formatPercent(fraction: number): string {
  return `${(100 * fraction).toFixed(1)}%`;
}

function buildCsv(result: IAnnotationSummary): string {
  const fields = [
    "Section",
    "Name",
    "Count",
    "Fraction",
    "Mean",
    "SD",
    "Min",
    "Max",
  ];
  const data: (string | number | null)[][] = [
    ["total", "", result.total, 1, null, null, null, null],
    ...result.tags.map((row) => [
      "tag",
      row.tag,
      row.count,
      result.total > 0 ? row.count / result.total : 0,
      null,
      null,
      null,
      null,
    ]),
    ...result.properties.map((row) => [
      "property",
      propertyName(row.path),
      row.count,
      result.total > 0 ? row.count / result.total : 0,
      row.mean,
      row.std,
      row.min,
      row.max,
    ]),
    ...(expression.value?.features ?? []).map((row) => [
      "expression",
      row.symbol,
      row.expressing,
      row.fractionExpressing,
      row.mean,
      null,
      null,
      null,
    ]),
  ];
  return Papa.unparse({ fields, data });
}

function download() {
  if (!summary.value) {
    return;
  }
  const datasetName = store.dataset?.name ?? "dataset";
  downloadToClient({
    href:
      "data:text/csv;charset=utf-8," +
      encodeURIComponent(buildCsv(summary.value)),
    download: `${datasetName}-${scope.value}-summary.csv`,
  });
}

defineExpose({
  dialog,
  scope,
  selectedPathStrings,
  summary,
  expressionSymbols,
  expression,
  expressionError,
  refreshExpression,
  loading,
  error,
  hasActiveFilter,
  requestFilters,
  refresh,
  buildCsv,
  download,
  formatNumber,
});
</script>

<style lang="scss" scoped>
.summary-total {
  font-size: 15px;
  font-weight: 600;
}

.summary-loading {
  font-size: 13px;
  opacity: 0.8;
  padding: 8px 0;
}

.summary-empty {
  font-size: 13px;
  opacity: 0.7;
  padding: 4px 0 8px;
}

.summary-table {
  th {
    font-weight: 600;
  }
}
</style>
