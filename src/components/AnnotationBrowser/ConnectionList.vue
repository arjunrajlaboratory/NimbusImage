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
        :disabled="!isLoggedIn || selectedCount === 0 || isDeleting"
        :loading="isDeleting"
        @click="deleteSelected"
      >
        Delete selected ({{ selectedCount }})
      </v-btn>
    </div>

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
            <span class="track-title">Track {{ shortId(track.id) }}</span>
            <span class="track-meta">
              {{ track.annotationCount }} objects
              <template v-if="track.timeRange">
                · T{{ track.timeRange.start + 1 }}–T{{
                  track.timeRange.end + 1
                }}
              </template>
              · {{ track.rows.length }} links
            </span>
            <v-spacer />
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
import { computed, ref } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import connectionListStore, {
  CONNECTION_SCOPE_LABELS,
  TConnectionScope,
} from "@/store/connectionList";
import ConnectionListRow from "@/components/AnnotationBrowser/ConnectionListRow.vue";
import { goToAnnotationLocation } from "@/utils/annotationNavigation";
import { logError } from "@/utils/log";
import {
  IConnectionRow,
  ITrackRow,
  shortAnnotationId,
} from "@/utils/connections";

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
const rows = computed(() => connectionListStore.connectionRows);
const tracks = computed(() => connectionListStore.trackRows);
const scopedCount = computed(
  () => connectionListStore.scopedConnections.length,
);
const hoveredId = computed(() => connectionListStore.hoveredConnectionId);
const selectedCount = computed(
  () => connectionListStore.selectedConnectionIds.size,
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

const emptyMessage = computed(() => {
  switch (connectionListStore.scope) {
    case "all":
      return "This dataset has no connections.";
    case "location":
      return "No connections touch an object at the current location.";
    case "selected":
      return "No connections touch the selected objects.";
    case "filtered":
      return "No connections touch an object passing the current filters.";
  }
  return "No connections.";
});

const selectAllValue = computed(
  () => rows.value.length > 0 && selectedCount.value >= rows.value.length,
);
const selectAllIndeterminate = computed(
  () => selectedCount.value > 0 && !selectAllValue.value,
);

function shortId(id: string) {
  return shortAnnotationId(id);
}

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
  connectionListStore.setSelectedConnectionIds([row.connection.id]);
  // Prefer the child (later) endpoint; fall back to the parent when the child
  // is dangling. If both are gone there is nowhere to navigate.
  const target = row.child.missing ? row.parent : row.child;
  if (target.missing) {
    return;
  }
  annotationStore.setSelected(
    [row.parent, row.child]
      .filter((endpoint) => !endpoint.missing)
      .map(({ id }) => id),
  );
  goToAnnotationLocation(target.id);
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
    await connectionListStore.deleteSelectedConnections();
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
      connectError.value =
        "No new connections were created — the selected objects are already connected.";
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
  rows,
  tracks,
  scopedCount,
  selectedCount,
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

.track-title {
  font-size: 13px;
  font-weight: 500;
}

.track-meta {
  font-size: 11px;
  opacity: 0.6;
}

.track-table {
  width: 100%;
  border-collapse: collapse;
  margin-left: 16px;
}
</style>
