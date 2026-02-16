<template>
  <div style="overflow-y: auto; scrollbar-width: none">
    <div v-mousetrap="mousetrapSliders" id="viewer-toolbar-tourstep">
      <v-layout>
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
      </v-layout>
      <v-layout>
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
      </v-layout>
      <v-layout>
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
      </v-layout>
      <v-layout v-if="maxTime > 0 && !unrollT">
        <v-checkbox
          id="timelapse-mode-tourstep"
          v-tour-trigger="'timelapse-mode-tourtrigger'"
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
        />
      </v-layout>
      <!-- TODO: Only display if there is more than one large image -->
      <large-image-dropdown />
      <v-layout v-if="timelapseMode">
        <tag-picker
          id="timelapse-tags-tourstep"
          class="ml-3"
          v-model="timelapseTags"
          style="max-width: 300px"
        />
      </v-layout>
      <v-layout v-if="timelapseMode">
        <v-checkbox
          id="timelapse-labels-tourstep"
          class="ml-3 my-checkbox"
          v-model="showTimelapseLabels"
          label="Show labels"
        />
      </v-layout>
      <v-layout v-if="timelapseMode">
        <v-btn
          class="ml-3"
          small
          @click="annotationStore.deleteAllTimelapseConnections"
        >
          Delete all timelapse connections
        </v-btn>
      </v-layout>
    </div>
    <toolset></toolset>
    <v-radio-group
      v-model="layerMode"
      label="Layers: "
      mandatory
      dense
      row
      hide-details
      class="layer-mode-controls"
    >
      <v-radio value="single" label="Single" class="smaller" />
      <v-radio value="multiple" label="Multiple" class="smaller" />
      <v-radio value="unroll" label="Unroll" class="smaller" />
    </v-radio-group>
    <div>
      <slot></slot>
    </div>
    <tag-filter-editor class="filter-element" v-model="tagFilter" />
  </div>
</template>

<style lang="scss" scoped>
.my-checkbox::v-deep .v-input__control {
  transform: scale(0.9) translateY(5%);
}
.v-input--selection-controls {
  margin-top: 0;
}
.lowertools {
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
}
.layer-mode-controls {
  margin: 10px 0;
  ::v-deep .v-radio {
    margin-right: 10px;
    > .v-input--selection-controls__input {
      margin-right: 0;
    }
  }
}
</style>
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import ValueSlider from "./ValueSlider.vue";
import SwitchToggle from "./SwitchToggle.vue";
import Toolset from "@/tools/toolsets/Toolset.vue";
import LargeImageDropdown from "./LargeImageDropdown.vue";
import store from "@/store";
import filterStore from "@/store/filters";
import annotationStore from "@/store/annotation";
import { ITagAnnotationFilter, TLayerMode } from "@/store/model";
import { IHotkey } from "@/utils/v-mousetrap";
import { logError } from "@/utils/log";

// Suppress unused import warnings for template-only components
void SwitchToggle;

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

const layerMode = computed({
  get: () => store.layerMode,
  set: (value: TLayerMode) => store.setLayerMode(value),
});

const tagFilter = computed({
  get: () => filterStore.tagFilter,
  set: (filter: ITagAnnotationFilter) => filterStore.setTagFilter(filter),
});

// Mousetrap bindings
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

defineExpose({
  dimensionLabels,
  xy,
  z,
  time,
  unrollXY,
  unrollZ,
  unrollT,
  maxXY,
  maxZ,
  maxTime,
  xyLabel,
  zLabel,
  timeLabel,
  timelapseMode,
  timelapseModeWindow,
  timelapseTags,
  showTimelapseLabels,
  layerMode,
  tagFilter,
  mousetrapSliders,
  loadDimensionLabels,
});
</script>
