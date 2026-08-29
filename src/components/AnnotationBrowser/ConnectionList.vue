<template>
  <div class="connection-list-panel">
    <div class="connection-list-toolbar">
      <v-select
        :model-value="connectionListStore.scope"
        :items="scopeItems"
        item-title="title"
        item-value="value"
        label="Scope"
        density="compact"
        variant="outlined"
        hide-details
        class="scope-select"
        @update:model-value="connectionListStore.setScope"
      />
      <v-btn-toggle
        :model-value="connectionListStore.grouping"
        density="compact"
        mandatory
        divided
        variant="outlined"
        @update:model-value="connectionListStore.setGrouping"
      >
        <v-btn value="flat" size="small">Flat</v-btn>
        <v-btn value="track" size="small">By track</v-btn>
      </v-btn-toggle>
      <!-- Track-metric filters: bounds on track size hide whole tracks from
           the list AND from the image viewer (both read one store predicate).
           The badge is the "something is narrowing this" cue when the menu is
           closed; the count's "of M" suffix is the cue next to the number. -->
      <v-menu :close-on-content-click="false" location="bottom">
        <template v-slot:activator="{ props: menuProps }">
          <v-btn
            v-bind="menuProps"
            variant="text"
            icon
            size="small"
            title="Track filters"
          >
            <v-badge :model-value="trackFiltersActive" dot color="primary">
              <v-icon>mdi-filter-variant</v-icon>
            </v-badge>
          </v-btn>
        </template>
        <v-card class="track-filter-menu">
          <v-card-title class="track-filter-title">
            Track filters
            <v-spacer />
            <v-btn
              variant="text"
              size="small"
              :disabled="!trackFiltersActive"
              @click="clearTrackFilters"
            >
              Clear
            </v-btn>
          </v-card-title>
          <v-card-text>
            <div class="text-caption mb-2">
              Hide tracks outside these ranges — from the list and the image.
            </div>
            <div
              v-for="metric in TRACK_FILTER_METRICS"
              :key="metric.key"
              class="track-filter-row"
            >
              <span class="track-filter-label">{{ metric.label }}</span>
              <v-text-field
                :model-value="
                  connectionListStore.trackFilters[metric.key].min ?? ''
                "
                type="number"
                min="0"
                placeholder="min"
                density="compact"
                variant="outlined"
                hide-details
                class="track-filter-bound"
                @update:model-value="
                  updateTrackFilterBound(metric.key, 'min', $event)
                "
              />
              <span class="track-filter-dash">–</span>
              <v-text-field
                :model-value="
                  connectionListStore.trackFilters[metric.key].max ?? ''
                "
                type="number"
                min="0"
                placeholder="max"
                density="compact"
                variant="outlined"
                hide-details
                class="track-filter-bound"
                @update:model-value="
                  updateTrackFilterBound(metric.key, 'max', $event)
                "
              />
            </div>
            <!-- Opt-in: a track filter narrows connections by default; this
                 extends it to the filtered-out tracks' OBJECTS in the viewer.
                 Unconnected objects are never hidden, and the HUD announces
                 the narrowing (activeConstraints). -->
            <v-checkbox
              :model-value="connectionListStore.hideFilteredTrackObjects"
              label="Also hide these tracks' objects in the image"
              density="compact"
              hide-details
              class="track-filter-objects"
              @update:model-value="
                connectionListStore.setHideFilteredTrackObjects($event === true)
              "
            />
          </v-card-text>
        </v-card>
      </v-menu>
      <v-spacer />
      <span class="connection-count">{{ countText }}</span>
    </div>

    <div class="connection-list-toolbar">
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        prepend-icon="mdi-link-variant-plus"
        :disabled="!connectionListStore.canConnectSelected || isConnecting"
        :loading="isConnecting"
        @click="connectSelected"
      >
        Connect selected ({{ selectedAnnotationCount }})
      </v-btn>
      <v-spacer />
      <v-btn
        variant="text"
        color="error"
        size="small"
        prepend-icon="mdi-delete"
        :disabled="!isLoggedIn || selectedInScopeCount === 0 || isDeleting"
        :loading="isDeleting"
        @click="deleteSelected"
      >
        Delete selected ({{ selectedInScopeCount }})
      </v-btn>
    </div>

    <!-- Dangling = an endpoint pointing at a DELETED annotation (data rot),
         common in older datasets. Whole-dataset cleanup on its own row (it
         squeezed Delete selected down to a bare icon when inlined), and only
         present when there is something to clean. -->
    <div v-if="danglingCount > 0" class="connection-list-toolbar">
      <span class="dangling-note">
        {{ danglingCount.toLocaleString() }} connections point at deleted
        objects.
      </span>
      <v-spacer />
      <v-btn
        variant="text"
        color="error"
        size="small"
        prepend-icon="mdi-link-variant-remove"
        :disabled="!isLoggedIn || isCleaningDangling"
        :loading="isCleaningDangling"
        @click="danglingDialogOpen = true"
      >
        Clean up
      </v-btn>
    </div>

    <v-dialog v-model="danglingDialogOpen" max-width="500px">
      <v-card>
        <v-card-title>Clean up dangling connections</v-card-title>
        <v-card-text>
          {{ danglingCount.toLocaleString() }} connections point at objects that
          no longer exist (deleted after the connection was made). This deletes
          those connections from the whole dataset, regardless of the current
          scope. It can be undone with Undo.
        </v-card-text>
        <v-card-actions class="button-bar">
          <v-spacer />
          <v-btn
            variant="text"
            size="small"
            @click="danglingDialogOpen = false"
          >
            Cancel
          </v-btn>
          <v-btn
            variant="flat"
            color="error"
            size="small"
            :loading="isCleaningDangling"
            @click="confirmCleanDangling"
          >
            Delete {{ danglingCount.toLocaleString() }} connections
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Track labels can mirror a worker-computed property (e.g. Parent-Child
         Connection IDs' trackId), so a track flagged during post-processing
         can be found here under the same id. Only meaningful for the By-track
         view. -->
    <div
      v-if="connectionListStore.grouping === 'track'"
      class="connection-list-toolbar"
    >
      <v-select
        :model-value="trackLabelKey"
        :items="trackLabelItems"
        item-title="title"
        item-value="value"
        label="Track ID property"
        density="compact"
        variant="outlined"
        hide-details
        class="track-label-select"
        title="Label tracks with a computed property value (e.g. the trackId from the Parent-Child Connection IDs worker) instead of the default short object id."
        @update:model-value="setTrackLabelFromKey"
      />
    </div>

    <!-- Lazy-mode fetch failure: the affected tracks render unresolved (plain
         short-id titles, no badge) rather than a false "no ID", and nothing
         else necessarily re-fires the fetch — hence the explicit retry. -->
    <v-alert
      v-if="trackLabelActive && trackLabelFetchFailed"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-2"
    >
      Couldn't load track ID values.
      <template v-slot:append>
        <v-btn size="x-small" variant="text" @click="ensureTrackLabelValues">
          Retry
        </v-btn>
      </template>
    </v-alert>

    <!-- Chaining an unbounded selection would POST tens of thousands of
         connections in one request, so the action is capped rather than left
         to fail slowly. -->
    <v-alert
      v-if="connectionListStore.connectSelectedExceedsMax"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-2"
    >
      {{ selectedAnnotationCount.toLocaleString() }} objects are selected.
      Connect selected chains at most
      {{ MAX_CONNECT_SELECTED.toLocaleString() }} at a time — narrow the
      selection to build a track.
    </v-alert>

    <!-- Same-frame pairs carry no direction in the data, so the chain falls
         back to selection order. Surface that rather than silently guessing —
         under drag-select the "order" is effectively arbitrary. -->
    <v-alert
      v-if="timeTies.length > 0 && connectionListStore.canConnectSelected"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-2"
    >
      {{ tieMessage }}
    </v-alert>

    <v-alert
      v-if="connectError"
      type="error"
      variant="tonal"
      density="compact"
      closable
      class="mb-2"
      @click:close="connectError = null"
    >
      {{ connectError }}
    </v-alert>

    <div class="connection-list-content">
      <div v-if="scopedCount === 0" class="connection-list-empty">
        <v-icon size="32" class="mb-2">mdi-link-variant-off</v-icon>
        <div class="text-body-2">{{ emptyMessage }}</div>
      </div>

      <!-- Flat: one row per connection. -->
      <v-data-table
        v-else-if="connectionListStore.grouping === 'flat'"
        :items="rows"
        :headers="headers"
        density="compact"
        item-value="connection.id"
        :page="connectionListStore.page"
        :items-per-page="connectionListStore.itemsPerPage"
        :items-per-page-options="[10, 50, 200]"
        @update:page="connectionListStore.setPage"
        @update:items-per-page="connectionListStore.setItemsPerPage"
        class="compact-table"
      >
        <template v-slot:header.select>
          <v-checkbox
            :model-value="selectAllValue"
            :indeterminate="selectAllIndeterminate"
            hide-details
            @click="toggleSelectAll"
          />
        </template>
        <template v-slot:item="{ item }">
          <connection-list-row
            :row="item"
            :hovered-id="hoveredId"
            @hover="connectionListStore.setHoveredConnectionId"
            @navigate="navigateToConnection"
            @toggle-select="connectionListStore.toggleConnectionSelection"
            @delete="deleteOne"
            @clicked-tag="emit('clickedTag', $event)"
          />
        </template>
      </v-data-table>

      <!-- By track: one expandable group per connected component. -->
      <div v-else class="track-list">
        <div v-for="track in tracks" :key="track.id" class="track-group">
          <div class="track-header" @click="toggleTrack(track)">
            <v-icon size="small">
              {{
                connectionListStore.isTrackExpanded(track.id)
                  ? "mdi-chevron-down"
                  : "mdi-chevron-right"
              }}
            </v-icon>
            <!-- The colour the track is drawn in, so a line picked out in the
                 viewer can be matched to its row without counting. Hidden under
                 uniform colouring, where it would claim a distinction the
                 canvas isn't making. -->
            <span
              v-if="showTrackSwatches"
              class="track-swatch"
              :style="{ backgroundColor: swatchColor(track) }"
              aria-hidden="true"
            />
            <span class="track-title" :title="trackTitleTooltip(track)">
              Track {{ trackTitle(track) }}
            </span>
            <!-- Staleness badges, not error states: a partial, mixed or
                 duplicate track means the connection graph changed after the
                 property was computed — exactly the tracks worth a second
                 look. -->
            <v-chip
              v-if="trackBadge(track)"
              size="x-small"
              variant="tonal"
              :color="trackBadge(track)?.color"
              class="track-badge"
              :title="trackBadge(track)?.tooltip"
            >
              {{ trackBadge(track)?.text }}
            </v-chip>
            <!-- Also in the title attribute: the counts are what gets
                 ellipsized when the row is tight, and the link count is the
                 diagnostic one (it exceeds objects−1 only when a track
                 branches or carries duplicate links). -->
            <span class="track-meta" :title="trackMeta(track)">
              {{ trackMeta(track) }}
            </span>
            <v-spacer />
            <!-- A menu rather than two buttons: the actions plus the swatch
                 already pushed this header onto two lines once, and 248 tracks
                 at two lines each is a lot of scroll. It also makes the
                 objects/links distinction explicit — with one "Select" button
                 the difference lived only in a tooltip, and selecting objects
                 looks like nothing happening unless you know to watch
                 "Connect selected" rather than "Delete selected". -->
            <v-menu location="bottom end">
              <template v-slot:activator="{ props: activatorProps }">
                <v-btn
                  v-bind="activatorProps"
                  variant="text"
                  size="x-small"
                  append-icon="mdi-menu-down"
                  @click.stop
                >
                  <v-icon size="small" start>mdi-select-group</v-icon>
                  Select
                </v-btn>
              </template>
              <v-list density="compact">
                <v-list-item
                  :disabled="selectableObjectCount(track) === 0"
                  @click="selectTrackObjects(track)"
                >
                  <v-list-item-title>
                    Objects ({{ selectableObjectCount(track) }})
                  </v-list-item-title>
                </v-list-item>
                <v-list-item @click="selectTrackConnections(track)">
                  <v-list-item-title>
                    Links ({{ track.rows.length }})
                  </v-list-item-title>
                </v-list-item>
                <v-list-item @click="selectTrackBoth(track)">
                  <v-list-item-title>Both</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>
            <v-btn
              variant="text"
              color="error"
              size="x-small"
              :disabled="!isLoggedIn || isDeleting"
              @click.stop="deleteTrack(track)"
            >
              <v-icon size="small" start>mdi-delete</v-icon>
              Delete track
            </v-btn>
          </div>
          <table
            v-if="connectionListStore.isTrackExpanded(track.id)"
            class="track-table"
          >
            <tbody>
              <connection-list-row
                v-for="row in track.rows"
                :key="row.connection.id"
                :row="row"
                :hovered-id="hoveredId"
                @hover="connectionListStore.setHoveredConnectionId"
                @navigate="navigateToConnection"
                @toggle-select="connectionListStore.toggleConnectionSelection"
                @delete="deleteOne"
                @clicked-tag="emit('clickedTag', $event)"
              />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, ref, watch } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import connectionListStore, {
  CONNECTION_SCOPE_LABELS,
  ITrackFilters,
  TConnectionScope,
  createEmptyTrackFilters,
} from "@/store/connectionList";
import { MAX_CONNECT_SELECTED } from "@/store/constants";
import propertyStore from "@/store/properties";
import timelapseStore from "@/store/timelapse";
import ConnectionListRow from "@/components/AnnotationBrowser/ConnectionListRow.vue";
import { goToConnection, goToTrack } from "@/utils/annotationNavigation";
import { logError } from "@/utils/log";
import {
  IConnectionRow,
  ITrackRow,
  TTrackLabelResolution,
  findDuplicateTrackLabelValues,
  formatTrackLabelValue,
  resolveTrackLabelValue,
  shortAnnotationId,
  trackColor,
} from "@/utils/connections";
import {
  createPathStringFromPathArray,
  getValueFromObjectAndPath,
} from "@/utils/paths";

