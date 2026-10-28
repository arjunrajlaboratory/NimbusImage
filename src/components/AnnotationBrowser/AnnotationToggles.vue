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
import { useCommand } from "@/commands/registry";
import { toggleCommands } from "@/commands/toggles";
import { useInViewer } from "@/commands/context";
import { ICommand } from "@/commands/types";
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

// "Show objects" and "Show object tooltips" are registered by ImageViewer,
// next to their hotkeys. The Settings palette stays mounted on every route,
// so these are gated to the viewer; like their checkboxes, they are off while
// objects are hidden.
const inViewer = useInViewer();

useCommand(() =>
  toggleCommands(
    [
      {
        id: "objects.toggleConnections",
        setting: drawConnections,
        turnOn: "Show connections between objects",
        turnOff: "Hide connections between objects",
        keywords: ["links", "lines", "lineage", "annotations"],
        icon: "mdi-vector-line",
        enabled: () => drawAnnotations.value,
      },
      {
        id: "objects.toggleFilteredDraw",
        setting: filteredDraw,
        // The off title names no part of the on state ("filter" included):
        // "filter objects" must not find it while filtering is on.
        turnOn: "Only show objects passing filters",
        turnOff: "Draw every object",
        keywords: ["annotations", "draw"],
        // "filtered" only while it turns filtering on: "filtered objects"
        // must not find the command that turns it off.
        turnOnKeywords: ["filter", "filtered", "passing"],
        turnOffKeywords: ["unfiltered", "every", "all"],
        icon: "mdi-filter-outline",
        enabled: () => drawAnnotations.value,
      },
      {
        id: "objects.toggleFilteredTooltips",
        setting: filteredAnnotationTooltips,
        // As above: no "filter" in the off title.
        turnOn: "Show tooltips only for objects passing filters",
        turnOff: "Show tooltips for every object",
        keywords: ["hover", "labels", "annotations"],
        turnOnKeywords: ["filter", "filtered", "passing"],
        turnOffKeywords: ["unfiltered", "every", "all"],
        icon: "mdi-tooltip-text-outline",
        // Same gate as the switch.
        enabled: () => showTooltips.value && drawAnnotations.value,
      },
    ],
    { when: inViewer },
  ),
);

// The selection-mode select: one command per mode other than the current.
useCommand(() =>
  annotationsSelectionTypeItems
    .filter((item) => item.value !== annotationSelectionType.value)
    .map(
      (item): ICommand => ({
        id: `objects.selectionMode.${item.value}`,
        title: `Object selection mode: ${item.text}`,
        group: "Actions",
        keywords: ["select", "selection", "lasso", "objects"],
        icon: "mdi-selection",
        enabled: inViewer,
        run: () => {
          annotationSelectionType.value = item.value;
        },
      }),
    ),
);

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
