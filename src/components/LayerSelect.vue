<template>
  <!-- layer -->
  <v-select
    v-bind="$attrs"
    :items="layerItems"
    item-title="label"
    density="compact"
    v-model="layer"
    :label="label"
  />
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from "vue";
import type { PropType } from "vue";
import store from "@/store";

const props = defineProps({
  modelValue: { type: String as PropType<string | null> },
  any: { type: undefined as any, default: undefined },
  label: { type: undefined as any, default: undefined },
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

const layer = computed<string | null | undefined>({
  get() {
    return props.modelValue;
  },
  set(val: string | null | undefined) {
    emit("update:modelValue", val as string | null);
  },
});

const layerItems = computed(() => {
  const layers: { label: string; value: string | null }[] = store.layers.map(
    (l: any) => ({
      label: l.name,
      value: l.id,
    }),
  );
  if (props.any !== undefined) {
    return [...layers, { label: "Any", value: null }];
  }
  return layers;
});

function ensureLayer() {
  if (props.any !== undefined) {
    if (layer.value === undefined) {
      layer.value = null;
    }
  } else {
    if (layer.value == null) {
      layer.value = layerItems.value[0].value;
    }
  }
}

onMounted(ensureLayer);
watch(layer, ensureLayer);

defineExpose({ layer, layerItems, ensureLayer });
</script>
