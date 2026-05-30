<template>
  <v-menu location="bottom end" offset="6">
    <template v-slot:activator="{ props: menuProps }">
      <v-tooltip text="Import / export data">
        <template v-slot:activator="{ props: tooltipProps }">
          <v-btn
            v-bind="{ ...menuProps, ...tooltipProps }"
            data-tour="data-io-button"
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
import { computed } from "vue";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

import AnnotationImport from "@/components/AnnotationBrowser/AnnotationImport.vue";
import AnnotationExport from "@/components/AnnotationBrowser/AnnotationExport.vue";
import AnnotationCsvDialog from "@/components/AnnotationBrowser/AnnotationCSVDialog.vue";
import IndexConversionDialog from "@/components/AnnotationBrowser/IndexConversionDialog.vue";
import { TOUR_TRIGGERS } from "@/tours/anchors";

const filteredAnnotations = computed(() => filterStore.filteredAnnotations);
const propertyPaths = computed(() => propertyStore.computedPropertyPaths);
</script>

<style scoped>
.data-io-card {
  padding-block: 4px;
}
</style>
