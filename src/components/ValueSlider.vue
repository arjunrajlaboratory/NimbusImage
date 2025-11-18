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
          <v-text-field
            :value="displayValue"
            class="mt-0 pt-0 no-underline"
            hide-details
            single-line
            type="text"
            dense
            @input="handleInput"
            @blur="handleBlur"
          />
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
</style>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";

@Component
export default class ValueSlider extends Vue {
  @Prop({ required: true })
  readonly value!: number;
  @Prop({ required: true })
  readonly min!: number;
  @Prop({ required: true })
  readonly max!: number;
  @Prop({ required: true })
  readonly label!: string;
  @Prop({ default: 0 })
  readonly offset!: number;
  @Prop({ default: null })
  readonly valueLabel!: string | null;
  @Prop({ default: false })
  readonly isUnrolled!: boolean;

  // Will be immediatiely updated by watchValue()
  private internalValue = 0;

  get slider() {
    return this.internalValue;
  }

  set slider(value: number) {
    const numberValue = typeof value === "number" ? value : parseInt(value);
    if (numberValue === this.internalValue) {
      return;
    }
    this.internalValue = numberValue;
    this.$emit("input", numberValue - this.offset);
  }

  get displayValue() {
    return this.valueLabel || (this.value + this.offset).toString();
  }

  get unrolledMessage() {
    return `${this.label} is unrolled`;
  }

  private updateInternalValue() {
    this.internalValue = this.value + this.offset;
  }

  @Watch("value", { immediate: true })
  watchValue() {
    this.updateInternalValue();
  }

  handleInput(value: string) {
    // Try to parse as number first
    const numValue = parseInt(value);
    if (!isNaN(numValue)) {
      this.slider = numValue;
      return;
    }

    // If not a number, check if the input matches the current value label
    // (If the user types the same label that's already displayed, do nothing)
    if (this.valueLabel && value === this.valueLabel) {
      return;
    }
    // Otherwise, if input is not a number and doesn't match the label, do nothing
    // (The display will be corrected on blur via handleBlur)
  }

  handleBlur() {
    // On blur, ensure we show the correct value
    this.updateInternalValue();
  }
}
</script>