const props = withDefaults(
  defineProps<{
    /** True while the Connections tab is the visible one. */
    isActive?: boolean;
  }>(),
  { isActive: false },
);

const emit = defineEmits<{
  (e: "clickedTag", tag: string): void;
}>();

const headers = [
  { title: "", key: "select", sortable: false, width: 40 },
  { title: "Parent", key: "parent.label", sortable: false },
  { title: "", key: "arrow", sortable: false, width: 20 },
  { title: "Child", key: "child.label", sortable: false },
  { title: "Tags", key: "connection.tags", sortable: false },
  { title: "", key: "actions", sortable: false, width: 32 },
];

const scopeItems = (
  Object.keys(CONNECTION_SCOPE_LABELS) as TConnectionScope[]
).map((value) => ({ value, title: CONNECTION_SCOPE_LABELS[value] }));

const isDeleting = ref(false);
const isConnecting = ref(false);
const connectError = ref<string | null>(null);

const isLoggedIn = computed(() => store.isLoggedIn);
// Gated on isActive so the store getters are never READ while the tab is
// hidden — an unread Vuex getter is never evaluated. Building rows depends on
// hydration (through resolveAnnotation), so it is invalidated by every pan;
// without this gate a user who opened the tab once kept paying to rebuild all
// rows on every pan for the rest of the session, with none of them rendered.
// Measured at ~6.7 ms for 4,983 connections, and it scales linearly.
const rows = computed(() =>
  props.isActive ? connectionListStore.connectionRows : [],
);
const tracks = computed(() =>
  props.isActive ? connectionListStore.trackRows : [],
);
// Gated for the same reason as the rows: scopedConnections resolves
// scopeAnnotationIds, which scans every annotation for the dynamic scopes, so
// an ungated read is a full-dataset scan on every XY/Z/Time scrub from a tab
// nobody is looking at.
const scopedCount = computed(() =>
  props.isActive ? connectionListStore.scopedConnections.length : 0,
);
const hoveredId = computed(() => connectionListStore.hoveredConnectionId);

