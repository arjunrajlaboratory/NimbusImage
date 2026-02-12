<template>
  <v-container>
    <v-row>
      <v-col class="pa-0">
        <docker-image-select
          v-model="image"
          :imageFilter="annotationImageFilter"
        />
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import { IWorkerLabels } from "@/store/model";

interface IImageSetup {
  image: string | null;
}

const props = defineProps<{
  value?: IImageSetup;
  template?: any;
}>();

const emit = defineEmits<{
  (e: "input", value: IImageSetup): void;
  (e: "change"): void;
}>();

const image = ref<string | null>(null);

function annotationImageFilter(labels: IWorkerLabels) {
  return labels.isAnnotationWorker !== undefined;
}

function updateFromValue() {
  if (!props.value) {
    reset();
    return;
  }
  image.value = props.value.image;
}

function reset() {
  image.value = null;
  changed();
}

function changed() {
  const result: IImageSetup = { image: image.value };
  emit("input", result);
  emit("change");
}

watch(image, changed);

onMounted(() => {
  updateFromValue();
});

defineExpose({
  image,
  annotationImageFilter,
  updateFromValue,
  reset,
  changed,
});
</script>
