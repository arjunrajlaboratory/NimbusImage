<template>
  <div class="navigator-panel">
    <div v-mousetrap="mousetrapSliders" :data-tour="TOUR_ANCHORS.viewerToolbar">
      <div class="d-flex align-center">
        <value-slider
          v-model="xy"
          label="XY"
          :min="0"
          :max="maxXY"
          :title="maxXY > 0 ? maxXY + 1 + ' XY Values (Hotkeys w/r)' : ''"
          :offset="1"
          :value-label="xyLabel"
          :is-unrolled="unrollXY"
        />
        <v-checkbox
          v-if="maxXY > 0 || unrollXY"
          class="ml-3 my-checkbox"
          v-model="unrollXY"
          label="Unroll"
          :disabled="!(maxXY > 0 || unrollXY)"
        />
      </div>
      <div class="d-flex align-center">
        <value-slider
          v-model="z"
          label="Z"
          :min="0"
          :max="maxZ"
          :title="maxZ > 0 ? maxZ + 1 + ' Z Values (Hotkeys d/e)' : ''"
          :offset="1"
          :value-label="zLabel"
          :is-unrolled="unrollZ"
        />
        <v-checkbox
          v-if="maxZ > 0 || unrollZ"
          class="ml-3 my-checkbox"
          v-model="unrollZ"
          label="Unroll"
          :disabled="!(maxZ > 0 || unrollZ)"
        />
      </div>
      <div class="d-flex align-center">
        <value-slider
          v-model="time"
          label="Time"
          :min="0"
          :max="maxTime"
          :title="maxTime > 0 ? maxTime + 1 + ' Time Values (Hotkeys s/f)' : ''"
          :offset="1"
          :value-label="timeLabel"
          :is-unrolled="unrollT"
        />
        <v-checkbox
          v-if="maxTime > 0 || unrollT"
          class="ml-3 my-checkbox"
          v-model="unrollT"
          label="Unroll"
          :disabled="!(maxTime > 0 || unrollT)"
        />
      </div>
      <div v-if="maxTime > 0 && !unrollT" class="d-flex align-center">
        <v-checkbox
          :data-tour="TOUR_ANCHORS.timelapseMode"
          v-tour-trigger="TOUR_TRIGGERS.timelapseMode"
          class="ml-3 my-checkbox"
          v-model="timelapseMode"
          label="Time lapse mode"
        />
        <value-slider
          id="timelapse-window"
          v-if="timelapseMode"
          v-model="timelapseModeWindow"
          label="Track window"
          :min="3"
          :max="100"
          :title="'Track window size'"
          class="track-window-slider"
        />
      </div>
      <div v-if="timelapseMode" class="d-flex align-center">
        <tag-picker
          :data-tour="TOUR_ANCHORS.timelapseTags"
          class="ml-3"
          v-model="timelapseTags"
          style="max-width: 300px"
        />
      </div>
      <div v-if="timelapseMode" class="d-flex align-center">
        <v-checkbox
          :data-tour="TOUR_ANCHORS.timelapseLabels"
          class="ml-3 my-checkbox"
          v-model="showTimelapseLabels"
          label="Show labels"
        />
        <v-btn
          class="ml-3 timelapse-delete-btn"
          variant="text"
          color="error"
          size="small"
          @click="annotationStore.deleteAllTimelapseConnections"
        >
          <v-icon start size="small">mdi-delete</v-icon>
          Delete all timelapse connections
        </v-btn>
      </div>
      <!-- TODO: Only display if there is more than one large image -->
      <large-image-dropdown />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.navigator-panel {
  padding: 8px 12px 12px;
}
.my-checkbox {
  flex-shrink: 0;
}
.my-checkbox :deep(.v-input__control) {
  transform: scale(0.9) translateY(5%);
}
.v-input--selection-controls {
  margin-top: 0;
}

/* "Track window" is a longer label than the XY/Z/Time sliders, so its fixed
   3em column wraps and renders at the 16px body size. Match the 13px label
   convention and let it size to its content on one line. */
.track-window-slider :deep(.label-column) {
  width: auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  padding-right: 4px;
}

/* The delete button inherits the 16px body size; pin it to 13px to match the
   surrounding controls. */
.timelapse-delete-btn {
  font-size: 13px;
  letter-spacing: 0;
}
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ValueSlider from "./ValueSlider.vue";
import LargeImageDropdown from "./LargeImageDropdown.vue";
import TagPicker from "./TagPicker.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { IHotkey } from "@/utils/v-mousetrap";
import { logError } from "@/utils/log";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";

