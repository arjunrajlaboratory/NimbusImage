<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        v-description="{
          section: 'Object list actions',
          title: 'Export CSV',
          description:
            'Export the current list of annotations and associated properties to a CSV file',
        }"
      >
        <v-icon>mdi-application-export</v-icon>
        EXPORT CSV
      </v-btn>
    </template>
    <v-card>
      <v-card-title> Current Annotation List as CSV </v-card-title>
      <v-card-subtitle>
        Export your measurements to a CSV spreadsheet
      </v-card-subtitle>

      <v-card-text>
        <v-alert type="info" text class="mb-4">
          Choose how you want to export your values and how to handle undefined
          values. The resulting CSV file can be opened in spreadsheet
          applications like Excel or Google Sheets.
        </v-alert>

        <v-subheader>Property Export Options</v-subheader>
        <v-radio-group v-model="propertyExportMode" class="mb-4">
          <v-radio label="Export all properties" value="all"></v-radio>
          <v-radio label="Export listed properties" value="listed"></v-radio>
          <v-radio
            label="Select properties to export"
            value="selected"
          ></v-radio>
        </v-radio-group>

        <v-subheader>Undefined Value Handling</v-subheader>
        <v-radio-group v-model="undefinedHandling" class="mb-4">
          <v-radio label="Empty string" value="empty"></v-radio>
          <v-radio label="NA" value="na"></v-radio>
          <v-radio label="NaN" value="nan"></v-radio>
        </v-radio-group>

        <template v-if="propertyExportMode === 'selected'">
          <v-text-field
            v-model="propertyFilter"
            label="Filter properties"
            clearable
            class="mb-4"
          ></v-text-field>

          <v-data-table
            v-model="selectedPropertyPaths"
            :headers="[{ text: 'Property Name', value: 'name' }]"
            :items="filteredPropertyItems"
            item-key="pathString"
            show-select
            class="mb-4"
            height="300px"
            fixed-header
            :items-per-page="-1"
          >
            <template #[`item.name`]="{ item }">
              {{ item.name }}
            </template>
          </v-data-table>
        </template>

        <template v-if="isTooLargeForPreview">
          <v-alert type="info" text class="mb-4">
            Preview is not available for more than
            {{ PREVIEW_ANNOTATION_LIMIT }} annotations ({{ annotations.length }}
            annotations selected). Download will export all annotations using
            the server.
          </v-alert>
          <v-textarea
            v-model="filename"
            class="my-2"
            label="File name"
            rows="1"
            no-resize
            hide-details
          />
        </template>
        <template v-else-if="text && text.length">
          <v-textarea ref="fieldToCopy" v-model="displayText" readonly>
            {{ displayText }}
            <template v-slot:append>
              <v-btn
                icon
                title="Copy to clipboard"
                @click="copyCSVText"
                :disabled="!canUseClipboard"
                ><v-icon>{{ "mdi-content-copy" }}</v-icon></v-btn
              >
            </template>
          </v-textarea>
          <v-textarea
            v-model="filename"
            class="my-2"
            label="File name"
            rows="1"
            no-resize
            hide-details
          />
        </template>
        <template v-else>
          <div class="d-flex flex-column align-center">
            <p>Generating CSV...</p>
            <v-progress-circular
              :value="processingProgress * 100"
              :indeterminate="processingProgress === 0"
              class="mb-2"
            />
            <span v-if="processingProgress > 0">
              {{ Math.round(processingProgress * 100) }}%
            </span>
          </div>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn @click="dialog = false" text>Close</v-btn>
        <v-btn @click="download" :disabled="!store.dataset" color="success">
          <v-icon> mdi-save </v-icon>
          Download
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

import Papa from "papaparse";

import { IAnnotation } from "@/store/model";
import { getValueFromObjectAndPath } from "@/utils/paths";

interface PropertyPathItem {
  name: string;
  path: string[];
  pathString: string;
}