// --- Track metric filters ---

const TRACK_FILTER_METRICS: {
  key: keyof ITrackFilters;
  label: string;
}[] = [
  { key: "connectionCount", label: "Connections in track" },
  { key: "memberCount", label: "Objects in track" },
  { key: "duration", label: "Duration (timepoints)" },
];

const trackFiltersActive = computed(
  () => connectionListStore.trackFiltersActive,
);

// Gated like scopedCount: for the dynamic scopes scopeOnlyConnections filters
// the whole connection array per read, and this component stays mounted (and
// rendering) while the tab is hidden.
const scopeOnlyCount = computed(() =>
  props.isActive && trackFiltersActive.value
    ? connectionListStore.scopeOnlyConnections.length
    : 0,
);

// "N of M" whenever the track filters are narrowing — a filtered count
// printed without a cue reads as data loss.
const countText = computed(() => {
  const count = scopedCount.value.toLocaleString();
  if (!props.isActive || !trackFiltersActive.value) {
    return count;
  }
  return `${count} of ${scopeOnlyCount.value.toLocaleString()}`;
});

function updateTrackFilterBound(
  metric: keyof ITrackFilters,
  bound: "min" | "max",
  raw: string | number | null,
) {
  const parsed =
    raw == null || raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
  const current = connectionListStore.trackFilters;
  connectionListStore.setTrackFilters({
    ...current,
    [metric]: { ...current[metric], [bound]: parsed },
  });
}

