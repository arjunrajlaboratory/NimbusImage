<template>
  <v-container v-if="propertyFullName">
    <v-row class="title text--primary d-flex align-center">
      <v-checkbox
        v-model="propertyFilter.enabled"
        class="ml-4"
        dense
        hide-details
        @change="toggleFilterEnabled"
      ></v-checkbox>
      <span>{{ propertyFullName }}</span>
      <v-btn-toggle
        v-model="propertyFilter.valuesOrRange"
        mandatory
        class="ml-4"
        dense
        @change="updateViewMode"
      >
        <v-btn value="range" small>Histogram</v-btn>
        <v-btn value="values" small>Values</v-btn>
      </v-btn-toggle>
      <v-spacer></v-spacer>
      <v-btn icon small class="mr-2" @click="removeFilter">
        <v-icon>mdi-close</v-icon>
      </v-btn>
    </v-row>

    <template v-if="propertyFilter.valuesOrRange === PropertyFilterMode.Range">
      <v-row>
        <v-col class="wrapper" ref="wrapper" :style="{ width: `${width}px` }">
          <svg :width="width" :height="height" v-if="hist">
            <path class="path" :d="area" />
          </svg>
          <div class="min-hint" :style="{ width: toValue(minValue) }"></div>
          <div
            class="max-hint"
            :style="{ width: toValue(maxValue, true) }"
          ></div>
          <div ref="min" class="min" :style="{ left: toValue(minValue) }"></div>
          <div
            ref="max"
            class="max"
            :style="{ right: toValue(maxValue, true) }"
          ></div>
        </v-col>
        <v-col>
          <v-checkbox v-model="useCDF" label="CDF"></v-checkbox>
        </v-col>
        <v-col>
          <v-checkbox v-model="useLog" label="log"></v-checkbox>
        </v-col>
      </v-row>
      <v-row>
        <v-col class="pa-1">
          <v-text-field
            dense
            hide-details
            label="Min"
            type="number"
            v-model="minValue"
          ></v-text-field>
        </v-col>
        <v-col class="pa-1">
          <v-text-field
            dense
            hide-details
            type="number"
            label="Max"
            v-model="maxValue"
          ></v-text-field>
        </v-col>
      </v-row>
    </template>

    <template v-else>
      <v-row>
        <v-col>
          <v-textarea
            v-model="valuesInput"
            dense
            rows="4"
            hide-details
            placeholder="Enter values separated by spaces, commas, tabs, or newlines"
            @input="debouncedUpdateValues"
          ></v-textarea>
        </v-col>
      </v-row>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { arePathEquals, getValueFromObjectAndPath } from "@/utils/paths";
import { selectAll, event as d3Event } from "d3-selection";
import { drag, D3DragEvent } from "d3-drag";

import { IPropertyAnnotationFilter, PropertyFilterMode } from "@/store/model";
import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import { area as d3Area, curveStepBefore } from "d3-shape";
import { v4 as uuidv4 } from "uuid";

import { scaleLinear, scaleSymlog } from "d3-scale";
import debounce from "lodash/debounce";

// Suppress unused import warnings for template-only components
void TagFilterEditor;

const props = defineProps<{ propertyPath: string[] }>();

// Template refs
const wrapper = ref<HTMLElement>();
const min = ref<HTMLElement>();
const max = ref<HTMLElement>();

const width = ref(300);
const height = ref(60);
const useLog = ref(false);
const useCDF = ref(false);
const defaultMinMax = ref(true);
const valuesInput = ref("");

const histToPixel = computed(() => {
  const scale = scaleLinear()
    .range([0, width.value])
    .domain([defaultMin.value, defaultMax.value]);
  return scale;
});

function toValue(val: number, isMax: boolean = false) {
  const base = histToPixel.value(val);
  if (isMax) {
    return `${width.value - base}px`;
  }
  return `${base}px`;
}

const minValue = computed({
  get: () =>
    defaultMinMax.value ? defaultMin.value : propertyFilter.value.range.min,
  set: (value) => {
    const numVal = Number(value);
    if (numVal > maxValue.value || numVal < defaultMin.value) return;
    if (defaultMinMax.value) {
      defaultMinMax.value = false;
    }
    filterStore.updatePropertyFilter({
      ...propertyFilter.value,
      range: { min: numVal, max: maxValue.value },
    });
  },
});

