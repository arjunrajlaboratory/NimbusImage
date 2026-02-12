<template>
  <v-expansion-panel>
    <v-expansion-panel-header> Actions </v-expansion-panel-header>
    <v-expansion-panel-content>
      <v-container>
        <v-row>
          <v-col class="pa-1">
            <v-btn :disabled="!undoEntry || isDoing" @click.native="undo" block>
              <template v-if="undoEntry">
                Undo {{ undoEntry.actionName }}
              </template>
              <template v-else> No Undo Available </template>
            </v-btn>
          </v-col>
          <v-col class="pa-1">
            <v-btn :disabled="!redoEntry || isDoing" @click.native="redo" block>
              <template v-if="redoEntry">
                Redo {{ redoEntry.actionName }}
              </template>
              <template v-else> No Redo Available </template>
            </v-btn>
          </v-col>
        </v-row>
        <v-row>
          <v-col>
            <v-divider />
          </v-col>
        </v-row>
        <v-row>
          <v-col class="pa-1">
            <v-btn
              v-if="selectionFilterEnabled"
              @click.native="clearSelection"
              block
            >
              Clear selection filter
            </v-btn>
            <v-btn v-else @click.native="filterBySelection" block>
              Use selection as filter
            </v-btn>
          </v-col>
          <v-col class="pa-1">
            <annotation-csv-dialog
              block
              :annotations="filteredAnnotations"
              :propertyPaths="propertyPaths"
            ></annotation-csv-dialog>
          </v-col>
        </v-row>
        <v-row>
          <v-col class="pa-1">
            <annotation-import block />
          </v-col>
          <v-col class="pa-1">
            <annotation-export block />
          </v-col>
        </v-row>
        <v-row>
          <v-col class="pa-1">
            <index-conversion-dialog block />
          </v-col>
          <v-col class="pa-1">
            <delete-connections block />
          </v-col>
        </v-row>
      </v-container>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

import AnnotationCsvDialog from "@/components/AnnotationBrowser/AnnotationCSVDialog.vue";
import AnnotationExport from "@/components/AnnotationBrowser/AnnotationExport.vue";
import AnnotationImport from "@/components/AnnotationBrowser/AnnotationImport.vue";
import DeleteConnections from "@/components/AnnotationBrowser/DeleteConnections.vue";
import IndexConversionDialog from "@/components/AnnotationBrowser/IndexConversionDialog.vue";

const isDoing = ref(false);

const propertyPaths = computed(() => propertyStore.computedPropertyPaths);

const history = computed(() => store.history);

const undoEntry = computed(() =>
  history.value.find((entry) => !entry.isUndone),
);

const redoEntry = computed(() => {
  const h = history.value;
  for (let i = h.length; i-- > 0; ) {
    if (h[i].isUndone) {
      return h[i];
    }
  }
  return undefined;
});

const filteredAnnotations = computed(() => filterStore.filteredAnnotations);
const selectionFilterEnabled = computed(
  () => filterStore.selectionFilter.enabled,
);

async function undoOrRedo(undo: boolean) {
  try {
    isDoing.value = true;
    await annotationStore.undoOrRedo(undo);
  } finally {
    isDoing.value = false;
  }
}

async function undo() {
  await undoOrRedo(true);
}

async function redo() {
  await undoOrRedo(false);
}

function clearSelection() {
  filterStore.clearSelection();
}

function filterBySelection() {
  filterStore.addSelectionAsFilter();
}

defineExpose({
  undoEntry,
  redoEntry,
  undo,
  redo,
  clearSelection,
  filterBySelection,
  isDoing,
  filteredAnnotations,
  propertyPaths,
});
</script>