function clearTrackFilters() {
  connectionListStore.setTrackFilters(createEmptyTrackFilters());
}

// --- Dangling connection cleanup ---

// Gated like every other scope-derived getter: danglingConnectionIds resolves
// both endpoints of every connection and is invalidated by hydration, so a
// hidden tab must never read it.
const danglingCount = computed(() =>
  props.isActive ? connectionListStore.danglingConnectionIds.length : 0,
);

const danglingDialogOpen = ref(false);
const isCleaningDangling = ref(false);

async function confirmCleanDangling() {
  isCleaningDangling.value = true;
  try {
    await connectionListStore.deleteDanglingConnections();
  } catch (error) {
    logError("Failed to clean up dangling connections", error);
    connectError.value =
      "Failed to delete dangling connections. See console for details.";
  } finally {
    isCleaningDangling.value = false;
    danglingDialogOpen.value = false;
  }
}
const selectedCount = computed(
  () => connectionListStore.selectedConnectionIds.size,
);
// The list's bulk delete acts only on rows it is actually showing, so the
// button's count must match — see selectedInScopeConnectionIds.
const selectedInScopeCount = computed(() =>
  props.isActive ? connectionListStore.selectedInScopeConnectionIds.length : 0,
);
const selectedAnnotationCount = computed(
  () => annotationStore.selectedAnnotationIds.size,
);
const timeTies = computed(() => connectionListStore.connectSelectedTimeTies);

const tieMessage = computed(() => {
  const times = timeTies.value.map((time) => `T${time + 1}`).join(", ");
  const plural = timeTies.value.length > 1 ? "timepoints" : "timepoint";
  return (
    `Selected objects share ${plural} ${times}. Direction can't be inferred ` +
    `within a frame, so those will be chained in the order you selected them.`
  );
});

// A Record rather than a switch: TypeScript enforces a message for every scope,
// and there is no unreachable fallback branch to keep the linter happy.
const EMPTY_MESSAGES: Record<TConnectionScope, string> = {
  all: "This dataset has no connections.",
  location: "No connections touch an object at the current location.",
  selected: "No connections touch the selected objects.",
  filtered: "No connections touch an object passing the current filters.",
};

const emptyMessage = computed(() => {
  // "This dataset has no connections" would be a lie when the track filters
  // are what hid them. isActive first: scopeOnlyConnections must never be
  // read from a hidden tab (this branch renders whenever the list is empty,
  // which includes the gated-to-empty hidden state).
  if (
    props.isActive &&
    trackFiltersActive.value &&
    connectionListStore.scopeOnlyConnections.length > 0
  ) {
    return "No connections match the track filters.";
  }
  return EMPTY_MESSAGES[connectionListStore.scope];
});

// Count only the selected rows that are actually in the list. A connection can
// be selected from the viewer while out of the current scope, so comparing the
// total selection size against the row count would read as "all selected" when
// none of the visible rows are. Mirrors AnnotationList's intersection check.
const selectedVisibleCount = computed(
  () =>
    rows.value.filter(({ connection }) =>
      connectionListStore.isConnectionSelected(connection.id),
    ).length,
);
const selectAllValue = computed(
  () =>
    rows.value.length > 0 && selectedVisibleCount.value === rows.value.length,
);
const selectAllIndeterminate = computed(
  () => selectedVisibleCount.value > 0 && !selectAllValue.value,
);

function shortId(id: string) {
  return shortAnnotationId(id);
}

// The scoped row id remains independent for expansion/labeling. `colorKey`
// comes from the dataset-wide connection graph, matching the viewer even when
// the current scope exposes only a tail of the track.
// Gated on the MODE as well as the option. `trackColor` is only ever called from
// the timelapse draw path, so with the mode off nothing on the canvas carries a
// track hue — measured on a real dataset, 248 swatches in 248 distinct colours
// against zero drawn connection features, since a timelapse link's endpoints sit
// on different timepoints and normal mode never co-displays them. Worse, the
// only control that hides them is in the Timelapse palette, which IS the mode,
// so with the mode off they were unturnoffable too.
const showTrackSwatches = computed(
  () => timelapseStore.showMode && timelapseStore.trackColoring === "track",
);

function swatchColor(track: ITrackRow) {
  return trackColor(track.colorKey, timelapseStore.colorSeed);
}

function trackMeta(track: ITrackRow) {
  const range = track.timeRange
    ? ` · T${track.timeRange.start + 1}–T${track.timeRange.end + 1}`
    : "";
  return `${track.annotationCount} objects${range} · ${track.rows.length} links`;
}

// --- Track labels from a property (issue #1330) ---

const trackLabelPath = computed(() => connectionListStore.trackLabelPath);
const trackLabelActive = computed(
  () =>
    props.isActive &&
    connectionListStore.grouping === "track" &&
    trackLabelPath.value.length > 0,
);

const trackLabelPropertyName = computed(
  () =>
    propertyStore.getFullNameFromPath(trackLabelPath.value) ??
    trackLabelPath.value.join(" / "),
);

