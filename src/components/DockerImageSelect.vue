<template>
  <!-- image -->
  <v-select
    :items="items"
    density="compact"
    v-model="image"
    label="Algorithm"
    :menu-props="{ maxHeight: 500 }"
  >
    <template v-slot:item="{ item }">
      <div>
        <div>{{ (item as any).raw?.text ?? item.title }}</div>
        <div v-if="(item as any).raw?.description" :style="{ color: 'grey' }">
          {{ (item as any).raw.description }}
        </div>
      </div>
    </template>
  </v-select>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import type { PropType } from "vue";
import propertiesStore from "@/store/properties";
import { IWorkerLabels } from "@/store/model";

interface IDockerImageSelectEntry {
  text: string;
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
        text: labels.interfaceName || img,
        value: img,
        description: labels.description,
      });
    }
  }
  const result = [];
  for (const category in imagesPerCategory) {
    result.push(
      { divider: true },
      { header: category },
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
