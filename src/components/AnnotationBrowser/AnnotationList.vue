<template>
  <v-expansion-panel>
    <v-expansion-panel-header class="py-1">
      Annotation List
      <v-spacer />
      <v-container style="width: auto">
        <v-row>
          <v-col class="pa-0 mx-1">
            <v-btn color="error" small outlined @click.stop="deleteSelected">
              Delete Selected
            </v-btn>
          </v-col>
          <v-col class="pa-0 mx-1">
            <v-menu offset-y>
              <template v-slot:activator="{ on, attrs }">
                <v-btn small v-bind="attrs" v-on="on">
                  More Actions
                  <v-icon small right>mdi-chevron-down</v-icon>
                </v-btn>
              </template>
              <v-list>
                <v-list-item @click="deleteUnselected">
                  <v-list-item-icon>
                    <v-icon>mdi-delete-outline</v-icon>
                  </v-list-item-icon>
                  <v-list-item-title>Delete Unselected</v-list-item-title>
                </v-list-item>

                <v-list-item @click="showTagDialog = true">
                  <v-list-item-icon>
                    <v-icon>mdi-tag</v-icon>
                  </v-list-item-icon>
                  <v-list-item-title>Tag Selected</v-list-item-title>
                </v-list-item>

                <v-list-item @click="showColorDialog = true">
                  <v-list-item-icon>
                    <v-icon>mdi-palette</v-icon>
                  </v-list-item-icon>
                  <v-list-item-title>Color Selected</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>
          </v-col>
        </v-row>
      </v-container>
    </v-expansion-panel-header>

    <tag-selection-dialog
      :show.sync="showTagDialog"
      @submit="handleTagSubmit"
    />

    <color-selection-dialog
      :show.sync="showColorDialog"
      @submit="handleColorSubmit"
    />

    <v-expansion-panel-content>
      <v-dialog v-model="annotationFilteredDialog">
        <v-card>
          <v-card-title>
            Annotation does not pass current filtering criteria
          </v-card-title>
          <v-card-actions>
            <v-spacer />
            <v-btn @click.native="annotationFilteredDialog = false">OK</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
      <v-row>
        <v-col cols="12" md="6">
          <v-chip-group
            v-model="selectedColumns"
            column
            multiple
            active-class="selected-chip"
          >
            <v-chip
              v-for="option in columnOptions"
              :key="option.value"
              :value="option.value"
              :class="{
                'selected-chip': selectedColumns.includes(option.value),
              }"
              outlined
              x-small
            >
              {{ option.text }}
            </v-chip>
          </v-chip-group>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="localIdFilter"
            label="Filter by annotation ID"
            single-line
            clearable
          ></v-text-field>
        </v-col>
      </v-row>
      <v-data-table
        :items="filteredItems"
        :headers="headers"
        show-select
        item-key="annotation.id"
        v-model="selectedItems"
        :page="page"
        :footer-props="{
          'items-per-page-options': [10, 50, 200],
        }"
        @update:items-per-page="itemsPerPage = $event"
        @update:group-by="groupBy = $event"
        ref="dataTable"
      >
        <template v-slot:header.data-table-select>
          <v-simple-checkbox
            :value="selectAllValue"
            :indeterminate="selectAllIndeterminate"
            @click="selectAllCallback"
          />
        </template>
        <template v-slot:body="{ items }">
          <tbody>
            <tr
              v-for="item in items"
              :key="item.annotation.id"
              @mouseover="hover(item.annotation.id)"
              @mouseleave="hover(null)"
              @click="goToAnnotationIdLocation(item.annotation.id)"
              title="Go to annotation location"
              :class="item.annotation.id === hoveredId ? 'is-hovered' : ''"
              :ref="item.annotation.id"
            >
              <td :class="tableItemClass">
                <v-checkbox
                  hide-details
                  title
                  :input-value="item.isSelected"
                  @click.stop="() => toggleAnnotationSelection(item.annotation)"
                />
              </td>
              <td
                :class="tableItemClass"
                v-if="selectedColumns.includes('annotation.id')"
              >
                <span class="user-select-text">{{ item.annotation.id }}</span>
              </td>
              <td
                :class="tableItemClass"
                v-if="selectedColumns.includes('index')"
              >
                <span>{{ item.index }}</span>
              </td>
              <td
                :class="tableItemClass"
                v-if="selectedColumns.includes('shapeName')"
              >
                <span>{{ item.shapeName }}</span>
              </td>
              <td
                :class="tableItemClass"
                v-if="selectedColumns.includes('annotation.tags')"
              >
                <span>
                  <v-chip
                    v-for="tag in item.annotation.tags"
                    :key="tag"
                    x-small
                    @click="clickedTag(tag)"
                    >{{ tag }}</v-chip
                  >
                </span>
              </td>
              <td v-if="selectedColumns.includes('annotation.location.XY')">
                {{ item.annotation.location.XY + 1 }}
              </td>
              <td v-if="selectedColumns.includes('annotation.location.Z')">
                {{ item.annotation.location.Z + 1 }}
              </td>
              <td v-if="selectedColumns.includes('annotation.location.Time')">
                {{ item.annotation.location.Time + 1 }}
              </td>
              <td
                :class="tableItemClass"
                v-if="selectedColumns.includes('annotation.name')"
              >
                <v-text-field
                  hide-details
                  :value="item.annotation.name || ''"
                  dense
                  flat
                  outlined
                  @change="updateAnnotationName($event, item.annotation.id)"
                  @click.capture.stop
                  title
                ></v-text-field>
              </td>
              <td
                v-for="(propertyPath, idx) in displayedPropertyPaths"
                :key="item.annotation.id + ' property ' + idx"
                :class="tableItemClass"
              >
                <span>{{
                  getStringFromPropertiesAndPath(
                    item.properties,
                    propertyPath,
                  ) ?? "-"
                }}</span>
              </td>
            </tr>
          </tbody>
        </template>
      </v-data-table>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script lang="ts">
