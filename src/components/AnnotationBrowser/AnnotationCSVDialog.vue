<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="activatorBinding">
      <slot name="activator" v-bind="activatorBinding">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          v-bind="{ ...activatorBinding.props, ...$attrs }"
          v-description="{
            section: 'Object list actions',
            title: 'Export CSV',
            description:
              'Export the current list of annotations and associated properties to a CSV file',
          }"
        >
          <v-icon>mdi-application-export</v-icon>
          EXPORT CSV
        </v-btn>
      </slot>
    </template>
    <v-card>
      <v-card-title> Current Annotation List as CSV </v-card-title>
      <v-card-subtitle>
        Export your measurements to a CSV spreadsheet
      </v-card-subtitle>

      <v-card-text>
        <v-alert type="info" variant="tonal" class="mb-4">
          Choose how you want to export your values and how to handle undefined
          values. The resulting CSV file can be opened in spreadsheet
          applications like Excel or Google Sheets.
        </v-alert>

        <v-radio-group v-model="exportScope" class="mt-0 mb-2" hide-details>
          <v-radio label="Current dataset only" value="current" />
          <v-radio
            :label="allDatasetsLabel"
            value="all"
            :disabled="!configuration"
          />
        </v-radio-group>

        <template v-if="exportScope === 'all'">
          <template v-if="loadingDatasets">
            <v-progress-linear indeterminate class="my-4" />
            <div class="text-center mb-4">
              Loading datasets in collection...
            </div>
          </template>
          <v-alert
            v-else-if="collectionDatasets.length === 0"
            type="warning"
            variant="tonal"
            class="my-4"
          >
            No datasets found in this collection.
          </v-alert>
          <v-alert
            v-else
            type="success"
            variant="tonal"
            density="compact"
            class="my-4"
          >
            Found {{ collectionDatasets.length }} dataset{{
              collectionDatasets.length === 1 ? "" : "s"
            }}
            in this collection.
          </v-alert>
        </template>

        <template v-if="exportScope === 'current'">
          <v-list-subheader>Annotations to Export</v-list-subheader>
          <v-radio-group
            v-model="annotationScope"
            class="mt-0 mb-2"
            hide-details
          >
            <v-radio
              value="all"
              :label="`All annotations (${allAnnotationCount})`"
            />
            <v-radio
              value="filtered"
              :label="`Filtered annotations (${filteredAnnotationCount})`"
              :disabled="!hasActiveFilter"
            />
            <v-radio
              value="selected"
              :label="`Selected annotations (${selectedAnnotationCount})`"
              :disabled="selectedAnnotationCount === 0"
            />
          </v-radio-group>
        </template>

        <v-divider class="mb-4" />

        <v-list-subheader>File Format</v-list-subheader>
        <v-radio-group v-model="fileFormat" class="mb-4">
          <v-radio label="CSV (comma-separated)" value="csv"></v-radio>
          <v-radio label="TSV (tab-separated)" value="tsv"></v-radio>
        </v-radio-group>

        <v-alert
          v-if="hasCommasInPropertyNames && !sanitizeColumnNames"
          :type="fileFormat === 'csv' ? 'warning' : 'info'"
          variant="tonal"
          class="mb-4"
        >
          <template v-if="fileFormat === 'csv'">
            Some property names contain commas, which may cause issues with CSV
            formatting. TSV format is recommended instead.
          </template>
          <template v-else>
            TSV format selected. This avoids issues with property names that
            contain commas.
          </template>
        </v-alert>

        <v-list-subheader>Property Export Options</v-list-subheader>
        <v-radio-group v-model="propertyExportMode" class="mb-4">
          <v-radio label="Export all properties" value="all"></v-radio>
          <v-radio label="Export listed properties" value="listed"></v-radio>
          <v-radio
            label="Select properties to export"
            value="selected"
          ></v-radio>
        </v-radio-group>

        <v-checkbox
          v-model="sanitizeColumnNames"
          label="Replace special characters in column names"
          class="mb-4"
          hide-details
        />

        <v-list-subheader>Undefined Value Handling</v-list-subheader>
        <v-radio-group v-model="undefinedHandling" class="mb-4">
          <v-radio label="Empty string" value="empty"></v-radio>
          <v-radio label="NA" value="na"></v-radio>
          <v-radio label="NaN" value="nan"></v-radio>
        </v-radio-group>

        <template v-if="propertyExportMode === 'selected'">
          <v-text-field
            v-model="propertyFilter"
            label="Filter properties"
            clearable
            class="mb-4"
          ></v-text-field>

          <v-data-table
            v-model="selectedPropertyPaths"
            :headers="[{ title: 'Property Name', key: 'name' }]"
            :items="filteredPropertyItems"
            item-value="pathString"
            show-select
            class="mb-4"
            height="300px"
            fixed-header
            :items-per-page="-1"
          >
            <template #[`item.name`]="{ item }">
              {{ item.name }}
            </template>
          </v-data-table>
        </template>

        <template v-if="exportScope === 'current'">
          <template v-if="isTooLargeForPreview">
            <v-alert type="info" variant="tonal" class="mb-4">
              Preview is not available for more than
              {{ PREVIEW_ANNOTATION_LIMIT }} annotations ({{
                annotationsToExport.length
              }}
              annotations to export). Download will export using the server.
            </v-alert>
            <v-textarea
              v-model="filename"
              class="my-2"
              label="File name"
              rows="1"
              no-resize
              hide-details
            />
          </template>
          <template v-else-if="text && text.length">
            <v-textarea ref="fieldToCopy" v-model="displayText" readonly>
              {{ displayText }}
              <template v-slot:append>
                <v-btn
                  variant="text"
                  icon
                  size="small"
                  title="Copy to clipboard"
                  @click="copyCSVText"
                  :disabled="!canUseClipboard"
                  ><v-icon>{{ "mdi-content-copy" }}</v-icon></v-btn
                >
              </template>
            </v-textarea>
            <v-textarea
              v-model="filename"
              class="my-2"
              label="File name"
              rows="1"
              no-resize
              hide-details
            />
          </template>
          <template v-else>
            <div class="d-flex flex-column align-center">
              <p>Generating CSV...</p>
              <v-progress-circular
                :model-value="processingProgress * 100"
                :indeterminate="processingProgress === 0"
                class="mb-2"
              />
              <span v-if="processingProgress > 0">
                {{ Math.round(processingProgress * 100) }}%
              </span>
            </div>
          </template>
        </template>

        <template v-if="bulkExporting">
          <v-divider class="my-4" />
          <div class="panel-section-title mb-2">
            Exported {{ bulkExportProgress }} of
            {{ collectionDatasets.length }} datasets
          </div>
          <v-progress-linear
            :model-value="
              (bulkExportProgress / collectionDatasets.length) * 100
            "
            class="mb-2"
          />
        </template>

        <v-alert
          v-if="bulkExportError"
          type="error"
          variant="tonal"
          class="mt-4"
        >
          {{ bulkExportError }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn
          variant="text"
          size="small"
          :disabled="bulkExporting"
          @click="dialog = false"
        >
          Close
        </v-btn>
        <v-btn
          variant="flat"
          color="success"
          size="small"
          @click="download"
          :disabled="!canDownload"
          :loading="isDownloading || bulkExporting"
          :min-width="isDownloading || bulkExporting ? 260 : undefined"
        >
          <template v-slot:loader>
            <v-progress-circular
              indeterminate
              size="18"
              width="2"
              class="mr-2"
            ></v-progress-circular>
            {{
              bulkExporting ? "Exporting datasets..." : "Preparing download..."
            }}
          </template>
          <v-icon> mdi-save </v-icon>
          {{ downloadButtonText }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import type { ComponentPublicInstance } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import { useCollectionDatasets } from "@/utils/useCollectionDatasets";

import Papa from "papaparse";

import { IAnnotation } from "@/store/model";
import { getValueFromObjectAndPath } from "@/utils/paths";

const UNDEFINED_VALUE_MAP = {
  na: "NA",
  nan: "NaN",
  empty: "",
} as const;

const PREVIEW_ANNOTATION_LIMIT = 1000;
const DISPLAY_CHAR_LIMIT = 10000;
// Must stay in sync with CSV_UNSAFE_COLUMN_CHARS in
// devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/export.py
// so this client-side preview matches the server-generated CSV exactly.
const UNSAFE_CSV_COLUMN_CHARS = /[^A-Za-z0-9_]+/g;

interface CsvColumn {
  name: string;
  // isQuoted controls value quoting, not just header quoting: Tags joins
  // multiple tags with ", " and Name is freeform user text, so these stay
  // quoted regardless of sanitization. Keeping the flag on the column
  // (rather than a separate parallel array) means it cannot drift out of
  // alignment with the name when fixed columns are added/moved/removed.
  isQuoted: boolean;
}

// Fixed columns for CSV export. Mirrors CSV_FIXED_COLUMNS in
// devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/export.py.
const CSV_FIXED_COLUMNS: readonly CsvColumn[] = [
  { name: "Id", isQuoted: true },
  { name: "Channel", isQuoted: false },
  { name: "XY", isQuoted: false },
  { name: "Z", isQuoted: false },
  { name: "Time", isQuoted: false },
  { name: "Tags", isQuoted: true },
  { name: "Shape", isQuoted: true },
  { name: "Name", isQuoted: true },
];

const props = defineProps<{
  annotations: IAnnotation[];
  propertyPaths: string[][];
}>();

const fieldToCopy = ref<ComponentPublicInstance>();

const filename = ref("");

const dialog = ref(false);
const text = ref("");
const displayText = ref("");

const propertyExportMode = ref<"all" | "selected" | "listed">("all");
const propertyFilter = ref("");
const selectedPropertyPaths = ref<string[]>([]);
const sanitizeColumnNames = ref(false);

const fileFormat = ref<"csv" | "tsv">("csv");
const fileDelimiter = computed(() => (fileFormat.value === "tsv" ? "\t" : ","));
const fileExtension = computed(() =>
  fileFormat.value === "tsv" ? ".tsv" : ".csv",
);

const propertyNamesWithCommas = computed(() => {
  return props.propertyPaths
    .map((path) => propertyStore.getFullNameFromPath(path))
    .filter((name): name is string => !!name && name.includes(","));
});

const hasCommasInPropertyNames = computed(
  () => propertyNamesWithCommas.value.length > 0,
);

const undefinedHandling = ref<"empty" | "na" | "nan">("empty");

const processingProgress = ref(0);
const isProcessing = ref(false);
const isDownloading = ref(false);

const annotationScope = ref<"all" | "filtered" | "selected">("all");

const allAnnotationCount = computed(() => annotationStore.annotations.length);
const filteredAnnotationCount = computed(() => props.annotations.length);
const selectedAnnotationCount = computed(
  () => annotationStore.selectedAnnotationIds.size,
);
const hasActiveFilter = computed(
  () => props.annotations.length < annotationStore.annotations.length,
);

const exportScope = ref<"current" | "all">("current");
const bulkExporting = ref(false);
const bulkExportProgress = ref(0);
const bulkExportError = ref("");

const annotationsToExport = computed(() => {
  if (annotationScope.value === "selected") {
    const ids = annotationStore.selectedAnnotationIds;
    return annotationStore.annotations.filter((a) => ids.has(a.id));
  }
  if (annotationScope.value === "filtered") {
    return props.annotations;
  }
  return annotationStore.annotations;
});

const { loadingDatasets, collectionDatasets, configuration, allDatasetsLabel } =
  useCollectionDatasets(dialog, exportScope);

const isTooLargeForPreview = computed(() => {
  return annotationsToExport.value.length > PREVIEW_ANNOTATION_LIMIT;
});

const canUseClipboard = computed(() => {
  return !!navigator || !!(navigator as Navigator)?.clipboard;
});

const dataset = computed(() => store.dataset);
const canDownload = computed(() => {
  if (isDownloading.value || bulkExporting.value) return false;
  if (exportScope.value === "current") return !!store.dataset;
  return collectionDatasets.value.length > 0 && !loadingDatasets.value;
});

const downloadButtonText = computed(() => {
  if (exportScope.value === "current") return "Download";
  const count = collectionDatasets.value.length;
  return `Download ${count} dataset${count === 1 ? "" : "s"}`;
});

const displayedPropertyPaths = computed(
  () => propertyStore.displayedPropertyPaths,
);

const filteredPropertyItems = computed(() => {
  return (
    propertyFilter.value
      ? props.propertyPaths
      : props.propertyPaths.filter((path) => {
          const name = propertyStore.getFullNameFromPath(path);
          return name
            ?.toLowerCase()
            .includes(propertyFilter.value.toLowerCase());
        })
  ).map((path) => ({
    name: propertyStore.getFullNameFromPath(path) || "",
    path: path,
    pathString: path.join("."),
  }));
});

function resetFilename() {
  filename.value = (dataset.value?.name ?? "unknown") + fileExtension.value;
}

function copyCSVText() {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text.value);
  } else {
    const fieldToCopyEl = (fieldToCopy.value as any)?.$el?.querySelector(
      "input",
    );
    if (fieldToCopyEl) {
      fieldToCopyEl.select();
      document.execCommand("copy");
    }
  }
}

