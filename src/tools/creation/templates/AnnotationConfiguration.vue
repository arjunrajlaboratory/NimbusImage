<template>
  <v-form ref="form" class="pa-0">
    <v-container class="px-0">
      <template v-if="!advanced">
        <!-- shape selection -->
        <v-row class="my-0" v-if="!hideShape">
          <v-col class="py-0">
            <v-select
              label="Shape"
              :items="availableShapes"
              v-model="shape"
              @change="changed"
              dense
            >
            </v-select>
          </v-col>
        </v-row>
        <v-row class="my-0" v-else>
          <v-col class="pt-0 pb-4 subtitle-2">
            Output shape type:
            {{ shape === null ? "nothing selected" : AnnotationNames[shape] }}
          </v-col>
        </v-row>
        <!-- layer location -->
        <v-row class="my-0" v-if="!hideLayer">
          <v-col class="py-0">
            <layer-select
              id="tool-creation-layer-select-tourstep"
              v-model="layer"
              label="Layer"
            />
          </v-col>
        </v-row>
        <!-- tags -->
        <v-row class="my-0">
          <v-col class="py-0">
            <tag-picker
              id="tool-creation-tag-picker-tourstep"
              v-model="tags"
              @input="useAutoTags = false"
            ></tag-picker>
          </v-col>
        </v-row>
      </template>
      <template v-else>
        <!-- Z and Time assignments -->
        <v-row>
          <v-col
            v-for="(coordinate, index) in coordinates"
            :key="index"
            class="py-0"
          >
            <v-radio-group
              @change="changed"
              :label="coordinate"
              v-model="coordinateAssignments[coordinate].type"
              :key="`${index}Radio`"
              mandatory
              dense
            >
              <v-radio
                value="layer"
                label="From Layer"
                v-if="!isMaxMerge(coordinate, layer ?? undefined)"
              ></v-radio>
              <v-radio value="assign">
                <template v-slot:label>
                  <span>Assign</span>
                  <v-text-field
                    dense
                    type="number"
                    :min="1"
                    class="pl-4"
                    v-model.number="coordinateAssignments[coordinate].value"
                    @change="changed"
                    :disabled="
                      coordinateAssignments[coordinate].type === 'layer'
                    "
                    :style="{ width: 'min-content' }"
                    :rules="[
                      isSmallerThanRule(coordinateAssignments[coordinate].max),
                    ]"
                  />
                </template>
              </v-radio>
            </v-radio-group>
          </v-col>
        </v-row>
        <v-row>
          <v-col>
            <v-checkbox
              v-model="customColorEnabled"
              label="Override layer color with a custom color"
            />
          </v-col>
          <v-col v-if="customColorEnabled">
            <v-color-picker
              label="Custom color picker"
              v-model="customColorValue"
            />
          </v-col>
        </v-row>
      </template>
    </v-container>
  </v-form>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import LayerSelect from "@/components/LayerSelect.vue";
import TagPicker from "@/components/TagPicker.vue";
import Persister from "@/store/Persister";
import {
  AnnotationNames,
  AnnotationShape,
  WelcomeTourTypes,
  WelcomeTourStatus,
  WelcomeTourNames,
} from "@/store/model";

type VForm = Vue & { validate: () => boolean };

export interface IAnnotationSetup {
  tags: string[];
  coordinateAssignments: {
    layer: string | null | undefined;
    Z: {
      type: string;
      value: number;
      max: number;
    };
    Time: {
      type: string;
      value: number;
      max: number;
    };
  };
  shape: AnnotationShape;
  color: string | undefined;
}

function isSmallerThanRule(max: number) {
  return (val: string) => Number.parseInt(val) < max;
}

// Interface element for configuring an annotation creation tool
@Component({
  components: {
    LayerSelect,
    TagPicker,
  },
})
export default class AnnotationConfiguration extends Vue {
  readonly store = store;

  @Prop({ default: false })
  readonly hideShape!: string;

  @Prop({ default: false })
  readonly hideLayer!: boolean;

  @Prop({ default: AnnotationShape.Point })
  readonly defaultShape!: AnnotationShape;

  @Prop({ default: false })
  readonly advanced!: boolean;

  @Prop()
  readonly value?: IAnnotationSetup;

  availableShapes = store.availableToolShapes;
  AnnotationNames = AnnotationNames;
  isSmallerThanRule = isSmallerThanRule;

  readonly coordinates: ["Z", "Time"] = ["Z", "Time"];

  // These could also be set in the updateFromValue() method called in the mounted() hook
  coordinateAssignments: IAnnotationSetup["coordinateAssignments"] = {
    layer: undefined, // Setting layer to undefined will reset the layer in layer-select
    Z: { type: "layer", value: 1, max: this.maxZ },
    Time: { type: "layer", value: 1, max: this.maxTime },
  };
  shape: AnnotationShape = AnnotationShape.Point;
  tagsInternal: string[] = [];
  useAutoTags: boolean = true;
  customColorEnabled: boolean = false;
  customColorValue: string = "#FFFFFF";

