<template>
  <div v-if="min !== max || isUnrolled" class="value-slider">
    <!-- Show unrolled message when unrolled -->
    <div v-if="isUnrolled" class="unrolled-message">
      {{ unrolledMessage }}
    </div>
    <!-- Show normal slider when not unrolled -->
    <template v-else>
      <!-- Row 1: Label and Text Input -->
      <v-row no-gutters class="mb-1">
        <v-col cols="2" class="text-right align-center label-column pa-0">
          {{ label }}:
        </v-col>
        <v-col cols="10" class="text-left align-center value-column pa-0 pl-2">
          <div class="d-flex align-center">
            <v-text-field
              :value="displayValue"
              class="mt-0 pt-0 no-underline flex-grow-0"
              hide-details
              single-line
              type="text"
              dense
              @input="handleInput"
              @blur="handleBlur"
            />
            <div class="step-arrows ml-1">
              <v-btn
                x-small
                icon
                class="step-btn"
                :disabled="value >= max"
                @click="increment"
              >
                <v-icon x-small>mdi-chevron-up</v-icon>
              </v-btn>
              <v-btn
                x-small
                icon
                class="step-btn"
                :disabled="value <= min"
                @click="decrement"
              >
                <v-icon x-small>mdi-chevron-down</v-icon>
              </v-btn>
            </div>
          </div>
        </v-col>
      </v-row>

      <!-- Row 2: Slider and Counter -->
      <v-row no-gutters class="mt-0">
        <v-col cols="6" class="slider-column pa-0 pl-2 offset-2">
          <v-slider
            v-model="slider"
            :max="max + offset"
            :min="min + offset"
            hide-details
          />
        </v-col>
        <v-col
          cols="4"
          class="text-right align-center counter-column pa-0 pl-2"
        >
          <span class="caption font-weight-light">
            {{ `${value + offset} of ${max + offset}` }}
          </span>
        </v-col>
      </v-row>
    </template>
  </div>
</template>

<style scoped>
.value-slider {
  width: 100%;
}

.label-column {
  transform: translateY(2px); /* Move the label vertically */
}

.counter-column {
  transform: translateY(2px); /* Align counter with other elements */
}

.unrolled-message {
  padding: 4px 0;
  font-size: inherit;
}

/* Kill the v-text-field underline (normal and focused) */
.no-underline ::v-deep .v-text-field__details {
  display: none;
}

.no-underline ::v-deep .v-input__slot:before,
.no-underline ::v-deep .v-input__slot:after {
  display: none !important;
}

/* Keep vertical rhythm tight */
.slider-column ::v-deep .v-slider {
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
import { ref, computed, watch, getCurrentInstance } from "vue";

const props = withDefaults(
  defineProps<{
    value: number;
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

const vm = getCurrentInstance()!.proxy;

const internalValue = ref(0);

const slider = computed({
  get: () => internalValue.value,
  set: (value: number) => {
    const numberValue = typeof value === "number" ? value : parseInt(value);
    if (numberValue === internalValue.value) {
      return;
    }
    internalValue.value = numberValue;
    vm.$emit("input", numberValue - props.offset);
  },
});

const displayValue = computed(
  () => props.valueLabel || (props.value + props.offset).toString(),
);

const unrolledMessage = computed(() => `${props.label} is unrolled`);

function updateInternalValue() {
  internalValue.value = props.value + props.offset;
}

watch(() => props.value, updateInternalValue, { immediate: true });

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
  if (props.value < props.max) {
    vm.$emit("input", props.value + 1);
  }
}

function decrement() {
  if (props.value > props.min) {
    vm.$emit("input", props.value - 1);
  }
}

defineExpose({ slider, displayValue, unrolledMessage, increment, decrement });
</script>
