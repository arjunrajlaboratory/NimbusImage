<template>
  <v-expansion-panel>
    <v-expansion-panel-title class="py-1">
      Annotation List
      <v-spacer />
      <v-container style="width: auto">
        <v-row>
          <v-col class="pa-0 mx-1">
            <v-btn
              color="error"
              size="small"
              variant="outlined"
              :loading="isDeletingAnnotations"
              :disabled="isDeletingAnnotations"
              @click.stop="deleteSelected"
            >
              Delete Selected
            </v-btn>
          </v-col>
          <v-col class="pa-0 mx-1">
            <v-menu>
              <template v-slot:activator="{ props: activatorProps }">
                <v-btn size="small" v-bind="activatorProps">
                  More Actions
                  <v-icon size="small" end>mdi-chevron-down</v-icon>
                </v-btn>
              </template>
              <v-list>
                <v-list-item
                  @click="deleteUnselected"
                  :disabled="isDeletingAnnotations"
                >
                  <v-icon>mdi-delete-outline</v-icon>
                  <v-list-item-title>Delete Unselected</v-list-item-title>
                </v-list-item>

                <v-list-item @click="showTagDialog = true">
                  <v-icon>mdi-tag</v-icon>
                  <v-list-item-title>Tag Selected</v-list-item-title>
                </v-list-item>

                <v-list-item @click="showColorDialog = true">
                  <v-icon>mdi-palette</v-icon>
                  <v-list-item-title>Color Selected</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>
          </v-col>
        </v-row>
      </v-container>
    </v-expansion-panel-title>

    <tag-selection-dialog
      v-model:show="showTagDialog"
      @submit="handleTagSubmit"
    />

    <color-selection-dialog
      v-model:show="showColorDialog"
      @submit="handleColorSubmit"
    />

    <v-expansion-panel-text id="annotation-list-content-tourstep">
      <v-dialog v-model="annotationFilteredDialog">
        <v-card>
          <v-card-title>
            Annotation does not pass current filtering criteria
          </v-card-title>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="annotationFilteredDialog = false">OK</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
      <v-row>
        <v-col cols="12" md="6">
          <v-chip-group
            v-model="selectedColumns"
            column
            multiple
            selected-class=""
          >
            <v-chip
              v-for="option in columnOptions"
              :key="option.key"
              :value="option.key"
              :variant="selectedColumns.includes(option.key) ? 'flat' : 'outlined'"
              :color="selectedColumns.includes(option.key) ? 'white' : undefined"
              :style="selectedColumns.includes(option.key) ? {} : { opacity: 0.4 }"
              size="x-small"
            >
              {{ option.title }}
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
        item-value="annotation.id"
        v-model="selectedItems"
        :page="page"
        :items-per-page-options="[10, 50, 200]"
        :sort-by="sortBy"
        @update:items-per-page="itemsPerPage = $event"
        @update:sort-by="sortBy = $event"
        @update:group-by="groupBy = $event"
        ref="dataTable"
      >
        <template v-slot:header.data-table-select>
          <v-checkbox
            :model-value="selectAllValue"
            :indeterminate="selectAllIndeterminate"
            @click="selectAllCallback"
            hide-details
          />
        </template>
        <template v-slot:item="{ item }">
          <tr
            @mouseover="hover(item.annotation.id)"
            @mouseleave="hover(null)"
            @click="goToAnnotationIdLocation(item.annotation.id)"
            title="Go to annotation location"
            :class="item.annotation.id === hoveredId ? 'is-hovered' : ''"
            :ref="(el) => setAnnotationRef(item.annotation.id, el)"
          >
            <td :class="tableItemClass">
              <v-checkbox
                hide-details
                title
                :model-value="item.isSelected"
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
                  size="x-small"
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
                :model-value="item.annotation.name || ''"
                density="compact"
                flat
                variant="outlined"
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
                getStringFromPropertiesAndPath(item.properties, propertyPath) ??
                "-"
              }}</span>
            </td>
          </tr>
        </template>
      </v-data-table>
    </v-expansion-panel-text>
  </v-expansion-panel>
</template>

<script lang="ts" setup>
import { ref, computed, watch } from "vue";
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
  { title: "Annotation ID", key: "annotation.id" },
  { title: "Index", key: "index" },
  { title: "Shape", key: "shapeName" },
  { title: "Tags", key: "annotation.tags" },
  { title: "XY", key: "annotation.location.XY" },
  { title: "Z", key: "annotation.location.Z" },
  { title: "Time", key: "annotation.location.Time" },
  { title: "Name", key: "annotation.name" },
] as const satisfies readonly {
  readonly title: string;
  readonly key: string;
}[];

const allHeaderIds = allHeaders.map(({ key }) => key);

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

const annotationRefMap = new Map<string, Element>();
function setAnnotationRef(id: string, el: any) {
  if (el) {
    // In Vue 2, component refs resolve to the component instance; get the $el
    const element = el.$el || el;
    annotationRefMap.set(id, element);
  } else {
    annotationRefMap.delete(id);
  }
}

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
const page = ref(1);
const itemsPerPage = ref(10);
const groupBy = ref<string | string[]>([]);
const sortBy = ref<{ key: string; order: "asc" | "desc" }[]>([]);

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
    selectedColumns.value.includes(header.key),
  );
  return [...filteredHeaders, ...propertyHeaders.value];
});

const propertyHeaders = computed(() => {
  const result = [];
  for (const path of displayedPropertyPaths.value) {
    const fullName = propertyStore.getFullNameFromPath(path);
    result.push({
      title: fullName ?? "",
      key: "properties." + path.join("."),
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

// In Vuetify 3, $children is not available. Instead, we track sort state
// via @update:sort-by and sort the items ourselves.
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

const dataTableItems = computed((): IAnnotationListItem[] => {
  const items = filteredItems.value.slice();
  if (sortBy.value.length) {
    const { key, order } = sortBy.value[0];
    items.sort((a, b) => {
      const valA = getNestedValue(a, key);
      const valB = getNestedValue(b, key);
      if (valA < valB) return order === "asc" ? -1 : 1;
      if (valA > valB) return order === "asc" ? 1 : -1;
      return 0;
    });
  }
  return items;
});

const getPageFromItemId = computed(() => {
  return (itemId: string) => {
    const entryIndex = dataTableItems.value.findIndex(
      ({ annotation }) => annotation.id === itemId,
    );
    if (entryIndex <= 0) {
      return 1;
    }
    const perPage = itemsPerPage.value;
    if (perPage <= 0) {
      return 1;
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
  // Get the tr element from the ref map if it exists
  const annotationEl = annotationRefMap.get(hoveredId.value);
  if (!annotationEl) {
    return;
  }
  // Scroll to the element
  annotationEl.scrollIntoView({
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
  dataTableItems,
  sortBy,
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

.v-chip {
  transition:
    background-color 0.3s,
    color 0.3s,
    opacity 0.3s;
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
