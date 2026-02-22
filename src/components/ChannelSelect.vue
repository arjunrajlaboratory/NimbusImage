<template>
  <!-- channel -->
  <v-select
    v-bind="$attrs"
    :items="channelItems"
    density="compact"
    v-model="channel"
    :label="label"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";

const props = withDefaults(
  defineProps<{
    modelValue?: number | null;
    any?: boolean;
    label?: string;
  }>(),
  {
    any: false,
    label: "",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number | null): void;
}>();

const channel = computed({
  get: () => props.modelValue ?? null,
  set: (value: number | null) => emit("update:modelValue", value),
});

const channelItems = computed(() => {
  const res: { text: string; value: number | null }[] = [];
  if (props.any) {
    res.push({ text: "Any", value: null });
  }
  if (store.dataset) {
    for (const ch of store.dataset.channels) {
      res.push({
        text: store.dataset.channelNames.get(ch) || `Channel ${ch}`,
        value: ch,
      });
    }
  }
  return res;
});

defineExpose({ channelItems });
</script>
