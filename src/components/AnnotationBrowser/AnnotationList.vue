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
      <v-alert
        v-if="roiActiveInServerMode"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-2"
      >
        Region (ROI) filters are not applied to this list while browsing a large
        dataset. Use tag, property, or annotation ID filters to narrow results.
      </v-alert>
      <!-- Client mode, under the size limit: the existing client-side table. -->
      <v-data-table
        v-if="!isServerMode && !tooManyToList"
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
          <annotation-list-row
            :item="item"
            :selected-columns="selectedColumns"
            :displayed-property-paths="displayedPropertyPaths"
            :hovered-id="hoveredId"
            :table-item-class="tableItemClass"
            :ref="(el) => setAnnotationRef(item.annotation.id, el)"
            @hover="hover"
            @navigate="goToAnnotationIdLocation"
            @toggle-select="toggleAnnotationSelection"
            @clicked-tag="clickedTag"
            @update-name="updateAnnotationName($event.name, $event.id)"
          />
        </template>
      </v-data-table>
      <!-- Client mode, over the size limit: ask the user to narrow filters. -->
      <div v-else-if="!isServerMode && tooManyToList" class="list-too-many">
        <v-icon size="32" class="mb-2">mdi-alert-circle-outline</v-icon>
        <div class="text-subtitle-1">
          {{ listedAnnotations.length.toLocaleString() }} annotations
        </div>
        <div class="text-body-2">
          Too many to list. Narrow with tag, property, or ROI filters (or the
          annotation ID filter above) to under
          {{ LIST_ITEM_LIMIT.toLocaleString() }} to browse them here.
        </div>
      </div>
      <!-- Server mode: backend-paginated table. Uses the SAME item markup. -->
      <v-data-table-server
        v-else
        :items="serverRowItems"
        :items-length="serverItemsLength"
        :loading="serverLoading"
        :headers="headers"
        show-select
        density="compact"
        item-value="annotation.id"
        v-model="selectedIds"
        :items-per-page-options="[10, 50, 200]"
        @update:options="onServerOptions"
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
          <annotation-list-row
            :item="item"
            :selected-columns="selectedColumns"
            :displayed-property-paths="displayedPropertyPaths"
            :hovered-id="hoveredId"
            :table-item-class="tableItemClass"
            :ref="(el) => setAnnotationRef(item.annotation.id, el)"
            @hover="hover"
            @navigate="goToAnnotationIdLocation"
            @toggle-select="toggleAnnotationSelection"
            @clicked-tag="clickedTag"
            @update-name="updateAnnotationName($event.name, $event.id)"
          />
        </template>
      </v-data-table-server>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import annotationStore from "@/store/annotation";
import annotationListServer from "@/store/annotationListServer";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { simpleCentroid } from "@/utils/annotation";

import TagSelectionDialog from "@/components/TagSelectionDialog.vue";
import ColorSelectionDialog from "@/components/ColorSelectionDialog.vue";
import DeleteConnections from "@/components/AnnotationBrowser/DeleteConnections.vue";
import PropertyPicker from "@/components/PropertyPicker.vue";
import AnnotationListRow from "@/components/AnnotationBrowser/AnnotationListRow.vue";

