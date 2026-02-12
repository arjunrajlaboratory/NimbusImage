<template>
  <v-dialog v-model="importDialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        :disabled="!isLoggedIn"
        v-description="{
          section: 'Object list actions',
          title: 'Import from JSON',
          description:
            'Import a set of annotations and connections from a JSON file',
        }"
      >
        <v-icon>mdi-import</v-icon>
        Import from JSON
      </v-btn>
    </template>
    <v-card class="pa-2" :disabled="!canImport">
      <v-card-title> Import </v-card-title>
      <v-card-text class="pt-5 pb-0">
        <v-file-input
          accept="application/JSON"
          prepend-icon="mdi-code-json"
          label="JSON file"
          v-model="jsonFile"
        />
        <v-progress-circular v-if="isLoadingFile" indeterminate />
        <div v-if="isJsonLoaded">
          <div class="pa-2">
            <v-checkbox
              v-model="importAnnotations"
              :label="`Import ${annotations.length} annotations`"
            />
            <v-checkbox
              v-model="importConnections"
              :disabled="!importAnnotations"
              :label="`Import ${connections.length} annotation connections`"
            />
            <v-checkbox
              v-model="importProperties"
              :label="`Import ${properties.length} properties`"
            />
            <v-checkbox
              v-model="importValues"
              :disabled="!importProperties || !importAnnotations"
              :label="`Import property values of ${
                Object.keys(values).length
              } annotations`"
            />
          </div>
          <div class="pa-2">
            <v-checkbox
              v-model="overwriteAnnotations"
              :label="`Overwrite ${annotationStore.annotations.length} annotations (delete current annotations)`"
              @change="overwriteAnnotationsDialog = overwriteAnnotations"
            />
            <v-checkbox
              v-model="overwriteProperties"
              :label="`Overwrite ${propertyStore.properties.length} properties (delete current properties)`"
              @change="overwritePropertiesDialog = overwriteProperties"
            />
            <v-dialog v-model="overwriteAnnotationsDialog" persistent>
              <v-card class="pa-2">
                <v-card-title> Overwrite annotations? </v-card-title>
                <v-card-text>
                  This will remove
                  {{ annotationStore.annotations.length }} annotations forever
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn
                    @click="
                      overwriteAnnotations = true;
                      overwriteAnnotationsDialog = false;
                    "
                    color="warning"
                  >
                    Overwrite
                  </v-btn>
                  <v-btn
                    @click="
                      overwriteAnnotations = false;
                      overwriteAnnotationsDialog = false;
                    "
                    color="primary"
                  >
                    Cancel
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>
            <v-dialog v-model="overwritePropertiesDialog" persistent>
              <v-card class="pa-2">
                <v-card-title> Overwrite properties? </v-card-title>
                <v-card-text>
                  This will remove
                  {{ propertyStore.properties.length }} properties forever
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn
                    @click="
                      overwriteProperties = true;
                      overwritePropertiesDialog = false;
                    "
                    color="warning"
                  >
                    Overwrite
                  </v-btn>
                  <v-btn
                    @click="
                      overwriteProperties = false;
                      overwritePropertiesDialog = false;
                    "
                    color="primary"
                  >
                    Cancel
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>
          </div>
        </div>
      </v-card-text>
      <v-card-actions v-if="isJsonLoaded">
        <v-spacer />
        <v-progress-circular v-if="isImporting" indeterminate />
        <v-btn @click="submit" color="primary"> Import selection </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import {
  importAnnotationsFromData,
  ImportOptions,
} from "@/utils/annotationImport";
import {
  IAnnotation,
  IAnnotationConnection,
  IAnnotationProperty,
  IAnnotationPropertyValues,
  ISerializedData,
} from "@/store/model";
import { logError } from "@/utils/log";

const importDialog = ref(false);

const jsonFile = ref<File | null>(null);
const isLoadingFile = ref(false);
const isJsonLoaded = ref(false);
const isImporting = ref(false);

const annotations = ref<IAnnotation[]>([]);
const connections = ref<IAnnotationConnection[]>([]);
const properties = ref<IAnnotationProperty[]>([]);
const values = ref<IAnnotationPropertyValues>({});

const importAnnotations = ref(true);
const importConnections = ref(true);
const importProperties = ref(true);
const importValues = ref(true);

const overwriteAnnotations = ref(false);
const overwriteAnnotationsDialog = ref(false);

const overwriteProperties = ref(false);
const overwritePropertiesDialog = ref(false);

const canImport = computed(() => !!store.dataset);
const isLoggedIn = computed(() => store.isLoggedIn);

watch(jsonFile, () => {
  isJsonLoaded.value = false;
  annotations.value = [];
  connections.value = [];
  properties.value = [];
  values.value = {};
  if (!jsonFile.value) {
    return;
  }
  isLoadingFile.value = true;
  jsonFile.value
    .text()
    .then((jsonText) => {
      const parsed = JSON.parse(jsonText) as ISerializedData;
      annotations.value = parsed.annotations;
      connections.value = parsed.annotationConnections;
      properties.value = parsed.annotationProperties;
      values.value = parsed.annotationPropertyValues;
      isJsonLoaded.value = true;
    })
    .catch(() => {
      jsonFile.value = null;
    })
    .finally(() => (isLoadingFile.value = false));
});

function reset() {
  importDialog.value = false;
  overwriteAnnotationsDialog.value = false;

  jsonFile.value = null;
  isLoadingFile.value = false;
  isJsonLoaded.value = false;
  isImporting.value = false;

  annotations.value = [];
  connections.value = [];
  properties.value = [];
  values.value = {};

  importAnnotations.value = true;
  importConnections.value = true;
  importProperties.value = true;
  importValues.value = true;
  overwriteAnnotations.value = false;
}

async function submit() {
  if (!isJsonLoaded.value || !store.dataset) {
    return;
  }

  const serializedData: ISerializedData = {
    annotations: annotations.value,
    annotationConnections: connections.value,
    annotationProperties: properties.value,
    annotationPropertyValues: values.value,
  };

  const options: ImportOptions = {
    importAnnotations: importAnnotations.value,
    importConnections: importConnections.value,
    importProperties: importProperties.value,
    importValues: importValues.value,
    overwriteAnnotations: overwriteAnnotations.value,
    overwriteProperties: overwriteProperties.value,
  };

  isImporting.value = true;

  try {
    await importAnnotationsFromData(serializedData, options);
    reset();
  } catch (error) {
    logError("Error importing annotations:", error);
  } finally {
    isImporting.value = false;
  }
}

defineExpose({
  isLoggedIn,
  canImport,
  importAnnotations,
  importConnections,
  importProperties,
  importValues,
  overwriteAnnotations,
  overwriteProperties,
  importDialog,
  isJsonLoaded,
  reset,
  annotations,
  connections,
  properties,
  values,
  submit,
});
</script>
