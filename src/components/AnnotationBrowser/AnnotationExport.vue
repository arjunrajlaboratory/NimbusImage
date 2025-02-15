<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        v-description="{
          section: 'Object list actions',
          title: 'Export to JSON',
          description: 'Export annotations and connections to a JSON file',
        }"
      >
        <v-icon>mdi-export</v-icon>
        Export to JSON
      </v-btn>
    </template>
    <v-card class="pa-2" :disabled="!canExport">
      <v-card-title> Export </v-card-title>
      <v-card-text class="pt-5 pb-0">
        <v-checkbox v-model="exportAnnotations" label="Export annotations" />
        <v-checkbox
          v-model="exportConnections"
          :disabled="!exportAnnotations"
          label="Export annotation connections"
        />
        <v-checkbox v-model="exportProperties" label="Export properties" />
        <v-checkbox
          v-model="exportValues"
          :disabled="!exportProperties || !exportAnnotations"
          label="Export property values"
        />
        <v-textarea
          v-model="filename"
          class="my-2"
          label="File name"
          rows="1"
          no-resize
          hide-details
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="submit" color="primary"> Export selection </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import propertyStore from "@/store/properties";

import {
  IAnnotation,
  IAnnotationConnection,
  IAnnotationProperty,
  IAnnotationPropertyValues,
  ISerializedData,
} from "@/store/model";
import { downloadToClient } from "@/utils/download";

@Component({})
export default class AnnotationImport extends Vue {
  readonly store = store;
  readonly propertyStore = propertyStore;

  dialog = false;

  exportAnnotations = true;
  exportConnections = true;
  exportProperties = true;
  exportValues = true;

  filename: string = "";

  get dataset() {
    return this.store.dataset;
  }

  get canExport() {
    return !!this.store.dataset;
  }

  mounted() {
    this.resetFilename();
  }

  @Watch("dataset")
  resetFilename() {
    this.filename = (this.dataset?.name ?? "unknown") + ".json";
  }

  /**
   * Serializes an array into JSON chunks to prevent memory issues
   */
  serializeArrayChunks(arr: any[], chunkSize = 10000): string[] {
    const chunks: string[] = [];
    chunks.push("[");
    const total = arr.length;
    let firstChunk = true;

    for (let i = 0; i < total; i += chunkSize) {
      const chunk = arr.slice(i, i + chunkSize);
      let chunkStr = JSON.stringify(chunk);
      chunkStr = chunkStr.substring(1, chunkStr.length - 1);

      if (!firstChunk && chunkStr.length > 0) {
        chunks.push(",");
      }
      chunks.push(chunkStr);
      firstChunk = false;
    }

    chunks.push("]");
    return chunks;
  }

  async submit() {
    let annotations: IAnnotation[] = [];
    if (this.exportAnnotations) {
      annotations = await this.store.annotationsAPI.getAnnotationsForDatasetId(
        this.dataset!.id,
      );
    }

    let annotationConnections: IAnnotationConnection[] = [];
    if (this.exportConnections && this.exportAnnotations) {
      annotationConnections =
        await this.store.annotationsAPI.getConnectionsForDatasetId(
          this.dataset!.id,
        );
    }

    let annotationProperties: IAnnotationProperty[] = [];
    if (this.exportProperties) {
      await this.propertyStore.fetchProperties();
      annotationProperties = this.propertyStore.properties;
    }

    let annotationPropertyValues: IAnnotationPropertyValues = {};
    if (this.exportValues) {
      annotationPropertyValues =
        await this.store.propertiesAPI.getPropertyValues(this.dataset!.id);
    }

    const parts: string[] = [];
    parts.push("{");
    parts.push('"annotations":');
    parts.push(...this.serializeArrayChunks(annotations));
    parts.push(',"annotationConnections":');
    parts.push(...this.serializeArrayChunks(annotationConnections));
    parts.push(',"annotationProperties":');
    parts.push(...this.serializeArrayChunks(annotationProperties));
    parts.push(',"annotationPropertyValues":');
    parts.push(JSON.stringify(annotationPropertyValues));
    parts.push("}");

    const blob = new Blob(parts, { type: "application/json" });
    const url = URL.createObjectURL(blob);

    try {
      downloadToClient({
        href: url,
        download: this.filename || "upennExport.json",
      });
      this.dialog = false;
    } finally {
      // Clean up the created URL to prevent memory leaks
      URL.revokeObjectURL(url);
    }
  }
}
</script>
