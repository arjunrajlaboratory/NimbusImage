<template>
  <v-card
    v-if="visible"
    class="tool-suggestions"
    :data-tour="undefined"
    elevation="8"
  >
    <v-card-title class="suggestions-header">
      <v-icon size="small" class="mr-2" color="primary"
        >mdi-lightbulb-on-outline</v-icon
      >
      <span class="suggestions-title">Suggested tools</span>
      <v-spacer />
      <v-btn
        icon
        variant="text"
        size="small"
        aria-label="Dismiss suggestions"
        @click="dismiss"
      >
        <v-icon size="small">mdi-close</v-icon>
      </v-btn>
    </v-card-title>

    <v-card-text class="suggestions-body">
      <template v-if="status === 'loading'">
        <div class="suggestions-loading">
          <v-progress-circular indeterminate size="20" width="2" />
          <span class="ml-3">Looking at your image…</span>
        </div>
      </template>

      <template v-else-if="status === 'error'">
        <div class="suggestions-error">
          {{ errorMessage || "Could not generate suggestions." }}
        </div>
      </template>

      <template v-else-if="suggestions.length === 0">
        <div class="suggestions-empty">
          No tool suggestions for this dataset.
        </div>
      </template>

      <template v-else>
        <div class="suggestions-intro">
          Based on what's in your image, you might want these tools:
        </div>
        <div
          v-for="resolved in suggestions"
          :key="resolved.tool.id"
          class="suggestion-row"
        >
          <div class="suggestion-info">
            <div class="suggestion-name">
              {{ resolved.catalogEntry.name }}
              <span
                v-if="resolved.suggestion.channelName"
                class="suggestion-channel"
              >
                · {{ resolved.suggestion.channelName }}
              </span>
            </div>
            <div class="suggestion-reason">
              {{ resolved.suggestion.reason }}
            </div>
          </div>
          <v-btn
            variant="outlined"
            color="primary"
            size="small"
            @click="accept(resolved)"
          >
            Add
          </v-btn>
        </div>
      </template>
    </v-card-text>

    <v-card-actions v-if="status === 'done' && suggestions.length > 0">
      <v-spacer />
      <v-btn variant="text" size="small" @click="dismiss">Not now</v-btn>
      <v-btn variant="flat" color="primary" size="small" @click="acceptAll">
        Add all
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import toolSuggestionsStore from "@/store/toolSuggestions";
import { IResolvedToolSuggestion } from "@/store/model";

const status = computed(() => toolSuggestionsStore.status);
const suggestions = computed(() => toolSuggestionsStore.suggestions);
const errorMessage = computed(() => toolSuggestionsStore.errorMessage);

// Show the panel while loading, on error, or when there is something to show —
// but never once the user has dismissed it for this run.
const visible = computed(() => {
  if (toolSuggestionsStore.dismissed) {
    return false;
  }
  if (status.value === "loading" || status.value === "error") {
    return true;
  }
  return status.value === "done" && suggestions.value.length > 0;
});

function accept(resolved: IResolvedToolSuggestion) {
  toolSuggestionsStore.acceptSuggestion(resolved);
}

function acceptAll() {
  toolSuggestionsStore.acceptAllSuggestions();
}

function dismiss() {
  toolSuggestionsStore.setDismissed(true);
}

defineExpose({ status, suggestions, errorMessage, visible, accept, acceptAll });
</script>

<style scoped lang="scss">
.tool-suggestions {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 5;
  width: 340px;
  max-width: calc(100vw - 32px);
  border-radius: 12px;
}

.suggestions-header {
  display: flex;
  align-items: center;
  font-size: 0.95rem;
  padding: 10px 12px;
}

.suggestions-title {
  font-weight: 600;
}

.suggestions-body {
  padding: 8px 12px;
}

.suggestions-loading {
  display: flex;
  align-items: center;
  font-size: 0.85rem;
  opacity: 0.85;
}

.suggestions-error,
.suggestions-empty {
  font-size: 0.85rem;
  opacity: 0.8;
}

.suggestions-intro {
  font-size: 0.8rem;
  opacity: 0.7;
  margin-bottom: 8px;
}

.suggestion-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}

.suggestion-info {
  flex: 1 1 auto;
  min-width: 0;
}

.suggestion-name {
  font-weight: 600;
  font-size: 0.85rem;
}

.suggestion-channel {
  font-weight: 400;
  opacity: 0.7;
}

.suggestion-reason {
  font-size: 0.78rem;
  opacity: 0.75;
}
</style>
