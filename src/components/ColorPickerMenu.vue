<template>
  <v-menu :close-on-content-click="false" transition="scale-transition">
    <template #activator="{ props: activatorProps }">
      <div
        v-bind="activatorProps"
        :class="parentClass"
        :style="[{ cursor: 'pointer' }, parentStyle]"
        class="d-flex align-center"
      >
        <span class="subtitle-2 mr-2">Color</span>
        <span :style="{ backgroundColor: color }" class="color-bar"></span>
      </div>
    </template>
    <v-color-picker
      :model-value="color"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </v-menu>
</template>

<script setup lang="ts">
import { computed, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  modelValue?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const attrs = useAttrs();

const color = computed(() => props.modelValue ?? "#FFFFFF");

const parentClass = computed(() => (attrs as any).class);
const parentStyle = computed(() => (attrs as any).style);
</script>

<style lang="scss" scoped>
.color-bar {
  border-radius: 6px;
  width: 100%;
  height: 1em;
  border: 2px solid grey;
}
</style>

<style lang="scss">
.v-color-picker__dot {
  box-shadow: 0px 0px 5px grey;
}

.v-color-picker .v-color-picker__controls .v-color-picker__edit i {
  border: solid 2px grey;
  border-radius: 5px;
  padding: 12px;
}
</style>