const maxValue = computed({
  get: () =>
    defaultMinMax.value ? defaultMax.value : propertyFilter.value.range.max,
  set: (value) => {
    const numVal = Number(value);
    if (numVal < minValue.value || numVal > defaultMax.value) return;
    if (defaultMinMax.value) {
      defaultMinMax.value = false;
    }
    filterStore.updatePropertyFilter({
      ...propertyFilter.value,
      range: { min: minValue.value, max: numVal },
    });
  },
});

const defaultMin = computed(() => Math.min(...values.value));

const defaultMax = computed(() => Math.max(...values.value));

const propertyFilters = computed(() => filterStore.propertyFilters);

const propertyFilter = computed(() => {
  const filter = propertyFilters.value.find(
    (value: IPropertyAnnotationFilter) =>
      arePathEquals(value.propertyPath, props.propertyPath),
  );
  if (!filter) {
    const newFilter: IPropertyAnnotationFilter = {
      range: { min: defaultMin.value, max: defaultMax.value },
      id: uuidv4(),
      propertyPath: props.propertyPath,
      exclusive: false,
      enabled: true,
      valuesOrRange: PropertyFilterMode.Range,
    };
    filterStore.updatePropertyFilter(newFilter);
    return newFilter;
  }
  return filter;
});

const propertyFullName = computed(() =>
  propertyStore.getFullNameFromPath(props.propertyPath),
);

const values = computed(() => {
  const valuesForThisProperty: number[] = [];
  const propValues = propertyStore.propertyValues;
  for (const annotationId in propValues) {
    const valuesPerProperty = propValues[annotationId];
    const value = getValueFromObjectAndPath(
      valuesPerProperty,
      props.propertyPath,
    );
    if (typeof value === "number") {
      valuesForThisProperty.push(value);
    }
  }
  return valuesForThisProperty;
});

const hist = computed(() => filterStore.getHistogram(props.propertyPath) || []);

const area = computed(() => {
  const nInitial = hist.value.length;
  if (nInitial === 0) return "";

  const minIntensity = hist.value[0].min;
  const maxIntensity = hist.value[nInitial - 1].max;
  const dummyFirstPoint = {
    count: 0,
    min: minIntensity,
    max: minIntensity,
  };
  const histData = [dummyFirstPoint, ...hist.value];

  const densities = histData.map(({ count, min, max }) =>
    max <= min ? 0 : count / (max - min),
  );
  if (useCDF.value) {
    for (let i = 1; i < densities.length; ++i) {
      densities[i] += densities[i - 1];
    }
  }

  const intensities = histData.map(({ max }) => max);

  const scaleY = useLog.value ? scaleSymlog() : scaleLinear();
  scaleY.domain([0, Math.max(...densities)]);
  scaleY.range([height.value, 0]);

  const scaleX = scaleLinear();
  scaleX.domain([minIntensity, maxIntensity]);
  scaleX.range([0, width.value]);

  const gen = d3Area<number>()
    .curve(curveStepBefore)
    .x((_, i) => scaleX(intensities[i])!)
    .y0(scaleY(0))
    .y1((d) => scaleY(d)!);
  return gen(densities) ?? undefined;
});

function updateMinMax(which: "min" | "max", pixel: number) {
  const val = Math.round(histToPixel.value.invert(pixel));
  if (which === "min") {
    minValue.value = Math.min(maxValue.value, val);
  } else {
    maxValue.value = Math.max(minValue.value, val);
  }
}

function initializeHandles() {
  if (min.value && max.value) {
    const minEl = min.value;
    const maxEl = max.value;

    const onDrag = (which: "min" | "max") => {
      const evt = d3Event as D3DragEvent<HTMLElement, any, any>;
      updateMinMax(which, Math.max(0, Math.min(evt.x, width.value)));
    };

    const dragBehavior = drag<HTMLElement, any>().on("drag", onDrag);

    selectAll([minEl, maxEl]).data(["min", "max"]).call(dragBehavior);
  }
}