const trackLabelItems = computed(() => {
  const items = propertyStore.computedPropertyPaths.map((path) => ({
    title: propertyStore.getFullNameFromPath(path) ?? path.join(" / "),
    value: createPathStringFromPathArray(path),
  }));
  // Keep the persisted selection listed even when its values are gone (e.g.
  // deleted between sessions), so the select shows what is configured and the
  // user can clear it — rather than displaying a raw path key.
  const currentKey = createPathStringFromPathArray(trackLabelPath.value);
  if (currentKey && !items.some((item) => item.value === currentKey)) {
    items.push({ title: trackLabelPropertyName.value, value: currentKey });
  }
  return [{ title: "Object ID (default)", value: "" }, ...items];
});

const trackLabelKey = computed(() =>
  createPathStringFromPathArray(trackLabelPath.value),
);

function setTrackLabelFromKey(key: string | null) {
  if (!key) {
    connectionListStore.setTrackLabelPath([]);
    return;
  }
  // The only offered key outside computedPropertyPaths is the currently
  // persisted one (see trackLabelItems), so a miss means "keep what we have".
  const path = propertyStore.computedPropertyPaths.find(
    (candidate) => createPathStringFromPathArray(candidate) === key,
  );
  if (path) {
    connectionListStore.setTrackLabelPath(path);
  }
}

/**
 * Lazy (stub-only) mode only: property values for track members, which the
 * viewport-scoped propertyValues cache does not hold. `null` marks an id that
 * was fetched and confirmed to have no value, so it is never refetched.
 */
const fetchedTrackValues = ref<Map<string, number | string | null>>(new Map());
// Identifies what the cache was fetched FOR; a path change or a server-side
// recompute (revision bump) invalidates it wholesale.
let fetchedTrackValuesKey = "";
// Ids already sent in an in-flight request for the current cache key. The
// tracks rebuild on every pan in lazy mode, re-entering the fetcher while a
// request is pending — these coalesce those re-entries instead of resending
// the same ids (and discarding each other's responses). Reset with the cache
// on every key change.
let pendingTrackValueIds = new Set<string>();
// The latest fetch failed; the uncovered members render unresolved rather
// than "no ID", and the toolbar offers a manual retry (nothing else
// necessarily re-fires the watcher after a failure).
const trackLabelFetchFailed = ref(false);

function asLeafValue(value: unknown): number | string | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function trackMemberValue(annotationId: string): number | string | null {
  if (annotationStore.stubOnlyMode) {
    return fetchedTrackValues.value.get(annotationId) ?? null;
  }
  const values = propertyStore.propertyValues[annotationId];
  return values
    ? asLeafValue(getValueFromObjectAndPath(values, trackLabelPath.value))
    : null;
}

const trackLabels = computed((): Map<string, TTrackLabelResolution> => {
  const labels = new Map<string, TTrackLabelResolution>();
  if (!trackLabelActive.value) {
    return labels;
  }
  const lazyCache = annotationStore.stubOnlyMode
    ? fetchedTrackValues.value
    : null;
  for (const track of tracks.value) {
    // In lazy mode an id absent from the fetch cache is UNKNOWN (in flight or
    // failed), not missing — leave the track unresolved (default short-id
    // title, no badge) rather than claim "no ID" about values that may exist
    // on the server. A successful fetch covers every requested id (confirmed
    // misses included), so resolution resumes as soon as one lands.
    if (lazyCache && !track.annotationIds.every((id) => lazyCache.has(id))) {
      continue;
    }
    labels.set(
      track.id,
      resolveTrackLabelValue(track.annotationIds, trackMemberValue),
    );
  }
  return labels;
});

// A split (connection deleted after the worker ran) leaves two tracks whose
// members each unanimously carry the same old id — per-track resolution alone
// marks both clean. Detection is across the displayed (scope-narrowed) rows —
// the default "All connections" scope makes that the whole dataset — but
// keyed by colorKey, the DATASET-WIDE track identity: a narrow scope can
// expose one intact track as two disconnected fragments, which share a value
// legitimately and must not read as a split.
const duplicateTrackLabelValues = computed(() => {
  const labelledTracks: {
    resolution: TTrackLabelResolution;
    datasetTrackKey: string;
  }[] = [];
  for (const track of tracks.value) {
    const resolution = trackLabels.value.get(track.id);
    if (resolution) {
      labelledTracks.push({ resolution, datasetTrackKey: track.colorKey });
    }
  }
  return findDuplicateTrackLabelValues(labelledTracks);
});

/**
 * Lazy mode: fetch the chosen property's values for track members missing from
 * the local cache. Wholesale mode reads propertyValues directly and never gets
 * here. Re-entered whenever the tracks change (cheap no-op once every member
 * is cached — comparable to the per-pan row rebuild the tab already pays).
 */
// A displayed member with no cache entry (in flight or failed). The failure
// warning keys off this, not off any individual request's fate: an obsolete
// request can fail after a newer one already covered everything shown.
function hasUncoveredTrackMember(): boolean {
  const cache = fetchedTrackValues.value;
  return tracks.value.some((track) =>
    track.annotationIds.some((annotationId) => !cache.has(annotationId)),
  );
}

