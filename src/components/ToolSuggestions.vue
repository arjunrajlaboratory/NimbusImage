<template>
  <v-card
    v-if="visible"
    class="tool-suggestions"
    data-tool-suggestions-panel
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
        aria-label="Refresh suggestions"
        :disabled="status === 'loading'"
        :loading="status === 'loading'"
        @click="refresh"
      >
        <v-icon size="small">mdi-refresh</v-icon>
      </v-btn>
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
          v-for="resolved in sortedSuggestions"
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
              <v-chip
                v-if="resolved.suggestion.confidence"
                size="x-small"
                variant="flat"
                :color="confidenceColor(resolved.suggestion.confidence)"
                class="suggestion-confidence"
              >
                {{ resolved.suggestion.confidence }}
              </v-chip>
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

    <v-card-actions
      v-if="status === 'done' && suggestions.length > 0"
      class="suggestions-actions"
    >
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

// Higher-confidence suggestions first; undefined confidence sorts last.
// Sorted separately from the raw store array so the store is never mutated.
const confidenceRank: Record<"high" | "medium" | "low", number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const sortedSuggestions = computed(() =>
  [...suggestions.value].sort((a, b) => {
    const aRank = a.suggestion.confidence
      ? confidenceRank[a.suggestion.confidence]
      : confidenceRank.low + 1;
    const bRank = b.suggestion.confidence
      ? confidenceRank[b.suggestion.confidence]
      : confidenceRank.low + 1;
    return aRank - bRank;
  }),
);

function confidenceColor(confidence: "low" | "medium" | "high") {
  return { high: "success", medium: "warning", low: "secondary" }[confidence];
}

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

function refresh() {
  toolSuggestionsStore.suggestForCurrentConfiguration();
}

function dismiss() {
  toolSuggestionsStore.setDismissed(true);
}

defineExpose({
  status,
  suggestions,
  sortedSuggestions,
  errorMessage,
  visible,
  accept,
  acceptAll,
  refresh,
  confidenceColor,
});
</script>

<style scoped lang="scss">
.tool-suggestions {
  position: absolute;
  right: 16px;
  bottom: 96px;
  z-index: 1003;
  width: 340px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 128px);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
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
  overflow-y: auto;
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

.suggestion-confidence {
  margin-left: 6px;
  vertical-align: middle;
  text-transform: capitalize;
}

.suggestion-reason {
  font-size: 0.78rem;
  opacity: 0.75;
}

.suggestions-actions {
  flex: 0 0 auto;
  padding: 4px 12px 12px;
}
</style>
