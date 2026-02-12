<template>
  <!-- image -->
  <v-select
    :items="items"
    dense
    v-model="image"
    label="Algorithm"
    :menu-props="{ maxHeight: 500 }"
  >
    <template v-slot:item="item">
      <div>
        <div>{{ item.item.text }}</div>
        <div v-if="item.item.description" :style="{ color: 'grey' }">
          {{ item.item.description }}
        </div>
      </div>
    </template>
  </v-select>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import propertiesStore from "@/store/properties";
import { IWorkerLabels } from "@/store/model";

interface IDockerImageSelectEntry {
  text: string;
  value: string;
  description: string | undefined;
}

const props = defineProps<{
  value: string | null;
  imageFilter: (labels: IWorkerLabels) => boolean;
}>();

const emit = defineEmits<{
  (e: "input", value: string | null): void;
}>();

const image = computed({
  get: () => props.value,
  set: (val: string | null) => emit("input", val),
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