async function ensureTrackLabelValues() {
  if (!trackLabelActive.value || !annotationStore.stubOnlyMode) {
    // The lazy fetcher is out of play — wholesale mode reads resident values
    // and an inactive view shows none — so a failure it recorded (possibly
    // for a previous dataset: this component outlives dataset switches) is
    // obsolete. Without this, a wholesale dataset opened after a lazy-mode
    // failure shows a permanent warning that Retry (this same early return)
    // can never clear.
    trackLabelFetchFailed.value = false;
    return;
  }
  // Readiness gate: during a dataset load stubOnlyMode flips before
  // fetchPropertyValues bumps the revision, and a batch launched in that gap
  // is superseded (and re-sent) moments later — one duplicated large query
  // per dataset open. Wait until the property refresh ran for THIS dataset;
  // the bump that records this id is a watch source, so the fetch fires then.
  if (propertyStore.propertyValuesDatasetId !== store.dataset?.id) {
    return;
  }
  const path = trackLabelPath.value;
  const cacheKey = `${propertyStore.propertyValuesRevision}:${createPathStringFromPathArray(path)}`;
  if (cacheKey !== fetchedTrackValuesKey) {
    fetchedTrackValuesKey = cacheKey;
    fetchedTrackValues.value = new Map();
    pendingTrackValueIds = new Set();
  }
  const cache = fetchedTrackValues.value;
  const pending = pendingTrackValueIds;
  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const track of tracks.value) {
    for (const annotationId of track.annotationIds) {
      if (
        !cache.has(annotationId) &&
        !pending.has(annotationId) &&
        !seen.has(annotationId)
      ) {
        seen.add(annotationId);
        missingIds.push(annotationId);
      }
    }
  }
  const datasetId = store.dataset?.id;
  if (missingIds.length === 0 || !datasetId) {
    // Everything displayed is covered: an earlier failure — possibly from a
    // request for tracks shown before a scope change — is moot. Without this,
    // Retry returns here and strands the warning forever.
    if (!hasUncoveredTrackMember()) {
      trackLabelFetchFailed.value = false;
    }
    return;
  }
  trackLabelFetchFailed.value = false;
  missingIds.forEach((id) => pending.add(id));
  try {
    // Single batched request — never a fetch-per-annotation loop.
    const entries = await propertyStore.propertiesAPI.getPropertyValuesForIds(
      datasetId,
      missingIds,
      [path],
    );
    // The response is valid exactly for the key it was fetched under: values
    // are immutable per path/revision, so concurrent same-key responses may
    // all merge (coverage only grows), while a response for a superseded key
    // — the path changed or a recompute bumped the revision, which also reset
    // the cache — must be dropped, never merged under the new key.
    if (cacheKey !== fetchedTrackValuesKey) {
      return;
    }
    const valuesById = new Map(
      entries.map(({ annotationId, values }) => [annotationId, values]),
    );
    const next = new Map(fetchedTrackValues.value);
    for (const annotationId of missingIds) {
      const values = valuesById.get(annotationId);
      // Ids absent from the response have no value doc at all — record the
      // confirmed miss so they are not refetched on every tracks change.
      next.set(
        annotationId,
        values ? asLeafValue(getValueFromObjectAndPath(values, path)) : null,
      );
    }
    fetchedTrackValues.value = next;
    // Recompute the warning now that coverage grew: an obsolete request can
    // fail WHILE this one is pending (warning correctly set at that instant),
    // and this success is what makes it moot — clearing only at request start
    // would strand it over fully resolved tracks.
    if (!hasUncoveredTrackMember()) {
      trackLabelFetchFailed.value = false;
    }
  } catch (error) {
    logError("Failed to fetch track label property values", error);
    // Warn only when a displayed member is actually uncovered: a superseded
    // key's failure says nothing about the current fetch state, and even a
    // current-key failure is moot once a newer request covered everything
    // shown (Retry would find nothing missing and could never clear it).
    if (cacheKey === fetchedTrackValuesKey && hasUncoveredTrackMember()) {
      trackLabelFetchFailed.value = true;
    }
  } finally {
    // Merged, dropped, or failed — these ids are no longer in flight, and a
    // failure leaves them refetchable by the next run or the Retry button.
    // Release them from the CAPTURED set this request added them to: after a
    // key change, the current set belongs to the new key's request, which may
    // have re-added the same ids — deleting from it would strand them as
    // neither cached nor pending, and the next pan would resend the batch.
    missingIds.forEach((id) => pending.delete(id));
  }
}

watch(
  [
    trackLabelActive,
    trackLabelPath,
    tracks,
    // The mode is settled by the annotation fetch while tracks are settled by
    // the connection fetch — parallel requests with no ordering guarantee. The
    // labels computed branches on the mode, so the fetcher must react to it
    // too, or a late flip to lazy mode leaves every track "no ID" with no
    // fetch ever issued.
    () => annotationStore.stubOnlyMode,
    // A recompute/import replaces the values server-side; refetch rather than
    // keep labelling from the superseded run.
    () => propertyStore.propertyValuesRevision,
  ],
  ensureTrackLabelValues,
  { immediate: true },
);

function trackTitle(track: ITrackRow): string {
  const resolution = trackLabels.value.get(track.id);
  if (
    resolution &&
    (resolution.status === "value" || resolution.status === "partial")
  ) {
    return formatTrackLabelValue(resolution.value);
  }
  return shortId(track.id);
}

// With a property label shown, the default id moves into the tooltip so the
// track can still be told apart from a same-valued neighbour. The full value
// leads because the title ellipsizes when a string value outgrows its cap.
function trackTitleTooltip(track: ITrackRow): string | undefined {
  const resolution = trackLabels.value.get(track.id);
  if (
    resolution &&
    (resolution.status === "value" || resolution.status === "partial")
  ) {
    return (
      `${formatTrackLabelValue(resolution.value)} · ` +
      `${trackLabelPropertyName.value} · ${shortId(track.id)}`
    );
  }
  return undefined;
}

