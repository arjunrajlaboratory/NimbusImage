<template>
  <div>
    <div class="pa-2">
      {{ hotkey === null ? "No hotkey yet" : `Current hotkey: ${hotkey}` }}
    </div>
    <div>
      <v-btn class="mr-2" @click="editHotkey()" :disabled="isRecordingHotkey">
        <v-progress-circular size="20" indeterminate v-if="isRecordingHotkey" />
        {{ isRecordingHotkey ? "Recording..." : "Record hotkey" }}
      </v-btn>
      <v-btn class="mr-2" @click="hotkey = null"> Clear hotkey </v-btn>
    </div>
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