function parseValuesInput(input: string): number[] {
  return input
    .split(/[\s,;\t\n]+/)
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .map(Number)
    .filter((v) => !isNaN(v));
}

function updateValuesFilter() {
  const parsedValues = parseValuesInput(valuesInput.value);
  if (parsedValues.length) {
    filterStore.updatePropertyFilter({
      ...propertyFilter.value,
      values: parsedValues,
    });
  }
}

const debouncedUpdateValues = debounce(updateValuesFilter, 500);

function updateViewMode(mode: PropertyFilterMode) {
  filterStore.updatePropertyFilter({
    ...propertyFilter.value,
    valuesOrRange: mode,
    values:
      mode === PropertyFilterMode.Range
        ? undefined
        : propertyFilter.value.values,
  });
  if (mode === PropertyFilterMode.Range) {
    nextTick(() => {
      initializeHandles();
    });
  } else {
    updateValuesFilter();
  }
}

function toggleFilterEnabled(enabled: boolean) {
  filterStore.updatePropertyFilter({
    ...propertyFilter.value,
    enabled,
  });
}

function removeFilter() {
  filterStore.togglePropertyPathFiltering(props.propertyPath);
}

watch(hist, () => initializeHandles());

onMounted(() => {
  if (
    propertyFilter.value.valuesOrRange === PropertyFilterMode.Values &&
    propertyFilter.value.values
  ) {
    valuesInput.value = propertyFilter.value.values.join(", ");
  }

  filterStore.updateHistograms();
  if (!propertyFilter.value.enabled) {
    filterStore.updatePropertyFilter({
      ...propertyFilter.value,
      enabled: true,
    });
  }
  initializeHandles();
});

onBeforeUnmount(() => {
  if (propertyFilter.value.enabled) {
    filterStore.updatePropertyFilter({
      ...propertyFilter.value,
      enabled: false,
    });
  }
});

defineExpose({
  width,
  height,
  useLog,
  useCDF,
  defaultMinMax,
  valuesInput,
  histToPixel,
  toValue,
  minValue,
  maxValue,
  defaultMin,
  defaultMax,
  propertyFilter,
  propertyFullName,
  values,
  hist,
  area,
  initializeHandles,
  updateValuesFilter,
  updateViewMode,
  toggleFilterEnabled,
  removeFilter,
});
</script>
<style scoped lang="scss">
.wrapper {
  margin-top: 0.5em;
  position: relative;
  display: flex;

  &:hover {
    > .min {
      border-right-width: 5px;
    }

    > .max {
      border-left-width: 5px;
    }
  }
}
.min,
.max {
  position: absolute;
  top: 0;
  height: 100%;
  transition: border-width 0.2s ease;
  width: 1px;
  cursor: ew-resize;
}

.max {
  right: 0;
  border-right: none;
}

$savedHint: 7px;
.min-hint,
.max-hint {
  position: absolute;
  top: 0;
  height: 100%;
  user-select: none;
  pointer-events: none;
}

.min-hint {
  left: 0;
}

.max-hint {
  right: 0;
}

.theme--dark {
  .path {
    fill: #c2c2c2;
  }

  .min {
    border-right: 1px solid lightgray;
  }

  .max {
    border-left: 1px solid lightgray;
  }

  .saved-min,
  .saved-max {
    border-top: $savedHint solid lightgray;
  }

  .min-hint,
  .max-hint {
    background: repeating-linear-gradient(
      -45deg,
      rgba(255, 255, 255, 0.5),
      rgba(255, 255, 255, 0.5) 5px,
      #696969 5px,
      #696969 10px
    );
  }
}

.theme--light {
  .path {
    fill: #c2c2c2;
  }
  .min {
    border-right: 1px solid darkgray;
  }

  .max {
    border-left: 1px solid darkgray;
  }

  .min-hint,
  .max-hint {
    background: repeating-linear-gradient(
      -45deg,
      rgba(255, 255, 255, 0.5),
      rgba(255, 255, 255, 0.5) 5px,
      #bdbdbd 5px,
      #bdbdbd 10px
    );
  }
}

.v-input--selection-controls {
  margin-top: 0;
  padding-top: 0;
}

.v-btn.v-btn--icon.v-size--small {
  width: 24px;
  height: 24px;
}
</style>
