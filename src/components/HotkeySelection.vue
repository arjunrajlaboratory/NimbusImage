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
  value?: string | null;
}>();

const emit = defineEmits<{
  (e: "input", value: string | null): void;
}>();

// v-model binding (Vue 2 uses value/input)
const hotkey = computed({
  get: () => props.value ?? null,
  set: (val: string | null) => emit("input", val),
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
