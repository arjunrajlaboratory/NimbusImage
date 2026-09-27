<template>
  <v-menu location="bottom end" offset="6">
    <template v-slot:activator="{ props: menuProps }">
      <v-tooltip text="Import / export data">
        <template v-slot:activator="{ props: tooltipProps }">
          <v-btn
            v-bind="{ ...menuProps, ...tooltipProps }"
            :data-tour="TOUR_ANCHORS.dataIoButton"
            v-tour-trigger="TOUR_TRIGGERS.dataIoButton"
            variant="text"
            icon
            size="small"
            aria-label="Import / export data"
          >
            <v-icon>mdi-swap-vertical-bold</v-icon>
          </v-btn>
        </template>
      </v-tooltip>
    </template>

    <v-card min-width="260" class="data-io-card">
      <v-list density="compact" nav>
        <annotation-import>
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              prepend-icon="mdi-import"
              title="Import from JSON"
            />
          </template>
        </annotation-import>

        <geo-json-import-dialog>
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              :disabled="!isLoggedIn"
              prepend-icon="mdi-vector-polygon"
              title="Import GeoJSON…"
            />
          </template>
        </geo-json-import-dialog>

        <annotation-export>
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              prepend-icon="mdi-export"
              title="Export to JSON"
            />
          </template>
        </annotation-export>

        <annotation-csv-dialog
          :annotations="filteredAnnotations"
          :propertyPaths="propertyPaths"
        >
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              prepend-icon="mdi-application-export"
              title="Export CSV"
            />
          </template>
        </annotation-csv-dialog>

        <v-list-item
          prepend-icon="mdi-map-marker-path"
          title="Export GeoJSON"
          :subtitle="geoJsonExportScopeLabel"
          :disabled="!dataset || isExportingGeoJson"
          @click="exportGeoJson"
        >
          <template v-if="isExportingGeoJson" v-slot:append>
            <v-progress-circular indeterminate size="16" width="2" />
          </template>
        </v-list-item>

        <selection-summary-dialog>
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              prepend-icon="mdi-chart-box-outline"
              title="Selection summary"
            />
          </template>
        </selection-summary-dialog>

        <index-conversion-dialog>
          <template v-slot:activator="{ props }">
            <v-list-item
              v-bind="props"
              prepend-icon="mdi-table-arrow-down"
              title="Download index conversions"
            />
          </template>
        </index-conversion-dialog>
      </v-list>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { geoJsonExportAnnotationIds } from "@/utils/geojson";
import { logError } from "@/utils/log";

import AnnotationImport from "@/components/AnnotationBrowser/AnnotationImport.vue";
import AnnotationExport from "@/components/AnnotationBrowser/AnnotationExport.vue";
import AnnotationCsvDialog from "@/components/AnnotationBrowser/AnnotationCSVDialog.vue";
import IndexConversionDialog from "@/components/AnnotationBrowser/IndexConversionDialog.vue";
import SelectionSummaryDialog from "@/components/AnnotationBrowser/SelectionSummaryDialog.vue";
import GeoJsonImportDialog from "@/components/AnnotationBrowser/GeoJsonImportDialog.vue";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";

const filteredAnnotations = computed(() => filterStore.filteredAnnotations);
const propertyPaths = computed(() => propertyStore.computedPropertyPaths);

const dataset = computed(() => store.dataset);
const isLoggedIn = computed(() => store.isLoggedIn);
const isExportingGeoJson = ref(false);

// Which annotations Export GeoJSON sends, decided like Export CSV's scopes:
// the selection, else the active filter, else everything (undefined). Ids
// only, never annotation objects, so this stays cheap in stub mode.
function geoJsonExportIds(): string[] | undefined {
  return geoJsonExportAnnotationIds({
    selectedIds: annotationStore.resolvedSelectedAnnotationIds,
    filteredAnnotations: filterStore.filteredAnnotations,
    annotationCount: annotationStore.annotationCount,
  });
}

const geoJsonExportScopeLabel = computed(() => {
  // resolvedSelectedAnnotationIds (stale ids dropped), the same list the
  // export sends, so the label cannot claim a selection the export ignores.
  const selected = annotationStore.resolvedSelectedAnnotationIds.length;
  if (selected > 0) {
    return `Selected annotations (${selected})`;
  }
  const filtered = filterStore.filteredAnnotations.length;
  return filtered < annotationStore.annotationCount
    ? `Filtered annotations (${filtered})`
    : `All annotations (${annotationStore.annotationCount})`;
});

async function exportGeoJson() {
  if (!store.dataset || isExportingGeoJson.value) {
    return;
  }
  isExportingGeoJson.value = true;
  try {
    await store.exportAPI.exportGeoJson({
      datasetId: store.dataset.id,
      annotationIds: geoJsonExportIds(),
      filename: `${store.dataset.name}-annotations.geojson`,
    });
  } catch (error) {
    logError("GeoJSON export failed:", error);
  } finally {
    isExportingGeoJson.value = false;
  }
}
</script>

<style scoped>
.data-io-card {
  padding-block: 4px;
}
</style>
