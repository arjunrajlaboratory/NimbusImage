<template>
  <layer-select any :label="label" v-model="selectedLayerId" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import LayerSelect from "@/components/LayerSelect.vue";

// Tool interface element (type "layerSelect") that stores an optional layer
// id (null = any layer). Attribute fallthrough is disabled so that the extra
// attributes ToolConfigurationItem binds on its dynamic component (e.g.
// return-object) don't reach the inner v-select and change its model type.
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    label?: string;
  }>(),
  {
    modelValue: null,
    label: "Layer",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

const selectedLayerId = computed({
  get() {
    return props.modelValue;
  },
  set(layerId: string | null) {
    emit("update:modelValue", layerId);
  },
});
</script>
