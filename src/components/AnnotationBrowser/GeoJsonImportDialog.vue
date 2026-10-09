<template>
  <v-dialog v-model="dialog" max-width="560px" :persistent="isImporting">
    <v-card :disabled="!store.dataset">
      <v-card-title>Import GeoJSON</v-card-title>
      <v-card-subtitle>
        Region layers from QuPath, 10x, or other tools
      </v-card-subtitle>
      <v-card-text>
        <v-file-input
          v-model="file"
          accept=".geojson,.json,application/geo+json,application/json"
          prepend-icon=""
          prepend-inner-icon="mdi-file-upload-outline"
          variant="outlined"
          density="compact"
          label="GeoJSON file (.geojson or .json)"
          show-size
          :disabled="isImporting"
        />
        <p class="text-caption text-medium-emphasis mb-3">
          Coordinates are read as this image's pixels, origin at the top-left
          (QuPath's convention). Annotations are placed at the current location
          (XY {{ store.xy + 1 }}, Z {{ store.z + 1 }}, time
          {{ store.time + 1 }}).
        </p>

        <v-progress-linear v-if="isParsing" indeterminate class="mb-3" />

        <v-alert
          v-if="parseError"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          {{ parseError }}
        </v-alert>

        <template v-if="parsed">
          <v-select
            v-model="layerId"
            :items="layerItems"
            label="Layer (sets the channel)"
            variant="outlined"
            density="compact"
            :disabled="isImporting || layerItems.length === 0"
            hide-details
            class="mb-3"
          />
          <v-text-field
            v-model="extraTag"
            label="Extra tag for every annotation (optional)"
            variant="outlined"
            density="compact"
            :disabled="isImporting"
            :hint="extraTagHint"
            persistent-hint
            :hide-details="!extraTagHint"
            class="mb-3"
          />

          <div class="panel-section-title mb-1">Preview</div>
          <div class="text-body-2 mb-2">
            {{ parsed.annotations.length.toLocaleString() }}
            annotation{{ parsed.annotations.length === 1 ? "" : "s" }} from
            {{ parsed.featureCount.toLocaleString() }}
            feature{{ parsed.featureCount === 1 ? "" : "s" }}
          </div>
          <div class="d-flex flex-wrap ga-1 mb-2">
            <v-chip
              v-for="(count, shape) in preview.byShape"
              :key="shape"
              size="small"
              label
            >
              {{ shape }}: {{ count.toLocaleString() }}
            </v-chip>
          </div>
          <div class="d-flex flex-wrap ga-1 mb-3">
            <v-chip
              v-for="[className, count] in classRows"
              :key="className"
              size="small"
              variant="outlined"
            >
              {{ className || "(no class)" }}: {{ count.toLocaleString() }}
            </v-chip>
            <span
              v-if="hiddenClassCount > 0"
              class="text-caption text-medium-emphasis align-self-center"
            >
              and {{ hiddenClassCount }} more classes
            </span>
          </div>

          <v-alert
            v-if="skippedSummary"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            Skipped: {{ skippedSummary }}.
          </v-alert>
          <v-alert
            v-if="preview.outOfBounds > 0"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            {{ preview.outOfBounds.toLocaleString() }}
            annotation{{
              preview.outOfBounds === 1 ? " has" : "s have"
            }}
            coordinates outside the image ({{ store.dataset?.width }} x
            {{ store.dataset?.height }} px). Check that the file uses this
            image's pixel coordinates, not microns.
          </v-alert>
        </template>

        <v-alert
          v-if="importError"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          {{ importError }}
        </v-alert>
        <v-progress-linear
          v-if="isImporting"
          :model-value="importProgress * 100"
          class="mt-2"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn
          variant="text"
          size="small"
          :disabled="isImporting"
          @click="dialog = false"
        >
          Cancel
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :disabled="!canImport"
          :loading="isImporting"
          @click="submit"
        >
          Import {{ parsed ? parsed.annotations.length.toLocaleString() : "" }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import {
  IGeoJsonParseResult,
  GeoJsonParseError,
  parseGeoJsonText,
  summarizeGeoJsonImport,
  toAnnotationBases,
} from "@/utils/geojson";
import { importGeoJsonAnnotations } from "@/utils/annotationImport";
import { logError } from "@/utils/log";

const MAX_PREVIEW_CLASSES = 12;

// Opened by its owner through `v-model:open` (DataIOMenu, from its menu or the
// command palette); the dialog renders no activator of its own.
const dialog = defineModel<boolean>("open", { default: false });
const file = ref<File | File[] | null>(null);
const isParsing = ref(false);
const parseError = ref("");
const parsed = ref<IGeoJsonParseResult | null>(null);
const layerId = ref<string | null>(null);
const extraTag = ref("region");
// Spatial analyses (neighborhoods, region summaries, recompute) leave out
// only polygons tagged "region"; imported regions without it count as cells.
const extraTagHint = computed(() =>
  extraTag.value.trim() === "region"
    ? ""
    : 'Regions of interest need the tag "region": without it, spatial ' +
      "analyses treat these polygons as cells.",
);
const isImporting = ref(false);
const importProgress = ref(0);
const importError = ref("");

const isLoggedIn = computed(() => store.isLoggedIn);

const layerItems = computed(() =>
  store.layers.map((layer) => ({ title: layer.name, value: layer.id })),
);

// A layer chosen earlier may be gone (configuration changed); fall back to
// the first layer, like a tool without a layer assignment.
const channel = computed(() => {
  const layer =
    store.layers.find(({ id }) => id === layerId.value) ?? store.layers[0];
  return layer?.channel ?? 0;
});

const preview = computed(() =>
  summarizeGeoJsonImport(
    parsed.value?.annotations ?? [],
    store.dataset
      ? { width: store.dataset.width, height: store.dataset.height }
      : null,
  ),
);

const sortedClasses = computed(() =>
  Object.entries(preview.value.byClass).sort((a, b) => b[1] - a[1]),
);
const classRows = computed(() =>
  sortedClasses.value.slice(0, MAX_PREVIEW_CLASSES),
);
const hiddenClassCount = computed(
  () => sortedClasses.value.length - classRows.value.length,
);

const skippedSummary = computed(() => {
  if (!parsed.value) {
    return "";
  }
  const parts = Object.entries(parsed.value.skipped).map(
    ([reason, count]) => `${count.toLocaleString()} ${reason}`,
  );
  const holes = parsed.value.holesSkipped;
  if (holes > 0) {
    parts.push(
      `${holes.toLocaleString()} polygon hole${holes === 1 ? "" : "s"} ` +
        "(outer boundaries only)",
    );
  }
  return parts.join(", ");
});

const canImport = computed(
  () =>
    !!store.dataset &&
    isLoggedIn.value &&
    !isImporting.value &&
    !!parsed.value &&
    parsed.value.annotations.length > 0,
);

function reset() {
  file.value = null;
  parsed.value = null;
  parseError.value = "";
  importError.value = "";
  importProgress.value = 0;
  extraTag.value = "region";
}

watch(dialog, (open) => {
  if (open) {
    layerId.value = store.layers[0]?.id ?? null;
  } else if (!isImporting.value) {
    reset();
  }
});

// Guards against a slow read of an earlier file landing after a newer pick.
let parseToken = 0;

watch(file, async (value) => {
  const token = ++parseToken;
  parsed.value = null;
  parseError.value = "";
  importError.value = "";
  const picked = Array.isArray(value) ? value[0] : value;
  if (!picked) {
    return;
  }
  isParsing.value = true;
  try {
    const text = await picked.text();
    if (token !== parseToken) {
      return;
    }
    parsed.value = parseGeoJsonText(text);
    if (parsed.value.annotations.length === 0) {
      parseError.value = "This file has no geometries that can be imported.";
    }
  } catch (error) {
    if (token !== parseToken) {
      return;
    }
    parseError.value =
      error instanceof GeoJsonParseError
        ? error.message
        : "This file could not be read.";
    if (!(error instanceof GeoJsonParseError)) {
      logError("Error reading GeoJSON file:", error);
    }
  } finally {
    if (token === parseToken) {
      isParsing.value = false;
    }
  }
});

async function submit() {
  if (!canImport.value || !parsed.value || !store.dataset) {
    return;
  }
  const annotationBases = toAnnotationBases(parsed.value.annotations, {
    datasetId: store.dataset.id,
    location: { XY: store.xy, Z: store.z, Time: store.time },
    channel: channel.value,
    extraTag: extraTag.value,
  });
  isImporting.value = true;
  importError.value = "";
  importProgress.value = 0;
  try {
    await importGeoJsonAnnotations(annotationBases, (created, total) => {
      importProgress.value = created / total;
    });
    isImporting.value = false;
    dialog.value = false;
  } catch (error) {
    logError("Error importing GeoJSON annotations:", error);
    importError.value = (error as Error).message || "The import failed.";
  } finally {
    isImporting.value = false;
  }
}

defineExpose({
  dialog,
  file,
  extraTagHint,
  parsed,
  parseError,
  layerId,
  extraTag,
  channel,
  preview,
  skippedSummary,
  canImport,
  importError,
  submit,
});
</script>
