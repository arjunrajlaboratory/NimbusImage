<template>
  <div style="display: inline-block">
    <div v-mousetrap="mousetrapSliders" id="viewer-toolbar-tourstep">
      <v-layout>
        <value-slider
          v-model="xy"
          label="XY"
          :min="0"
          :max="maxXY"
          :title="maxXY > 0 ? maxXY + 1 + ' XY Values (Hotkeys w/r)' : ''"
          :offset="1"
        />
        <v-checkbox
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
        />
        <v-checkbox
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
        />
        <v-checkbox
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
<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import ValueSlider from "./ValueSlider.vue";
import SwitchToggle from "./SwitchToggle.vue";
import Toolset from "@/tools/toolsets/Toolset.vue";
import LargeImageDropdown from "./LargeImageDropdown.vue";
import store from "@/store";
import filterStore from "@/store/filters";
import annotationStore from "@/store/annotation";
import { ITagAnnotationFilter, TLayerMode } from "@/store/model";
import { IHotkey } from "@/utils/v-mousetrap";

@Component({
  components: {
    ValueSlider,
    SwitchToggle,
    Toolset,
    LargeImageDropdown,
  },
})
export default class ViewerToolbar extends Vue {
  readonly store = store;
  readonly filterStore = filterStore;
  readonly annotationStore = annotationStore;

  get xy() {
    return this.store.xy;
  }

  get z() {
    return this.store.z;
  }

  get time() {
    return this.store.time;
  }

  set xy(value: number) {
    this.store.setXY(value);
  }

  set z(value: number) {
    this.store.setZ(value);
  }

  set time(value: number) {
    this.store.setTime(value);
  }

  get unrollXY() {
    return this.store.unrollXY;
  }

  set unrollXY(value: boolean) {
    this.store.setUnrollXY(value);
  }

  @Watch("unrollXY")
  watchUnrollXY() {
    this.store.refreshDataset();
  }

  get unrollZ() {
    return this.store.unrollZ;
  }

  set unrollZ(value: boolean) {
    this.store.setUnrollZ(value);
  }

  @Watch("unrollZ")
  watchUnrollZ() {
    this.store.refreshDataset();
  }

  get unrollT() {
    return this.store.unrollT;
  }

  set unrollT(value: boolean) {
    this.store.setUnrollT(value);
  }

  @Watch("unrollT")
  watchUnrollT() {
    this.store.refreshDataset();
  }

  get maxXY() {
    return this.store.dataset ? this.store.dataset.xy.length - 1 : this.xy;
  }

  get maxZ() {
    return this.store.dataset ? this.store.dataset.z.length - 1 : this.z;
  }

  get maxTime() {
    return this.store.dataset ? this.store.dataset.time.length - 1 : this.time;
  }

  get timelapseMode() {
    return this.store.showTimelapseMode;
  }

  set timelapseMode(value: boolean) {
    this.store.setShowTimelapseMode(value);
  }

  get timelapseModeWindow() {
    return this.store.timelapseModeWindow;
  }

  set timelapseModeWindow(value: number) {
    this.store.setTimelapseModeWindow(value);
  }

  get timelapseTags() {
    return this.store.timelapseTags;
  }

  set timelapseTags(value: string[]) {
    this.store.setTimelapseTags(value);
  }

  get showTimelapseLabels() {
    return this.store.showTimelapseLabels;
  }

  set showTimelapseLabels(value: boolean) {
    this.store.setShowTimelapseLabels(value);
  }

  set layerMode(value: TLayerMode) {
    this.store.setLayerMode(value);
  }

  get layerMode() {
    return this.store.layerMode;
  }

  get tagFilter() {
    return this.filterStore.tagFilter;
  }

  set tagFilter(filter: ITagAnnotationFilter) {
    this.filterStore.setTagFilter(filter);
  }

  // Mousetrap bindings
  mousetrapSliders: IHotkey[] = [
    {
      // XY left
      bind: "w",
      handler: () => {
        this.xy = Math.max(this.xy - 1, 0);
      },
      data: {
        section: "Image Navigation",
        description: "Decrease XY position",
      },
    },
    {
      // XY right
      bind: "r",
      handler: () => {
        this.xy = Math.min(this.xy + 1, this.maxXY);
      },
      data: {
        section: "Image Navigation",
        description: "Increase XY position",
      },
    },
    {
      // Z down
      bind: "d",
      handler: () => {
        this.z = Math.max(this.z - 1, 0);
      },
      data: {
        section: "Image Navigation",
        description: "Decrease Z position",
      },
    },
    {
      // Z up
      bind: "e",
      handler: () => {
        this.z = Math.min(this.z + 1, this.maxZ);
      },
      data: {
        section: "Image Navigation",
        description: "Increase Z position",
      },
    },
    {
      // previous T
      bind: "s",
      handler: () => {
        this.time = Math.max(this.time - 1, 0);
      },
      data: {
        section: "Image Navigation",
        description: "Decrease T position",
      },
    },
    {
      // next T
      bind: "f",
      handler: () => {
        this.time = Math.min(this.time + 1, this.maxTime);
      },
      data: {
        section: "Image Navigation",
        description: "Increase T position",
      },
    },
  ];

  deleteAllTimelapseConnections() {
    this.store.setTimelapseTags([]);
  }
}
</script>