function trackBadge(
  track: ITrackRow,
): { text: string; color?: string; tooltip: string } | null {
  const resolution = trackLabels.value.get(track.id);
  if (!resolution) {
    return null;
  }
  const propertyName = trackLabelPropertyName.value;
  switch (resolution.status) {
    case "value":
      // Partial/mixed take precedence (already staleness warnings); a clean
      // value shared with another displayed track means a split since the
      // property ran.
      if (duplicateTrackLabelValues.value.has(resolution.value)) {
        return {
          text: "duplicate ID",
          color: "warning",
          tooltip:
            `Another displayed track carries the same "${propertyName}" ` +
            `value — the property may predate a track split. Recompute it ` +
            `to refresh the ids.`,
        };
      }
      return null;
    case "partial":
      return {
        text: "partial",
        color: "warning",
        tooltip:
          `Some objects in this track have no "${propertyName}" value — ` +
          `the property may predate the current connections. Recompute it ` +
          `to refresh the ids.`,
      };
    case "mixed":
      return {
        text: "mixed IDs",
        color: "warning",
        tooltip:
          `Objects in this track carry differing "${propertyName}" values ` +
          `(${resolution.values.slice(0, 4).map(formatTrackLabelValue).join(", ")}` +
          `${resolution.values.length > 4 ? ", …" : ""}) — the property may ` +
          `predate the current connections. Recompute it to refresh the ids.`,
      };
    case "missing":
      return {
        text: "no ID",
        tooltip: `No "${propertyName}" values on this track's objects yet.`,
      };
  }
}

/**
 * A track's member ids that still resolve to an annotation or stub.
 *
 * `annotationIds` comes from the connection endpoints, which can outlive the
 * annotation they point at — the list deliberately keeps dangling links visible
 * so they can be deleted. Selecting those ids put phantom entries in the
 * selection: they inflate every "(N)" counter, and nothing can ever clear them
 * by clicking, because no row or feature exists to click.
 */
function resolvableTrackObjectIds(track: ITrackRow): string[] {
  const resolve = connectionListStore.resolveAnnotation;
  return track.annotationIds.filter((id) => resolve(id) !== undefined);
}

function selectableObjectCount(track: ITrackRow) {
  return resolvableTrackObjectIds(track).length;
}

/**
 * Select the track's objects, its links, or both. Each REPLACES its own
 * selection rather than adding — "select this track" means this track, and the
 * per-row checkboxes remain the way to build a union.
 *
 * Objects and links are separate selections feeding separate actions ("Connect
 * selected" reads the object selection, "Delete selected" the connection one),
 * so choosing one deliberately leaves the other alone. "Both" exists because
 * reviewing a track usually wants it.
 */
function selectTrackObjects(track: ITrackRow) {
  annotationStore.setSelected(resolvableTrackObjectIds(track));
}

function selectTrackConnections(track: ITrackRow) {
  connectionListStore.setSelectedConnectionIds(
    track.rows.map(({ connection }) => connection.id),
  );
}

function selectTrackBoth(track: ITrackRow) {
  selectTrackObjects(track);
  selectTrackConnections(track);
}

/**
 * Bring a connection into view in the list. Clicking a line in the viewer only
 * sets the selected id, so without this the highlighted link could sit on any
 * page with nothing indicating where.
 *
 * Deliberately does NOT open the Object Browser or switch tabs — a canvas click
 * should not throw a palette over the image. It only puts the row where it can
 * be found once the user looks.
 */
