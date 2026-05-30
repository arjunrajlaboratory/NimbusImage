<template>
  <div class="annotation-list-panel">
    <div class="annotation-list-toolbar">
      <v-tooltip
        text="Measure objects: configure and run property computations"
      >
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            icon
            size="small"
            class="mr-1"
            aria-label="Measure objects"
            :data-tour="TOUR_ANCHORS.measureObjects"
            v-tour-trigger="TOUR_TRIGGERS.measureObjects"
            @click="store.setIsAnalyzeDialogOpen(true)"
          >
            <v-icon>mdi-ruler-square</v-icon>
          </v-btn>
        </template>
      </v-tooltip>
      <property-picker>
        <template v-slot:activator="{ props: pickerProps }">
          <v-btn
            v-bind="pickerProps"
            variant="flat"
            color="primary"
            size="small"
            prepend-icon="mdi-plus"
          >
            Add property
          </v-btn>
        </template>
      </property-picker>
      <v-spacer />
      <v-btn
        variant="text"
        color="error"
        size="small"
        :loading="isDeletingAnnotations"
        :disabled="!isLoggedIn || isDeletingAnnotations"
        @click.stop="deleteSelected"
      >
        <v-icon start>mdi-delete</v-icon>
        Delete Selected
      </v-btn>
      <v-menu>
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            variant="outlined"
            color="primary"
            size="small"
            v-bind="activatorProps"
            class="ml-2"
          >
            More Actions
            <v-icon size="small" end>mdi-chevron-down</v-icon>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item
            prepend-icon="mdi-delete-outline"
            title="Delete Unselected"
            @click="deleteUnselected"
            :disabled="!isLoggedIn || isDeletingAnnotations"
          />

          <v-list-item
            prepend-icon="mdi-tag"
            title="Tag Selected"
            @click="showTagDialog = true"
            :disabled="!isLoggedIn"
          />

          <v-list-item
            prepend-icon="mdi-palette"
            title="Color Selected"
            @click="showColorDialog = true"
            :disabled="!isLoggedIn"
          />

          <v-divider class="my-1" />

          <delete-connections>
            <template v-slot:activator="{ props }">
              <v-list-item
                v-bind="props"
                prepend-icon="mdi-link-variant-off"
                title="Delete Connections…"
                :disabled="!isLoggedIn"
                base-color="error"
              />
            </template>
          </delete-connections>
        </v-list>
      </v-menu>
    </div>

    <tag-selection-dialog
      v-model:show="showTagDialog"
      @submit="handleTagSubmit"
    />

    <color-selection-dialog
      v-model:show="showColorDialog"
      @submit="handleColorSubmit"
    />

    <div
      :data-tour="TOUR_ANCHORS.annotationListContent"
      class="annotation-list-content"
    >
      <v-dialog v-model="annotationFilteredDialog">
        <v-card>
          <v-card-title>
            Annotation does not pass current filtering criteria
          </v-card-title>
          <v-card-actions>
            <v-spacer />
            <v-btn
              variant="flat"
              color="primary"
              size="small"
              @click="annotationFilteredDialog = false"
              >OK</v-btn
            >
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
              :variant="
                selectedColumns.includes(option.key) ? 'flat' : 'outlined'
              "
              :color="
                selectedColumns.includes(option.key) ? 'white' : undefined
              "
              :style="
                selectedColumns.includes(option.key) ? {} : { opacity: 0.4 }
              "
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
        density="compact"
        item-value="annotation.id"
        v-model="selectedIds"
        :page="page"
        :items-per-page-options="[10, 50, 200]"
        :sort-by="sortBy"
        @update:items-per-page="itemsPerPage = $event"
        @update:page="page = $event"
        @update:sort-by="sortBy = $event"
        @update:group-by="groupBy = $event"
        ref="dataTable"
        class="compact-table"
      >
        <template v-slot:header.data-table-select>
          <v-checkbox
            :model-value="selectAllValue"
            :indeterminate="selectAllIndeterminate"
            @click="selectAllCallback"
            hide-details
          />
        </template>
        <template
          v-for="header in propertyHeaders"
          :key="header.key"
          v-slot:[`header.${header.key}`]="{ column }"
        >
          <span class="property-header-label">{{ column.title }}</span>
          <v-btn
            variant="text"
            size="x-small"
            density="compact"
            icon
            class="property-header-remove ml-1"
            :title="`Remove '${column.title}' from list`"
            @click.stop="removePropertyColumn(header.path)"
          >
            <v-icon size="14">mdi-close</v-icon>
          </v-btn>
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
                @change="
                  updateAnnotationName($event.target.value, item.annotation.id)
                "
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
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, watch } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import { simpleCentroid } from "@/utils/annotation";

