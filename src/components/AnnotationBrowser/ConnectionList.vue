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
      <v-spacer />
      <span class="connection-count">{{ scopedCount.toLocaleString() }}</span>
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
            <span class="track-title">Track {{ shortId(track.id) }}</span>
            <!-- Also in the title attribute: the counts are what gets
                 ellipsized when the row is tight, and the link count is the
                 diagnostic one (it exceeds objects−1 only when a track
                 branches or carries duplicate links). -->
            <span class="track-meta" :title="trackMeta(track)">
              {{ trackMeta(track) }}
            </span>
            <v-spacer />
            <!-- "Select", not "Select objects": the two actions plus the
                 swatch pushed the header onto two lines at the palette's
                 512px, and 248 tracks at two lines each is a lot of scroll. -->
            <v-btn
              variant="text"
              size="x-small"
              title="Select this track's objects"
              @click.stop="selectTrackObjects(track)"
            >
              <v-icon size="small" start>mdi-select-group</v-icon>
              Select
            </v-btn>
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
  TConnectionScope,
} from "@/store/connectionList";
import { MAX_CONNECT_SELECTED } from "@/store/constants";
import ConnectionListRow from "@/components/AnnotationBrowser/ConnectionListRow.vue";
import { goToConnection } from "@/utils/annotationNavigation";
import { logError } from "@/utils/log";
import {
  IConnectionRow,
  ITrackRow,
  shortAnnotationId,
  trackColor,
} from "@/utils/connections";

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

const emptyMessage = computed(() => EMPTY_MESSAGES[connectionListStore.scope]);

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

// `track.id` is the track key, so this is the same input the viewer colours
// from — the swatch matches the drawn line rather than merely resembling it.
const showTrackSwatches = computed(
  () => store.timelapseTrackColoring === "track",
);

function swatchColor(track: ITrackRow) {
  return trackColor(track.id, store.timelapseColorSeed);
}

function trackMeta(track: ITrackRow) {
  const range = track.timeRange
    ? ` · T${track.timeRange.start + 1}–T${track.timeRange.end + 1}`
    : "";
  return `${track.annotationCount} objects${range} · ${track.rows.length} links`;
}

/**
 * Select every object in the track. Replaces the selection rather than adding
 * to it: "select this track" means this track, and the Objects tab's own
 * checkboxes remain the way to build a union.
 */
function selectTrackObjects(track: ITrackRow) {
  annotationStore.setSelected(track.annotationIds);
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

function toggleTrack(track: ITrackRow) {
  connectionListStore.toggleTrackExpanded(track.id);
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
  selectTrackObjects,
  swatchColor,
  showTrackSwatches,
  trackMeta,
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

.connection-count {
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
