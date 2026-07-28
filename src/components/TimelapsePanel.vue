<template>
  <div class="timelapse-panel">
    <value-slider
      v-model="trackWindow"
      class="window-slider"
      label="Window"
      :min="3"
      :max="100"
      title="How many timepoints of track to draw on either side of the current frame"
    />

    <tag-picker
      :data-tour="TOUR_ANCHORS.timelapseTags"
      v-model="timelapseTags"
      class="tag-picker"
    />

    <div class="control-row">
      <v-checkbox
        :data-tour="TOUR_ANCHORS.timelapseLabels"
        v-model="showLabels"
        class="compact-checkbox"
        label="Labels"
        hide-details
        density="compact"
      />
      <v-spacer />
      <!-- Icon-only, so each needs a tooltip per BUTTON_CONVENTIONS.md §6 —
           none of these three icons is self-explanatory. Each also carries an
           aria-label: a tooltip is a hover affordance and gives a screen reader
           nothing to announce for a button whose only content is an icon. -->
      <v-btn-toggle
        :model-value="trackColoring"
        density="compact"
        mandatory
        divided
        variant="outlined"
        @update:model-value="timelapseStore.setTrackColoring"
      >
        <v-tooltip text="Give each track its own color">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              value="track"
              size="x-small"
              aria-label="Color each track separately"
            >
              <v-icon size="small">mdi-palette</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
        <v-tooltip text="Draw every track in one color">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              value="uniform"
              size="x-small"
              aria-label="Draw every track in one color"
            >
              <v-icon size="small">mdi-invert-colors-off</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
      </v-btn-toggle>
      <v-tooltip text="Shuffle track colors">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            size="x-small"
            icon
            aria-label="Shuffle track colors"
            :disabled="trackColoring !== 'track'"
            @click="timelapseStore.shuffleColors"
          >
            <v-icon size="small">mdi-shuffle-variant</v-icon>
          </v-btn>
        </template>
      </v-tooltip>
    </div>

    <div class="control-row track-summary">
      <span class="summary-text">
        {{ trackCount.toLocaleString() }}
        {{ trackCount === 1 ? "track" : "tracks" }} ·
        {{ connectionCount.toLocaleString() }}
        {{ connectionCount === 1 ? "link" : "links" }}
      </span>
      <v-spacer />
      <v-btn
        variant="outlined"
        size="x-small"
        :disabled="connectionCount === 0"
        @click="showTracks"
      >
        Show tracks
      </v-btn>
    </div>

    <div class="control-row">
      <v-btn
        variant="text"
        color="error"
        size="x-small"
        class="delete-btn"
        :disabled="!isLoggedIn || timelapseTaggedCount === 0 || isDeleting"
        :loading="isDeleting"
        @click="deleteAll"
      >
        <v-icon start size="small">mdi-delete</v-icon>
        Delete all timelapse connections
      </v-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import ValueSlider from "./ValueSlider.vue";
import TagPicker from "./TagPicker.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import connectionListStore from "@/store/connectionList";
import timelapseStore from "@/store/timelapse";
import { TIMELAPSE_CONNECTION_TAG } from "@/store/constants";
import { TOUR_ANCHORS } from "@/tours/anchors";

const isDeleting = ref(false);

const trackWindow = computed({
  get: () => timelapseStore.modeWindow,
  set: (value: number) => timelapseStore.setModeWindow(value),
});

const timelapseTags = computed({
  get: () => timelapseStore.tags,
  set: (value: string[]) => timelapseStore.setTags(value),
});

const showLabels = computed({
  get: () => timelapseStore.showLabels,
  set: (value: boolean) => timelapseStore.setShowLabels(value),
});

const trackColoring = computed(() => timelapseStore.trackColoring);

// `deleteAllTimelapseConnections` returns immediately when not logged in
// (src/store/annotation.ts:1141), so without this the button is enabled for a
// signed-out viewer of a public dataset and the click silently does nothing.
// Not a security check — the backend owns that; this is just not offering an
// action that provably no-ops. ConnectionLists delete controls already do it.
const isLoggedIn = computed(() => store.isLoggedIn);

// Every connection, deliberately: the timelapse view draws any connection whose
// endpoints are both displayed, regardless of tag, so this is what the readout
// beside "N tracks" is counting.
const connectionCount = computed(
  () => annotationStore.annotationConnections.length,
);

// ...but the delete button's guard must count what the ACTION deletes, which is
// only the tagged subset. Guarding on the total left the button enabled on a
// dataset whose connections are all hand-made or from Connect-to-nearest, where
// clicking it deleted nothing and reported nothing.
const timelapseTaggedCount = computed(
  () =>
    annotationStore.annotationConnections.filter((connection) =>
      connection.tags.includes(TIMELAPSE_CONNECTION_TAG),
    ).length,
);

// Gated on the mode, for the same reason ConnectionList gates its row getters:
// FloatingPalette uses v-show, so this component stays mounted for the whole
// session whether or not timelapse is ever switched on. `trackCount` runs a
// union-find over every connection, so an ungated read pays it on load for
// every dataset with connections — and again on every connection create or
// delete, doubling the work the draw path is already doing.
const trackCount = computed(() =>
  timelapseStore.showMode ? connectionListStore.trackCount : 0,
);

// Open the Object Browser on the track view. Sets the grouping too: landing on
// the flat connection list after clicking "Show tracks" would be the wrong
// answer to what was asked.
function showTracks() {
  connectionListStore.setGrouping("track");
  store.openAnnotationBrowserTab("connections");
}

async function deleteAll() {
  isDeleting.value = true;
  try {
    await annotationStore.deleteAllTimelapseConnections();
  } finally {
    isDeleting.value = false;
  }
}

defineExpose({
  trackCount,
  isLoggedIn,
  connectionCount,
  timelapseTaggedCount,
  showTracks,
  deleteAll,
});
</script>

<style lang="scss" scoped>
.timelapse-panel {
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
}

/* The sliders in the Navigator reserve a fixed 3em label column, which wraps
   "Window" onto its own line at this panel's narrower width. */
.window-slider :deep(.label-column) {
  width: auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  padding-right: 6px;
}

.tag-picker {
  font-size: 13px;
}

.compact-checkbox {
  flex: 0 0 auto;
}
.compact-checkbox :deep(.v-label) {
  font-size: 13px;
  opacity: 1;
}
.compact-checkbox :deep(.v-input__control) {
  transform: scale(0.9);
  transform-origin: left center;
}

.track-summary {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  padding-top: 6px;
  margin-top: 2px;
}

.summary-text {
  font-size: 12px;
  opacity: 0.7;
}

.delete-btn {
  font-size: 11px;
  letter-spacing: 0;
}
</style>