import TagSelectionDialog from "@/components/TagSelectionDialog.vue";
import ColorSelectionDialog from "@/components/ColorSelectionDialog.vue";
import DeleteConnections from "@/components/AnnotationBrowser/DeleteConnections.vue";
import PropertyPicker from "@/components/PropertyPicker.vue";

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
const isLoggedIn = computed(() => store.isLoggedIn);

const isDeletingAnnotations = computed(() => {
  return annotationStore.isDeleting;
});

const selectedIds = computed({
  get: () => {
    return [...annotationStore.selectedAnnotationIds].filter((id) =>
      filteredAnnotationIdToIdx.value.has(id),
    );
  },
  set: (ids: string[]) => {
    annotationStore.setSelected(ids);
  },
});

const selectedItems = computed(() => {
  return filteredItems.value.filter((item) => item.isSelected);
});

function toggleAnnotationSelection(annotation: IAnnotation) {
  annotationStore.toggleSelected([annotation.id]);
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
    selectedIds.value = [];
  } else {
    selectedIds.value = filteredItems.value.map((item) => item.annotation.id);
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
      path,
      minWidth: 140,
    });
  }
  return result;
});

function removePropertyColumn(path: string[]) {
  propertyStore.togglePropertyPathVisibility(path);
}

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
      // Sort null/undefined to end regardless of sort direction
      // (matches Vuetify's internal sort behavior)
      if (valA == null && valB == null) return 0;
      if (valA == null) return 1;
      if (valB == null) return -1;
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

// Track whether hover originated from within the list itself.
// When hovering a row in the list, the annotation is already visible —
// no page change or scroll is needed. The page/scroll logic only matters
// for external hovers (e.g., hovering an annotation in the image viewer).
let hoverFromList = false;

// Stacked @Watch("hoveredId") @Watch("itemsPerPage") → single watch
watch([hoveredId, itemsPerPage], () => {
  if (hoveredId.value === null) {
    hoverFromList = false;
    return;
  }
  if (hoverFromList) {
    hoverFromList = false;
    return;
  }
  // Change page (only for external hovers, e.g., from image viewer)
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
    hoverFromList = true;
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
  isLoggedIn,
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
  selectedIds,
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
  removePropertyColumn,
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
  min-height: 0;
  display: flex;
  align-items: center;
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

.annotation-list-panel {
  padding: 6px 10px 10px;
}

.annotation-list-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0 8px;
}

.add-property-btn {
  letter-spacing: 0;
  text-transform: none;
}

.property-header-label {
  vertical-align: middle;
  font-size: 12px;
  font-weight: 500;
  display: inline-block;
  max-width: 100%;
}

.property-header-remove {
  vertical-align: middle;
  opacity: 0.6;
}
.property-header-remove:hover {
  opacity: 1;
}

/* Compact data-table typography — headers + cells slightly smaller and
   tighter than Vuetify's default 14px / 48px so the palette feels dense
   without sacrificing legibility. */
.compact-table th,
.compact-table td {
  font-size: 12px;
  padding-inline: 8px;
}
.compact-table th {
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.25;
  vertical-align: middle;
  white-space: normal;
}
.compact-table tbody tr {
  height: 32px;
}
.compact-table .v-data-table-footer {
  font-size: 12px;
}

/* Let the palette's frosted-glass surface show through the table — the
   default Vuetify backgrounds are opaque and look stamped against the
   translucent container. */
.compact-table,
.compact-table.v-table,
.compact-table .v-table__wrapper,
.compact-table table,
.compact-table thead,
.compact-table tbody,
.compact-table tfoot,
.compact-table tr,
.compact-table th,
.compact-table td,
.compact-table .v-data-table-footer,
.compact-table .v-data-table__td {
  background: transparent !important;
  background-color: transparent !important;
}
.compact-table tbody tr td {
  border-bottom: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
}
</style>
