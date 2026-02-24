<template>
  <div class="hotkey-selection">
    <span class="hotkey-label">
      {{ hotkey === null ? "No hotkey yet" : `Hotkey: ${hotkey}` }}
    </span>
    <v-btn size="small" class="mr-2" @click="editHotkey()" :disabled="isRecordingHotkey">
      <v-progress-circular size="16" indeterminate v-if="isRecordingHotkey" class="mr-1" />
      {{ isRecordingHotkey ? "Recording..." : "Record" }}
    </v-btn>
    <v-btn size="small" @click="hotkey = null"> Clear </v-btn>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import Mousetrap from "mousetrap";

const props = defineProps<{
  modelValue?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

// v-model binding (Vue 3 uses modelValue/update:modelValue)
const hotkey = computed({
  get: () => props.modelValue ?? null,
  set: (val: string | null) => emit("update:modelValue", val),
});

const isRecordingHotkey = ref(false);

function editHotkey() {
  // The extensions of Mousetrap are loaded in main.ts
  // but they don't update the types, hence the ts-ignore
  isRecordingHotkey.value = true;
  // @ts-ignore
  Mousetrap.record((sequence: string[]) => {
    hotkey.value = sequence.join(" ");
    isRecordingHotkey.value = false;
  });
}
</script>

<style scoped>
.hotkey-selection {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hotkey-label {
  font-size: 0.85rem;
  opacity: 0.7;
  white-space: nowrap;
}
</style>
