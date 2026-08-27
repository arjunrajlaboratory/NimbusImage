<template>
  <section class="settings-section">
    <h4 class="settings-section-title">Object display & selection</h4>
    <div class="settings-section-body">
      <v-checkbox
        hide-details
        v-model="drawAnnotations"
        density="compact"
        label="Show objects (hotkey A)"
      />
      <div class="settings-indent" :class="{ 'is-disabled': !drawAnnotations }">
        <v-checkbox
          hide-details
          density="compact"
          :disabled="!drawAnnotations"
          v-model="drawConnections"
          label="Show connections between objects"
        />
        <v-switch
          hide-details
          density="compact"
          :disabled="!drawAnnotations"
          v-model="filteredDraw"
          label="Only show objects passing filters"
        />
        <v-checkbox
          hide-details
          density="compact"
          :disabled="!drawAnnotations"
          v-model="showTooltips"
          label="Show object tooltips (hotkey T)"
        />
        <div class="settings-indent">
          <v-switch
            hide-details
            density="compact"
            :disabled="!showTooltips || !drawAnnotations"
            v-model="filteredAnnotationTooltips"
            label="Show tooltips only for objects passing filters"
          />
        </div>
      </div>
      <v-select
        v-model="annotationSelectionType"
        :items="annotationsSelectionTypeItems"
        item-title="text"
        item-value="value"
        label="Object selection mode"
        title="When adding to a selection, you can add, remove, or toggle the selection of objects"
        density="compact"
        variant="outlined"
        hide-details
        class="mt-2"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";
import {
  AnnotationSelectionTypes,
  AnnotationSelectionTypesNames,
} from "../../store/model";

const annotationsSelectionTypeItems = [
  {
    text: AnnotationSelectionTypesNames[AnnotationSelectionTypes.ADD],
    value: AnnotationSelectionTypes.ADD,
  },
  {
    text: AnnotationSelectionTypesNames[AnnotationSelectionTypes.TOGGLE],
    value: AnnotationSelectionTypes.TOGGLE,
  },
  {
    text: AnnotationSelectionTypesNames[AnnotationSelectionTypes.REMOVE],
    value: AnnotationSelectionTypes.REMOVE,
  },
];

const annotationSelectionType = computed({
  get: () => store.annotationSelectionType,
  set: (value) => store.setAnnotationSelectionType(value),
});

const drawAnnotations = computed({
  get: () => store.drawAnnotations,
  set: (value: boolean) => store.setDrawAnnotations(value),
});

const showTooltips = computed({
  get: () => store.showTooltips,
  set: (value: boolean) => store.setShowTooltips(value),
});

const filteredAnnotationTooltips = computed({
  get: () => store.filteredAnnotationTooltips,
  set: (value: boolean) => store.setFilteredAnnotationTooltips(value),
});

const filteredDraw = computed({
  get: () => store.filteredDraw,
  set: (value: boolean) => store.setFilteredDraw(value),
});

const drawConnections = computed({
  get: () => store.drawAnnotationConnections,
  set: (value: boolean) => store.setDrawAnnotationConnections(value),
});

defineExpose({
  annotationSelectionType,
  drawAnnotations,
  showTooltips,
  filteredAnnotationTooltips,
  filteredDraw,
  drawConnections,
  annotationsSelectionTypeItems,
});
</script>