const dimensionLabels = ref<{
  xy: string[] | null;
  z: string[] | null;
  t: string[] | null;
} | null>(null);

async function loadDimensionLabels() {
  if (!store.selectedDatasetId) {
    dimensionLabels.value = null;
    return;
  }

  try {
    const folder = await store.girderResources.getFolder(
      store.selectedDatasetId,
    );
    if (folder && folder.meta && folder.meta.dimensionLabels) {
      dimensionLabels.value = folder.meta.dimensionLabels;
    } else {
      dimensionLabels.value = null;
    }
  } catch (error) {
    logError("Failed to load dimension labels:", error);
    dimensionLabels.value = null;
  }
}

const xy = computed({
  get: () => store.xy,
  set: (value: number) => store.setXY(value),
});

const z = computed({
  get: () => store.z,
  set: (value: number) => store.setZ(value),
});

const time = computed({
  get: () => store.time,
  set: (value: number) => store.setTime(value),
});

const unrollXY = computed({
  get: () => store.unrollXY,
  set: (value: boolean) => store.setUnrollXY(value),
});

const unrollZ = computed({
  get: () => store.unrollZ,
  set: (value: boolean) => store.setUnrollZ(value),
});

const unrollT = computed({
  get: () => store.unrollT,
  set: (value: boolean) => store.setUnrollT(value),
});

watch([unrollXY, unrollZ, unrollT], () => {
  store.refreshDataset();
});

const maxXY = computed(() =>
  store.dataset ? store.dataset.xy.length - 1 : xy.value,
);

const maxZ = computed(() =>
  store.dataset ? store.dataset.z.length - 1 : z.value,
);

const maxTime = computed(() =>
  store.dataset ? store.dataset.time.length - 1 : time.value,
);

const xyLabel = computed(() => {
  if (!store.showXYLabels) return null;
  if (!dimensionLabels.value || !dimensionLabels.value.xy) return null;
  return dimensionLabels.value.xy[xy.value] || null;
});

const zLabel = computed(() => {
  if (!store.showZLabels) return null;
  if (!dimensionLabels.value || !dimensionLabels.value.z) return null;
  return dimensionLabels.value.z[z.value] || null;
});

const timeLabel = computed(() => {
  if (!store.showTimeLabels) return null;
  if (!dimensionLabels.value || !dimensionLabels.value.t) return null;
  return dimensionLabels.value.t[time.value] || null;
});

const timelapseMode = computed({
  get: () => store.showTimelapseMode,
  set: (value: boolean) => store.setShowTimelapseMode(value),
});

const timelapseModeWindow = computed({
  get: () => store.timelapseModeWindow,
  set: (value: number) => store.setTimelapseModeWindow(value),
});

const timelapseTags = computed({
  get: () => store.timelapseTags,
  set: (value: string[]) => store.setTimelapseTags(value),
});

const showTimelapseLabels = computed({
  get: () => store.showTimelapseLabels,
  set: (value: boolean) => store.setShowTimelapseLabels(value),
});

const mousetrapSliders: IHotkey[] = [
  {
    bind: "w",
    handler: () => {
      xy.value = Math.max(xy.value - 1, 0);
    },
    data: {
      section: "Image Navigation",
      description: "Decrease XY position",
    },
  },
  {
    bind: "r",
    handler: () => {
      xy.value = Math.min(xy.value + 1, maxXY.value);
    },
    data: {
      section: "Image Navigation",
      description: "Increase XY position",
    },
  },
  {
    bind: "d",
    handler: () => {
      z.value = Math.max(z.value - 1, 0);
    },
    data: {
      section: "Image Navigation",
      description: "Decrease Z position",
    },
  },
  {
    bind: "e",
    handler: () => {
      z.value = Math.min(z.value + 1, maxZ.value);
    },
    data: {
      section: "Image Navigation",
      description: "Increase Z position",
    },
  },
  {
    bind: "s",
    handler: () => {
      time.value = Math.max(time.value - 1, 0);
    },
    data: {
      section: "Image Navigation",
      description: "Decrease T position",
    },
  },
  {
    bind: "f",
    handler: () => {
      time.value = Math.min(time.value + 1, maxTime.value);
    },
    data: {
      section: "Image Navigation",
      description: "Increase T position",
    },
  },
];

watch(
  () => store.selectedDatasetId,
  () => loadDimensionLabels(),
);

onMounted(async () => {
  await loadDimensionLabels();
});
</script>
