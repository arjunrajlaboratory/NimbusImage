<template>
  <!-- tags -->
  <v-combobox
    v-model="tags"
    :items="tagList"
    v-model:search="tagSearchInput"
    multiple
    hide-selected
    hide-details
    chips
    density="compact"
    label="Tags"
    :disabled="disabled"
    @update:model-value="onTagChange"
    ref="combobox"
  >
    <template v-slot:chip="{ item, props: chipProps }">
      <v-chip v-bind="chipProps" class="pa-2" closable pill size="x-small">
        {{ item }}
      </v-chip>
    </template>
  </v-combobox>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string[]): void;
}>();

const tags = computed({
  get() {
    return props.modelValue;
  },
  set(val: string[]) {
    emit("update:modelValue", val);
  },
});

const tagSearchInput = ref("");
const combobox = ref<HTMLFormElement>();

const tagList = computed((): string[] => {
  return Array.from(
    new Set([...annotationStore.annotationTags, ...store.toolTags]),
  );
});

function onTagChange() {
  nextTick(() => {
    if (combobox.value) {
      combobox.value.blur();
    }
  });
}

defineExpose({ tags, tagList, tagSearchInput, onTagChange });
</script>
