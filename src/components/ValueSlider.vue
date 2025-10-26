<template>
  <div class="value-slider">
    <!-- Row 1: Label and Text Input -->
    <v-row no-gutters class="mb-1">
      <v-col cols="2" class="text-right align-center label-column pa-0">
        {{ label }}:
      </v-col>
      <v-col cols="10" class="text-left align-center value-column pa-0 pl-2">
        <v-text-field
          v-model="displayValue"
          class="mt-0 pt-0 no-underline"
          hide-details
          single-line
          type="text"
          :disabled="min === max"
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
          :disabled="min === max"
        />
      </v-col>
      <v-col cols="4" class="text-right align-center counter-column pa-0 pl-2">
        <span class="caption font-weight-light">
          {{ `${value + offset} of ${max + offset}` }}
        </span>
      </v-col>
    </v-row>
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

  set displayValue(_value: string) {
    // This will be handled by handleInput method
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

    // If not a number, try to find the label in the available labels
    if (this.valueLabel && value === this.valueLabel) {
      // Already at the correct label, do nothing
      return;
    }
  }

  handleBlur() {
    // On blur, ensure we show the correct value
    this.updateInternalValue();
  }
}
</script>
