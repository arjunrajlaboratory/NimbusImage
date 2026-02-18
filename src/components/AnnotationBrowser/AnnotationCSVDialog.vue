<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
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
    </template>
    <v-card>
      <v-card-title> Current Annotation List as CSV </v-card-title>
      <v-card-subtitle>
        Export your measurements to a CSV spreadsheet
      </v-card-subtitle>

      <v-card-text>
        <v-alert type="info" text class="mb-4">
          Choose how you want to export your values and how to handle undefined
          values. The resulting CSV file can be opened in spreadsheet
          applications like Excel or Google Sheets.
        </v-alert>

        <v-subheader>Property Export Options</v-subheader>
        <v-radio-group v-model="propertyExportMode" class="mb-4">
          <v-radio label="Export all properties" value="all"></v-radio>
          <v-radio label="Export listed properties" value="listed"></v-radio>
          <v-radio
            label="Select properties to export"
            value="selected"
          ></v-radio>
        </v-radio-group>

        <v-subheader>Undefined Value Handling</v-subheader>
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
            :headers="[{ text: 'Property Name', value: 'name' }]"
            :items="filteredPropertyItems"
            item-key="pathString"
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

        <template v-if="isTooLargeForPreview">
          <v-alert type="info" text class="mb-4">
            Preview is not available for more than
            {{ PREVIEW_ANNOTATION_LIMIT }} annotations ({{ annotations.length }}
            annotations selected). Download will export all annotations using
            the server.
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
                icon
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
              :value="processingProgress * 100"
              :indeterminate="processingProgress === 0"
              class="mb-2"
            />
            <span v-if="processingProgress > 0">
              {{ Math.round(processingProgress * 100) }}%
            </span>
          </div>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn @click="dialog = false" text>Close</v-btn>
        <v-btn
          @click="download"
          :disabled="!store.dataset || isDownloading"
          :loading="isDownloading"
          color="success"
          :min-width="isDownloading ? 260 : undefined"
        >
          <template v-slot:loader>
            <v-progress-circular
              indeterminate
              size="18"
              width="2"
              class="mr-2"
            ></v-progress-circular>
            Preparing download...
          </template>
          <v-icon> mdi-save </v-icon>
          Download
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import type Vue from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";

import Papa from "papaparse";

import { IAnnotation } from "@/store/model";
import { getValueFromObjectAndPath } from "@/utils/paths";

interface PropertyPathItem {
  name: string;
  path: string[];
  pathString: string;
}

const UNDEFINED_VALUE_MAP = {
  na: "NA",
  nan: "NaN",
  empty: "",
} as const;

const PREVIEW_ANNOTATION_LIMIT = 1000;
const DISPLAY_CHAR_LIMIT = 10000;

const props = defineProps<{
  annotations: IAnnotation[];
  propertyPaths: string[][];
}>();

const fieldToCopy = ref<InstanceType<typeof Vue>>();

const filename = ref("");

const dialog = ref(false);
const text = ref("");
const displayText = ref("");

const propertyExportMode = ref<"all" | "selected" | "listed">("all");
const propertyFilter = ref("");
const selectedPropertyPaths = ref<PropertyPathItem[]>([]);

const undefinedHandling = ref<"empty" | "na" | "nan">("empty");

const processingProgress = ref(0);
const isProcessing = ref(false);
const isDownloading = ref(false);

const isTooLargeForPreview = computed(() => {
  return props.annotations.length > PREVIEW_ANNOTATION_LIMIT;
});

const canUseClipboard = computed(() => {
  return !!navigator || !!(navigator as Navigator)?.clipboard;
});

const dataset = computed(() => store.dataset);

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
  filename.value = (dataset.value?.name ?? "unknown") + ".csv";
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

async function generateCSVStringForAnnotations() {
  isProcessing.value = true;
  processingProgress.value = 0;

  try {
    // Fields
    const fields = [
      "Id",
      "Channel",
      "XY",
      "Z",
      "Time",
      "Tags",
      "Shape",
      "Name",
    ];
    const quotes = [true, false, false, false, false, true, true, true];
    const usedPaths: string[][] = [];

    // Pre-compute included paths to avoid repeated checks
    const includedPaths = props.propertyPaths.filter((path) => {
      const pathName = propertyStore.getFullNameFromPath(path);
      return pathName && shouldIncludePropertyPath(path);
    });

    includedPaths.forEach((path) => {
      fields.push(propertyStore.getFullNameFromPath(path)!);
      quotes.push(false);
      usedPaths.push(path);
    });

    // Process annotations in chunks
    const CHUNK_SIZE = 100;
    const data: (string | number)[][] = [];
    const propValues = propertyStore.propertyValues;
    const annotations = props.annotations;
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

    // Generate csv
    return Papa.unparse({ fields, data }, { quotes });
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
  if (!store.dataset) {
    return;
  }

  isDownloading.value = true;
  try {
    // Always use backend endpoint for downloads (handles large datasets)
    await store.exportAPI.exportCsv({
      datasetId: store.dataset.id,
      propertyPaths: getIncludedPropertyPaths(),
      annotationIds: props.annotations.map((a) => a.id),
      undefinedValue: getUndefinedValueString(),
      filename: filename.value || "upenn_annotation_export.csv",
    });
  } finally {
    isDownloading.value = false;
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
      selectedPropertyPaths.value.some(
        (selectedPath) => selectedPath.pathString === pathString,
      ))
  );
}

// Collapse 4 stacked @Watch into single watch
watch(
  [propertyExportMode, selectedPropertyPaths, undefinedHandling, dialog],
  () => updateText(),
);

watch(dataset, () => resetFilename());

onMounted(() => resetFilename());

defineExpose({
  dialog,
  text,
  filename,
  propertyExportMode,
  undefinedHandling,
  processingProgress,
  isProcessing,
  isTooLargeForPreview,
  displayedPropertyPaths,
  filteredPropertyItems,
  resetFilename,
  generateCSVStringForAnnotations,
  updateText,
  getIncludedPropertyPaths,
  getUndefinedValueString,
  shouldIncludePropertyPath,
  download,
});
</script>