import {
  AnnotationNames,
  IAnnotation,
  IAnnotationListSort,
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

// --- Server-driven (stub-only) list mode ---------------------------------
// In server mode the list is paginated/sorted/filtered by the backend. NONE of
// the computeds below may read filterStore.filteredAnnotations (or anything
// derived from it): that getter iterates ALL stubs client-side and applies
// property filters without property values loaded, so it is both expensive and
// wrong in server mode. Every shared computed has an isServerMode branch.
const isServerMode = computed(() => annotationStore.stubOnlyMode);

const serverItemsLength = computed(() => annotationListServer.total);

const serverLoading = computed(() => annotationListServer.loading);

// Adapter: present server rows in the SAME item shape the client table uses.
// Server rows are stubs (no name/coordinates/datasetId); add the fields the
// shared item markup reads so it renders identically to the client table.
const serverRowItems = computed(() =>
  annotationListServer.rows.map((row, i) => ({
    annotation: { ...row, name: row.name ?? null },
    index: (annotationListServer.page - 1) * annotationListServer.pageSize + i,
    shapeName: AnnotationNames[row.shape],
    isSelected: annotationStore.isAnnotationSelected(row.id),
    properties: row.values || {},
  })),
);

// ROI filtering is not supported by the server list endpoint (it is a
// client-side polygon test). Surface a notice when one is active in server mode.
const roiActiveInServerMode = computed(
  () => isServerMode.value && filterStore.roiFilters.some((f) => f.enabled),
);

// Vuetify emits sort keys equal to the column `key`s. The backend field-sort
// only accepts location.XY|location.Z|location.Time|name|channel|_id (anything
// else → HTTP 400), plus property sort via a path array. Return null for
// unsupported columns so we never send a 400-causing key (backend defaults to
// _id when sort is null).
function mapSort(entry: {
  key: string;
  order: "asc" | "desc";
}): IAnnotationListSort | null {
  const { key, order } = entry;
  if (key.startsWith("properties.")) {
    const path = key.slice("properties.".length).split(".");
    return { type: "property", key: path, order };
  }
  switch (key) {
    case "annotation.location.XY":
      return { type: "field", key: "location.XY", order };
    case "annotation.location.Z":
      return { type: "field", key: "location.Z", order };
    case "annotation.location.Time":
      return { type: "field", key: "location.Time", order };
    case "annotation.name":
      return { type: "field", key: "name", order };
    case "annotation.id":
      return { type: "field", key: "_id", order };
    default:
      // annotation.tags, shapeName, index, and anything else: unsupported
      // server-side. (index is offset+rowIndex — only meaningful in default
      // order — so it is not meaningfully sortable; see serverUnsortableColumns.)
      return null;
  }
}

function onServerOptions(opts: {
  page: number;
  itemsPerPage: number;
  sortBy?: { key: string; order: "asc" | "desc" }[];
}) {
  const entry = opts.sortBy?.[0];
  const newSort = entry ? mapSort(entry) : null;
  // Vuetify's options composable watches {immediate:true} and emits
  // update:options on mount, which would duplicate the onMounted fetchPage().
  // No-op when the incoming options already match the store state so the
  // mount-time emit doesn't trigger a second identical request.
  if (
    opts.page === annotationListServer.page &&
    opts.itemsPerPage === annotationListServer.pageSize &&
    JSON.stringify(newSort) === JSON.stringify(annotationListServer.sort)
  ) {
    return;
  }
  annotationListServer.setOptions({
    page: opts.page,
    pageSize: opts.itemsPerPage,
    sort: newSort,
  });
  annotationListServer.fetchPage();
}

const selectedIds = computed({
  get: () => {
    if (isServerMode.value) {
      return [...annotationStore.selectedAnnotationIds];
    }
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

function toggleAnnotationSelection(annotation: { id: string }) {
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

// Defensive scale guard, superseded in practice by stubOnlyMode (server mode):
// server mode activates at maxVisible = 10,000, below this 20,000 threshold, so
// the client-side `tooManyToList` branch is effectively unreachable now that the
// server-driven list (Option B) handles large datasets. Kept as a safety net for
// any client-mode path that materializes one item per filtered annotation and
// sorts client-side (which would hang the tab above this many).
const LIST_ITEM_LIMIT = 20000;

const tooManyToList = computed(
  () => listedAnnotations.value.length > LIST_ITEM_LIMIT,
);

const filteredItems = computed(() => {
  if (tooManyToList.value) {
    return [];
  }
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

async function updateAnnotationName(name: string, id: string) {
  await annotationStore.updateAnnotationName({ name, id });
  await refreshServerListIfNeeded();
}

const selectAllIndeterminate = computed(() => {
  if (isServerMode.value) {
    const nSelected = annotationStore.selectedAnnotationIds.size;
    return nSelected > 0 && nSelected < serverItemsLength.value;
  }
  const nSelected = selectedItems.value.length;
  return nSelected > 0 && nSelected < filteredItems.value.length;
});

const selectAllValue = computed(() => {
  if (isServerMode.value) {
    const total = serverItemsLength.value;
    return total > 0 && annotationStore.selectedAnnotationIds.size === total;
  }
  return selectedItems.value.length === filteredItems.value.length;
});

function selectAllCallback() {
  if (isServerMode.value) {
    // In server mode: if anything is currently selected, clear the selection;
    // otherwise select all matching annotations by fetching their ids from the
    // backend (selectAllMatchingInServerMode → fetchMatchingIds).
    if (annotationStore.selectedAnnotationIds.size > 0) {
      selectedIds.value = [];
    } else {
      selectAllMatchingInServerMode();
    }
    return;
  }
  if (selectAllValue.value) {
    selectedIds.value = [];
  } else {
    selectedIds.value = filteredItems.value.map((item) => item.annotation.id);
  }
}

async function selectAllMatchingInServerMode() {
  const ids = await annotationListServer.fetchMatchingIds();
  annotationStore.setSelected(ids);
}

// Columns the backend list endpoint cannot sort on. In server mode they are
// marked non-sortable so Vuetify won't emit a sort key that mapSort would have
// to drop (mapSort still returns null for them as the essential guard).
const serverUnsortableColumns: readonly string[] = [
  "annotation.tags",
  "shapeName",
  "index",
];

const headers = computed(() => {
  const filteredHeaders = allHeaders
    .filter((header) => selectedColumns.value.includes(header.key))
    .map((header) =>
      isServerMode.value && serverUnsortableColumns.includes(header.key)
        ? { ...header, sortable: false }
        : header,
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
  // In stub-only mode getAnnotationFromId returns undefined for non-hydrated
  // annotations, so fall back to the stub (which carries location + centroid).
  const annotation = annotationStore.getAnnotationFromId(annotationId);
  const stub = annotationStore.getStub(annotationId);
  const location = annotation?.location ?? stub?.location;
  if (!location) {
    return;
  }
  store.setXY(location.XY);
  store.setZ(location.Z);
  store.setTime(location.Time);
  // Stubs have no coordinates — recenter on the stub centroid (or the centroid
  // map); full annotations use their actual coordinate centroid.
  const center = annotation?.coordinates
    ? simpleCentroid(annotation.coordinates)
    : stub?.centroid ?? annotationStore.annotationCentroids[annotationId];
  if (center) {
    store.setCameraInfo({
      ...store.cameraInfo,
      center,
    });
  }
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
  // In server mode the page/scroll-to-hovered logic would read the client
  // filtered set (via getPageFromItemId → dataTableItems → filteredItems);
  // skip it entirely so server mode never touches that getter.
  if (isServerMode.value) {
    return;
  }
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

// --- Server-mode reactive refetch -----------------------------------------
// Each watch body is a no-op in client mode (the client set is reactive on its
// own). In server mode, a change to any query input resets to page 1 and
// refetches. The annotation-ID text filter is wired through the store's
// idSubstring so it folds into the backend query.
//
// The refetch is debounced (trailing, 300ms): typing in the ID filter or
// rapid filter/frame changes would otherwise fire one slow /list request per
// keystroke. State (idSubstring, page reset) is updated synchronously so the
// store is always consistent; only the network fetch is deferred.
const debouncedServerRefetch = debounce(() => {
  annotationListServer.fetchPage();
}, 300);

watch(localIdFilter, (value) => {
  if (!isServerMode.value) {
    return;
  }
  annotationListServer.setIdSubstring(value?.trim() ?? "");
  annotationListServer.setOptions({ page: 1 });
  debouncedServerRefetch();
});

watch(
  [
    () => filterStore.tagFilter,
    () => filterStore.propertyFilters,
    () => filterStore.onlyCurrentFrame,
    () => filterStore.selectionFilter,
    () => filterStore.annotationIdFilters,
    () => propertyStore.displayedPropertyPaths,
    () => store.xy,
    () => store.z,
    () => store.time,
  ],
  () => {
    if (!isServerMode.value) {
      return;
    }
    annotationListServer.setOptions({ page: 1 });
    debouncedServerRefetch();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  debouncedServerRefetch.cancel();
});

onMounted(() => {
  if (isServerMode.value) {
    annotationListServer.fetchPage();
  }
});

function clickedTag(tag: string) {
  emit("clickedTag", tag);
}

function hover(annotationId: string | null) {
  if (annotationStore.annotationsForIteration.length < 5000) {
    hoverFromList = true;
    annotationStore.setHoveredAnnotationId(annotationId);
  }
}

// Bulk tag/color/name edits route through annotationStore.updateAnnotationsPerId,
// which is stub-aware (persists via the batch endpoint in server mode). The
// server list rows are backend-driven, so refresh the page after the edit.
async function refreshServerListIfNeeded() {
  if (isServerMode.value) {
    await annotationListServer.fetchPage();
  }
}

async function handleTagSubmit({
  tags,
  addOrRemove,
  replaceExisting,
}: {
  tags: string[];
  addOrRemove: "add" | "remove";
  replaceExisting: boolean;
}) {
  if (addOrRemove === "add") {
    await annotationStore.tagSelectedAnnotations({
      tags,
      replace: replaceExisting,
    });
  } else {
    await annotationStore.removeTagsFromSelectedAnnotations(tags);
  }
  await refreshServerListIfNeeded();
}

async function handleColorSubmit({
  useColorFromLayer,
  color,
  randomize,
}: {
  useColorFromLayer: boolean;
  color: string;
  randomize?: boolean;
}) {
  const newColor = useColorFromLayer ? null : color;
  await annotationStore.colorSelectedAnnotations({
    color: newColor,
    randomize,
  });
  await refreshServerListIfNeeded();
}

async function deleteSelected() {
  if (isServerMode.value) {
    // In server mode the client annotation set is empty, so the store action
    // would delete nothing. Delete the currently-selected ids directly, clear
    // the selection, and refresh the server page so the deleted rows drop out.
    await annotationStore.deleteAnnotations([
      ...annotationStore.selectedAnnotationIds,
    ]);
    annotationStore.setSelected([]);
    await annotationListServer.fetchPage();
    return;
  }
  annotationStore.deleteSelectedAnnotations();
}

async function deleteUnselected() {
  if (isServerMode.value) {
    // In server mode "unselected" means everything matching the current
    // filters except the selected ids — fetch all matching ids from the
    // backend and subtract the selection, then refresh the server page.
    const allMatching = await annotationListServer.fetchMatchingIds();
    const selected = new Set(annotationStore.selectedAnnotationIds);
    await annotationStore.deleteAnnotations(
      allMatching.filter((id) => !selected.has(id)),
    );
    await annotationListServer.fetchPage();
    return;
  }
  annotationStore.deleteUnselectedAnnotations();
}

defineExpose({
  isLoggedIn,
  isDeletingAnnotations,
  isServerMode,
  serverItemsLength,
  serverLoading,
  serverRowItems,
  roiActiveInServerMode,
  mapSort,
  onServerOptions,
  selectAllMatchingInServerMode,
  columnOptions,
  selectedColumns,
  tableItemClass,
  annotationFilteredDialog,
  localIdFilter,
  LIST_ITEM_LIMIT,
  tooManyToList,
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

.list-too-many {
  text-align: center;
  padding: 32px 16px;
  opacity: 0.8;
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
