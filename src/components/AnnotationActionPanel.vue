<template>
  <div class="action-panel">
    <div class="selected-count">{{ selectedCount }} objects selected</div>
    <v-btn small class="ma-1" @click="$emit('delete-selected')">
      <v-icon left small>mdi-delete</v-icon>
      Delete Selected
    </v-btn>
    <v-btn small class="ma-1" @click="$emit('delete-unselected')">
      <v-icon left small>mdi-delete-sweep</v-icon>
      Delete Unselected
    </v-btn>
    <v-btn small class="ma-1" @click="$emit('tag-selected')">
      <v-icon left small>mdi-tag</v-icon>
      Tag Selected
    </v-btn>
    <v-btn small class="ma-1" @click="$emit('color-selected')">
      <v-icon left small>mdi-palette</v-icon>
      Color Selected
    </v-btn>
    <v-btn small class="ma-1" @click="copyAnnotationIds">
      <v-icon left small :color="copySuccess ? 'success' : undefined">
        {{ copySuccess ? "mdi-check" : "mdi-content-copy" }}
      </v-icon>
      Copy Selected IDs
    </v-btn>
    <v-btn small class="ma-1" @click="$emit('deselect-all')">
      <v-icon left small>mdi-select-off</v-icon>
      Deselect All
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { logError } from "@/utils/log";
import annotationStore from "@/store/annotation";

defineProps<{
  selectedCount: number;
}>();

defineEmits<{
  (e: "delete-selected"): void;
  (e: "delete-unselected"): void;
  (e: "tag-selected"): void;
  (e: "color-selected"): void;
  (e: "deselect-all"): void;
}>();

const copySuccess = ref(false);

async function copyAnnotationIds() {
  try {
    await navigator.clipboard.writeText(
      annotationStore.selectedAnnotationIds.join("\n"),
    );
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 1000);
  } catch (err) {
    logError("Failed to copy annotation IDs:", err);
  }
}
</script>

<style lang="scss" scoped>
.action-panel {
  position: absolute;
  top: 20px;
  right: 20px;
  background: rgba(33, 33, 33, 0.9);
  border-radius: 4px;
  padding: 12px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.selected-count {
  color: white;
  margin-bottom: 8px;
  text-align: center;
}
</style>
