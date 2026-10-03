<template>
  <div class="undo-redo">
    <v-tooltip :text="undoTooltip">
      <template v-slot:activator="{ props: activatorProps }">
        <v-btn
          v-bind="activatorProps"
          variant="text"
          icon
          size="small"
          aria-label="Undo"
          :disabled="!undoEntry || isDoing"
          :loading="isDoing"
          data-command-id="edit.undo"
          @click="undo"
        >
          <v-icon>mdi-undo</v-icon>
        </v-btn>
      </template>
    </v-tooltip>
    <v-tooltip :text="redoTooltip">
      <template v-slot:activator="{ props: activatorProps }">
        <v-btn
          v-bind="activatorProps"
          variant="text"
          icon
          size="small"
          aria-label="Redo"
          :disabled="!redoEntry || isDoing"
          :loading="isDoing"
          data-command-id="edit.redo"
          @click="redo"
        >
          <v-icon>mdi-redo</v-icon>
        </v-btn>
      </template>
    </v-tooltip>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { useCommand } from "@/commands/registry";
import { boundHotkey } from "@/commands/hotkeys";

const isDoing = ref(false);

const history = computed(() => store.history);

const undoEntry = computed(() =>
  history.value.find((entry) => !entry.isUndone),
);

const redoEntry = computed(() => {
  const h = history.value;
  for (let i = h.length; i-- > 0; ) {
    if (h[i].isUndone) return h[i];
  }
  return undefined;
});

const undoTooltip = computed(() =>
  undoEntry.value ? `Undo ${undoEntry.value.actionName}` : "Nothing to undo",
);

const redoTooltip = computed(() =>
  redoEntry.value ? `Redo ${redoEntry.value.actionName}` : "Nothing to redo",
);

async function undoOrRedo(undo: boolean) {
  try {
    isDoing.value = true;
    await annotationStore.undoOrRedo(undo);
  } finally {
    isDoing.value = false;
  }
}

async function undo() {
  await undoOrRedo(true);
}

async function redo() {
  await undoOrRedo(false);
}

useCommand(() => [
  {
    id: "edit.undo",
    title: undoEntry.value ? `Undo ${undoEntry.value.actionName}` : "Undo",
    group: "Actions",
    keywords: ["revert", "back"],
    icon: "mdi-undo",
    // Bound by ImageViewer.
    hotkey: boundHotkey("mod+z", "Undo last action"),
    enabled: () => !!undoEntry.value && !isDoing.value,
    run: undo,
  },
  {
    id: "edit.redo",
    title: redoEntry.value ? `Redo ${redoEntry.value.actionName}` : "Redo",
    group: "Actions",
    keywords: ["again", "forward"],
    icon: "mdi-redo",
    hotkey: boundHotkey("mod+shift+z", "Redo last action"),
    enabled: () => !!redoEntry.value && !isDoing.value,
    run: redo,
  },
]);

defineExpose({ undoEntry, redoEntry, undo, redo, isDoing });
</script>

<style scoped>
.undo-redo {
  display: inline-flex;
  align-items: center;
  gap: 0;
}
</style>
