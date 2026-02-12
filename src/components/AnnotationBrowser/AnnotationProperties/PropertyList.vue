<template>
  <v-card class="d-flex flex-column property-list">
    <div class="property-header">
      <div class="d-flex align-center px-4 py-2">
        <span class="text-subtitle-1">Object Properties</span>
        <v-spacer></v-spacer>
        <template v-if="uncomputedProperties.length <= 0">
          <span class="text-none px-2 success--text">
            Computations done
            <v-icon small color="success">mdi-check</v-icon>
          </span>
        </template>
        <v-btn
          v-else
          text
          small
          color="primary"
          class="text-none px-2"
          @click="computeUncomputedProperties"
          :disabled="uncomputedRunning > 0"
        >
          {{
            uncomputedRunning > 0
              ? "Running uncomputed properties"
              : "Compute all"
          }}
          <template v-if="uncomputedRunning > 0">
            <v-progress-circular
              indeterminate
              size="16"
              width="2"
              class="ml-1"
            />
          </template>
          <template v-else>
            <v-icon small right>mdi-play</v-icon>
          </template>
        </v-btn>
      </div>
      <v-divider></v-divider>
    </div>
    <div class="property-content">
      <v-expansion-panels>
        <v-expansion-panel
          v-for="(property, index) in properties"
          :key="`${property.id} ${index}`"
        >
          <v-expansion-panel-header>
            <annotation-property
              :property="property"
              :applyToAllDatasets="applyToAllDatasets"
              @compute-property-batch="$emit('compute-property-batch', $event)"
            />
          </v-expansion-panel-header>
          <v-expansion-panel-content>
            <annotation-property-body :property="property" />
          </v-expansion-panel-content>
        </v-expansion-panel>
      </v-expansion-panels>
    </div>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import propertyStore from "@/store/properties";
import AnnotationProperty from "@/components/AnnotationBrowser/AnnotationProperties/Property.vue";
import AnnotationPropertyBody from "@/components/AnnotationBrowser/AnnotationProperties/PropertyBody.vue";
import { IAnnotationProperty } from "@/store/model";

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
  (e: "compute-property-batch", property: IAnnotationProperty): void;
}>();

const properties = computed(() => propertyStore.properties);

const uncomputedProperties = computed(() => {
  const res: IAnnotationProperty[] = [];
  for (const property of propertyStore.properties) {
    if (
      propertyStore.uncomputedAnnotationsPerProperty[property.id].length > 0
    ) {
      res.push(property);
    }
  }
  return res;
});

const uncomputedRunning = computed(() => {
  let value = 0;
  for (const property of uncomputedProperties.value) {
    if (propertyStore.propertyStatuses[property.id]?.running) {
      value++;
    }
  }
  return value;
});

function computeUncomputedProperties() {
  if (props.applyToAllDatasets) {
    emit("compute-properties-batch", uncomputedProperties.value);
    return;
  }
  for (const property of uncomputedProperties.value) {
    propertyStore.computeProperty({
      property,
      errorInfo: { errors: [] },
    });
  }
}

defineExpose({
  properties,
  uncomputedProperties,
  uncomputedRunning,
  computeUncomputedProperties,
});
</script>

<style scoped>
.property-list {
  height: 100%;
}

.property-header {
  flex: 0 0 auto;
}

.property-content {
  flex: 1 1 auto;
  overflow-y: scroll;
}
</style>
