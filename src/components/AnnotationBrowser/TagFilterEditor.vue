<template>
  <div class="tag-filter-editor">
    <div class="tag-filter-toolbar">
      <v-text-field
        v-model="searchText"
        prepend-inner-icon="mdi-magnify"
        placeholder="Search tags"
        density="compact"
        variant="outlined"
        hide-details
        single-line
        clearable
        class="tag-filter-search"
      />
      <span class="tag-match-label">Match:</span>
      <v-select
        v-model="exclusive"
        :items="exclusiveItems"
        item-title="text"
        item-value="value"
        density="compact"
        variant="outlined"
        hide-details
        single-line
        class="tag-match-select"
      />
    </div>
    <tag-cloud-picker
      v-model="tags"
      v-model:allSelected="allSelected"
      :searchText="searchText"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { ITagAnnotationFilter } from "@/store/model";
import TagCloudPicker from "@/components/TagCloudPicker.vue";

const props = defineProps<{
  modelValue: ITagAnnotationFilter;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: ITagAnnotationFilter): void;
}>();

const searchText = ref("");

const exclusiveItems = [
  {
    text: "Any",
    value: false,
  },
  {
    text: "Only",
    value: true,
  },
];

const tags = computed({
  get() {
    return props.modelValue.tags;
  },
  set(newTags: string[]) {
    emit("update:modelValue", { ...props.modelValue, tags: newTags });
  },
});

const allSelected = computed({
  get() {
    return !props.modelValue.enabled;
  },
  set(val: boolean) {
    const exclusive = val ? false : props.modelValue.exclusive;
    emit("update:modelValue", {
      ...props.modelValue,
      enabled: !val,
      exclusive,
    });
  },
});

const exclusive = computed({
  get() {
    return props.modelValue.exclusive;
  },
  set(val: boolean) {
    emit("update:modelValue", {
      ...props.modelValue,
      enabled: true,
      exclusive: val,
    });
  },
});

defineExpose({ tags, allSelected, exclusive, exclusiveItems, searchText });
</script>

<style lang="scss" scoped>
.tag-filter-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.tag-filter-search {
  flex: 1 1 auto;
  min-width: 0;
}

.tag-match-label {
  font-size: 12px;
  color: var(--nimbus-text-muted, #8a8f98);
  white-space: nowrap;
}

.tag-match-select {
  flex: 0 0 auto;
  width: 92px;

  :deep(.v-field__input) {
    font-size: 12px;
    min-height: 32px;
    padding-top: 0;
    padding-bottom: 0;
  }
  :deep(.v-list-item-title) {
    font-size: 12px;
  }
}
</style>