  get color() {
    return this.customColorEnabled ? this.customColorValue : undefined;
  }

  set color(color: string | undefined) {
    if (color === undefined) {
      this.customColorEnabled = false;
    } else {
      this.customColorEnabled = true;
      this.customColorValue = color;
    }
  }

  get layer() {
    return this.coordinateAssignments.layer;
  }

  set layer(value) {
    Vue.set(this.coordinateAssignments, "layer", value);
  }

  get tags() {
    if (this.useAutoTags) {
      return this.autoTags;
    }
    return this.tagsInternal;
  }

  set tags(value: string[]) {
    this.tagsInternal = value;
  }

  get autoTags() {
    const layerId = this.layer;
    const layerName = layerId ? store.getLayerFromId(layerId)?.name || "" : "";
    const shapeName = AnnotationNames[this.shape].toLowerCase();
    return [`${layerName} ${shapeName}`];
  }

  get maxZ() {
    // 1 indexing
    return (this.store.dataset?.z.length || 0) + 1;
  }

  get maxTime() {
    // 1 indexing
    return (this.store.dataset?.time.length || 0) + 1;
  }

  isMaxMerge(axis: string, layerId?: string) {
    const layer = this.store.getLayerFromId(layerId);
    if (!layer) {
      return false;
    }
    const key = axis === "Z" ? "z" : "time";
    return layer[key].type === "max-merge";
  }

  mounted() {
    console.log("AnnotationConfiguration mounted.");
    if (this.value?.tags) {
      this.useAutoTags = false;
    }
    this.updateFromValue();

    // Tour logic to show the "Working with tags" tour
    // if the user has not seen it yet
    // Note for the future: somehow, this component gets mounted twice.
    // Hence, if you just run the tour here, it will run twice, causing problems.
    // Given that we only want to show the tour once and we gate that by the
    // Persister state, this code will just run the one time and it should be fine.
    // However, this does hide the underlying, but as yet unsolved, problem of the
    // component getting mounted twice.
    const tourStatus = Persister.get(
      WelcomeTourTypes.WORKING_WITH_TAGS,
      WelcomeTourStatus.NOT_YET_RUN,
    );

    if (!(this.$isTourActive && this.$isTourActive())) {
      if (tourStatus === WelcomeTourStatus.NOT_YET_RUN) {
        Persister.set(
          WelcomeTourTypes.WORKING_WITH_TAGS,
          WelcomeTourStatus.ALREADY_RUN,
        );
        this.$startTour(WelcomeTourNames[WelcomeTourTypes.WORKING_WITH_TAGS]);
      }
    }
  }

  @Watch("value")
  updateFromValue() {
    if (!this.value) {
      this.reset();
      return;
    }
    this.updateCoordinateAssignement(this.value.coordinateAssignments);
    this.shape = this.value.shape;
    this.tagsInternal = this.value.tags;
    this.color = this.value.color;
  }

  @Watch("defaultShape")
  reset() {
    // Set internal values to the current input, or defaults
    this.updateCoordinateAssignement();
    this.useAutoTags = !this.advanced;
    this.tagsInternal = [];
    this.shape = this.defaultShape;
    this.color = undefined;
    this.changed();
  }

  // Update or reset the coordinateAssignments
  // Don't update the layer if the new layer is falsy
  updateCoordinateAssignement(val?: IAnnotationSetup["coordinateAssignments"]) {
    const oldLayer = this.layer;

    this.coordinateAssignments = val ?? {
      layer: undefined, // Setting layer to undefined will reset the layer in layer-select
      Z: { type: "layer", value: 1, max: this.maxZ },
      Time: { type: "layer", value: 1, max: this.maxTime },
    };

    const newLayer = this.layer;
    if (!newLayer && newLayer !== oldLayer) {
      // Wait for next tick before setting the layer
      // Otherwise, the layer-select component may not register the change
      this.layer = oldLayer;
      this.$nextTick().then(() => (this.layer = newLayer));
    }
  }

  @Watch("coordinateAssignments", { deep: true })
  @Watch("layer")
  @Watch("tags")
  @Watch("shape")
  @Watch("color")
  changed() {
    const form = this.$refs.form as VForm;
    if (!form?.validate()) {
      if (this.coordinateAssignments.Z.value > this.maxZ) {
        this.coordinateAssignments.Z.value = this.maxZ;
      }
      if (this.coordinateAssignments.Time.value > this.maxTime) {
        this.coordinateAssignments.Time.value = this.maxTime;
      }
    }
    const result: IAnnotationSetup = {
      tags: this.tags,
      coordinateAssignments: this.coordinateAssignments,
      shape: this.shape,
      color: this.color,
    };
    this.$emit("input", result);
    this.$emit("change");
  }
}
</script>
