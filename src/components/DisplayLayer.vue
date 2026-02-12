<template>
  <v-expansion-panel>
    <v-expansion-panel-header class="displayLayerHeader">
      <v-row dense class="align-center">
        <v-col class="denseCol">
          <v-icon :color="value.color" left>mdi-circle</v-icon>
        </v-col>
        <v-col class="textCol">
          <div class="header pa-1">{{ value.name }}</div>
        </v-col>
        <v-col v-if="hoverValue !== null" class="denseCol">
          {{ hoverValue }}
        </v-col>
        <v-col class="denseCol">
          <v-switch
            @click.native.stop
            @mousedown.native.stop
            @mouseup.native.stop
            v-mousetrap="zMaxMergeHotkey"
            class="toggleButton"
            v-model="isZMaxMerge"
            v-show="hasMultipleZ"
            :title="`Toggle Z Max Merge (hotkey ${zMaxMergeBinding})`"
            dense
            hide-details
          />
        </v-col>
        <v-col class="denseCol">
          <v-switch
            @click.native.stop
            @mousedown.native.stop
            @mouseup.native.stop
            v-mousetrap="visibilityHotkey"
            class="toggleButton"
            v-model="visible"
            :title="`Toggle Visibility (hotkey ${index + 1})`"
            dense
            hide-details
          />
        </v-col>
      </v-row>
    </v-expansion-panel-header>
    <v-expansion-panel-content :class="{ notVisible: !value.visible }">
      <v-text-field
        :value="value.name"
        @change="changeProp('name', $event)"
        label="Name"
        dense
        hide-details
      />
      <contrast-histogram
        :configurationContrast="configurationContrast"
        :viewContrast="currentContrast"
        @change="changeContrast($event, false)"
        @commit="changeContrast($event, true)"
        @revert="resetContrastInView()"
        :histogram="histogram"
      />
      <color-picker-menu
        :value="value.color"
        @input="changeProp('color', $event)"
        class="mb-4"
      />
      <v-radio-group
        row
        v-model="channel"
        label="Channel"
        dense
        hide-details
        class="channel"
      >
        <v-radio
          v-for="(channel, index) in channels"
          :key="index"
          :value="index"
          :label="channelName(channel)"
        />
      </v-radio-group>
      <v-expansion-panel>
        <v-expansion-panel-header
          >Advanced layer options</v-expansion-panel-header
        >
        <v-expansion-panel-content>
          <display-slice
            :value="value.xy"
            @change="changeProp('xy', $event)"
            label="XY-Slice"
            :max-value="maxXY"
            v-if="maxXY > 0"
            :displayed="displayXY"
            :offset="1"
          />
          <display-slice
            :value="value.z"
            @change="changeProp('z', $event)"
            label="Z-Slice"
            :max-value="maxZ"
            v-if="maxZ > 0"
            :displayed="displayZ"
            :offset="1"
          />
          <display-slice
            :value="value.time"
            @change="changeProp('time', $event)"
            label="Time-Slice"
            :max-value="maxTime"
            v-if="maxTime > 0"
            :displayed="displayTime"
            :offset="1"
          />
          <div class="buttons">
            <v-btn color="warning" small @click="removeLayer"
              >Delete layer</v-btn
            >
          </div>
        </v-expansion-panel-content>
      </v-expansion-panel>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { IDisplayLayer, IContrast, IDisplaySlice } from "../store/model";
import DisplaySlice from "./DisplaySlice.vue";
import ContrastHistogram from "./ContrastHistogram.vue";
import ColorPickerMenu from "./ColorPickerMenu.vue";
import store from "../store";
import { IHotkey } from "@/utils/v-mousetrap";

const props = defineProps<{
  value: IDisplayLayer;
}>();

const alternativeZSlice = ref<IDisplaySlice>({ type: "current", value: null });

onMounted(() => {
  alternativeZSlice.value =
    props.value.z.type === "max-merge"
      ? { type: "current", value: null }
      : { ...props.value.z };
});

const index = computed(() => store.getLayerIndexFromId(props.value.id)!);

const hoverValue = computed(() => {
  const layerId = props.value.id;
  return store.hoverValue?.[layerId]?.join(", ") ?? null;
});

const histogram = computed(() => store.getLayerHistogram(props.value));

const channels = computed(() => (store.dataset ? store.dataset.channels : []));

const configurationContrast = computed(() => {
  const layerId = props.value.id;
  const configuration = store.configuration;
  if (!configuration) {
    return null;
  }
  const configurationLayer = store.getConfigurationLayerFromId(layerId);
  if (!configurationLayer) {
    return null;
  }
  return configurationLayer.contrast;
});

