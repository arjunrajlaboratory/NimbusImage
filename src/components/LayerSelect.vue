<template>
  <!-- layer -->
  <v-select
    v-bind="$attrs"
    :items="layerItems"
    item-text="label"
    dense
    v-model="layer"
    :label="label"
  />
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from "vue";
import type { PropType } from "vue";
import store from "@/store";

const props = defineProps({
  value: { type: String as PropType<string | null> },
  any: { type: undefined as any, default: undefined },
  label: { type: undefined as any, default: undefined },
});

const emit = defineEmits<{
  (e: "input", value: string | null): void;
}>();

const layer = computed<string | null | undefined>({
  get() {
    return props.value;
  },
  set(val: string | null | undefined) {
    emit("input", val as string | null);
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
