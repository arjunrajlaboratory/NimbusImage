<template>
  <v-dialog v-model="showDialog" width="50%">
    <v-card>
      <v-card-title>
        Add tags to or remove tags from selected objects
      </v-card-title>
      <tag-picker class="ma-4 pa-4" v-model="localTags"></tag-picker>
      <v-radio-group v-model="localAddOrRemove" row class="ma-4">
        <v-radio label="Add tags to selected objects" value="add"></v-radio>
        <v-radio
          label="Remove tags from selected objects"
          value="remove"
        ></v-radio>
      </v-radio-group>
      <v-checkbox
        v-model="localReplaceExisting"
        label="Replace existing tags"
        class="ma-4"
        :disabled="localAddOrRemove === 'remove'"
      ></v-checkbox>
      <v-divider></v-divider>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn color="warning" @click="clearTags"> Clear input </v-btn>
        <v-btn color="primary" @click="submit"> Add/remove tags </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import TagPicker from "@/components/TagPicker.vue";

const props = defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
  (
    e: "submit",
    payload: {
      tags: string[];
      addOrRemove: "add" | "remove";
      replaceExisting: boolean;
    },
  ): void;
}>();

const localTags = ref<string[]>([]);
const localAddOrRemove = ref<"add" | "remove">("add");
const localReplaceExisting = ref(false);

const showDialog = computed({
  get: () => props.show,
  set: (value: boolean) => emit("update:show", value),
});

function clearTags() {
  localTags.value = [];
}

function submit() {
  emit("submit", {
    tags: localTags.value,
    addOrRemove: localAddOrRemove.value,
    replaceExisting: localReplaceExisting.value,
  });
  clearTags();
  localAddOrRemove.value = "add";
  localReplaceExisting.value = false;
  showDialog.value = false;
}

defineExpose({
  localTags,
  localAddOrRemove,
  localReplaceExisting,
  showDialog,
  clearTags,
  submit,
});
</script>
