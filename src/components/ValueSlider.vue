<template>
  <div v-if="min !== max || isUnrolled" class="value-slider">
    <!-- Show unrolled message when unrolled -->
    <div v-if="isUnrolled" class="unrolled-message">
      {{ unrolledMessage }}
    </div>
    <!-- Show normal slider when not unrolled -->
    <template v-else>
      <!-- Row 1: Label and Text Input -->
      <div class="d-flex align-center mb-1">
        <div class="label-column text-right pa-0">{{ label }}:</div>
        <v-text-field
          :model-value="displayValue"
          class="mt-0 pt-0 no-underline flex-grow-1 ml-2"
          hide-details
          single-line
          type="text"
          density="compact"
          @update:model-value="handleInput"
          @blur="handleBlur"
        />
        <div class="step-arrows ml-1">
          <v-btn
            size="x-small"
            icon
            class="step-btn"
            :disabled="modelValue >= max"
            @click="increment"
          >
            <v-icon size="x-small">mdi-chevron-up</v-icon>
          </v-btn>
          <v-btn
            size="x-small"
            icon
            class="step-btn"
            :disabled="modelValue <= min"
            @click="decrement"
          >
            <v-icon size="x-small">mdi-chevron-down</v-icon>
          </v-btn>
        </div>
      </div>

      <!-- Row 2: Slider and Counter -->
      <div class="d-flex align-center mt-0">
        <div class="label-column flex-shrink-0"></div>
        <div class="slider-column flex-grow-1 ml-2">
          <v-slider
            v-model="slider"
            :max="max + offset"
            :min="min + offset"
            :step="1"
            hide-details
          />
        </div>
        <span class="caption font-weight-light counter-label ml-2">
          {{ `${modelValue + offset} of ${max + offset}` }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.value-slider {
  flex: 1;
  min-width: 0;
}

.label-column {
  width: 3em;
  min-width: 3em;
  flex-shrink: 0;
}

.counter-label {
  white-space: nowrap;
  flex-shrink: 0;
}

.unrolled-message {
  padding: 4px 0;
  font-size: inherit;
}

/* Kill the v-text-field underline (normal and focused) */
.no-underline :deep(.v-text-field__details) {
  display: none;
}

.no-underline :deep(.v-input__slot:before),
.no-underline :deep(.v-input__slot:after) {
  display: none !important;
}

/* Keep vertical rhythm tight */
.slider-column :deep(.v-slider) {
  margin-top: 1px;
  margin-bottom: 0;
}

/* Step arrows styling */
.step-arrows {
  display: flex;
  flex-direction: column;
  margin-left: 4px;
}

.step-btn {
  height: 14px !important;
  width: 14px !important;
  min-width: 14px !important;
}

.step-btn .v-icon {
  font-size: 14px !important;
}
</style>

<script setup lang="ts">
import { ref, computed, watch } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    label: string;
    offset?: number;
    valueLabel?: string | null;
    isUnrolled?: boolean;
  }>(),
  {
    offset: 0,
    valueLabel: null,
    isUnrolled: false,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
}>();

const internalValue = ref(0);

const slider = computed({
  get: () => internalValue.value,
  set: (value: number) => {
    const numberValue = typeof value === "number" ? value : parseInt(value);
    if (numberValue === internalValue.value) {
      return;
    }
    internalValue.value = numberValue;
    emit("update:modelValue", numberValue - props.offset);
  },
});

const displayValue = computed(
  () => props.valueLabel || (props.modelValue + props.offset).toString(),
);

const unrolledMessage = computed(() => `${props.label} is unrolled`);

function updateInternalValue() {
  internalValue.value = props.modelValue + props.offset;
}

watch(() => props.modelValue, updateInternalValue, { immediate: true });

function handleInput(value: string) {
  const numValue = parseInt(value);
  if (!isNaN(numValue)) {
    slider.value = numValue;
    return;
  }
  if (props.valueLabel && value === props.valueLabel) {
    return;
  }
}

function handleBlur() {
  updateInternalValue();
}

function increment() {
  if (props.modelValue < props.max) {
    emit("update:modelValue", props.modelValue + 1);
  }
}

function decrement() {
  if (props.modelValue > props.min) {
    emit("update:modelValue", props.modelValue - 1);
  }
}

defineExpose({ slider, displayValue, unrolledMessage, increment, decrement });
</script>
