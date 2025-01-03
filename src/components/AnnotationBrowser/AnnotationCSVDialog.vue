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
      <v-card-text>
        <v-radio-group v-model="propertyExportMode" class="mb-4">
          <v-radio label="Export all properties" value="all"></v-radio>
          <v-radio label="Export listed properties" value="listed"></v-radio>
          <v-radio
            label="Select properties to export"
            value="selected"
          ></v-radio>
        </v-radio-group>

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

        <template v-if="text && text.length">
          <v-textarea ref="fieldToCopy" v-model="text" readonly>
            {{ text }}
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
          <p>LOADING</p>
          <v-progress-circular indeterminate />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn @click="dialog = false" text>Close</v-btn>
        <v-btn @click="download" :enabled="text && text.length" color="success">
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
import { downloadToClient } from "@/utils/download";
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

  filename: string = "";

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

  async generateCSVStringForAnnotations() {
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

    for (const path of this.propertyPaths) {
      const pathName = this.propertyStore.getFullNameFromPath(path);
      if (pathName && this.shouldIncludePropertyPath(path)) {
        fields.push(pathName);
        quotes.push(false);
        usedPaths.push(path);
      }
    }

    // Data
    const data: (string | number)[][] = [];
    const propValues = this.propertyStore.propertyValues;
    const annotations = this.annotations;
    const nAnnotations = annotations.length;
    for (let iAnnotation = 0; iAnnotation < nAnnotations; ++iAnnotation) {
      const annotation = annotations[iAnnotation];
      const row: (string | number)[] = [];
      row.push(annotation.id);
      row.push(annotation.channel);
      row.push(annotation.location.XY + 1);
      row.push(annotation.location.Z + 1);
      row.push(annotation.location.Time + 1);
      row.push(annotation.tags.join(", "));
      row.push(annotation.shape);
      row.push(annotation.name ?? "");
      for (let iProp = 0; iProp < usedPaths.length; ++iProp) {
        const value = getValueFromObjectAndPath(
          propValues[annotation.id],
          usedPaths[iProp],
        );
        switch (typeof value) {
          case "object":
          case "undefined":
            row.push(
              AnnotationCsvDialog.UNDEFINED_VALUE_MAP[this.undefinedHandling],
            );
            break;
          default:
            row.push(value);
            break;
        }
      }
      data.push(row);
    }

    // Generate csv
    return Papa.unparse({ fields, data }, { quotes });
  }

  @Watch("propertyExportMode")
  @Watch("selectedPropertyPaths")
  @Watch("undefinedHandling")
  @Watch("dialog")
  updateText() {
    if (this.dialog) {
      this.generateCSVStringForAnnotations().then((text: string) => {
        this.text = text;
      });
    } else {
      this.text = "";
    }
  }

  download() {
    const params = {
      href: "data:text/plain;charset=utf-8," + encodeURIComponent(this.text),
      download: this.filename || "upenn_annotation_export.csv",
    };
    downloadToClient(params);
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
