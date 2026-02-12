<template>
  <!-- tags -->
  <v-combobox
    v-model="tags"
    :items="tagList"
    :search-input.sync="tagSearchInput"
    multiple
    hide-selected
    hide-details
    small-chips
    dense
    label="Tags"
    :disabled="disabled"
    @change="onTagChange"
    ref="combobox"
  >
    <template v-slot:selection="{ attrs, index, item, parent }">
      <v-chip
        :key="index"
        class="pa-2"
        v-bind="attrs"
        close
        pill
        x-small
        @click:close="parent.selectItem(item)"
      >
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
    value: string[];
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: "input", value: string[]): void;
}>();

const tags = computed({
  get() {
    return props.value;
  },
  set(val: string[]) {
    emit("input", val);
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
