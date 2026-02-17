<template>
  <v-expansion-panel>
    <v-expansion-panel-header class="py-1">
      Annotation List
      <v-spacer />
      <v-container style="width: auto">
        <v-row>
          <v-col class="pa-0 mx-1">
            <v-btn
              color="error"
              small
              outlined
              :loading="isDeletingAnnotations"
              :disabled="isDeletingAnnotations"
              @click.stop="deleteSelected"
            >
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
                <v-list-item
                  @click="deleteUnselected"
                  :disabled="isDeletingAnnotations"
                >
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

    <v-expansion-panel-content id="annotation-list-content-tourstep">
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

<script lang="ts" setup>
import { ref, computed, watch, getCurrentInstance } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import { simpleCentroid } from "@/utils/annotation";

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

const emit = defineEmits<{
  (e: "clickedTag", tag: string): void;
}>();

const vm = getCurrentInstance()!.proxy;

// Template ref
const dataTable = ref<any>(null);

// Data
const columnOptions = allHeaders;
const selectedColumns = ref<THeaderId[]>(initialSelectedColumns);
const tableItemClass = "px-1";
const annotationFilteredDialog = ref(false);
const localIdFilter = ref<string | undefined>("");
const addOrRemove = ref<"add" | "remove">("add");

// These are "from" or "to" v-data-table
const page = ref(0);
const itemsPerPage = ref(10);
const groupBy = ref<string | string[]>([]);

const showTagDialog = ref(false);
const showColorDialog = ref(false);

// Computeds
const isDeletingAnnotations = computed(() => {
  return annotationStore.isDeleting;
});

const selected = computed({
  get: () => {
    return annotationStore.selectedAnnotations.filter((annotation) =>
      filteredAnnotationIdToIdx.value.has(annotation.id),
    );
  },
  set: (selected: IAnnotation[]) => {
    annotationStore.setSelected(selected);
  },
});

const selectedItems = computed({
  get: () => {
    return filteredItems.value.filter((item) => item.isSelected);
  },
  set: (items: IAnnotationListItem[]) => {
    selected.value = items.map((item) => item.annotation);
  },
});

function toggleAnnotationSelection(annotation: IAnnotation) {
  annotationStore.toggleSelected([annotation]);
}

const filteredAnnotationIdToIdx = computed(() => {
  return filterStore.filteredAnnotationIdToIdx;
});

const listedAnnotations = computed(() => {
  let annotations = filterStore.filteredAnnotations;
  const idFilter = localIdFilter.value?.trim();
  if (idFilter) {
    annotations = annotations.filter((annotation) =>
      annotation.id.includes(idFilter),
    );
  }
  return annotations;
});

const filteredItems = computed(() => {
  return listedAnnotations.value.map(annotationToItem.value);
});

const annotationToItem = computed(() => {
  return (annotation: IAnnotation) => ({
    annotation,
    index: annotationIdToIndex.value[annotation.id],
    shapeName: AnnotationNames[annotation.shape],
    isSelected: annotationStore.isAnnotationSelected(annotation.id),
    properties: propertyStore.propertyValues[annotation.id] || {},
  });
});

const displayedPropertyPaths = computed(() => {
  return propertyStore.displayedPropertyPaths;
});

const annotationIdToIndex = computed(() => {
  return annotationStore.annotationIdToIdx;
});

function updateAnnotationName(name: string, id: string) {
  annotationStore.updateAnnotationName({ name, id });
}

const selectAllIndeterminate = computed(() => {
  const nSelected = selectedItems.value.length;
  return nSelected > 0 && nSelected < filteredItems.value.length;
});

const selectAllValue = computed(() => {
  return selectedItems.value.length === filteredItems.value.length;
});

function selectAllCallback() {
  if (selectAllValue.value) {
    selectedItems.value = [];
  } else {
    selectedItems.value = filteredItems.value;
  }
}

const headers = computed(() => {
  const filteredHeaders = allHeaders.filter((header) =>
    selectedColumns.value.includes(header.value),
  );
  return [...filteredHeaders, ...propertyHeaders.value];
});

const propertyHeaders = computed(() => {
  const result = [];
  for (const path of displayedPropertyPaths.value) {
    const fullName = propertyStore.getFullNameFromPath(path);
    result.push({
      text: fullName,
      value: "properties." + path.join("."),
    });
  }
  return result;
});

