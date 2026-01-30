<template>
  <v-menu
    :close-on-content-click="false"
    transition="scale-transition"
    offset-x
  >
    <template #activator="{ on }">
      <div
        v-on="on"
        :class="parentClass"
        :style="[{ cursor: 'pointer' }, parentStyle]"
        class="d-flex align-center"
      >
        <span class="subtitle-2 mr-2">Color</span>
        <span :style="{ backgroundColor: color }" class="color-bar"></span>
      </div>
    </template>
    <v-color-picker :value="color" @input="emit('input', $event)" />
  </v-menu>
</template>

<!-- Dual script blocks needed for inheritAttrs in Vue 2.7 -->
<!-- In Vue 3.3+, can use defineOptions({ inheritAttrs: false }) instead -->
<script lang="ts">
export default {
  inheritAttrs: false,
};
</script>

<script setup lang="ts">
import { computed, getCurrentInstance } from "vue";

defineProps<{
  value?: string;
}>();

const emit = defineEmits<{
  (e: "input", value: string): void;
}>();

const instance = getCurrentInstance();

// Access the v-model value with fallback
const color = computed(() => instance?.proxy?.$props?.value ?? "#FFFFFF");

// Vue 2 specific: access parent-provided class/style from vnode
// In Vue 3, these would be in useAttrs() instead
const parentClass = computed(
  () => (instance?.proxy as any)?.$vnode?.data?.staticClass,
);
const parentStyle = computed(
  () => (instance?.proxy as any)?.$vnode?.data?.staticStyle,
);
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
