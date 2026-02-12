<template>
  <v-list two-line>
    <v-list-item v-for="(item, i) in scaleItems" :key="`item-${i}`">
      <v-list-item-content>
        <span class="d-flex align-center">
          <div style="min-width: 10em">
            {{ item.text }}
          </div>
          <v-text-field
            :value="scales[item.key].value"
            @input="setScaleValueForItem(item, $event)"
            class="mx-2"
            hide-details
            dense
            type="number"
          />
          <v-select
            :value="scales[item.key].unit"
            @input="setUnitValueForItem(item, $event)"
            class="mx-2 small-input"
            hide-details
            dense
            :items="getUnitValues(item.unit)"
          />
          <template v-if="!configurationOnly">
            <div>
              <v-btn
                class="ma-1 d-flex"
                small
                @click="resetFromDataset(item.key)"
              >
                Reset from dataset
              </v-btn>
              <v-btn
                class="ma-1 d-flex"
                small
                :disabled="!viewScales[item.key]"
                @click="revertToCollection(item.key)"
              >
                Reset from collection
              </v-btn>
              <v-btn
                class="ma-1 d-flex"
                small
                :disabled="!viewScales[item.key]"
                @click="saveInCollection(item.key)"
              >
                Save in collection
              </v-btn>
            </div>
          </template>
        </span>
      </v-list-item-content>
    </v-list-item>
    <v-list-item>
      <v-list-item-content>
        <pixel-scale-bar-setting class="mx-2" />
      </v-list-item-content>
    </v-list-item>
    <span class="d-flex align-center">
      <color-picker-menu
        v-model="scalebarColor"
        class="mx-2"
        style="min-width: 200px"
      />
    </span>
  </v-list>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store/index";
import {
  IScaleInformation,
  IScales,
  TUnitLength,
  TUnitTime,
  unitLengthOptions,
  unitTimeOptions,
} from "@/store/model";

import { convertLength, convertTime } from "@/utils/conversion";
import { getDatasetScales } from "@/store/GirderAPI";

import PixelScaleBarSetting from "@/components/PixelScaleBarSetting.vue";

interface IScaleItem {
  text: string;
  key: keyof IScales;
  unit: "time" | "length";
}

const props = withDefaults(
  defineProps<{
    configurationOnly?: boolean;
  }>(),
  { configurationOnly: false },
);

const configuration = computed(() => store.configuration);

const viewScales = computed(() => store.viewScales);

const scales = computed(() => {
  if (props.configurationOnly) {
    return store.configurationScales;
  }
  return { ...store.configurationScales, ...viewScales.value };
});

const scaleItems = computed<IScaleItem[]>(() => {
  const items: IScaleItem[] = [];
  items.push({
    text: "Pixel size",
    key: "pixelSize",
    unit: "length",
  });
  items.push({
    text: "Z step",
    key: "zStep",
    unit: "length",
  });
  items.push({
    text: "Time step",
    key: "tStep",
    unit: "time",
  });
  return items;
});

const scalebarColor = computed({
  get: () => store.scalebarColor,
  set: (color: string) => {
    store.setScalebarColor(color);
  },
});

function defaultSaveScale(
  key: keyof IScales,
  scale: IScaleInformation<TUnitLength | TUnitTime>,
) {
  if (props.configurationOnly) {
    store.saveScaleInConfiguration({ itemId: key, scale });
  } else {
    store.saveScalesInView({ itemId: key, scale });
  }
}

function saveInCollection(key: keyof IScales) {
  store.saveScaleInConfiguration({
    itemId: key,
    scale: scales.value[key],
  });
  revertToCollection(key);
}

function revertToCollection(key: keyof IScales) {
  store.resetScalesInView(key);
}

function resetFromDataset(key: keyof IScales) {
  const dataset = store.dataset;
  if (!dataset) {
    return;
  }
  const datasetScales = getDatasetScales(dataset);
  defaultSaveScale(key, datasetScales[key]);
}

function setScaleValueForItem(item: IScaleItem, value: string | number) {
  const newValue = Number(value);
  if (isNaN(newValue)) {
    return;
  }
  defaultSaveScale(item.key, {
    value: newValue,
    unit: scales.value[item.key].unit,
  });
}

function setUnitValueForItem(item: IScaleItem, newUnit: string) {
  if (!newUnit) {
    return;
  }
  const currentScales = scales.value;
  const oldValue = currentScales[item.key].value;
  const oldUnit = currentScales[item.key].unit;
  let newValue: number;
  switch (item.unit) {
    case "length":
      newValue = convertLength(
        oldValue,
        oldUnit as TUnitLength,
        newUnit as TUnitLength,
      );
      break;
    case "time":
      newValue = convertTime(
        oldValue,
        oldUnit as TUnitTime,
        newUnit as TUnitTime,
      );
      break;
  }
  defaultSaveScale(item.key, {
    value: newValue!,
    unit: newUnit as any,
  });
}

function getUnitValues(unit: IScaleItem["unit"]) {
  switch (unit) {
    case "length":
      return unitLengthOptions;
    case "time":
      return unitTimeOptions;
  }
}

defineExpose({
  scales,
  scaleItems,
  scalebarColor,
  defaultSaveScale,
  saveInCollection,
  revertToCollection,
  resetFromDataset,
  setScaleValueForItem,
  setUnitValueForItem,
  getUnitValues,
});
</script>

<style lang="scss" scoped>
.small-input {
  flex-grow: 0;
  width: 10em;
}
</style>
