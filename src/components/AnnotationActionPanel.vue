<template>
  <div class="action-panel">
    <div class="selected-count">{{ selectedCount }} objects selected</div>
    <v-btn
      variant="outlined"
      color="error"
      size="small"
      class="action-btn"
      :disabled="!isLoggedIn"
      @click="$emit('delete-selected')"
    >
      <v-icon start size="small">mdi-delete</v-icon>
      Delete Selected
    </v-btn>
    <v-btn
      variant="outlined"
      color="error"
      size="small"
      class="action-btn"
      :disabled="!isLoggedIn"
      @click="$emit('delete-unselected')"
    >
      <v-icon start size="small">mdi-delete-sweep</v-icon>
      Delete Unselected
    </v-btn>
    <v-btn
      variant="outlined"
      color="primary"
      size="small"
      class="action-btn"
      :disabled="!isLoggedIn"
      @click="$emit('tag-selected')"
    >
      <v-icon start size="small">mdi-tag</v-icon>
      Tag Selected
    </v-btn>
    <v-btn
      variant="outlined"
      color="primary"
      size="small"
      class="action-btn"
      :disabled="!isLoggedIn"
      @click="$emit('color-selected')"
    >
      <v-icon start size="small">mdi-palette</v-icon>
      Color Selected
    </v-btn>
    <v-btn
      variant="outlined"
      color="primary"
      size="small"
      class="action-btn"
      @click="copyAnnotationIds"
    >
      <v-icon start size="small" :color="copySuccess ? 'success' : undefined">
        {{ copySuccess ? "mdi-check" : "mdi-content-copy" }}
      </v-icon>
      Copy Selected IDs
    </v-btn>
    <v-btn
      variant="outlined"
      color="primary"
      size="small"
      class="action-btn"
      @click="$emit('deselect-all')"
    >
      <v-icon start size="small">mdi-select-off</v-icon>
      Deselect All
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { logError } from "@/utils/log";
import store from "@/store";
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

const isLoggedIn = computed(() => store.isLoggedIn);

const copySuccess = ref(false);

async function copyAnnotationIds() {
  try {
    await navigator.clipboard.writeText(
      [...annotationStore.selectedAnnotationIds].join("\n"),
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
  // Sit at the top-left of the canvas, clearing the floating app bar and the
  // dataset breadcrumbs above it. When any left palette is open the panel
  // would be hidden behind it, so we slide it right past the column (see the
  // `.any-left-palette-open` ancestor selector below). The 462 value matches
  // the bottom-left button shift (Layers palette: left 16 + width 420 +
  // ~26 px gap).
  top: 72px;
  left: 16px;
  // Shrink-wrap to the widest child (longest button or the "N objects
  // selected" header), so short labels don't leave empty space on the right
  // and a large N can still push the panel wider when needed.
  width: max-content;
  min-width: 140px;
  max-width: 320px;
  background: rgba(18, 22, 30, 0.78);
  backdrop-filter: blur(28px) saturate(140%);
  -webkit-backdrop-filter: blur(28px) saturate(140%);
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
  transition: left 0.2s ease;
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

/* Compact action buttons so the column doesn't dominate the canvas. */
.action-btn {
  margin: 0 !important;
}
.action-panel :deep(.v-btn) {
  font-size: 12px;
  --v-btn-height: 26px;
  --v-btn-padding-inline: 8px;
  justify-content: flex-start;
}
.action-panel :deep(.v-btn .v-icon) {
  font-size: 16px;
}

/* Slide the panel right of the open left-palette column so it isn't hidden
   behind it. `.any-left-palette-open` is set on `<v-app>` by App.vue (an
   ancestor of this panel); scoped CSS adds the data-v attribute to the last
   compound selector only, so the ancestor class still matches. */
.any-left-palette-open .action-panel {
  left: 462px;
}
</style>
