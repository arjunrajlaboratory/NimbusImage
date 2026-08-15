<template>
  <span
    v-if="uncomputedProperties.length <= 0"
    class="text-none px-2 text-success"
  >
    Computations done
    <v-icon size="small" color="success">mdi-check</v-icon>
  </span>
  <v-btn
    v-else
    variant="text"
    size="small"
    color="primary"
    class="text-none px-2"
    @click="computeUncomputedProperties"
    :disabled="uncomputedRunning > 0"
  >
    {{
      uncomputedRunning > 0 ? "Running uncomputed properties" : "Compute all"
    }}
    <template v-if="uncomputedRunning > 0">
      <v-progress-circular indeterminate size="16" width="2" class="ml-1" />
    </template>
    <template v-else>
      <v-icon size="small" end>mdi-play-circle-outline</v-icon>
    </template>
  </v-btn>
</template>

<script setup lang="ts">
import { computed } from "vue";
import propertyStore from "@/store/properties";
import { IAnnotationProperty } from "@/store/model";
import { computePropertyWithStatus } from "@/utils/propertyCompute";

const props = withDefaults(
  defineProps<{
    applyToAllDatasets?: boolean;
  }>(),
  {
    applyToAllDatasets: false,
  },
);

const emit = defineEmits<{
  (e: "compute-properties-batch", properties: IAnnotationProperty[]): void;
}>();

const uncomputedProperties = computed(() => {
  const counts = propertyStore.uncomputedCountByProperty;
  return propertyStore.properties.filter(
    (property) => (counts[property.id] ?? 0) > 0,
  );
});

const uncomputedRunning = computed(
  () =>
    uncomputedProperties.value.filter(
      (property) => propertyStore.propertyStatuses[property.id]?.running,
    ).length,
);

function computeUncomputedProperties() {
  if (props.applyToAllDatasets) {
    emit("compute-properties-batch", uncomputedProperties.value);
    return;
  }
  for (const property of uncomputedProperties.value) {
    computePropertyWithStatus(property);
  }
}

defineExpose({
  uncomputedProperties,
  uncomputedRunning,
  computeUncomputedProperties,
});
</script>
