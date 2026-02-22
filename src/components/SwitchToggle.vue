<template>
  <v-switch
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :label="trueLabel"
    hide-details
    :id="id"
    :true-value="trueValue"
    :false-value="falseValue"
  >
    <template #prepend>
      <label
        :class="{
          'v-label': true,
          'v-theme--light': !$vuetify.theme.current.dark,
          'v-theme--dark': $vuetify.theme.current.dark,
        }"
        :for="id"
      >
        {{ label }} {{ falseLabel }}
      </label>
    </template>
  </v-switch>
</template>

<style>
.v-input--selection-controls > .v-input__prepend-outer {
  white-space: nowrap;
  margin-top: 2px;
}
.v-input--selection-controls {
  margin-top: 8px;
}
</style>

<script setup lang="ts">
defineProps<{
  id?: string;
  modelValue?: string;
  trueLabel?: string;
  trueValue?: string;
  falseLabel?: string;
  falseValue?: string;
  label?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();
</script>
