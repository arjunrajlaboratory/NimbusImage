<template>
  <div class="body-1 d-flex flex-wrap">
    <tag-cloud-picker v-model="tags" v-model:allSelected="allSelected" />
    <div>
      Tag match:
      <v-select
        density="compact"
        hide-details
        single-line
        class="mx-2 select-exclusive-filter"
        v-model="exclusive"
        :items="exclusiveItems"
        item-title="text"
        item-value="value"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ITagAnnotationFilter } from "@/store/model";
import TagCloudPicker from "@/components/TagCloudPicker.vue";

const props = defineProps<{
  modelValue: ITagAnnotationFilter;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: ITagAnnotationFilter): void;
}>();

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

defineExpose({ tags, allSelected, exclusive, exclusiveItems });
</script>

<style lang="scss">
.select-exclusive-filter .v-select__selections {
  width: 40px;
}
</style>