function sanitizeCsvColumnName(name: string): string {
  return (
    name.replace(UNSAFE_CSV_COLUMN_CHARS, "_").replace(/^_+|_+$/g, "") || "_"
  );
}

function getCsvColumnName(name: string): string {
  return sanitizeColumnNames.value ? sanitizeCsvColumnName(name) : name;
}

// Sanitization can collapse distinct names to the same token, which would
// break R imports that rely on unique header names. Suffix repeats with
// _2, _3, ... in order of appearance, checking each candidate against the
// used set so ["Area", "Area_2", "Area"] becomes ["Area", "Area_2",
// "Area_3"] rather than two "Area_2"s. Matches the backend dedup logic.
function deduplicateColumnNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    let counter = 1;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `${name}_${counter}`;
    }
    used.add(candidate);
    return candidate;
  });
}

async function generateCSVStringForAnnotations() {
  isProcessing.value = true;
  processingProgress.value = 0;

  try {
    // Build columns as {name, isQuoted} so the quote flag travels with its
    // column. Fixed columns first, then one column per included property.
    const columns: CsvColumn[] = CSV_FIXED_COLUMNS.map((col) => ({
      name: getCsvColumnName(col.name),
      isQuoted: col.isQuoted,
    }));
    const usedPaths: string[][] = [];

    // Pre-compute included paths to avoid repeated checks
    const includedPaths = props.propertyPaths.filter((path) => {
      const pathName = propertyStore.getFullNameFromPath(path);
      return pathName && shouldIncludePropertyPath(path);
    });

    includedPaths.forEach((path) => {
      const name = propertyStore.getFullNameFromPath(path)!;
      const columnName = getCsvColumnName(name);
      columns.push({ name: columnName, isQuoted: columnName.includes(",") });
      usedPaths.push(path);
    });

    if (sanitizeColumnNames.value) {
      // Dedup operates on names only; re-attach to the existing columns so
      // each name keeps its isQuoted flag.
      const uniqueNames = deduplicateColumnNames(columns.map((c) => c.name));
      uniqueNames.forEach((name, i) => (columns[i].name = name));
    }

    // Papa.unparse takes parallel fields/quotes arrays, so split only here.
    const fields = columns.map((c) => c.name);
    const quotes = columns.map((c) => c.isQuoted);

    // Process annotations in chunks
    const CHUNK_SIZE = 100;
    const data: (string | number)[][] = [];
    const propValues = propertyStore.propertyValues;
    const annotations = annotationsToExport.value;
    const nAnnotations = annotations.length;

    for (let i = 0; i < nAnnotations; i += CHUNK_SIZE) {
      const chunk = annotations.slice(i, i + CHUNK_SIZE);

      // Process chunk
      const rows = chunk.map((annotation) => {
        const row: (string | number)[] = [
          annotation.id,
          annotation.channel,
          annotation.location.XY + 1,
          annotation.location.Z + 1,
          annotation.location.Time + 1,
          annotation.tags.join(", "),
          annotation.shape,
          annotation.name ?? "",
        ];

        for (const path of usedPaths) {
          const value = getValueFromObjectAndPath(
            propValues[annotation.id],
            path,
          );
          row.push(
            typeof value === "object" || typeof value === "undefined"
              ? UNDEFINED_VALUE_MAP[undefinedHandling.value]
              : value,
          );
        }
        return row;
      });

      data.push(...rows);
      processingProgress.value = (i + CHUNK_SIZE) / nAnnotations;
    }

    // Generate csv/tsv
    return Papa.unparse(
      { fields, data },
      { quotes, delimiter: fileDelimiter.value },
    );
  } finally {
    isProcessing.value = false;
    processingProgress.value = 1;
  }
}

