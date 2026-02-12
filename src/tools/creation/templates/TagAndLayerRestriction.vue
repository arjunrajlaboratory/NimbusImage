<template>
  <v-container>
    <v-row class="pa-0">
      <v-col class="pa-0 pr-2 d-flex">
        <!-- tags -->
        <tag-picker v-model="newTags"></tag-picker>
        <v-btn
          v-if="inclusiveToggle"
          class="mx-2"
          :title="`Current tags selection mode: ${
            areTagsInclusive ? 'inclusive' : 'exclusive'
          }`"
          x-small
          fab
          @click="areTagsInclusive = !areTagsInclusive"
        >
          <v-icon>
            {{ areTagsInclusive ? "mdi-approximately-equal" : "mdi-equal" }}
          </v-icon>
        </v-btn>
      </v-col>
      <v-col class="pa-0 pr-2 d-flex">
        <!-- layers -->
        <layer-select
          any
          :label="layerLabelWithDefault"
          v-model="selectedLayer"
        ></layer-select>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import { IToolConfiguration } from "@/store/model";
import LayerSelect from "@/components/LayerSelect.vue";
import TagPicker from "@/components/TagPicker.vue";

interface IRestrictionSetup {
  tags: string[];
  layer: string | null;
  tagsInclusive?: boolean;
}

const props = withDefaults(
  defineProps<{
    value?: IRestrictionSetup;
    inclusiveToggle?: boolean;
    template?: any;
    tagsLabel?: string;
    layerLabel?: string;
  }>(),
  {
    inclusiveToggle: true,
  },
);

const emit = defineEmits<{
  (e: "input", value: IRestrictionSetup): void;
  (e: "change"): void;
}>();

const newTags = ref<string[]>([]);
const areTagsInclusive = ref(true);
const selectedLayer = ref<string | null>(null);

function updateFromValue() {
  if (!props.value) {
    reset();
    return;
  }
  newTags.value = props.value.tags;
  areTagsInclusive.value = !!props.value.tagsInclusive;
  selectedLayer.value = props.value.layer;
}

function reset() {
  newTags.value = [];
  areTagsInclusive.value = true;
  selectedLayer.value = null;
  changed();
}

const dataset = computed(() => store.dataset);

const tagList = computed((): string[] => {
  return store.tools
    .filter(
      (tool: IToolConfiguration) =>
        (tool.type === "create" || tool.type === "snap") &&
        tool.values.annotation,
    )
    .map((tool: IToolConfiguration) => tool.values.annotation.tags)
    .flat();
});

const layerLabelWithDefault = computed(() => {
  return props.layerLabel || "Filter by layer";
});

function changed() {
  const result: IRestrictionSetup = {
    tags: newTags.value,
    layer: selectedLayer.value,
  };
  if (props.inclusiveToggle) {
    result.tagsInclusive = areTagsInclusive.value;
  }
  emit("input", result);
  emit("change");
}

watch(newTags, changed);
watch(selectedLayer, changed);
watch(areTagsInclusive, changed);
watch(() => props.value, updateFromValue);

onMounted(() => {
  updateFromValue();
});

defineExpose({
  newTags,
  areTagsInclusive,
  selectedLayer,
  updateFromValue,
  reset,
  dataset,
  tagList,
  layerLabelWithDefault,
  changed,
});
</script>
