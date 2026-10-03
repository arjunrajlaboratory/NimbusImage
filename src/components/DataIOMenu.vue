<template>
  <!-- One root, so the class App.vue passes still lands on something. -->
  <div class="data-io-menu">
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
          <v-list-item
            v-for="entry in DATA_ENTRIES"
            :key="entry.commandId"
            :prepend-icon="entry.icon"
            :title="entry.menuTitle"
            :subtitle="entry.subtitle?.()"
            :data-command-id="entry.commandId"
            :disabled="!entry.isAvailable()"
            @click="entry.run()"
          >
            <template v-if="entry.isBusy?.()" v-slot:append>
              <v-progress-circular indeterminate size="16" width="2" />
            </template>
          </v-list-item>
        </v-list>
      </v-card>
    </v-menu>

    <!-- Outside the menu, so the command palette can open them with the menu
       closed. Each mounts the first time it is opened and stays mounted, so
       a viewer load still pays for none of them (the CSV dialog would
       otherwise read the filtered annotation list on every render). -->
    <annotation-import
      v-if="mountedDialogs.import"
      v-model:open="openDialogs.import"
    />
    <geo-json-import-dialog
      v-if="mountedDialogs.geoJsonImport"
      v-model:open="openDialogs.geoJsonImport"
    />
    <annotation-export
      v-if="mountedDialogs.export"
      v-model:open="openDialogs.export"
    />
    <annotation-csv-dialog
      v-if="mountedDialogs.csv"
      v-model:open="openDialogs.csv"
      @closed="isCsvShown = false"
      :annotations="isCsvShown ? filteredAnnotations : NO_ANNOTATIONS"
      :propertyPaths="propertyPaths"
    />
    <selection-summary-dialog
      v-if="mountedDialogs.selectionSummary"
      v-model:open="openDialogs.selectionSummary"
    />
    <index-conversion-dialog
      v-if="mountedDialogs.indexConversions"
      v-model:open="openDialogs.indexConversions"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { useCommand } from "@/commands/registry";
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
// Handed to the CSV dialog while it is closed: once opened it stays mounted,
// and reading the filtered list in this render would otherwise re-render the
// menu on every filter change for the rest of the session. (Its export reads
// the ids before its first await, so closing mid-export is safe.)
const NO_ANNOTATIONS: typeof filterStore.filteredAnnotations = [];
// From opening until its leave transition ends, so the closing card keeps its
// counts rather than flashing "(0)".
const isCsvShown = ref(false);
const propertyPaths = computed(() => propertyStore.computedPropertyPaths);

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

type TDataDialog =
  | "import"
  | "geoJsonImport"
  | "export"
  | "csv"
  | "selectionSummary"
  | "indexConversions";

interface IDataEntry {
  commandId: string;
  menuTitle: string;
  commandTitle: string;
  icon: string;
  keywords: string[];
  // Import writes, so it needs a login; the exports work for anonymous viewers
  // of a public dataset. (The backend enforces this either way; this only
  // avoids offering an action that can only fail.)
  requiresLogin?: boolean;
  // The dialog this entry opens; entries without one act directly.
  dialog?: TDataDialog;
  action?: () => void | Promise<void>;
  // Beyond the login rule: whether the entry can act right now.
  isReady?: () => boolean;
  subtitle?: () => string;
  isBusy?: () => boolean;
}

const DATA_ENTRY_DEFINITIONS: IDataEntry[] = [
  {
    commandId: "data.import.json",
    menuTitle: "Import from JSON",
    commandTitle: "Import annotations from JSON…",
    icon: "mdi-import",
    keywords: ["upload", "load", "objects", "connections"],
    requiresLogin: true,
    dialog: "import",
  },
  {
    commandId: "data.import.geojson",
    menuTitle: "Import GeoJSON…",
    commandTitle: "Import regions from GeoJSON…",
    icon: "mdi-vector-polygon",
    keywords: ["upload", "load", "regions", "polygons", "qupath", "10x"],
    requiresLogin: true,
    dialog: "geoJsonImport",
  },
  {
    commandId: "data.export.json",
    menuTitle: "Export to JSON",
    commandTitle: "Export annotations as JSON…",
    icon: "mdi-export",
    keywords: ["download", "save", "objects", "connections"],
    dialog: "export",
  },
  {
    commandId: "data.export.csv",
    menuTitle: "Export CSV",
    commandTitle: "Export annotations as CSV…",
    icon: "mdi-application-export",
    keywords: ["download", "spreadsheet", "table", "tsv", "measurements"],
    dialog: "csv",
  },
  {
    commandId: "data.export.geojson",
    menuTitle: "Export GeoJSON",
    commandTitle: "Export annotations as GeoJSON",
    icon: "mdi-map-marker-path",
    keywords: ["download", "save", "regions", "polygons", "qupath"],
    action: exportGeoJson,
    isReady: () => !!store.dataset && !isExportingGeoJson.value,
    subtitle: () => geoJsonExportScopeLabel.value,
    isBusy: () => isExportingGeoJson.value,
  },
  {
    commandId: "data.selectionSummary",
    menuTitle: "Selection summary",
    commandTitle: "Summarize the selection…",
    icon: "mdi-chart-box-outline",
    keywords: ["statistics", "tags", "composition", "properties", "counts"],
    dialog: "selectionSummary",
  },
  {
    commandId: "data.export.indexConversions",
    menuTitle: "Download index conversions",
    commandTitle: "Download index conversions…",
    icon: "mdi-table-arrow-down",
    keywords: ["xy", "z", "time", "frame", "coordinates"],
    dialog: "indexConversions",
  },
];

const mountedDialogs = reactive<Record<TDataDialog, boolean>>({
  import: false,
  geoJsonImport: false,
  export: false,
  csv: false,
  selectionSummary: false,
  indexConversions: false,
});
const openDialogs = reactive<Record<TDataDialog, boolean>>({
  import: false,
  geoJsonImport: false,
  export: false,
  csv: false,
  selectionSummary: false,
  indexConversions: false,
});

// Mount closed, THEN open: the dialogs do their on-open work (CSV preview,
// dimension labels, collection datasets) in watchers on their open state,
// which a component created already open never fires.
async function openDataDialog(id: TDataDialog) {
  if (!mountedDialogs[id]) {
    mountedDialogs[id] = true;
    await nextTick();
  }
  if (id === "csv") {
    isCsvShown.value = true;
  }
  openDialogs[id] = true;
}

// One rule for the menu item and its palette command.
function isEntryAvailable(entry: IDataEntry) {
  return (
    (!entry.requiresLogin || store.isLoggedIn) && (entry.isReady?.() ?? true)
  );
}

const DATA_ENTRIES = DATA_ENTRY_DEFINITIONS.map((entry) => ({
  ...entry,
  isAvailable: () => isEntryAvailable(entry),
  run: (): void | Promise<void> =>
    entry.dialog ? openDataDialog(entry.dialog) : entry.action?.(),
}));

// DataIOMenu is only mounted in the dataset view, so its commands exist only
// there.
useCommand(
  DATA_ENTRIES.map((entry) => ({
    id: entry.commandId,
    title: entry.commandTitle,
    group: "Actions" as const,
    keywords: entry.keywords,
    icon: entry.icon,
    enabled: entry.isAvailable,
    run: entry.run,
  })),
);
</script>

<style scoped>
.data-io-menu {
  display: inline-flex;
  align-items: center;
}

.data-io-card {
  padding-block: 4px;
}
</style>