function goToAnnotationIdLocation(annotationId: string) {
  const annotation = annotationStore.getAnnotationFromId(annotationId);
  if (!annotation) {
    return;
  }
  store.setXY(annotation.location.XY);
  store.setZ(annotation.location.Z);
  store.setTime(annotation.location.Time);
  store.setCameraInfo({
    ...store.cameraInfo,
    center: simpleCentroid(annotation.coordinates),
  });
  annotationStore.setHoveredAnnotationId(annotationId);
}

const hoveredId = computed(() => {
  return annotationStore.hoveredAnnotationId;
});

const dataTableInner = computed(() => {
  const vDataTableParent = dataTable.value as any;
  if (!vDataTableParent) {
    return null;
  }
  return vDataTableParent.$children?.[0] || null;
});

const dataTableItems = computed((): IAnnotationListItem[] => {
  const table = dataTableInner.value;
  if (!table) {
    return [];
  }
  let tableItems = table.filteredItems.slice();
  if (
    (!table.disableSort || groupBy.value?.length) &&
    table.serverItemsLength <= 0
  ) {
    tableItems = table.sortItems(tableItems);
  }
  return tableItems;
});

const getPageFromItemId = computed(() => {
  return (itemId: string) => {
    const entryIndex = dataTableItems.value.findIndex(
      ({ annotation }) => annotation.id === itemId,
    );
    if (entryIndex <= 0) {
      return 0;
    }
    const perPage = itemsPerPage.value;
    if (perPage <= 0) {
      return 0;
    } else {
      return (Math.floor(entryIndex / perPage) || 0) + 1;
    }
  };
});

// Stacked @Watch("hoveredId") @Watch("itemsPerPage") → single watch
watch([hoveredId, itemsPerPage], () => {
  if (hoveredId.value === null) {
    return;
  }
  // Change page
  page.value = getPageFromItemId.value(hoveredId.value);
  // Get the tr element from the refs if it exists
  let annotationRef = vm.$refs[hoveredId.value];
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
});

function clickedTag(tag: string) {
  emit("clickedTag", tag);
}

function hover(annotationId: string | null) {
  if (annotationStore.annotations.length < 5000) {
    annotationStore.setHoveredAnnotationId(annotationId);
  }
}

function handleTagSubmit({
  tags,
  addOrRemove,
  replaceExisting,
}: {
  tags: string[];
  addOrRemove: "add" | "remove";
  replaceExisting: boolean;
}) {
  if (addOrRemove === "add") {
    annotationStore.tagSelectedAnnotations({
      tags,
      replace: replaceExisting,
    });
  } else {
    annotationStore.removeTagsFromSelectedAnnotations(tags);
  }
}

function handleColorSubmit({
  useColorFromLayer,
  color,
  randomize,
}: {
  useColorFromLayer: boolean;
  color: string;
  randomize?: boolean;
}) {
  const newColor = useColorFromLayer ? null : color;
  annotationStore.colorSelectedAnnotations({
    color: newColor,
    randomize,
  });
}

function deleteSelected() {
  annotationStore.deleteSelectedAnnotations();
}

function deleteUnselected() {
  annotationStore.deleteUnselectedAnnotations();
}

defineExpose({
  isDeletingAnnotations,
  columnOptions,
  selectedColumns,
  tableItemClass,
  annotationFilteredDialog,
  localIdFilter,
  addOrRemove,
  page,
  itemsPerPage,
  groupBy,
  selected,
  selectedItems,
  toggleAnnotationSelection,
  filteredAnnotationIdToIdx,
  listedAnnotations,
  filteredItems,
  annotationToItem,
  displayedPropertyPaths,
  annotationIdToIndex,
  updateAnnotationName,
  selectAllIndeterminate,
  selectAllValue,
  selectAllCallback,
  headers,
  propertyHeaders,
  goToAnnotationIdLocation,
  hoveredId,
  dataTableInner,
  dataTableItems,
  getPageFromItemId,
  clickedTag,
  hover,
  showTagDialog,
  showColorDialog,
  handleTagSubmit,
  handleColorSubmit,
  deleteSelected,
  deleteUnselected,
  getStringFromPropertiesAndPath,
});
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
