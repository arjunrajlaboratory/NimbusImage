<template>
  <v-radio-group
    :value="value.type"
    @change="changeSlice($event, value.value)"
    :label="labelHint"
    hide-details
    dense
  >
    <template v-if="maxValue > 0">
      <v-radio value="current" label="Current" class="smaller" />

      <v-radio value="constant" class="inline-text smaller">
        <template #label>
          <span>Constant</span>
          <v-text-field
            v-show="value.type === 'constant'"
            :value="(value.value || 0) + offset"
            :min="offset"
            :max="maxValue + offset"
            type="number"
            dense
            hide-details
            @input="changeSlice('constant', $event)"
          />
        </template>
      </v-radio>
      <v-radio
        value="offset"
        class="inline-text smaller"
        :disabled="maxValue === 0"
      >
        <template #label>
          <span>Offset</span>
          <v-text-field
            v-show="value.type === 'offset'"
            :value="value.value || 0"
            type="number"
            dense
            :min="minOffsetValue"
            :max="maxOffsetValue"
            hide-details
            @input="changeSlice('offset', $event)"
          />
        </template>
      </v-radio>
      <v-radio value="max-merge" label="Max Merge" class="smaller" />
    </template>
  </v-radio-group>
</template>
<style>
.v-input--radio-group--column .v-input--radio-group__input > .v-label {
  padding-bottom: 2px;
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import { IDisplaySlice, TDisplaySliceType } from "@/store/model";

const props = defineProps<{
  value: IDisplaySlice;
  maxValue: number;
  label: string;
  displayed: number;
  offset: number;
}>();

const emit = defineEmits<{
  (e: "change", payload: { type: TDisplaySliceType; value: number }): void;
}>();

const maxOffsetValue = computed(() => props.maxValue);
const minOffsetValue = computed(() => -props.maxValue);

const labelHint = computed(() => {
  if (props.maxValue === 0) {
    return `${props.label} (no slices available)`;
  }
  return props.label;
});

function changeSlice(type: TDisplaySliceType, value: string | number | null) {
  const inputValue =
    typeof value === "string" ? parseInt(value, 10) : value || 0;

  const typeHasChanged = props.value.type !== type;
  if (
    (!typeHasChanged && props.value.value === value) ||
    (!inputValue && inputValue !== 0)
  ) {
    return;
  }

  let validated = inputValue;
  switch (type) {
    case "constant":
      const constantValue =
        inputValue !== null ? inputValue - props.offset : null;

      validated =
        constantValue == null || typeHasChanged
          ? props.displayed
          : Math.max(Math.min(constantValue, props.maxValue), 0);
      break;
    case "offset":
      validated =
        inputValue == null || typeHasChanged
          ? 0
          : Math.max(
              Math.min(inputValue, maxOffsetValue.value),
              minOffsetValue.value,
            );
      break;
    default:
      validated = 0;
      break;
  }
  emit("change", {
    type,
    value: validated,
  });
}

defineExpose({ maxOffsetValue, minOffsetValue, labelHint, changeSlice });
</script>

<style lang="scss" scoped>
.smaller {
  margin-bottom: 0 !important;

  ::v-deep .v-label {
    font-size: 14px;
    height: auto;
  }
}

.inline-text {
  span {
    width: 6em;
  }

  .v-text-field {
    font-size: 12px;
    margin: 0;

    ::v-deep input {
      padding: 0 !important;
    }
  }
}
</style>
