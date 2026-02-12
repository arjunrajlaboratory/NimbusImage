<template>
  <v-container class="pa-0 ma-0">
    <div
      v-if="image"
      class="text-caption ml-1 mb-0 mt-0 py-0"
      style="font-size: 8px; letter-spacing: 1px; opacity: 0.7; line-height: 1"
    >
      Image: {{ image }}
    </div>
    <v-row class="pa-0 ma-0">
      <v-col cols="12" class="pa-0 ma-0">
        <v-progress-circular
          v-if="workerInterface === undefined"
          indeterminate
        />
        <worker-interface-values
          v-else-if="workerInterface"
          :workerInterface="workerInterface"
          v-model="interfaceValues"
          tooltipPosition="left"
        />
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { IWorkerInterfaceValues } from "@/store/model";
import propertiesStore from "@/store/properties";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";

const props = defineProps<{
  value: IWorkerInterfaceValues;
  image: string | null;
}>();

const emit = defineEmits<{
  (e: "input", value: IWorkerInterfaceValues): void;
}>();

const interfaceValues = computed({
  get: () => props.value,
  set: (val: IWorkerInterfaceValues) => emit("input", val),
});

const workerInterface = computed(() =>
  props.image !== null ? propertiesStore.getWorkerInterface(props.image) : null,
);

defineExpose({ workerInterface, interfaceValues });
</script>
