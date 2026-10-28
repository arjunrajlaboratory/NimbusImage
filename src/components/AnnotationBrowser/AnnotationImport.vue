<template>
  <v-dialog v-model="importDialog">
    <v-card class="pa-2" :disabled="!canImport">
      <v-card-title> Import </v-card-title>
      <v-card-text class="pt-5 pb-0">
        <v-file-input
          accept="application/JSON"
          prepend-icon=""
          prepend-inner-icon="mdi-file-upload-outline"
          variant="outlined"
          label="Click to upload a JSON file"
          show-size
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
              :label="`Overwrite ${annotationStore.annotationsForIteration.length} annotations (delete current annotations)`"
              @update:model-value="
                overwriteAnnotationsDialog = overwriteAnnotations
              "
            />
            <v-checkbox
              v-model="overwriteProperties"
              :label="`Overwrite ${propertyStore.properties.length} properties (delete current properties)`"
              @update:model-value="
                overwritePropertiesDialog = overwriteProperties
              "
            />
            <v-alert
              v-if="overwriteProperties && overwriteBlockedBy"
              type="error"
              variant="tonal"
              density="compact"
              class="overwrite-blocked"
            >
              The pipeline "{{ overwriteBlockedBy.pipeline.name }}" is running
              and computes the property "{{ overwriteBlockedBy.propertyName }}".
              Wait for it to finish, or cancel it, before overwriting
              properties: removing the property now would make the rest of the
              run compute into a new property instead.
            </v-alert>
            <v-alert
              v-else-if="overwriteProperties && overwrittenPropertyLinks.length"
              type="warning"
              variant="tonal"
              density="compact"
              class="overwrite-linked-steps"
            >
              These pipeline steps use properties this would remove:
              <ul class="linked-steps">
                <li
                  v-for="link in overwrittenPropertyLinks"
                  :key="`${link.pipelineId}:${link.stepId}:${link.propertyId}`"
                >
                  {{ link.pipelineName }}: {{ link.stepName }} ("{{
                    link.propertyName
                  }}")
                  <span v-if="link.use === 'created'">(created it)</span>
                  <span v-if="!link.enabled">(disabled)</span>
                </li>
              </ul>
              If you overwrite them, each creates a new pipeline-owned property
              on its next run instead.
            </v-alert>
            <v-dialog v-model="overwriteAnnotationsDialog" persistent>
              <v-card class="pa-2">
                <v-card-title> Overwrite annotations? </v-card-title>
                <v-card-text>
                  This will remove
                  {{ annotationStore.annotationsForIteration.length }}
                  annotations forever
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn
                    variant="text"
                    size="small"
                    @click="
                      overwriteAnnotations = false;
                      overwriteAnnotationsDialog = false;
                    "
                  >
                    Cancel
                  </v-btn>
                  <v-btn
                    variant="flat"
                    color="error"
                    size="small"
                    @click="
                      overwriteAnnotations = true;
                      overwriteAnnotationsDialog = false;
                    "
                  >
                    Overwrite
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>
            <v-dialog v-model="overwritePropertiesDialog" persistent>
              <v-card class="pa-2">
                <v-card-title> Overwrite properties? </v-card-title>
                <v-card-text>
                  This will remove
                  {{ propertyStore.properties.length }} properties forever.
                  <p v-if="overwriteBlockedBy" class="mt-2">
                    The pipeline "{{ overwriteBlockedBy.pipeline.name }}" is
                    running and computes one of them, so the import stays
                    disabled until the run ends.
                  </p>
                  <p v-else-if="overwrittenStepCount" class="mt-2">
                    {{ overwrittenStepCount }} pipeline
                    {{ overwrittenStepCount === 1 ? "step uses" : "steps use" }}
                    them and will create new properties on their next run; the
                    import dialog lists them.
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn
                    variant="text"
                    size="small"
                    @click="
                      overwriteProperties = false;
                      overwritePropertiesDialog = false;
                    "
                  >
                    Cancel
                  </v-btn>
                  <v-btn
                    variant="flat"
                    color="error"
                    size="small"
                    @click="
                      overwriteProperties = true;
                      overwritePropertiesDialog = false;
                    "
                  >
                    Overwrite
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
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :disabled="isOverwriteBlocked"
          @click="submit"
        >
          Import selection
        </v-btn>
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
  pipelineStepsUsingOverwrittenProperties,
  runningPipelineComputingOverwrittenProperty,
} from "@/utils/annotationImport";
import {
  IAnnotationPropertyValues,
  ISerializedAnnotation,
  ISerializedConnection,
  ISerializedProperty,
  ISerializedData,
} from "@/store/model";
import { logError } from "@/utils/log";

// Opened by its owner through `v-model:open` (DataIOMenu, from its menu or the
// command palette); the dialog renders no activator of its own.
const importDialog = defineModel<boolean>("open", { default: false });

const jsonFile = ref<File | null>(null);
const isLoadingFile = ref(false);
const isJsonLoaded = ref(false);
const isImporting = ref(false);

const annotations = ref<ISerializedAnnotation[]>([]);
const connections = ref<ISerializedConnection[]>([]);
const properties = ref<ISerializedProperty[]>([]);
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

// Pipeline steps that use a property "Overwrite properties" would remove:
// each creates a new pipeline-owned property on its next run.
const overwrittenPropertyLinks = computed(() =>
  pipelineStepsUsingOverwrittenProperties(),
);

// Distinct steps: one step can use two of the properties (linked to one,
// created the other).
const overwrittenStepCount = computed(
  () =>
    new Set(
      overwrittenPropertyLinks.value.map(
        ({ pipelineId, stepId }) => `${pipelineId}:${stepId}`,
      ),
    ).size,
);

// A running pipeline that computes one of those properties: overwriting is
// refused until the run ends (importAnnotationsFromData refuses it too).
const overwriteBlockedBy = computed(() =>
  runningPipelineComputingOverwrittenProperty(),
);
const isOverwriteBlocked = computed(
  () => overwriteProperties.value && !!overwriteBlockedBy.value,
);

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
  overwritePropertiesDialog.value = false;

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
  overwriteProperties.value = false;
}

async function submit() {
  if (!isJsonLoaded.value || !store.dataset || isOverwriteBlocked.value) {
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
  canImport,
  importAnnotations,
  importConnections,
  importProperties,
  importValues,
  overwriteAnnotations,
  overwriteProperties,
  overwrittenPropertyLinks,
  overwrittenStepCount,
  overwriteBlockedBy,
  isOverwriteBlocked,
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

<style scoped>
.linked-steps {
  margin: 4px 0 4px 20px;
}
</style>