import { Vue, Component, Emit, Watch } from "vue-property-decorator";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import { simpleCentroid } from "@/utils/annotation";

import TagPicker from "@/components/TagPicker.vue";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import TagSelectionDialog from "@/components/TagSelectionDialog.vue";
import ColorSelectionDialog from "@/components/ColorSelectionDialog.vue";

import {
  AnnotationNames,
  IAnnotation,
  IAnnotationPropertyValues,
} from "@/store/model";

const allHeaders = [
  { text: "Annotation ID", value: "annotation.id" },
  { text: "Index", value: "index" },
  { text: "Shape", value: "shapeName" },
  { text: "Tags", value: "annotation.tags" },
  { text: "XY", value: "annotation.location.XY" },
  { text: "Z", value: "annotation.location.Z" },
  { text: "Time", value: "annotation.location.Time" },
  { text: "Name", value: "annotation.name" },
] as const satisfies readonly {
  readonly text: string;
  readonly value: string;
}[];

const allHeaderIds = allHeaders.map(({ value }) => value);

// Remove a few headers by default because they are not commonly used and clutter the interface
const headersToRemoveByDefault: THeaderId[] = [
  "annotation.id",
  "shapeName",
  "annotation.name",
];
const initialSelectedColumns = allHeaderIds.filter(
  (value) => !headersToRemoveByDefault.includes(value),
);

type THeaderId = (typeof allHeaderIds)[number];

interface IAnnotationListItem {
  annotation: IAnnotation;
  index: number;
  shapeName: string;
  isSelected: boolean;
  properties: IAnnotationPropertyValues[string];
}

