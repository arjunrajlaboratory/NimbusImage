<template>
  <v-card class="d-flex flex-column property-list">
    <div class="property-header" :data-tour="TOUR_ANCHORS.propertiesHeader">
      <div class="d-flex align-center px-4 py-2">
        <span class="panel-section-title">Object Properties</span>
        <v-spacer></v-spacer>
        <compute-all-status
          :applyToAllDatasets="applyToAllDatasets"
          @compute-properties-batch="$emit('compute-properties-batch', $event)"
        />
      </div>
      <v-divider></v-divider>
    </div>
    <div class="property-content" :data-tour="TOUR_ANCHORS.propertiesContent">
      <v-expansion-panels>
        <v-expansion-panel
          v-for="(property, index) in properties"
          :key="`${property.id} ${index}`"
        >
          <v-expansion-panel-title>
            <annotation-property
              :property="property"
              :applyToAllDatasets="applyToAllDatasets"
              @compute-property-batch="$emit('compute-property-batch', $event)"
            />
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <annotation-property-body :property="property" />
          </v-expansion-panel-text>
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
import ComputeAllStatus from "@/components/AnnotationBrowser/AnnotationProperties/ComputeAllStatus.vue";
import { IAnnotationProperty } from "@/store/model";
import { TOUR_ANCHORS } from "@/tours/anchors";

withDefaults(
  defineProps<{
    applyToAllDatasets?: boolean;
  }>(),
  {
    applyToAllDatasets: false,
  },
);

defineEmits<{
  (e: "compute-properties-batch", properties: IAnnotationProperty[]): void;
  (e: "compute-property-batch", property: IAnnotationProperty): void;
}>();

const properties = computed(() => propertyStore.properties);

defineExpose({
  properties,
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
