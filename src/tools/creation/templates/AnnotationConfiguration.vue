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
  shape: import("@/store/model").AnnotationShape;
  color: string | undefined;
}
</script>

<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  onMounted,
  getCurrentInstance,
  nextTick,
} from "vue";
import Vue from "vue";
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

function isSmallerThanRule(max: number) {
  return (val: string) => Number.parseInt(val) < max;
}

const props = withDefaults(
  defineProps<{
    hideShape?: string | boolean;
    hideLayer?: boolean;
    defaultShape?: AnnotationShape;
    advanced?: boolean;
    value?: IAnnotationSetup;
  }>(),
  {
    hideShape: false,
    hideLayer: false,
    defaultShape: AnnotationShape.Point,
    advanced: false,
  },
);

const emit = defineEmits<{
  (e: "input", value: IAnnotationSetup): void;
  (e: "change"): void;
}>();

const availableShapes = store.availableToolShapes;
const coordinates: ["Z", "Time"] = ["Z", "Time"];

const maxZ = computed(() => {
  // 1 indexing
  return (store.dataset?.z.length || 0) + 1;
});

const maxTime = computed(() => {
  // 1 indexing
  return (store.dataset?.time.length || 0) + 1;
});

const coordinateAssignments = ref<IAnnotationSetup["coordinateAssignments"]>({
  layer: undefined, // Setting layer to undefined will reset the layer in layer-select
  Z: { type: "layer", value: 1, max: maxZ.value },
  Time: { type: "layer", value: 1, max: maxTime.value },
});
const shape = ref<AnnotationShape>(AnnotationShape.Point);
const tagsInternal = ref<string[]>([]);
const useAutoTags = ref<boolean>(true);
const customColorEnabled = ref<boolean>(false);
const customColorValue = ref<string>("#FFFFFF");

const form = ref<VForm>();

const color = computed({
  get: () => {
    return customColorEnabled.value ? customColorValue.value : undefined;
  },
  set: (colorVal: string | undefined) => {
    if (colorVal === undefined) {
      customColorEnabled.value = false;
    } else {
      customColorEnabled.value = true;
      customColorValue.value = colorVal;
    }
  },
});

const layer = computed({
  get: (): string | null => {
    return coordinateAssignments.value.layer ?? null;
  },
  set: (value) => {
    Vue.set(coordinateAssignments.value, "layer", value);
  },
});

const tags = computed({
  get: () => {
    if (useAutoTags.value) {
      return autoTags.value;
    }
    return tagsInternal.value;
  },
  set: (value: string[]) => {
    tagsInternal.value = value;
  },
});

const autoTags = computed(() => {
  const layerId = layer.value;
  const layerName = layerId ? store.getLayerFromId(layerId)?.name || "" : "";
  const shapeName = AnnotationNames[shape.value].toLowerCase();
  return [`${layerName} ${shapeName}`];
});

function isMaxMerge(axis: string, layerId?: string) {
  const layerObj = store.getLayerFromId(layerId);
  if (!layerObj) {
    return false;
  }
  const key = axis === "Z" ? "z" : "time";
  return layerObj[key].type === "max-merge";
}

function updateFromValue() {
  if (!props.value) {
    reset();
    return;
  }
  updateCoordinateAssignement(props.value.coordinateAssignments);
  shape.value = props.value.shape;
  tagsInternal.value = props.value.tags;
  color.value = props.value.color;
}

function reset() {
  // Set internal values to the current input, or defaults
  updateCoordinateAssignement();
  useAutoTags.value = !props.advanced;
  tagsInternal.value = [];
  shape.value = props.defaultShape;
  color.value = undefined;
  changed();
}

// Update or reset the coordinateAssignments
// Don't update the layer if the new layer is falsy
function updateCoordinateAssignement(
  val?: IAnnotationSetup["coordinateAssignments"],
) {
  const oldLayer = layer.value;

  coordinateAssignments.value = val ?? {
    layer: undefined, // Setting layer to undefined will reset the layer in layer-select
    Z: { type: "layer", value: 1, max: maxZ.value },
    Time: { type: "layer", value: 1, max: maxTime.value },
  };

  const newLayer = layer.value;
  if (!newLayer && newLayer !== oldLayer) {
    // Wait for next tick before setting the layer
    // Otherwise, the layer-select component may not register the change
    layer.value = oldLayer;
    nextTick().then(() => (layer.value = newLayer));
  }
}

function changed() {
  const formEl = form.value as VForm;
  if (!formEl?.validate()) {
    if (coordinateAssignments.value.Z.value > maxZ.value) {
      coordinateAssignments.value.Z.value = maxZ.value;
    }
    if (coordinateAssignments.value.Time.value > maxTime.value) {
      coordinateAssignments.value.Time.value = maxTime.value;
    }
  }
  const result: IAnnotationSetup = {
    tags: tags.value,
    coordinateAssignments: coordinateAssignments.value,
    shape: shape.value,
    color: color.value,
  };
  emit("input", result);
  emit("change");
}

// Watches
watch(() => props.value, updateFromValue);
watch(() => props.defaultShape, reset);
watch(coordinateAssignments, changed, { deep: true });
watch(layer, changed);
watch(tags, changed);
watch(shape, changed);
watch(color, changed);

onMounted(() => {
  if (props.value?.tags) {
    useAutoTags.value = false;
  }
  updateFromValue();

  // Tour logic to show the "Working with tags" tour
  // if the user has not seen it yet
  const instance = getCurrentInstance()!.proxy;
  const tourStatus = Persister.get(
    WelcomeTourTypes.WORKING_WITH_TAGS,
    WelcomeTourStatus.NOT_YET_RUN,
  );

  if (!((instance as any).$isTourActive && (instance as any).$isTourActive())) {
    if (tourStatus === WelcomeTourStatus.NOT_YET_RUN) {
      Persister.set(
        WelcomeTourTypes.WORKING_WITH_TAGS,
        WelcomeTourStatus.ALREADY_RUN,
      );
      (instance as any).$startTour(
        WelcomeTourNames[WelcomeTourTypes.WORKING_WITH_TAGS],
      );
    }
  }
});

defineExpose({
  coordinateAssignments,
  shape,
  tagsInternal,
  useAutoTags,
  customColorEnabled,
  customColorValue,
  color,
  layer,
  tags,
  autoTags,
  maxZ,
  maxTime,
  form,
  updateFromValue,
  reset,
  changed,
  updateCoordinateAssignement,
  isMaxMerge,
  availableShapes,
  AnnotationNames,
  isSmallerThanRule,
});
</script>
