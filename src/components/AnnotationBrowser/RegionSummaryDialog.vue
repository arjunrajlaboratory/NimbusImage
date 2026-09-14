<template>
  <v-dialog v-model="dialog" max-width="820">
    <template #activator="{ props: activatorProps }">
      <slot name="activator" :props="activatorProps" />
    </template>
    <v-card>
      <v-card-title>Region statistics</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-3">
          Regions are polygons: the ones carrying a tag, or the ones selected in
          the viewer. Each region's cells are the cell polygons whose center
          lies inside it.
        </p>
        <v-radio-group v-model="source" inline hide-details class="mb-2">
          <v-radio value="tag" label="Polygons with a tag" />
          <v-radio
            value="selection"
            :label="`Selected polygons (${selectedCount})`"
          />
        </v-radio-group>
        <v-row align="center">
          <v-col cols="5">
            <v-combobox
              v-if="source === 'tag'"
              v-model="regionTag"
              :items="tagOptions"
              label="Region tag"
              density="compact"
              variant="outlined"
              hide-details
            />
            <div v-else class="text-caption text-medium-emphasis">
              Up to {{ MAX_REGIONS }} selected polygons are summarized.
            </div>
          </v-col>
          <v-col cols="7">
            <spatial-feature-picker
              v-if="spatialStore.hasTable"
              v-model="symbols"
              label="Genes (mean per region)"
            />
          </v-col>
        </v-row>
        <div class="d-flex align-center my-2">
          <v-btn
            color="primary"
            variant="flat"
            size="small"
            :loading="loading"
            :disabled="!canSummarize || loading"
            @click="refresh"
          >
            Summarize
          </v-btn>
          <v-spacer />
          <v-btn
            v-if="rows.length"
            variant="text"
            size="small"
            prepend-icon="mdi-download"
            @click="download"
          >
            CSV
          </v-btn>
        </div>
        <v-alert v-if="error" type="error" variant="tonal" density="compact">
          {{ error }}
        </v-alert>
        <div v-else-if="loaded && rows.length === 0" class="text-caption">
          {{
            source === "tag"
              ? "No polygon carries that tag."
              : "None of the selected objects is a polygon."
          }}
        </div>
        <v-table v-if="rows.length" density="compact">
          <thead>
            <tr>
              <th>Region</th>
              <th class="text-right">Cells</th>
              <th>Composition</th>
              <th
                v-for="symbol in symbolsShown"
                :key="symbol"
                class="text-right"
              >
                {{ symbol }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>{{ row.name }}</td>
              <td class="text-right">{{ row.cells.toLocaleString() }}</td>
              <td class="composition">{{ compositionText(row) }}</td>
              <td
                v-for="symbol in symbolsShown"
                :key="symbol"
                class="text-right"
              >
                {{ meanOf(row, symbol) }}
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="dialog = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Papa from "papaparse";
import store from "@/store";
import spatialStore from "@/store/spatial";
import annotationStore from "@/store/annotation";
import { ISpatialRegionSummary } from "@/store/model";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";
import SpatialFeaturePicker from "@/components/AnnotationBrowser/SpatialFeaturePicker.vue";

/** Composition (and expression) of the cells inside tagged region polygons
 * (SPATIAL_PLUGIN.md "Phase 6"). */

const MAX_REGIONS = 50;

const dialog = ref(false);
const source = ref<"tag" | "selection">("tag");
const regionTag = ref<string | null>(null);
const symbols = ref<string[]>([]);
const rows = ref<ISpatialRegionSummary[]>([]);
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
// The genes the current table was computed with, so a picker change does not
// desynchronize the columns from the rows until Summarize is pressed again.
const symbolsShown = ref<string[]>([]);

// Only polygons can be regions; a selection may also hold points and lines.
// Ids the store cannot resolve (not loaded) are kept — the server filters by
// shape anyway.
const selectedPolygonIds = computed(() => {
  const resolve = annotationStore.getAnnotationOrStubFromId;
  return Array.from(annotationStore.selectedAnnotationIds).filter((id) => {
    const shape = resolve(id)?.shape;
    return shape === undefined || shape === "polygon" || shape === "rectangle";
  });
});

const selectedCount = computed(() => selectedPolygonIds.value.length);

const canSummarize = computed(() =>
  source.value === "tag"
    ? !!regionTag.value
    : selectedCount.value > 0 && selectedCount.value <= MAX_REGIONS,
);

// annotationTags covers stub-only mode, where `annotations` holds only the
// hydrated objects and would hide a tag carried by unhydrated polygons.
const tagOptions = computed(() => [...annotationStore.annotationTags].sort());

function compositionText(row: ISpatialRegionSummary): string {
  return row.composition
    .map((entry) => `${entry.type} ${entry.count.toLocaleString()}`)
    .join(", ");
}

function meanOf(row: ISpatialRegionSummary, symbol: string): string {
  const entry = row.expression.find((f) => f.symbol === symbol);
  return entry && entry.mean !== null ? entry.mean.toFixed(2) : "—";
}

async function refresh() {
  const datasetId = store.dataset?.id;
  if (!datasetId || !canSummarize.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await store.spatialAPI.regionSummary(
      datasetId,
      source.value === "tag"
        ? { regionTag: regionTag.value! }
        : { regionIds: selectedPolygonIds.value },
      spatialStore.hasTable ? symbols.value : [],
    );
    symbolsShown.value = spatialStore.hasTable ? [...symbols.value] : [];
  } catch (caught) {
    logError("Region summary failed:", caught);
    error.value = extractErrorMessage(caught);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

function buildCsv(): string {
  const types = Array.from(
    new Set(rows.value.flatMap((r) => r.composition.map((c) => c.type))),
  ).sort();
  return Papa.unparse({
    fields: ["region", "cells", ...types, ...symbolsShown.value],
    data: rows.value.map((row) => [
      row.name,
      row.cells,
      ...types.map(
        (type) => row.composition.find((c) => c.type === type)?.count ?? 0,
      ),
      ...symbolsShown.value.map(
        (symbol) => row.expression.find((f) => f.symbol === symbol)?.mean ?? "",
      ),
    ]),
  });
}

function download() {
  downloadToClient({
    href: "data:text/csv;charset=utf-8," + encodeURIComponent(buildCsv()),
    download: `${store.dataset?.name ?? "dataset"}-regions.csv`,
  });
}

watch(dialog, (open) => {
  if (open) {
    error.value = null;
  }
});

defineExpose({
  dialog,
  source,
  regionTag,
  symbols,
  rows,
  refresh,
  buildCsv,
  error,
  canSummarize,
});
</script>

<style lang="scss" scoped>
.composition {
  max-width: 320px;
  white-space: normal;
}
</style>
