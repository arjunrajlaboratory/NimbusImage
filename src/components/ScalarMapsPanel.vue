<template>
  <div class="scalar-maps-panel pa-3">
    <!-- The viewer's own object switch (hotkey A, Object display settings),
         offered here too: cells drawn over a map hide it. One piece of state,
         held in the main store; this is a second control for it. -->
    <div class="text-caption text-medium-emphasis mb-1">Objects</div>
    <div class="d-flex align-center mb-3 objects-toggle">
      <v-checkbox-btn
        :model-value="store.drawAnnotations"
        color="primary"
        density="compact"
        aria-label="Show objects"
        class="flex-grow-0 mr-1"
        @update:model-value="store.setDrawAnnotations(!!$event)"
      />
      <div>
        <div class="text-body-2 font-weight-medium">Show objects</div>
        <div class="text-caption text-medium-emphasis">
          Cells and other annotations, drawn over the maps (hotkey A)
        </div>
      </div>
    </div>
    <div class="d-flex align-center mb-1">
      <span class="text-caption text-medium-emphasis">Saved maps</span>
      <v-spacer />
      <v-tooltip text="List saved maps again and reload failed tiles">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            icon="mdi-refresh"
            size="small"
            aria-label="Refresh saved maps"
            :loading="scalarMapsStore.loading"
            :disabled="scalarMapsStore.loading"
            @click="refresh"
          />
        </template>
      </v-tooltip>
    </div>
    <div v-if="scalarMapsStore.scalarMapsError" class="mb-2">
      <p class="text-body-2 text-error">
        {{ scalarMapsStore.scalarMapsError }}
      </p>
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        :loading="scalarMapsStore.loading"
        :disabled="scalarMapsStore.loading"
        @click="refresh"
        >Retry map lookup</v-btn
      >
    </div>
    <template v-if="maps.length === 0">
      <p v-if="!scalarMapsStore.scalarMapsError" class="text-body-2 mb-2">
        {{
          scalarMapsStore.loading
            ? "Reading saved maps…"
            : "No saved maps for this dataset."
        }}
      </p>
      <p
        v-if="!scalarMapsStore.scalarMapsError && !scalarMapsStore.loading"
        class="text-caption text-medium-emphasis mb-0"
      >
        Run the Hotspot Regions worker with <em>Save map layer</em> on to create
        one.
      </p>
    </template>
    <p
      v-if="maps.length > 1"
      class="text-caption text-medium-emphasis mb-2 reorder-hint"
    >
      Drag to reorder. The top map is drawn on top.
    </p>
    <!-- Dragged only by the handle, so the sliders, the checkbox and text
         selection inside a card keep working. The order is the store's
         (`reorderScalarMaps`), and the overlay stacks by it. -->
    <draggable
      :key="listRemounts"
      :model-value="maps"
      item-key="itemId"
      handle=".map-drag-handle"
      :animation="150"
      @start="onDragStart"
      @end="onDragEnd"
      @update:model-value="reorder"
    >
      <template #item="{ element: map }">
        <v-card
          variant="outlined"
          class="mb-3 pa-2 map-card"
          :data-map-id="map.itemId"
        >
          <div class="d-flex align-start">
            <span
              v-if="maps.length > 1"
              class="map-drag-handle flex-grow-0 mr-1 mt-1"
              role="img"
              :aria-label="`Drag to reorder ${scalarMapTitle(map.meta)}`"
              title="Drag to reorder"
            >
              <v-icon icon="mdi-drag-vertical" size="small" />
            </span>
            <v-checkbox-btn
              :model-value="displayOf(map).visible"
              color="primary"
              density="compact"
              :aria-label="`Show ${scalarMapTitle(map.meta)}`"
              class="flex-grow-0 mr-1"
              @update:model-value="update(map, { visible: !!$event })"
            />
            <div class="flex-grow-1 map-title">
              <div class="text-body-2 font-weight-medium">
                {{ scalarMapTitle(map.meta) }}
              </div>
              <div
                v-if="scalarMapSummary(map.meta)"
                class="text-caption text-medium-emphasis"
              >
                {{ scalarMapSummary(map.meta) }}
              </div>
            </div>
            <v-btn
              v-if="canDelete"
              variant="text"
              color="error"
              size="small"
              icon="mdi-delete"
              :aria-label="`Delete ${scalarMapTitle(map.meta)}`"
              @click="askDelete(map)"
            />
          </div>

          <!-- Only while the palette is shown: FloatingPalette keeps it mounted
           (display:none) when closed, and the body reads the viewer's
           position, so every scrub would re-render every shown map's card. -->
          <template v-if="visible && displayOf(map).visible">
            <p
              v-if="!hasDataHere(map)"
              class="text-caption text-warning mt-1 mb-0 no-data-here"
            >
              This map has no data at the current position.
            </p>
            <p
              v-if="scalarMapsStore.tileFailedMapIds.includes(map.itemId)"
              class="text-caption text-warning mt-1 mb-0 tiles-failed"
            >
              Some tiles of this map failed to load. Press Refresh to try again.
            </p>

            <div class="text-caption mt-2">
              Opacity {{ Math.round(displayOf(map).opacity * 100) }}%
            </div>
            <v-slider
              :model-value="displayOf(map).opacity"
              :min="0.05"
              :max="1"
              :step="0.05"
              density="compact"
              hide-details
              @update:model-value="update(map, { opacity: $event })"
            />

            <v-select
              :model-value="displayOf(map).colormap"
              :items="SCALAR_MAP_COLORMAPS"
              item-title="title"
              item-value="value"
              label="Colormap"
              density="compact"
              variant="outlined"
              hide-details
              class="mt-2"
              @update:model-value="update(map, { colormap: $event })"
            />

            <div
              v-if="legendGradient(displayOf(map).colormap)"
              class="color-bar mt-2"
              :style="{ background: legendGradient(displayOf(map).colormap)! }"
            />
            <div class="d-flex text-caption color-bar-labels">
              <span>{{ formatMapValue(displayOf(map).min) }}</span>
              <v-spacer />
              <span v-if="map.meta.units" class="text-medium-emphasis">{{
                map.meta.units
              }}</span>
              <v-spacer />
              <span>{{ formatMapValue(displayOf(map).max) }}</span>
            </div>

            <div class="d-flex align-center text-caption mt-2">
              Display range
              <v-spacer />
              <v-btn
                variant="text"
                size="small"
                @click="scalarMapsStore.resetScalarMapRange(map.itemId)"
                >Reset</v-btn
              >
            </div>
            <!-- Integer positions, never a float step: see SLIDER_POSITIONS. -->
            <v-range-slider
              :model-value="rangePositions(map)"
              :min="0"
              :max="SLIDER_POSITIONS"
              :step="1"
              density="compact"
              hide-details
              @update:model-value="onRange(map, $event)"
            />

            <v-switch
              :model-value="displayOf(map).thresholdEnabled"
              label="Preview a threshold"
              color="primary"
              density="compact"
              hide-details
              class="mt-1"
              @update:model-value="update(map, { thresholdEnabled: !!$event })"
            />
            <template v-if="displayOf(map).thresholdEnabled">
              <div class="d-flex align-center flex-wrap ga-2 mb-1">
                <v-btn-toggle
                  :model-value="displayOf(map).thresholdSide"
                  mandatory
                  density="compact"
                  variant="outlined"
                  divided
                  @update:model-value="
                    scalarMapsStore.setScalarMapThresholdSide({
                      itemId: map.itemId,
                      side: $event,
                    })
                  "
                >
                  <v-btn value="above" size="small">Above</v-btn>
                  <v-btn value="below" size="small">Below</v-btn>
                </v-btn-toggle>
                <v-btn-toggle
                  v-model="thresholdUnits"
                  mandatory
                  density="compact"
                  variant="outlined"
                  divided
                >
                  <v-btn value="share" size="small">% of tissue</v-btn>
                  <v-btn value="value" size="small">Value</v-btn>
                </v-btn-toggle>
              </div>
              <v-slider
                v-if="thresholdUnits === 'share'"
                :model-value="shareOf(map).requested ?? shareOf(map).selected"
                :min="0"
                :max="100"
                :step="0.5"
                density="compact"
                hide-details
                @update:model-value="onShare(map, $event)"
              />
              <v-slider
                v-else
                :model-value="thresholdPosition(map)"
                :min="0"
                :max="SLIDER_POSITIONS"
                :step="1"
                density="compact"
                hide-details
                @update:model-value="onThresholdPosition(map, $event)"
              />
              <div class="text-caption threshold-readout">
                {{ thresholdText(map) }}
              </div>
              <div class="text-caption text-medium-emphasis mt-1">
                For the Hotspot Regions tool:
              </div>
              <!-- Two rows per form, label beside its value, so a phrase never
               wraps away from its number. -->
              <div
                v-for="form in workerForms(map)"
                :key="form.type"
                class="text-caption worker-form"
              >
                <span class="worker-form-label">Threshold type</span>
                <code class="worker-form-value">{{ form.type }}</code>
                <span class="worker-form-label">Threshold</span>
                <span>
                  <code class="worker-form-value">{{ form.threshold }}</code>
                  <span
                    v-if="form.approximate"
                    class="ml-1 text-medium-emphasis approximate"
                    >(≈ approximate)</span
                  >
                </span>
              </div>
            </template>
          </template>
        </v-card>
      </template>
    </draggable>

    <v-dialog v-model="deleteDialog" max-width="420">
      <v-card>
        <v-card-title>Delete saved map?</v-card-title>
        <v-card-text>
          <p class="mb-2">
            “{{ pendingDelete ? scalarMapTitle(pendingDelete.meta) : "" }}” will
            be deleted for everyone with access to this dataset. Regions already
            created from it are kept.
          </p>
          <p v-if="deleteError" class="text-error mb-0">{{ deleteError }}</p>
        </v-card-text>
        <v-card-actions class="button-bar">
          <v-spacer />
          <v-btn
            variant="text"
            size="small"
            :disabled="deleting"
            @click="deleteDialog = false"
            >Cancel</v-btn
          >
          <v-btn
            variant="flat"
            color="error"
            size="small"
            :loading="deleting"
            :disabled="deleting"
            @click="confirmDelete"
            >Delete</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import draggable from "vuedraggable";
