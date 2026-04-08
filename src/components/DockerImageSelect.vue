<template>
  <!-- image -->
  <v-select
    :items="items"
    density="compact"
    v-model="image"
    label="Algorithm"
    :menu-props="{ maxHeight: 500 }"
  >
    <template v-slot:item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps">
        <v-list-item-subtitle v-if="'description' in item && item.description">
          {{ item.description }}
        </v-list-item-subtitle>
      </v-list-item>
    </template>
  </v-select>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import type { PropType } from "vue";
import propertiesStore from "@/store/properties";
import { IWorkerLabels } from "@/store/model";

interface IDockerImageSelectEntry {
  title: string;
  value: string;
  description: string | undefined;
}

const props = defineProps({
  modelValue: { type: String as PropType<string | null>, default: null },
  imageFilter: {
    type: Function as PropType<(labels: IWorkerLabels) => boolean>,
    required: true as const,
  },
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

const image = computed({
  get: () => props.modelValue,
  set: (val: string | null) => emit("update:modelValue", val),
});

const images = computed(() => propertiesStore.workerImageList);

const items = computed(() => {
  const imagesPerCategory: {
    [category: string]: IDockerImageSelectEntry[];
  } = {};
  for (const img in images.value) {
    const labels = images.value[img];
    if (props.imageFilter(labels)) {
      const category = labels.interfaceCategory || "No category";
      if (!imagesPerCategory[category]) {
        imagesPerCategory[category] = [];
      }
      imagesPerCategory[category].push({
        title: labels.interfaceName || img,
        value: img,
        description: labels.description,
      });
    }
  }
  const result: (IDockerImageSelectEntry | { type: string; title: string })[] =
    [];
  for (const category in imagesPerCategory) {
    result.push(
      { type: "divider", title: "" },
      { type: "subheader", title: category },
      ...imagesPerCategory[category],
    );
  }
  return result;
});

onMounted(() => {
  propertiesStore.fetchWorkerImageList();
});

defineExpose({ images, items });
</script>
