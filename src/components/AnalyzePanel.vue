<template>
  <div class="analyze-panel">
    <div class="property-container">
      <div class="property-creation-column">
        <property-creation
          :applyToAllDatasets="applyToAllDatasets"
          @compute-property-batch="$emit('compute-property-batch', $event)"
        />
        <gene-expression-card :visible="visible" class="mt-4" />
      </div>
      <v-card class="property-list-container">
        <div class="property-list-scroll">
          <property-list
            :applyToAllDatasets="applyToAllDatasets"
            @compute-property-batch="$emit('compute-property-batch', $event)"
            @compute-properties-batch="
              $emit('compute-properties-batch', $event)
            "
          />
        </div>
      </v-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import PropertyList from "@/components/AnnotationBrowser/AnnotationProperties/PropertyList.vue";
import PropertyCreation from "@/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue";
import GeneExpressionCard from "@/components/AnnotationBrowser/AnnotationProperties/GeneExpressionCard.vue";

withDefaults(
  defineProps<{
    applyToAllDatasets?: boolean;
    // False while this panel's palette is closed (its content stays
    // mounted): the gene card defers its spatial-table lookup until shown.
    visible?: boolean;
  }>(),
  {
    applyToAllDatasets: false,
    visible: true,
  },
);
</script>

<style scoped>
.analyze-panel {
  width: 100%;
  max-width: 1300px; /* Ensures dialog will be wide enough */
}

.property-container {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  min-height: 500px; /* Ensures consistent height */
}

.property-creation-column {
  flex: 1 1 0; /* Equal width with property list */
  min-width: 0;
}

.property-list-container {
  flex: 1 1 0; /* Equal width with property creation */
  height: 600px; /* Fixed height */
  display: flex;
  flex-direction: column;
}

.property-list-scroll {
  flex-grow: 1;
  overflow-y: auto;
  padding: 0;
}

/* Ensure scrollbar appears nicely in webkit browsers */
.property-list-scroll::-webkit-scrollbar {
  width: 8px;
}

.property-list-scroll::-webkit-scrollbar-track {
  background: #f1f1f1;
}

.property-list-scroll::-webkit-scrollbar-thumb {
  background: #888;
  border-radius: 4px;
}
</style>