import store from "@/store";
import scalarMapsStore, { defaultScalarMapDisplay } from "@/store/scalarMaps";
import sync from "@/store/sync";
import {
  IScalarMap,
  IScalarMapDisplay,
  TScalarMapColormap,
} from "@/store/model";
import {
  SCALAR_MAP_COLORMAPS,
  SLIDER_POSITIONS,
  displayValueRange,
  formatMapValue,
  formatRequestedShare,
  formatShare,
  scalarMapLocationKey,
  scalarMapSummary,
  scalarMapTitle,
  separatedRangePositions,
  sliderPositionToValue,
  thresholdShare,
  valueToSliderPosition,
  workerThresholdForms,
} from "@/utils/scalarMap";
import { cssLinearGradient } from "@/utils/colors";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";

/**
 * The Map Layers palette (HOTSPOT_REGIONS_WORKER.md §8.3): the dataset's
 * saved scalar maps, how ScalarMapOverlay draws each, and a threshold
 * preview that reads both as a value and as a share of tissue, in the forms
 * the Hotspot Regions worker takes.
 */

const props = defineProps<{ visible: boolean }>();

const maps = computed(() => scalarMapsStore.currentMaps);

// Sliders for the threshold in percent of tissue or in map units.
const thresholdUnits = ref<"share" | "value">("share");