@Component({
  components: {
    TagPicker,
    ColorPickerMenu,
    TagSelectionDialog,
    ColorSelectionDialog,
  },
})
export default class AnnotationList extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;
  readonly propertyStore = propertyStore;
  readonly filterStore = filterStore;
  readonly getStringFromPropertiesAndPath = getStringFromPropertiesAndPath;

  readonly columnOptions = allHeaders;

  // Pick the default columns to display
  selectedColumns: THeaderId[] = initialSelectedColumns;

  tableItemClass = "px-1"; // To enable dividers, use v-data-table__divider

  annotationFilteredDialog: boolean = false;
  localIdFilter?: string = "";

  addOrRemove: "add" | "remove" = "add";

  // These are "from" or "to" v-data-table
  page: number = 0; // one-way binding :page
  itemsPerPage: number = 10; // one-way binding @update:items-per-page
  groupBy: string | string[] = []; // one-way binding @update:group-by

  get selected() {
    return this.annotationStore.selectedAnnotations.filter((annotation) =>
      this.filteredAnnotationIdToIdx.has(annotation.id),
    );
  }

  set selected(selected: IAnnotation[]) {
    this.annotationStore.setSelected(selected);
  }

  get selectedItems() {
    return this.filteredItems.filter((item) => item.isSelected);
  }

  set selectedItems(items) {
    this.selected = items.map((item) => item.annotation);
  }

  toggleAnnotationSelection(annotation: IAnnotation) {
    this.annotationStore.toggleSelected([annotation]);
  }

  get filteredAnnotationIdToIdx() {
    return this.filterStore.filteredAnnotationIdToIdx;
  }

  get listedAnnotations() {
    let annotations = this.filterStore.filteredAnnotations;
    const idFilter = this.localIdFilter?.trim();
    if (idFilter) {
      annotations = annotations.filter((annotation) =>
        annotation.id.includes(idFilter),
      );
    }
    return annotations;
  }

  get filteredItems() {
    return this.listedAnnotations.map(this.annotationToItem);
  }

  get annotationToItem() {
    return (annotation: IAnnotation) => ({
      annotation,
      index: this.annotationIdToIndex[annotation.id],
      shapeName: AnnotationNames[annotation.shape],
      isSelected: this.annotationStore.isAnnotationSelected(annotation.id),
      properties: this.propertyStore.propertyValues[annotation.id] || {},
    });
  }

  get displayedPropertyPaths() {
    return this.propertyStore.displayedPropertyPaths;
  }

  get annotationIdToIndex() {
    return this.annotationStore.annotationIdToIdx;
  }

  updateAnnotationName(name: string, id: string) {
    this.annotationStore.updateAnnotationName({ name, id });
  }

  get selectAllIndeterminate() {
    const nSelected = this.selectedItems.length;
    return nSelected > 0 && nSelected < this.filteredItems.length;
  }

  get selectAllValue() {
    return this.selectedItems.length === this.filteredItems.length;
  }

  selectAllCallback() {
    if (this.selectAllValue) {
      this.selectedItems = [];
    } else {
      this.selectedItems = this.filteredItems;
    }
  }

  get headers() {
    // Filter headers based on selectedColumns while preserving the order defined above
    const filteredHeaders = allHeaders.filter((header) =>
      this.selectedColumns.includes(header.value),
    );

    // Return the filtered headers with propertyHeaders appended at the end
    return [...filteredHeaders, ...this.propertyHeaders];
  }

  get propertyHeaders() {
    const propertyHeaders = [];
    // Order is important, it should be the same as in the <td v-for="x in y"> above
    for (const path of this.displayedPropertyPaths) {
      const fullName = this.propertyStore.getFullNameFromPath(path);
      propertyHeaders.push({
        text: fullName,
        value: "properties." + path.join("."),
      });
    }
    return propertyHeaders;
  }

  goToAnnotationIdLocation(annotationId: string) {
    const annotation = this.annotationStore.getAnnotationFromId(annotationId);
    if (!annotation) {
      return;
    }
    this.store.setXY(annotation.location.XY);
    this.store.setZ(annotation.location.Z);
    this.store.setTime(annotation.location.Time);
    // Also center the view on the annotation
    this.store.setCameraInfo({
      ...this.store.cameraInfo,
      center: simpleCentroid(annotation.coordinates),
    });
    this.annotationStore.setHoveredAnnotationId(annotationId);
  }

  get hoveredId() {
    return this.annotationStore.hoveredAnnotationId;
  }

  get vDataTable() {
    const vDataTableParent = this.$refs.dataTable as any;
    if (!vDataTableParent) {
      return null;
    }
    return vDataTableParent.$children?.[0] || null;
  }

  get dataTableItems(): IAnnotationListItem[] {
    const vDataTable = this.vDataTable;
    if (!vDataTable) {
      return [];
    }
    let tableItems = vDataTable.filteredItems.slice();
    if (
      (!vDataTable.disableSort || this.groupBy?.length) &&
      vDataTable.serverItemsLength <= 0
    ) {
      tableItems = vDataTable.sortItems(tableItems);
    }
    return tableItems;
  }

  get getPageFromItemId() {
    return (itemId: string) => {
      const entryIndex = this.dataTableItems.findIndex(
        ({ annotation }) => annotation.id === itemId,
      );
      if (entryIndex <= 0) {
        return 0;
      }
      const itemsPerPage = this.itemsPerPage;
      if (itemsPerPage <= 0) {
        return 0;
      } else {
        return (Math.floor(entryIndex / itemsPerPage) || 0) + 1;
      }
    };
  }

  @Watch("hoveredId")
  @Watch("itemsPerPage")
  hoveredAnnotationChanged() {
    if (this.hoveredId === null) {
      return;
    }
    // Change page
    this.page = this.getPageFromItemId(this.hoveredId);
    // Get the tr element from the refs if it exists
    let annotationRef = this.$refs[this.hoveredId];
    if (annotationRef === undefined) {
      return;
    }
    if (Array.isArray(annotationRef)) {
      if (annotationRef.length <= 0) {
        return;
      }
      annotationRef = annotationRef[0];
    }
    // Scroll to the element
    (annotationRef as Element).scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }

  @Emit("clickedTag")
  clickedTag(tag: string) {
    return tag;
  }

  hover(annotationId: string | null) {
    // Only update the hover if the total number of annotations is less than 5000
    // Otherwise the update will be too slow for the UI to be responsive
    // TODO: This could probably be relaxed by conditioning on the number of displayedAnnotations
    if (this.annotationStore.annotations.length < 5000) {
      this.annotationStore.setHoveredAnnotationId(annotationId);
    }
  }

  showTagDialog = false;
  showColorDialog = false;

  handleTagSubmit({
    tags,
    addOrRemove,
    replaceExisting,
  }: {
    tags: string[];
    addOrRemove: "add" | "remove";
    replaceExisting: boolean;
  }) {
    if (addOrRemove === "add") {
      this.annotationStore.tagSelectedAnnotations({
        tags,
        replace: replaceExisting,
      });
    } else {
      this.annotationStore.removeTagsFromSelectedAnnotations(tags);
    }
  }

  handleColorSubmit({
    useColorFromLayer,
    color,
  }: {
    useColorFromLayer: boolean;
    color: string;
  }) {
    const newColor = useColorFromLayer ? null : color;
    this.annotationStore.colorSelectedAnnotations(newColor);
  }

  deleteSelected() {
    this.annotationStore.deleteSelectedAnnotations();
  }

  deleteUnselected() {
    this.annotationStore.deleteUnselectedAnnotations();
  }
}
</script>
<style>
tbody tr:hover,
tbody tr.is-hovered,
tbody tr.is-hovered:hover {
  background-color: #616161;
  cursor: pointer;
}

.v-text-field .v-input__control .v-input__slot {
  min-height: 0 !important;
  display: flex !important;
  align-items: center !important;
}

.v-dialog {
  width: 50%;
}

.v-input--selection-controls {
  padding: 0px;
  margin: 0px;
}

.v-input__slot {
  justify-content: center;
}

.selected-chip {
  border-color: #ffffff !important; /* Change to your preferred color */
}

.v-chip {
  transition:
    background-color 0.3s,
    color 0.3s; /* Smooth transition */
}

td span {
  display: block;
  text-align: center;
  margin: auto;
}

.user-select-text {
  user-select: text;
}
</style>
