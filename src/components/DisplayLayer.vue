<template>
  <v-expansion-panels>
    <v-expansion-panel>
      <v-expansion-panel-title class="displayLayerHeader">
        <v-row dense class="align-center">
          <v-col cols="7" class="d-flex align-center">
            <v-icon :color="modelValue.color" start>mdi-circle</v-icon>
            <div class="header pa-1 text-truncate">{{ modelValue.name }}</div>
            <span v-if="hoverValue !== null" class="ml-auto text-no-wrap">{{
              hoverValue
            }}</span>
          </v-col>
          <v-col class="d-flex justify-center">
            <v-switch
              @click.stop
              @mousedown.stop
              @mouseup.stop
              v-mousetrap="zMaxMergeHotkey"
              class="toggleButton"
              v-model="isZMaxMerge"
              v-show="hasMultipleZ"
              :title="`Toggle Z Max Merge (hotkey ${zMaxMergeBinding})`"
              density="compact"
              hide-details
            />
          </v-col>
          <v-col class="d-flex justify-center">
            <v-switch
              @click.stop
              @mousedown.stop
              @mouseup.stop
              v-mousetrap="visibilityHotkey"
              class="toggleButton"
              v-model="visible"
              :title="`Toggle Visibility (hotkey ${index + 1})`"
              density="compact"
              hide-details
            />
          </v-col>
        </v-row>
      </v-expansion-panel-title>
      <v-expansion-panel-text :class="{ notVisible: !modelValue.visible }">
        <v-text-field
          :model-value="modelValue.name"
          @change="changeProp('name', $event.target.value)"
          label="Name"
          density="compact"
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
          :model-value="modelValue.color"
          @update:model-value="changeProp('color', $event)"
          class="mb-4"
        />
        <v-radio-group
          inline
          v-model="channel"
          label="Channel"
          density="compact"
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
        <v-expansion-panels>
          <v-expansion-panel>
            <v-expansion-panel-title
              >Advanced layer options</v-expansion-panel-title
            >
            <v-expansion-panel-text>
              <display-slice
                :model-value="modelValue.xy"
                @change="changeProp('xy', $event)"
                label="XY-Slice"
                :max-value="maxXY"
                v-if="maxXY > 0"
                :displayed="displayXY"
                :offset="1"
              />
              <display-slice
                :model-value="modelValue.z"
                @change="changeProp('z', $event)"
                label="Z-Slice"
                :max-value="maxZ"
                v-if="maxZ > 0"
                :displayed="displayZ"
                :offset="1"
              />
              <display-slice
                :model-value="modelValue.time"
                @change="changeProp('time', $event)"
                label="Time-Slice"
                :max-value="maxTime"
                v-if="maxTime > 0"
                :displayed="displayTime"
                :offset="1"
              />
              <div class="buttons">
                <v-btn color="warning" size="small" @click="removeLayer"
                  >Delete layer</v-btn
                >
              </div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
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
  modelValue: IDisplayLayer;
}>();

const alternativeZSlice = ref<IDisplaySlice>({ type: "current", value: null });

onMounted(() => {
  alternativeZSlice.value =
    props.modelValue.z.type === "max-merge"
      ? { type: "current", value: null }
      : { ...props.modelValue.z };
});

const index = computed(() => store.getLayerIndexFromId(props.modelValue.id)!);

const hoverValue = computed(() => {
  const layerId = props.modelValue.id;
  return store.hoverValue?.[layerId]?.join(", ") ?? null;
});

const histogram = computed(() => store.getLayerHistogram(props.modelValue));

const channels = computed(() => (store.dataset ? store.dataset.channels : []));

const configurationContrast = computed(() => {
  const layerId = props.modelValue.id;
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

const currentContrast = computed(() => props.modelValue.contrast);

function channelName(channel: number): string {
  let result = channel.toString();
  if (store.dataset) {
    result = store.dataset.channelNames.get(channel) || result;
  }
  return result;
}

const visible = computed({
  get: () => props.modelValue.visible,
  set: (value: boolean) => {
    if (props.modelValue.visible === value) {
      return;
    }
    store.toggleLayerVisibility(props.modelValue.id);
  },
});

const zMaxMergeBinding = computed(() => `shift+${index.value + 1}`);

const zSlice = computed(() => props.modelValue.z);

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
    description: `Toggle Z max-merge for layer: ${props.modelValue.name}`,
  },
}));

const visibilityHotkey = computed<IHotkey>(() => ({
  bind: `${index.value + 1}`,
  handler: () => store.toggleLayerVisibility(props.modelValue.id),
  data: {
    section: "Layer control",
    description: `Show/hide layer: ${props.modelValue.name}`,
  },
}));

watch(zSlice, () => {
  if (!isZMaxMerge.value) {
    alternativeZSlice.value = { ...zSlice.value };
  }
});

const channel = computed({
  get: () => props.modelValue.channel,
  set: (value: number) => {
    // value can be undefined when going to another route:
    // routeMapper sets datasetId = null -> channels becomes [] -> channel = undefined
    if (value !== undefined) {
      changeProp("channel", value);
    }
  },
});

const maxXY = computed(() =>
  store.dataset ? store.dataset.xy.length - 1 : props.modelValue.xy.value || 0,
);

const maxZ = computed(() =>
  store.dataset ? store.dataset.z.length - 1 : props.modelValue.z.value || 0,
);

const maxTime = computed(() =>
  store.dataset
    ? store.dataset.time.length - 1
    : props.modelValue.time.value || 0,
);

const displayXY = computed(() => store.xy);

const displayZ = computed(() => store.z);

const hasMultipleZ = computed(
  () => store.dataset && store.dataset.z.length > 1,
);

const displayTime = computed(() => store.time);

function changeProp(prop: keyof IDisplayLayer, value: any) {
  if (props.modelValue[prop] === value) {
    return;
  }
  store.changeLayer({
    layerId: props.modelValue.id,
    delta: {
      [prop]: value,
    },
  });
}

function changeContrast(contrast: IContrast, syncConfiguration: boolean) {
  if (syncConfiguration) {
    store.saveContrastInConfiguration({
      layerId: props.modelValue.id,
      contrast,
    });
  } else {
    store.saveContrastInView({ layerId: props.modelValue.id, contrast });
  }
}

function resetContrastInView() {
  store.resetContrastInView(props.modelValue.id);
}

function removeLayer() {
  store.removeLayer(props.modelValue.id);
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
  :deep(.v-label) {
    width: 100%;
  }

  :deep(.v-radio) {
    margin-right: 10px;

    > .v-label {
      font-size: 14px;
    }
  }
}
</style>