const deleteDialog = ref(false);
const pendingDelete = ref<IScalarMap | null>(null);
// Whether the map this confirmation names has a DELETE in flight. Read from
// the store, which holds it per item until the request settles: the request
// outlives the dialog (Escape while deleting), so a flag reset on close let
// a reopened confirmation send a second DELETE for the same map.
const deleting = computed(
  () =>
    pendingDelete.value !== null &&
    scalarMapsStore.deletingMapIds.includes(pendingDelete.value.itemId),
);
const deleteError = ref<string | null>(null);

// The server enforces WRITE; this only hides the control from sessions that
// can never have it (logged out, or a read-only share link).
const canDelete = computed(
  () => store.isLoggedIn && !store.girderUser?.shareLink,
);

function displayOf(map: IScalarMap): IScalarMapDisplay {
  return scalarMapsStore.display[map.itemId] ?? defaultScalarMapDisplay(map);
}

function update(
  map: IScalarMap,
  changes: Parameters<
    typeof scalarMapsStore.updateScalarMapDisplay
  >[0]["changes"],
) {
  scalarMapsStore.updateScalarMapDisplay({ itemId: map.itemId, changes });
}

// A drop: the whole list in its new order (vuedraggable never changes the
// array it is given). Session-only, like `display`.
function reorder(reordered: IScalarMap[]) {
  if (listChangedDuringDrag()) {
    return;
  }
  const itemIds = reordered.map((map) => map.itemId);
  scalarMapsStore.reorderScalarMaps(itemIds);
  // The drop's own change is not a change made under the drag.
  dragStartIds.value = itemIds;
}

