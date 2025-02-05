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

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
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

@Component({ components: { PixelScaleBarSetting } })
export default class ScaleSettings extends Vue {
  readonly store = store;
  readonly unitLengthOptions = unitLengthOptions;
  readonly unitTimeOptions = unitTimeOptions;

  @Prop({ default: false })
  configurationOnly!: boolean;

  get configuration() {
    return this.store.configuration;
  }

  get viewScales() {
    return this.store.viewScales;
  }

  get scales() {
    if (this.configurationOnly) {
      return this.store.configurationScales;
    }
    return { ...this.store.configurationScales, ...this.viewScales };
  }

  get scaleItems(): IScaleItem[] {
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
  }

  get scalebarColor() {
    return this.store.scalebarColor;
  }

  set scalebarColor(color: string) {
    this.store.setScalebarColor(color);
  }

  defaultSaveScale(
    key: keyof IScales,
    scale: IScaleInformation<TUnitLength | TUnitTime>,
  ) {
    if (this.configurationOnly) {
      this.store.saveScaleInConfiguration({ itemId: key, scale });
    } else {
      this.store.saveScalesInView({ itemId: key, scale });
    }
  }

  saveInCollection(key: keyof IScales) {
    this.store.saveScaleInConfiguration({
      itemId: key,
      scale: this.scales[key],
    });
    this.revertToCollection(key);
  }

  revertToCollection(key: keyof IScales) {
    this.store.resetScalesInView(key);
  }

  resetFromDataset(key: keyof IScales) {
    const dataset = this.store.dataset;
    if (!dataset) {
      return;
    }
    const datasetScales = getDatasetScales(dataset);
    this.defaultSaveScale(key, datasetScales[key]);
  }

  setScaleValueForItem(item: IScaleItem, value: string | number) {
    const newValue = Number(value);
    if (isNaN(newValue)) {
      return;
    }
    this.defaultSaveScale(item.key, {
      value: newValue,
      unit: this.scales[item.key].unit,
    });
  }

  setUnitValueForItem(item: IScaleItem, newUnit: string) {
    if (!newUnit) {
      return;
    }
    const scales = this.scales;
    const oldValue = scales[item.key].value;
    const oldUnit = scales[item.key].unit;
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
    this.defaultSaveScale(item.key, {
      value: newValue,
      unit: newUnit as any,
    });
  }

  getUnitValues(unit: IScaleItem["unit"]) {
    switch (unit) {
      case "length":
        return this.unitLengthOptions;
      case "time":
        return this.unitTimeOptions;
    }
  }
}
</script>

<style lang="scss" scoped>
.small-input {
  flex-grow: 0;
  width: 10em;
}
</style>