function updateText() {
  if (dialog.value) {
    // Skip preview generation for large datasets
    if (isTooLargeForPreview.value) {
      text.value = "";
      displayText.value = "";
      processingProgress.value = 1;
      return;
    }

    generateCSVStringForAnnotations().then((csv: string) => {
      text.value = csv;
      displayText.value =
        csv.length > DISPLAY_CHAR_LIMIT
          ? `${csv.slice(0, DISPLAY_CHAR_LIMIT)}... (truncated, ${csv.length} total characters)`
          : csv;
    });
  } else {
    text.value = "";
    displayText.value = "";
  }
}

function getIncludedPropertyPaths(): string[][] {
  return props.propertyPaths.filter((path) => {
    const pathName = propertyStore.getFullNameFromPath(path);
    return pathName && shouldIncludePropertyPath(path);
  });
}

function getUndefinedValueString(): "" | "NA" | "NaN" {
  return UNDEFINED_VALUE_MAP[undefinedHandling.value];
}

async function download() {
  if (exportScope.value === "current") {
    await downloadSingleDataset();
  } else {
    await downloadAllDatasets();
  }
}

async function downloadSingleDataset() {
  if (!store.dataset) return;

  isDownloading.value = true;
  try {
    // Only send annotationIds when exporting a subset, to avoid
    // exceeding MongoDB's 16MB BSON query size limit.
    const exportAnnotations = annotationsToExport.value;
    const isSubset =
      exportAnnotations.length < annotationStore.annotations.length;

    await store.exportAPI.exportCsv({
      datasetId: store.dataset.id,
      propertyPaths: getIncludedPropertyPaths(),
      ...(isSubset
        ? { annotationIds: exportAnnotations.map((a) => a.id) }
        : {}),
      undefinedValue: getUndefinedValueString(),
      delimiter: fileDelimiter.value,
      sanitizeColumnNames: sanitizeColumnNames.value,
      filename:
        filename.value || `upenn_annotation_export${fileExtension.value}`,
    });
  } finally {
    isDownloading.value = false;
  }
}