// A drag in progress: the listed ids when it started, or null when no card
// is being dragged. Set by the list's `start`, cleared by its `end`; a drop
// (`reorder`, which runs before `end`) moves it to the order it committed.
// It exists because the list can change under a drag (a re-list after a job
// ends, a delete settling): vuedraggable moves the element at the index it
// captured at drag start, so on a changed list the drop would move another
// map and leave the DOM order unlike the list. Such a drop is ignored and
// the list is mounted again from the store. A drag whose `end` never fires
// (the palette is unmounted) leaves nothing behind: the next `start`
// overwrites it, and `reorder` only runs during a drag.
const dragStartIds = ref<string[] | null>(null);
// Bumped to mount the list again after an ignored drop.
const listRemounts = ref(0);

function listChangedDuringDrag(): boolean {
  const started = dragStartIds.value;
  return (
    started !== null &&
    (started.length !== maps.value.length ||
      maps.value.some((map, index) => map.itemId !== started[index]))
  );
}

function onDragStart() {
  dragStartIds.value = maps.value.map((map) => map.itemId);
}

function onDragEnd() {
  if (listChangedDuringDrag()) {
    listRemounts.value++;
  }
  dragStartIds.value = null;
}

// Refresh lists the maps again and requests every failed tile again: GeoJS
// keeps a failed tile and never asks for it on its own, and a re-list that
// finds the same revision leaves the tile URL as it was.
function refresh() {
  scalarMapsStore.requestScalarMapTileRetry();
  scalarMapsStore.refreshScalarMaps(true);
}

function hasDataHere(map: IScalarMap): boolean {
  return scalarMapLocationKey(map.meta, store.xy, store.z, store.time) !== null;
}

/** The server's anchor table as a CSS gradient; null until it is loaded. */
function legendGradient(colormap: TScalarMapColormap): string | null {
  const stops = scalarMapsStore.colormapStops?.[colormap];
  return stops && stops.length > 0
    ? cssLinearGradient(stops, "to right")
    : null;
}

// The sliders' value bounds: the map's range, widened if it is constant.
function bounds(map: IScalarMap): [number, number] {
  return displayValueRange(map.meta.valueRange);
}

function rangePositions(map: IScalarMap): number[] {
  const display = displayOf(map);
  return [
    valueToSliderPosition(display.min, bounds(map)),
    valueToSliderPosition(display.max, bounds(map)),
  ];
}

function onRange(map: IScalarMap, positions: number[]) {
  const [low, high] = separatedRangePositions(positions, rangePositions(map));
  update(map, {
    min: sliderPositionToValue(low, bounds(map)),
    max: sliderPositionToValue(high, bounds(map)),
  });
}

function thresholdPosition(map: IScalarMap): number {
  return valueToSliderPosition(displayOf(map).threshold, bounds(map));
}

function onThresholdPosition(map: IScalarMap, position: number) {
  scalarMapsStore.setScalarMapThresholdValue({
    itemId: map.itemId,
    value: sliderPositionToValue(position, bounds(map)),
  });
}

function shareOf(map: IScalarMap) {
  const display = displayOf(map);
  return thresholdShare(
    map.meta.percentiles,
    display.threshold,
    display.thresholdSide,
    display.thresholdPercent,
  );
}

function onShare(map: IScalarMap, percent: number) {
  scalarMapsStore.setScalarMapThresholdPercent({ itemId: map.itemId, percent });
}

function thresholdText(map: IScalarMap): string {
  const display = displayOf(map);
  const above = display.thresholdSide === "above";
  const units = map.meta.units ? ` ${map.meta.units}` : "";
  const value = `Value ${above ? "≥" : "≤"} ${formatMapValue(
    display.threshold,
  )}${units}`;
  const share = shareOf(map);
  const sideWord = above ? "top" : "bottom";
  // An estimate from the percentiles pooled over every position of the map,
  // not a count on the plane on screen. A share the user set is shown as set
  // (no rounding past the slider's 0.5 steps); a derived one is rounded.
  const shown =
    share.requested !== null && !share.tied
      ? formatRequestedShare(share.requested)
      : formatShare(share.selected);
  const estimate = `≈ ${sideWord} ${shown}% of tissue (all positions)`;
  if (share.tied && share.requested !== null) {
    return `${value} · ${estimate}; ${formatRequestedShare(
      share.requested,
    )}% requested, more selected because of ties at the cutoff`;
  }
  return `${value} · ${estimate}`;
}