async function revealConnection(connectionId: string) {
  if (connectionListStore.grouping === "track") {
    const track = tracks.value.find((t) =>
      t.rows.some((row) => row.connection.id === connectionId),
    );
    if (track && !connectionListStore.isTrackExpanded(track.id)) {
      connectionListStore.toggleTrackExpanded(track.id);
    }
  } else {
    const index = rows.value.findIndex(
      ({ connection }) => connection.id === connectionId,
    );
    if (index < 0) {
      return;
    }
    const page = Math.floor(index / connectionListStore.itemsPerPage) + 1;
    if (page !== connectionListStore.page) {
      connectionListStore.setPage(page);
    }
  }
  await nextTick();
  document
    .querySelector(`[data-connection-id="${connectionId}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function revealCurrentSelection() {
  // EXISTING, not raw: the selection deliberately keeps ids for connections
  // deleted through other paths (existence is derived, not pruned). Using the
  // raw set meant one externally deleted selected connection blocked
  // hover-based reveal forever — every later click highlighted a row the list
  // would never page to.
  const selected = connectionListStore.selectedExistingConnectionIds;
  // A single selected connection is what a shift+click produces; a multi-select
  // made in the list needs no revealing.
  if (selected.length === 1) {
    revealConnection(selected[0]);
    return;
  }
  // A plain click in the viewer only HIGHLIGHTS, so hover has to reveal too —
  // otherwise clicking a line highlights a row the user cannot see. Safe to do
  // on hover: a row hovered in the list is by definition already on the current
  // page and on screen, so both the paging and the scroll are no-ops there.
  const hovered = connectionListStore.hoveredConnectionId;
  if (hovered) {
    revealConnection(hovered);
  }
}

watch(
  [
    () => connectionListStore.selectedConnectionIds,
    () => connectionListStore.hoveredConnectionId,
  ],
  revealCurrentSelection,
);

// Retry on show. A selection made while this tab was closed could not be
// revealed (the component had not mounted yet), and one made while it was
// merely hidden could not scroll, because a hidden row has no layout. Neither
// changes the selection, so the watcher above would never fire again.
watch(
  () => props.isActive,
  (isActive) => {
    if (isActive) {
      revealCurrentSelection();
    }
  },
  { immediate: true },
);

function toggleSelectAll() {
  connectionListStore.setSelectedConnectionIds(
    selectAllValue.value
      ? []
      : rows.value.map(({ connection }) => connection.id),
  );
}

/**
 * Toggle the track's disclosure, and frame it in the viewer when it OPENS.
 *
 * Only on open, deliberately. Framing on collapse too would yank the camera
 * back every time the user tidied up the list — including after they had panned
 * away on purpose — whereas expanding a track is an unambiguous "show me this
 * one".
 */
function toggleTrack(track: ITrackRow) {
  const willExpand = !connectionListStore.isTrackExpanded(track.id);
  connectionListStore.toggleTrackExpanded(track.id);
  if (willExpand) {
    goToTrack(track.annotationIds);
  }
}

// Navigate to the child (later) endpoint and select both endpoints so the
// Objects tab agrees with what the viewer is showing.
function navigateToConnection(row: IConnectionRow) {
  // Go there and HIGHLIGHT — deliberately not select. This mirrors the Objects
  // tab, where clicking a row navigates and sets hover while the checkbox is
  // what selects. Selecting on a mere row click would silently arm the bulk
  // delete and the connection action panel.
  connectionListStore.setHoveredConnectionId(row.connection.id);
  if (row.parent.missing && row.child.missing) {
    // Both endpoints are gone — nowhere to navigate. The row is still
    // checkbox-selectable so the dangling link can be deleted.
    return;
  }
  // Frames both endpoints when they share a frame — a connection is only drawn
  // when both are displayed, so centering on one would show nothing at zoom.
  goToConnection(row.parent.id, row.child.id);
}

async function deleteOne(connectionId: string) {
  isDeleting.value = true;
  try {
    await connectionListStore.deleteConnectionsById([connectionId]);
  } finally {
    isDeleting.value = false;
  }
}

async function deleteSelected() {
  isDeleting.value = true;
  try {
    await connectionListStore.deleteSelectedInScopeConnections();
  } finally {
    isDeleting.value = false;
  }
}

async function deleteTrack(track: ITrackRow) {
  isDeleting.value = true;
  try {
    await connectionListStore.deleteConnectionsById(
      track.rows.map(({ connection }) => connection.id),
    );
  } finally {
    isDeleting.value = false;
  }
}

async function connectSelected() {
  isConnecting.value = true;
  connectError.value = null;
  try {
    const created = await connectionListStore.connectSelectedAnnotations();
    if (created.length === 0) {
      // Distinguish dedupe from failure: the API layer catches HTTP errors and
      // returns null, which arrives here as an empty array, so an empty result
      // alone would misreport a permissions or server error as "already
      // connected". Only the store knows which happened.
      connectError.value = connectionListStore.lastConnectSkippedAsDuplicate
        ? "No new connections were created — the selected objects are already connected."
        : "Failed to create connections. See console for details.";
    }
  } catch (error) {
    logError("Failed to connect selected annotations", error);
    connectError.value =
      "Failed to create connections. See console for details.";
  } finally {
    isConnecting.value = false;
  }
}

defineExpose({
  revealCurrentSelection,
  rows,
  tracks,
  scopedCount,
  selectedCount,
  selectedInScopeCount,
  revealConnection,
  selectedVisibleCount,
  selectAllValue,
  selectAllIndeterminate,
  timeTies,
  tieMessage,
  emptyMessage,
  connectError,
  toggleSelectAll,
  navigateToConnection,
  deleteOne,
  deleteSelected,
  deleteTrack,
  connectSelected,
  toggleTrack,
  selectTrackObjects,
  selectTrackConnections,
  selectTrackBoth,
  selectableObjectCount,
  resolvableTrackObjectIds,
  swatchColor,
  showTrackSwatches,
  trackMeta,
  trackLabelItems,
  trackLabelKey,
  setTrackLabelFromKey,
  trackLabels,
  trackTitle,
  trackTitleTooltip,
  trackBadge,
  ensureTrackLabelValues,
  trackLabelFetchFailed,
  trackFiltersActive,
  scopeOnlyCount,
  countText,
  updateTrackFilterBound,
  clearTrackFilters,
  danglingCount,
  danglingDialogOpen,
  confirmCleanDangling,
});
</script>

<style lang="scss" scoped>
.connection-list-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.connection-list-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  flex: 0 0 auto;
}

.scope-select {
  max-width: 220px;
}

.track-label-select {
  max-width: 280px;
}

.track-badge {
  flex: 0 0 auto;
}

.connection-count {
  font-size: 12px;
  opacity: 0.7;
}

.track-filter-menu {
  min-width: 340px;
}

.track-filter-title {
  display: flex;
  align-items: center;
  font-size: 14px;
}

.track-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  &:last-child {
    margin-bottom: 0;
  }
}

.track-filter-label {
  flex: 1 1 auto;
  font-size: 13px;
}

.track-filter-bound {
  flex: 0 0 72px;
}

.track-filter-dash {
  opacity: 0.6;
}

.dangling-note {
  font-size: 12px;
  opacity: 0.7;
}

.connection-list-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.connection-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 32px 16px;
  opacity: 0.7;
}

.track-group {
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}

.track-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  cursor: pointer;
  user-select: none;
}

.track-header:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.track-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: 0 0 auto;
  /* The hues are tuned to read against the image, not against the palette's
     own background; a hairline keeps a pale track from dissolving into it. */
  box-shadow: 0 0 0 1px rgba(var(--v-theme-on-surface), 0.25);
}

.track-title {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  /* A property label can be an arbitrary string; cap and ellipsize so it can
     never push the badge, meta and row actions out of the panel. The full
     value stays available in the tooltip. flex-shrink: 0 (not min-width: 0)
     so the cap binds only the title's OWN content — row pressure keeps
     squeezing .track-meta first, and a short title never ellipsizes just
     because a badge tightened the row. */
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Shrinks and truncates ahead of the title and the actions — the counts are
   the least load-bearing part of the header. */
.track-meta {
  font-size: 11px;
  opacity: 0.6;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-table {
  width: 100%;
  border-collapse: collapse;
  margin-left: 16px;
}
</style>
