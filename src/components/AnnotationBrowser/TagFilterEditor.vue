<template>
  <div class="body-1 d-flex flex-wrap">
    <tag-cloud-picker v-model="tags" :allSelected.sync="allSelected" />
    <div>
      Tag match:
      <v-select
        dense
        hide-details
        single-line
        class="mx-2 select-exclusive-filter"
        v-model="exclusive"
        :items="exclusiveItems"
        item-text="text"
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
  value: ITagAnnotationFilter;
}>();

const emit = defineEmits<{
  (e: "input", value: ITagAnnotationFilter): void;
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
    return props.value.tags;
  },
  set(newTags: string[]) {
    emit("input", { ...props.value, tags: newTags });
  },
});

const allSelected = computed({
  get() {
    return !props.value.enabled;
  },
  set(val: boolean) {
    const exclusive = val ? false : props.value.exclusive;
    emit("input", { ...props.value, enabled: !val, exclusive });
  },
});

const exclusive = computed({
  get() {
    return props.value.exclusive;
  },
  set(val: boolean) {
    emit("input", { ...props.value, enabled: true, exclusive: val });
  },
});

defineExpose({ tags, allSelected, exclusive, exclusiveItems });
</script>

<style lang="scss">
.select-exclusive-filter .v-select__selections {
  width: 40px;
}
</style>
