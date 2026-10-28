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
      <!-- Only the toggle lives here. Everything the mode configures moved to
           the Timelapse palette, which opens alongside this one — five controls
           inline made the Navigator taller than the three sliders it exists
           for. -->
      <div v-if="maxTime > 0 && !unrollT" class="d-flex align-center">
        <v-checkbox
          :data-tour="TOUR_ANCHORS.timelapseMode"
          v-tour-trigger="TOUR_TRIGGERS.timelapseMode"
          class="ml-3 my-checkbox"
          v-model="timelapseMode"
          label="Time lapse mode"
        />
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
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ValueSlider from "./ValueSlider.vue";
import LargeImageDropdown from "./LargeImageDropdown.vue";
import store from "@/store";
import timelapseStore from "@/store/timelapse";
import { useCommand } from "@/commands/registry";
import { boundHotkey } from "@/commands/hotkeys";
import { ICommand } from "@/commands/types";
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
  get: () => timelapseStore.showMode,
  set: (value: boolean) => timelapseStore.setShowMode(value),
});

// Palette commands for the Navigator's controls: stepping (the same as the
// w/r, d/e, s/f hotkeys), the unroll checkboxes and time lapse mode. They
// live here because the unroll watch above is what refreshes the dataset.
interface INavigatorDimension {
  key: "xy" | "z" | "time";
  label: string;
  value: typeof xy;
  max: typeof maxXY;
  unroll: typeof unrollXY;
  keys: [string, string];
  hotkeyLabel: string;
  icon: string;
}

const NAVIGATOR_DIMENSIONS: INavigatorDimension[] = [
  {
    key: "xy",
    label: "XY position",
    value: xy,
    max: maxXY,
    unroll: unrollXY,
    keys: ["w", "r"],
    hotkeyLabel: "XY",
    icon: "mdi-crosshairs-gps",
  },
  {
    key: "z",
    label: "Z slice",
    value: z,
    max: maxZ,
    unroll: unrollZ,
    keys: ["d", "e"],
    hotkeyLabel: "Z",
    icon: "mdi-layers-outline",
  },
  {
    key: "time",
    label: "time point",
    value: time,
    max: maxTime,
    unroll: unrollT,
    keys: ["s", "f"],
    hotkeyLabel: "T",
    icon: "mdi-clock-outline",
  },
];

function stepDimension(dim: INavigatorDimension, delta: 1 | -1) {
  // Clamp to the top first so an empty dimension (max -1) still yields 0.
  dim.value.value = Math.max(
    Math.min(dim.value.value + delta, dim.max.value),
    0,
  );
}

useCommand(() => [
  ...NAVIGATOR_DIMENSIONS.flatMap((dim): ICommand[] => {
    const hasSteps = dim.max.value > 0;
    return [
      {
        id: `navigate.${dim.key}.previous`,
        title: `Previous ${dim.label}`,
        group: "Navigate",
        keywords: ["back", "decrease", "step", dim.key],
        icon: dim.icon,
        hotkey: boundHotkey(
          dim.keys[0],
          `Decrease ${dim.hotkeyLabel} position`,
        ),
        enabled: () => hasSteps && dim.value.value > 0,
        run: () => stepDimension(dim, -1),
      },
      {
        id: `navigate.${dim.key}.next`,
        title: `Next ${dim.label}`,
        group: "Navigate",
        keywords: ["forward", "increase", "step", dim.key],
        icon: dim.icon,
        hotkey: boundHotkey(
          dim.keys[1],
          `Increase ${dim.hotkeyLabel} position`,
        ),
        enabled: () => hasSteps && dim.value.value < dim.max.value,
        run: () => stepDimension(dim, 1),
      },
      {
        id: `navigate.${dim.key}.unroll`,
        // While unrolled, nothing about it says "unroll": "unroll z" must
        // not find the command that rolls it back up.
        title: dim.unroll.value
          ? `Roll up ${dim.hotkeyLabel}`
          : `Unroll ${dim.hotkeyLabel}`,
        group: "Navigate",
        keywords: dim.unroll.value
          ? ["stack", "single", "collapse", dim.key]
          : ["grid", "tile", "side by side", "montage", dim.key],
        icon: "mdi-view-grid-outline",
        enabled: () => hasSteps || dim.unroll.value,
        run: () => {
          dim.unroll.value = !dim.unroll.value;
        },
      },
    ];
  }),
  {
    id: "navigate.timelapseMode",
    title: timelapseMode.value
      ? "Turn off time lapse mode"
      : "Turn on time lapse mode",
    group: "Navigate",
    keywords: ["tracks", "tracking", "timelapse", "movie", "time"],
    icon: "mdi-timer-outline",
    // Same condition as the checkbox's v-if.
    enabled: () => maxTime.value > 0 && !unrollT.value,
    run: () => {
      timelapseMode.value = !timelapseMode.value;
    },
  },
]);

// The w/r, d/e, s/f hotkeys; the palette's Next/Previous commands above run
// the same stepDimension.
const mousetrapSliders: IHotkey[] = NAVIGATOR_DIMENSIONS.flatMap(
  (dim): IHotkey[] => [
    {
      bind: dim.keys[0],
      handler: () => stepDimension(dim, -1),
      data: {
        section: "Image Navigation",
        description: `Decrease ${dim.hotkeyLabel} position`,
      },
    },
    {
      bind: dim.keys[1],
      handler: () => stepDimension(dim, 1),
      data: {
        section: "Image Navigation",
        description: `Increase ${dim.hotkeyLabel} position`,
      },
    },
  ],
);

watch(
  () => store.selectedDatasetId,
  () => loadDimensionLabels(),
);

onMounted(async () => {
  await loadDimensionLabels();
});
</script>