function workerForms(map: IScalarMap) {
  const display = displayOf(map);
  return workerThresholdForms(
    map.meta.percentiles,
    display.threshold,
    display.thresholdSide,
    display.thresholdPercent,
  );
}

// One confirmation is one session. The palette is mounted for the app's
// lifetime, so a dialog can outlive its dataset (browser Back/Forward) and a
// request can outlive its dialog (Escape while deleting): a result (closing
// the dialog, or its error) applies only to the session that started it,
// and closing the dialog or switching datasets ends the session. Ending a
// session does not end the request: `deleting` stays true for that map until
// the store says it settled.
let deleteSession = 0;

// `pendingDelete` is kept so the closing dialog does not flash an empty
// name; confirmDelete refuses a map that is not on screen anyway.
function endDeleteSession() {
  deleteSession++;
  deleteError.value = null;
}

function askDelete(map: IScalarMap) {
  endDeleteSession();
  pendingDelete.value = map;
  deleteDialog.value = true;
}

async function confirmDelete() {
  const map = pendingDelete.value;
  // Only a map of the dataset on screen: the confirmation names one of them.
  // Never a map already being deleted (the store would join that request,
  // but this session did not start it).
  // Nor while a dataset view loads: `store.dataset`, and so `currentMaps`,
  // is still the outgoing dataset's until the fetch completes.
  if (
    !map ||
    deleting.value ||
    sync.datasetLoading ||
    !scalarMapsStore.currentMaps.some(
      (candidate) => candidate.itemId === map.itemId,
    )
  ) {
    return;
  }
  const session = deleteSession;
  deleteError.value = null;
  try {
    await scalarMapsStore.deleteScalarMap(map.itemId);
    if (session === deleteSession) {
      deleteDialog.value = false;
    }
  } catch (error) {
    logError("Failed to delete the saved map:", error);
    if (session === deleteSession) {
      deleteError.value = extractErrorMessage(error);
    }
  }
}

watch(deleteDialog, (open) => {
  if (!open) {
    endDeleteSession();
  }
});

function closeDeleteDialog() {
  deleteDialog.value = false;
  endDeleteSession();
}

// The dialog is teleported, so nothing else closes it with its context: end
// the confirmation when a dataset view starts loading (Back/Forward sets
// `sync.datasetLoading` while `store.dataset` is still the one being left)
// or the dataset changes, when the palette is hidden
// (navigating Home can hide it without changing the dataset), and when the
// map it names leaves the list (a job's re-list removed it, or another tab
// deleted it), which would otherwise leave a Delete that does nothing.
watch(() => [store.dataset?.id, sync.datasetLoading], closeDeleteDialog);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      closeDeleteDialog();
    }
  },
);

watch(
  () =>
    deleteDialog.value &&
    pendingDelete.value !== null &&
    !scalarMapsStore.currentMaps.some(
      (candidate) => candidate.itemId === pendingDelete.value!.itemId,
    ),
  (targetGone) => {
    if (targetGone) {
      closeDeleteDialog();
    }
  },
);

// The palette content stays mounted while hidden: list the maps again only
// when it is shown (a worker run may have saved one since), and for a new
// dataset while it is open. Opening a dataset (App.vue) lists them too; the
// store shares one request between the two.
watch(
  () => [props.visible, store.dataset?.id],
  () => {
    if (props.visible && store.dataset?.id) {
      scalarMapsStore.refreshScalarMaps();
      scalarMapsStore.ensureScalarMapColormapStops();
    }
  },
  { immediate: true },
);

defineExpose({
  thresholdUnits,
  thresholdText,
  workerForms,
  onShare,
  onRange,
  onThresholdPosition,
  rangePositions,
  thresholdPosition,
  legendGradient,
  askDelete,
  confirmDelete,
  canDelete,
  refresh,
});
</script>

<style lang="scss" scoped>
.scalar-maps-panel {
  width: 100%;
}

.map-drag-handle {
  cursor: grab;
  display: inline-flex;
}

.map-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.color-bar {
  height: 12px;
  border-radius: 2px;
}

.worker-form {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  column-gap: 8px;
  align-items: baseline;
  margin-top: 4px;
}

.worker-form-label {
  white-space: nowrap;
}

.worker-form-value {
  font-family: monospace;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
</style>
