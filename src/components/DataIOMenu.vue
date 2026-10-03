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
            v-for="entry in DATA_DIALOGS"
            :key="entry.id"
            :prepend-icon="entry.icon"
            :title="entry.menuTitle"
            :data-command-id="entry.commandId"
            @click="openDataDialog(entry.id)"
          />
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
    >
      <template #activator />
    </annotation-import>
    <annotation-export
      v-if="mountedDialogs.export"
      v-model:open="openDialogs.export"
    >
      <template #activator />
    </annotation-export>
    <annotation-csv-dialog
      v-if="mountedDialogs.csv"
      v-model:open="openDialogs.csv"
      :annotations="openDialogs.csv ? filteredAnnotations : NO_ANNOTATIONS"
      :propertyPaths="propertyPaths"
    >
      <template #activator />
    </annotation-csv-dialog>
    <index-conversion-dialog
      v-if="mountedDialogs.indexConversions"
      v-model:open="openDialogs.indexConversions"
    >
      <template #activator />
    </index-conversion-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { useCommand } from "@/commands/registry";

import AnnotationImport from "@/components/AnnotationBrowser/AnnotationImport.vue";
import AnnotationExport from "@/components/AnnotationBrowser/AnnotationExport.vue";
import AnnotationCsvDialog from "@/components/AnnotationBrowser/AnnotationCSVDialog.vue";
import IndexConversionDialog from "@/components/AnnotationBrowser/IndexConversionDialog.vue";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";

const filteredAnnotations = computed(() => filterStore.filteredAnnotations);
// Handed to the CSV dialog while it is closed: once opened it stays mounted,
// and reading the filtered list in this render would otherwise re-render the
// menu on every filter change for the rest of the session. (Its export reads
// the ids before its first await, so closing mid-export is safe.)
const NO_ANNOTATIONS: typeof filterStore.filteredAnnotations = [];
const propertyPaths = computed(() => propertyStore.computedPropertyPaths);

type TDataDialog = "import" | "export" | "csv" | "indexConversions";

const DATA_DIALOGS: {
  id: TDataDialog;
  commandId: string;
  menuTitle: string;
  commandTitle: string;
  icon: string;
  keywords: string[];
  requiresLogin?: boolean;
}[] = [
  {
    id: "import",
    commandId: "data.import.json",
    menuTitle: "Import from JSON",
    commandTitle: "Import annotations from JSON…",
    icon: "mdi-import",
    keywords: ["upload", "load", "objects", "connections"],
    requiresLogin: true,
  },
  {
    id: "export",
    commandId: "data.export.json",
    menuTitle: "Export to JSON",
    commandTitle: "Export annotations as JSON…",
    icon: "mdi-export",
    keywords: ["download", "save", "objects", "connections"],
  },
  {
    id: "csv",
    commandId: "data.export.csv",
    menuTitle: "Export CSV",
    commandTitle: "Export annotations as CSV…",
    icon: "mdi-application-export",
    keywords: ["download", "spreadsheet", "table", "tsv", "measurements"],
  },
  {
    id: "indexConversions",
    commandId: "data.export.indexConversions",
    menuTitle: "Download index conversions",
    commandTitle: "Download index conversions…",
    icon: "mdi-table-arrow-down",
    keywords: ["xy", "z", "time", "frame", "coordinates"],
  },
];

const mountedDialogs = reactive<Record<TDataDialog, boolean>>({
  import: false,
  export: false,
  csv: false,
  indexConversions: false,
});
const openDialogs = reactive<Record<TDataDialog, boolean>>({
  import: false,
  export: false,
  csv: false,
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
  openDialogs[id] = true;
}

// DataIOMenu is only mounted in the dataset view, so its commands exist only
// there.
useCommand(
  DATA_DIALOGS.map((entry) => ({
    id: entry.commandId,
    title: entry.commandTitle,
    group: "Actions" as const,
    keywords: entry.keywords,
    icon: entry.icon,
    enabled: entry.requiresLogin ? () => store.isLoggedIn : undefined,
    run: () => openDataDialog(entry.id),
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
