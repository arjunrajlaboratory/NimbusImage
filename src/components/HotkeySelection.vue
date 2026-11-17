<template>
  <div ref="rootRef">
    <div class="hotkey-selection">
      <span class="hotkey-label">
        {{ hotkey === null ? "No hotkey yet" : `Hotkey: ${hotkey}` }}
      </span>
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        class="mr-2"
        @click="editHotkey()"
        :disabled="isRecordingHotkey"
      >
        <v-progress-circular
          size="16"
          indeterminate
          v-if="isRecordingHotkey"
          class="mr-1"
        />
        {{ isRecordingHotkey ? "Recording..." : "Record" }}
      </v-btn>
      <v-btn variant="text" size="small" @click="hotkey = null"> Clear </v-btn>
    </div>
    <div v-if="conflict" class="hotkey-conflict text-caption text-warning">
      {{ conflict }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from "vue";
import Mousetrap from "mousetrap";
import { boundKeys, pauseHotkeysWhile } from "@/utils/v-mousetrap";
import { canonicalHotkey, formatHotkey } from "@/commands/hotkeys";

const props = defineProps<{
  modelValue?: string | null;
  // The edited tool's saved hotkey and help description: that one binding
  // is the tool itself, not a clash.
  ownHotkey?: string | null;
  ownDescription?: string | null;
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
const rootRef = ref<HTMLElement | null>(null);

// Mousetrap runs every handler bound to a key, so a hotkey that is already
// bound fires both actions. Only keys bound right now are known: a key that
// only exists in another dataset (e.g. transcripts) is not checked. Keys are
// compared canonically: a recorded "ctrl+z" is the built-in "mod+z" on
// Windows.
const conflict = computed(() => {
  const key = hotkey.value;
  if (key === null) {
    return null;
  }
  const canonical = canonicalHotkey(key);
  const others = Object.entries(boundKeys.value)
    .filter(([bound]) => canonicalHotkey(bound) === canonical)
    .flatMap(([, bindings]) => bindings);
  if (
    props.ownHotkey != null &&
    canonicalHotkey(props.ownHotkey) === canonical
  ) {
    // Drop only the tool's own binding; another one on the key still clashes.
    const own = others.findIndex(
      (bound) => bound.description === props.ownDescription,
    );
    if (own >= 0) {
      others.splice(own, 1);
    }
  }
  if (others.length === 0) {
    return null;
  }
  const uses = others
    .map((bound) => `"${bound.description}" (${bound.section})`)
    .join(" and ");
  return `${formatHotkey(key)} is already used for ${uses}. Pressing it will do both.`;
});

// Dialogs hide their content without unmounting it, so a recorder whose
// dialog closed mid-recording is still mounted: it must neither keep the
// other hotkeys paused nor take the next key pressed elsewhere.
function isShown(): boolean {
  return rootRef.value?.offsetParent != null;
}

let releasePause: (() => void) | null = null;

function stopRecording() {
  isRecordingHotkey.value = false;
  releasePause?.();
  releasePause = null;
}

function editHotkey() {
  isRecordingHotkey.value = true;
  releasePause?.();
  // The key being recorded must not also run what is already bound to it.
  releasePause = pauseHotkeysWhile(() => isRecordingHotkey.value && isShown());
  // The extensions of Mousetrap are loaded in main.ts
  // but they don't update the types, hence the ts-ignore
  // @ts-ignore
  Mousetrap.record((sequence: string[]) => {
    if (!isRecordingHotkey.value) {
      return;
    }
    // Pressed while this recorder was hidden: not meant for it.
    if (isShown()) {
      hotkey.value = sequence.join(" ");
    }
    stopRecording();
  });
}

onBeforeUnmount(stopRecording);
</script>

<style scoped>
.hotkey-selection {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hotkey-conflict {
  margin-top: 4px;
}

.hotkey-label {
  font-size: 0.85rem;
  opacity: 0.7;
  white-space: nowrap;
}
</style>
