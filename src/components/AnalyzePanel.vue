<template>
  <div class="analyze-panel">
    <div class="property-container">
      <property-creation class="property-creation" />
      <v-card class="property-list-container">
        <div class="property-list-scroll">
          <property-list />
        </div>
      </v-card>
    </div>
  </div>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import PropertyList from "@/components/AnnotationBrowser/AnnotationProperties/PropertyList.vue";
import PropertyCreation from "@/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue";

@Component({
  components: {
    PropertyCreation,
    PropertyList,
  },
})
export default class AnalyzeAnnotations extends Vue {}
</script>

<style scoped>
.analyze-panel {
  width: 100%;
  max-width: 1200px; /* Ensures dialog will be wide enough */
}

.property-container {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  min-height: 500px; /* Ensures consistent height */
}

.property-creation {
  flex: 0 1 500px; /* Fixed width, can shrink if needed */
}

.property-list-container {
  flex: 0 0 400px; /* Fixed width, won't grow or shrink */
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
