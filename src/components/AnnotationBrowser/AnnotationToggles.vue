<template>
  <v-expansion-panel>
    <v-expansion-panel-header>
      Object display and selection controls
    </v-expansion-panel-header>
    <v-expansion-panel-content>
      <v-list dense class="py-0">
        <v-list-item>
          <v-checkbox
            hide-details
            v-model="drawAnnotations"
            dense
            label="Show objects (hotkey A)"
          ></v-checkbox>
        </v-list-item>
        <v-list-item>
          <v-list dense class="py-0">
            <v-list-item>
              <v-checkbox
                hide-details
                dense
                :disabled="!drawAnnotations"
                v-model="drawConnections"
                label="Show connections between objects"
              ></v-checkbox>
            </v-list-item>
            <v-list-item>
              <v-switch
                hide-details
                dense
                :disabled="!drawAnnotations"
                v-model="filteredDraw"
                label="Only show objects passing filters"
              ></v-switch>
            </v-list-item>
            <v-list-item>
              <v-checkbox
                hide-details
                dense
                :disabled="!drawAnnotations"
                v-model="showTooltips"
                label="Show object tooltips (hotkey T)"
              ></v-checkbox>
            </v-list-item>
            <v-list-item>
              <v-list dense class="py-0">
                <v-list-item>
                  <v-switch
                    hide-details
                    dense
                    :disabled="!showTooltips || !drawAnnotations"
                    v-model="filteredAnnotationTooltips"
                    label="Show tooltips only for objects passing filters"
                  ></v-switch>
                </v-list-item>
              </v-list>
            </v-list-item>
          </v-list>
        </v-list-item>
        <v-list-item>
          <v-select
            v-model="annotationSelectionType"
            :items="annotationsSelectionTypeItems"
            item-text="text"
            item-value="value"
            label="Object selection mode"
            title="When adding to a selection, you can add, remove, or toggle the selection of objects"
          ></v-select>
        </v-list-item>
      </v-list>
    </v-expansion-panel-content>
  </v-expansion-panel>
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