@Component({
  components: {},
})
export default class AnnotationCsvDialog extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;
  readonly propertyStore = propertyStore;
  readonly filterStore = filterStore;

  readonly PREVIEW_ANNOTATION_LIMIT = 1000;

  filename: string = "";

  get isTooLargeForPreview() {
    return this.annotations.length > this.PREVIEW_ANNOTATION_LIMIT;
  }

  get canUseClipboard() {
    return !!navigator || !!(navigator as Navigator)?.clipboard;
  }

  get dataset() {
    return this.store.dataset;
  }

  mounted() {
    this.resetFilename();
  }

  @Watch("dataset")
  resetFilename() {
    this.filename = (this.dataset?.name ?? "unknown") + ".csv";
  }

  copyCSVText() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(this.text);
    } else {
      const fieldToCopy = (this.$refs.fieldToCopy as Vue)?.$el?.querySelector(
        "input",
      );
      if (fieldToCopy) {
        fieldToCopy.select();
        document.execCommand("copy");
      }
    }
  }

  dialog: boolean = false;
  text = "";
  displayText = "";
  readonly DISPLAY_CHAR_LIMIT = 10000;

  @Prop()
  readonly annotations!: IAnnotation[];

  @Prop()
  readonly propertyPaths!: string[][];

  propertyExportMode: "all" | "selected" | "listed" = "all";
  propertyFilter: string = "";
  selectedPropertyPaths: PropertyPathItem[] = [];

  undefinedHandling: "empty" | "na" | "nan" = "empty";

  private static readonly UNDEFINED_VALUE_MAP = {
    na: "NA",
    nan: "NaN",
    empty: "",
  } as const;

  get filteredPropertyItems() {
    return (
      this.propertyFilter
        ? this.propertyPaths
        : this.propertyPaths.filter((path) => {
            const name = this.propertyStore.getFullNameFromPath(path);
            return name
              ?.toLowerCase()
              .includes(this.propertyFilter.toLowerCase());
          })
    ).map((path) => ({
      name: this.propertyStore.getFullNameFromPath(path) || "",
      path: path,
      pathString: path.join("."),
    }));
  }

  processingProgress: number = 0;
  isProcessing: boolean = false;

  async generateCSVStringForAnnotations() {
    this.isProcessing = true;
    this.processingProgress = 0;

    try {
      // Fields
      const fields = [
        "Id",
        "Channel",
        "XY",
        "Z",
        "Time",
        "Tags",
        "Shape",
        "Name",
      ];
      const quotes = [true, false, false, false, false, true, true, true];
      const usedPaths: string[][] = [];

      // Pre-compute included paths to avoid repeated checks
      const includedPaths = this.propertyPaths.filter((path) => {
        const pathName = this.propertyStore.getFullNameFromPath(path);
        return pathName && this.shouldIncludePropertyPath(path);
      });

      includedPaths.forEach((path) => {
        fields.push(this.propertyStore.getFullNameFromPath(path)!);
        quotes.push(false);
        usedPaths.push(path);
      });

      // Process annotations in chunks
      const CHUNK_SIZE = 100;
      const data: (string | number)[][] = [];
      const propValues = this.propertyStore.propertyValues;
      const annotations = this.annotations;
      const nAnnotations = annotations.length;

      for (let i = 0; i < nAnnotations; i += CHUNK_SIZE) {
        const chunk = annotations.slice(i, i + CHUNK_SIZE);

        // Process chunk
        const rows = chunk.map((annotation) => {
          const row: (string | number)[] = [
            annotation.id,
            annotation.channel,
            annotation.location.XY + 1,
            annotation.location.Z + 1,
            annotation.location.Time + 1,
            annotation.tags.join(", "),
            annotation.shape,
            annotation.name ?? "",
          ];

          for (const path of usedPaths) {
            const value = getValueFromObjectAndPath(
              propValues[annotation.id],
              path,
            );
            row.push(
              typeof value === "object" || typeof value === "undefined"
                ? AnnotationCsvDialog.UNDEFINED_VALUE_MAP[
                    this.undefinedHandling
                  ]
                : value,
            );
          }
          return row;
        });

        data.push(...rows);
        this.processingProgress = (i + CHUNK_SIZE) / nAnnotations;
      }

      // Generate csv
      return Papa.unparse({ fields, data }, { quotes });
    } finally {
      this.isProcessing = false;
      this.processingProgress = 1;
    }
  }

  @Watch("propertyExportMode")
  @Watch("selectedPropertyPaths")
  @Watch("undefinedHandling")
  @Watch("dialog")
  updateText() {
    if (this.dialog) {
      // Skip preview generation for large datasets
      if (this.isTooLargeForPreview) {
        this.text = "";
        this.displayText = "";
        this.processingProgress = 1;
        return;
      }

      this.generateCSVStringForAnnotations().then((text: string) => {
        this.text = text;
        this.displayText =
          text.length > this.DISPLAY_CHAR_LIMIT
            ? `${text.slice(0, this.DISPLAY_CHAR_LIMIT)}... (truncated, ${text.length} total characters)`
            : text;
      });
    } else {
      this.text = "";
      this.displayText = "";
    }
  }

  /**
   * Get the property paths to include based on the current export mode.
   */
  getIncludedPropertyPaths(): string[][] {
    return this.propertyPaths.filter((path) => {
      const pathName = this.propertyStore.getFullNameFromPath(path);
      return pathName && this.shouldIncludePropertyPath(path);
    });
  }

  /**
   * Get the undefined value string for the current handling mode.
   */
  getUndefinedValueString(): "" | "NA" | "NaN" {
    return AnnotationCsvDialog.UNDEFINED_VALUE_MAP[this.undefinedHandling];
  }

  async download() {
    if (!this.store.dataset) {
      return;
    }

    // Always use backend endpoint for downloads (handles large datasets)
    await this.store.exportAPI.exportCsv({
      datasetId: this.store.dataset.id,
      propertyPaths: this.getIncludedPropertyPaths(),
      annotationIds: this.annotations.map((a) => a.id),
      undefinedValue: this.getUndefinedValueString(),
      filename: this.filename || "upenn_annotation_export.csv",
    });
  }

  get displayedPropertyPaths() {
    return this.propertyStore.displayedPropertyPaths;
  }

  shouldIncludePropertyPath(path: string[]) {
    const pathString = path.join(".");
    return (
      this.propertyExportMode === "all" ||
      (this.propertyExportMode === "listed" &&
        this.displayedPropertyPaths.some(
          (displayPath: string[]) => displayPath.join(".") === pathString,
        )) ||
      (this.propertyExportMode === "selected" &&
        this.selectedPropertyPaths.some(
          (selectedPath) => selectedPath.pathString === pathString,
        ))
    );
  }
}
</script>
