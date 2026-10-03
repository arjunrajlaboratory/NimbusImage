<template>
  <div class="connection-action-panel" :class="{ stacked }">
    <div class="selected-count">
      {{ selectedCount }} connection{{ selectedCount === 1 ? "" : "s" }}
      selected
    </div>
    <v-btn
      variant="outlined"
      color="error"
      size="small"
      class="action-btn"
      :disabled="!isLoggedIn || isDeleting"
      :loading="isDeleting"
      @click="deleteSelected"
    >
      <v-icon start size="small">mdi-delete</v-icon>
      Delete Selected
    </v-btn>
    <v-btn
      variant="outlined"
      color="primary"
      size="small"
      class="action-btn"
      @click="connectionListStore.setSelectedConnectionIds([])"
    >
      <v-icon start size="small">mdi-select-off</v-icon>
      Deselect
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import store from "@/store";
import connectionListStore from "@/store/connectionList";

defineProps<{
  /** Shift below AnnotationActionPanel when objects are also selected. */
  stacked: boolean;
}>();

const isLoggedIn = computed(() => store.isLoggedIn);
const isDeleting = ref(false);
// Count links that still exist, matching what Delete Selected will act on —
// connections can be removed by paths that never touch this module.
const selectedCount = computed(
  () => connectionListStore.selectedExistingConnectionIds.length,
);

async function deleteSelected() {
  if (!store.isLoggedIn || isDeleting.value) {
    return;
  }
  isDeleting.value = true;
  try {
    await connectionListStore.deleteSelectedConnections();
  } finally {
    isDeleting.value = false;
  }
}

// Delete/Backspace removes the selected connection(s), matching how the object
// action panel behaves. Ignored while typing so it can't fire from a text
// field, a tag input, or a contenteditable.
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Delete" && event.key !== "Backspace") {
    return;
  }
  // Bare Delete/Backspace only. `mod+backspace` is already bound to "delete
  // selected objects" (ImageViewer.vue), and clicking a connection row selects
  // both endpoint objects AND the connection — so matching the modified combo
  // here would make one keystroke fire two destructive operations at once.
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  ) {
    return;
  }
  event.preventDefault();
  deleteSelected();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

defineExpose({ selectedCount, deleteSelected, onKeydown });
</script>

<style lang="scss" scoped>
/* Mirrors AnnotationActionPanel. Both are visible together in the common case
   (clicking a connection row also selects its two endpoint objects), so
   `.stacked` drops this one below the object panel. */
.connection-action-panel {
  position: absolute;
  top: 72px;
  left: 16px;
  width: max-content;
  min-width: 140px;
  max-width: 320px;
  background: var(--nimbus-glass-bg);
  backdrop-filter: var(--nimbus-glass-filter);
  -webkit-backdrop-filter: var(--nimbus-glass-filter);
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.08));
  border-radius: var(--nimbus-radius-lg, 12px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 0 0 0.5px rgba(255, 255, 255, 0.06),
    0 20px 40px -16px rgba(0, 0, 0, 0.7);
  padding: 8px 10px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  transition: transform 0.2s ease;
}

/* AnnotationActionPanel has a fixed six-button body, so its height is
   deterministic rather than content-driven — a constant offset is safe here.
   Measured live: that panel occupies 72–295px, so this clears it with a gap. */
.connection-action-panel.stacked {
  top: 304px;
}

.selected-count {
  color: var(--nimbus-text-secondary, rgba(var(--v-theme-on-surface), 0.85));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 4px;
  padding: 2px 4px;
}

.action-btn {
  margin: 0 !important;
}
.connection-action-panel :deep(.v-btn) {
  font-size: 12px;
  --v-btn-height: 26px;
  --v-btn-padding-inline: 8px;
  justify-content: flex-start;
}
.connection-action-panel :deep(.v-icon) {
  font-size: 16px;
}

.any-left-palette-open .connection-action-panel {
  transform: translateX(calc(var(--nimbus-left-palette-clear-x) - 16px));
}

/* The twin of AnnotationActionPanel's rule — the Timelapse palette occupies the
   spot both panels slide to. `.stacked` still applies on top of this, so the two
   keep stacking vertically in their new corner rather than overlapping. See that
   component for why the offset is one resolved variable rather than a class per
   right-edge overlay. */
.timelapse-palette-open .connection-action-panel {
  left: auto;
  right: var(--nimbus-right-edge-clear-x);
  transform: none;
  top: var(--nimbus-action-panel-top, 72px);
}

/* `.stacked` follows the object panel wherever it went. Ordered after the rule
   above so it wins, and after the plain `.stacked` rule further up whose fixed
   304px assumes the un-shifted 72px top. */
.timelapse-palette-open .connection-action-panel.stacked {
  top: var(--nimbus-stacked-action-panel-top, 304px);
}
</style>