const currentContrast = computed(() => props.value.contrast);

function channelName(channel: number): string {
  let result = channel.toString();
  if (store.dataset) {
    result = store.dataset.channelNames.get(channel) || result;
  }
  return result;
}

const visible = computed({
  get: () => props.value.visible,
  set: (value: boolean) => {
    if (props.value.visible === value) {
      return;
    }
    store.toggleLayerVisibility(props.value.id);
  },
});

const zMaxMergeBinding = computed(() => `shift+${index.value + 1}`);

const zSlice = computed(() => props.value.z);

const isZMaxMerge = computed({
  get: () => zSlice.value.type === "max-merge",
  set: (value: boolean) => {
    if ((zSlice.value.type === "max-merge") === value) {
      return;
    }
    const newZSlice = value
      ? { type: "max-merge" as const, value: null }
      : alternativeZSlice.value;
    changeProp("z", newZSlice);
  },
});

const zMaxMergeHotkey = computed<IHotkey>(() => ({
  bind: zMaxMergeBinding.value,
  handler: () => (isZMaxMerge.value = !isZMaxMerge.value),
  data: {
    section: "Layer control",
    description: `Toggle Z max-merge for layer: ${props.value.name}`,
  },
}));

const visibilityHotkey = computed<IHotkey>(() => ({
  bind: `${index.value + 1}`,
  handler: () => store.toggleLayerVisibility(props.value.id),
  data: {
    section: "Layer control",
    description: `Show/hide layer: ${props.value.name}`,
  },
}));

watch(zSlice, () => {
  if (!isZMaxMerge.value) {
    alternativeZSlice.value = { ...zSlice.value };
  }
});

const channel = computed({
  get: () => props.value.channel,
  set: (value: number) => {
    // value can be undefined when going to another route:
    // routeMapper sets datasetId = null -> channels becomes [] -> channel = undefined
    if (value !== undefined) {
      changeProp("channel", value);
    }
  },
});

const maxXY = computed(() =>
  store.dataset ? store.dataset.xy.length - 1 : props.value.xy.value || 0,
);

const maxZ = computed(() =>
  store.dataset ? store.dataset.z.length - 1 : props.value.z.value || 0,
);

const maxTime = computed(() =>
  store.dataset ? store.dataset.time.length - 1 : props.value.time.value || 0,
);

const displayXY = computed(() => store.xy);

const displayZ = computed(() => store.z);

const hasMultipleZ = computed(
  () => store.dataset && store.dataset.z.length > 1,
);

const displayTime = computed(() => store.time);

function changeProp(prop: keyof IDisplayLayer, value: any) {
  if (props.value[prop] === value) {
    return;
  }
  store.changeLayer({
    layerId: props.value.id,
    delta: {
      [prop]: value,
    },
  });
}

function changeContrast(contrast: IContrast, syncConfiguration: boolean) {
  if (syncConfiguration) {
    store.saveContrastInConfiguration({
      layerId: props.value.id,
      contrast,
    });
  } else {
    store.saveContrastInView({ layerId: props.value.id, contrast });
  }
}

function resetContrastInView() {
  store.resetContrastInView(props.value.id);
}

function removeLayer() {
  store.removeLayer(props.value.id);
}

defineExpose({
  alternativeZSlice,
  index,
  hoverValue,
  histogram,
  channels,
  configurationContrast,
  currentContrast,
  channelName,
  visible,
  zMaxMergeBinding,
  zMaxMergeHotkey,
  visibilityHotkey,
  isZMaxMerge,
  zSlice,
  channel,
  maxXY,
  maxZ,
  maxTime,
  displayXY,
  displayZ,
  hasMultipleZ,
  displayTime,
  changeProp,
  changeContrast,
  resetContrastInView,
  removeLayer,
});
</script>

<style lang="scss" scoped>
.notVisible {
  opacity: 0.5;
}

.displayLayerHeader {
  > i {
    flex: 0 0 auto;
  }
  > .header {
    flex: 1 1 0;
  }
}

.toggleButton {
  margin: 0;
  flex: 0 0 auto;
}

.buttons {
  display: flex;
  justify-content: flex-end;
}

.channel {
  ::v-deep .v-label {
    width: 100%;
  }

  ::v-deep .v-radio {
    margin-right: 10px;

    > .v-label {
      font-size: 14px;
    }
  }
}
</style>