async function downloadAllDatasets() {
  if (collectionDatasets.value.length === 0) return;

  bulkExporting.value = true;
  bulkExportProgress.value = 0;
  bulkExportError.value = "";

  try {
    await store.exportAPI.exportBulkCsv({
      datasets: collectionDatasets.value,
      propertyPaths: getIncludedPropertyPaths(),
      undefinedValue: getUndefinedValueString(),
      delimiter: fileDelimiter.value,
      sanitizeColumnNames: sanitizeColumnNames.value,
      onProgress: (completed) => {
        bulkExportProgress.value = completed;
      },
    });

    dialog.value = false;
  } catch (error) {
    bulkExportError.value =
      `Export failed after ${bulkExportProgress.value} of ` +
      `${collectionDatasets.value.length} datasets. ` +
      (error instanceof Error ? error.message : "Unknown error.");
  } finally {
    bulkExporting.value = false;
  }
}

function shouldIncludePropertyPath(path: string[]) {
  const pathString = path.join(".");
  return (
    propertyExportMode.value === "all" ||
    (propertyExportMode.value === "listed" &&
      displayedPropertyPaths.value.some(
        (displayPath: string[]) => displayPath.join(".") === pathString,
      )) ||
    (propertyExportMode.value === "selected" &&
      selectedPropertyPaths.value.includes(pathString))
  );
}

// Collapse 4 stacked @Watch into single watch
watch(
  [
    propertyExportMode,
    selectedPropertyPaths,
    undefinedHandling,
    sanitizeColumnNames,
    fileFormat,
    dialog,
    annotationScope,
  ],
  () => updateText(),
);

watch([fileFormat, dataset], () => resetFilename());

onMounted(() => resetFilename());

defineExpose({
  dialog,
  text,
  filename,
  annotationScope,
  propertyExportMode,
  fileFormat,
  undefinedHandling,
  sanitizeColumnNames,
  processingProgress,
  isProcessing,
  isTooLargeForPreview,
  displayedPropertyPaths,
  filteredPropertyItems,
  propertyNamesWithCommas,
  hasCommasInPropertyNames,
  resetFilename,
  sanitizeCsvColumnName,
  generateCSVStringForAnnotations,
  updateText,
  getIncludedPropertyPaths,
  getUndefinedValueString,
  shouldIncludePropertyPath,
  download,
  exportScope,
  bulkExporting,
  bulkExportError,
  collectionDatasets,
  downloadAllDatasets,
  canDownload,
  downloadButtonText,
});
</script>
