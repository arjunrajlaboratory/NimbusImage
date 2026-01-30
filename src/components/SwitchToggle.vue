<template>
  <v-switch
    :value="value"
    @input="emit('input', $event)"
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
          'theme--light': !$vuetify.theme.dark,
          'theme--dark': $vuetify.theme.dark,
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
  value?: string;
  trueLabel?: string;
  trueValue?: string;
  falseLabel?: string;
  falseValue?: string;
  label?: string;
}>();

const emit = defineEmits<{
  (e: "input", value: string): void;
}>();
</script>
