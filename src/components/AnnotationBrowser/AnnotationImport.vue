<template>
  <v-dialog v-model="importDialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
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

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
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

@Component({})
export default class AnnotationImport extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;
  readonly propertyStore = propertyStore;

  importDialog = false;

  jsonFile: File | null = null;
  isLoadingFile = false;
  isJsonLoaded = false;
  isImporting = false;

  annotations: IAnnotation[] = [];
  connections: IAnnotationConnection[] = [];
  properties: IAnnotationProperty[] = [];
  values: IAnnotationPropertyValues = {};

  importAnnotations = true;
  importConnections = true;
  importProperties = true;
  importValues = true;

  overwriteAnnotations = false;
  overwriteAnnotationsDialog = false;

  overwriteProperties = false;
  overwritePropertiesDialog = false;

  get canImport() {
    return !!store.dataset;
  }

  @Watch("jsonFile")
  getJsonContent() {
    this.isJsonLoaded = false;
    this.annotations = [];
    this.connections = [];
    this.properties = [];
    this.values = {};
    if (!this.jsonFile) {
      return;
    }
    this.isLoadingFile = true;
    this.jsonFile
      .text()
      .then((jsonText) => {
        ({
          annotations: this.annotations,
          annotationConnections: this.connections,
          annotationProperties: this.properties,
          annotationPropertyValues: this.values,
        } = JSON.parse(jsonText) as ISerializedData);
        this.isJsonLoaded = true;
      })
      .catch(() => {
        this.jsonFile = null;
      })
      .finally(() => (this.isLoadingFile = false));
  }

  reset() {
    this.importDialog = false;
    this.overwriteAnnotationsDialog = false;

    this.jsonFile = null;
    this.isLoadingFile = false;
    this.isJsonLoaded = false;
    this.isImporting = false;

    this.annotations = [];
    this.connections = [];
    this.properties = [];
    this.values = {};

    this.importAnnotations = true;
    this.importConnections = true;
    this.importProperties = true;
    this.importValues = true;
    this.overwriteAnnotations = false;
  }

  async submit() {
    if (!this.isJsonLoaded || !this.store.dataset) {
      return;
    }

    // Prepare the serialized data
    const serializedData: ISerializedData = {
      annotations: this.annotations,
      annotationConnections: this.connections,
      annotationProperties: this.properties,
      annotationPropertyValues: this.values,
    };

    // Prepare the import options
    const options: ImportOptions = {
      importAnnotations: this.importAnnotations,
      importConnections: this.importConnections,
      importProperties: this.importProperties,
      importValues: this.importValues,
      overwriteAnnotations: this.overwriteAnnotations,
      overwriteProperties: this.overwriteProperties,
    };

    this.isImporting = true;

    try {
      // Use the extracted import logic
      await importAnnotationsFromData(serializedData, options);
      this.reset();
    } catch (error) {
      logError("Error importing annotations:", error);
    } finally {
      this.isImporting = false;
    }
  }
}
</script>
