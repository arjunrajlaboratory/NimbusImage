<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        v-description="{
          section: 'Object list actions',
          title: 'Export to JSON',
          description:
            'Export annotations, connections, properties, and property values to a JSON file',
        }"
      >
        <v-icon>mdi-export</v-icon>
        Export to JSON
      </v-btn>
    </template>
    <v-card class="pa-2" :disabled="!canExport">
      <v-card-title>Export</v-card-title>
      <v-card-subtitle>
        Export your annotations and related data as a JSON file
      </v-card-subtitle>

      <v-card-text class="pt-2 pb-0">
        <v-alert type="info" text class="mb-4">
          An exported JSON file contains a complete specification of your
          annotation data. That include coordinates of points and polygons,
          color, property values, connections between annotations, and more. The
          exported JSON file can be used for backup purposes or to transfer
          annotations between datasets. You can also parse the JSON file for
          sophisticated analyses using other tools.
        </v-alert>

        <v-checkbox v-model="exportAnnotations" label="Export annotations" />
        <v-checkbox
          v-model="exportConnections"
          :disabled="!exportAnnotations"
          label="Export annotation connections"
        />
        <v-checkbox v-model="exportProperties" label="Export properties" />
        <v-radio-group
          v-model="propertyScope"
          :disabled="!exportProperties"
          class="ml-8 mt-0"
          hide-details
        >
          <v-radio label="All configurations" value="all" />
          <v-radio label="Current configuration only" value="current" />
        </v-radio-group>
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
        <v-btn @click="submit" color="primary"> Export selected items </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";

@Component({})
export default class AnnotationExport extends Vue {
  readonly store = store;

  dialog = false;

  exportAnnotations = true;
  exportConnections = true;
  exportProperties = true;
  exportValues = true;
  propertyScope: "all" | "current" = "all";

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

  submit() {
    this.store.exportAPI.exportJson({
      datasetId: this.dataset!.id,
      configurationId:
        this.propertyScope === "current"
          ? this.store.configuration?.id
          : undefined,
      includeAnnotations: this.exportAnnotations,
      includeConnections: this.exportConnections,
      includeProperties: this.exportProperties,
      includePropertyValues: this.exportValues,
      filename: this.filename,
    });
    this.dialog = false;
  }
}
</script>
