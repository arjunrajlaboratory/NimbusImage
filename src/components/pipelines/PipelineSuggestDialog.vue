<template>
  <v-dialog v-model="dialogOpen" max-width="700">
    <v-card>
      <v-card-title>Suggest pipelines</v-card-title>
      <v-card-text>
        <v-row class="my-0" dense>
          <v-col class="py-1">
            <v-text-field
              v-model="goal"
              label="What are you trying to measure? (optional)"
              placeholder="e.g. count nuclei and measure their intensity"
              density="compact"
              hide-details
              :disabled="loading"
              @keyup.enter="suggest"
            />
          </v-col>
        </v-row>
        <v-row class="my-0" dense>
          <v-col class="py-1">
            <v-btn
              variant="flat"
              color="primary"
              size="small"
              :loading="loading"
              @click="suggest"
            >
              <v-icon start>mdi-creation</v-icon>
              Suggest
            </v-btn>
          </v-col>
        </v-row>

        <v-alert v-if="error" type="error" density="compact" class="mt-3">
          {{ error }}
        </v-alert>

        <v-row v-if="loading" class="my-4" justify="center">
          <v-progress-circular indeterminate color="primary" />
        </v-row>

        <v-row v-else-if="hasSearched && suggestions.length === 0" class="my-4">
          <v-col class="text-caption text-medium-emphasis">
            No suggestions were returned. Try rephrasing your goal, or check
            that worker images are installed.
          </v-col>
        </v-row>

        <v-row
          v-for="(suggestion, index) in suggestions"
          :key="index"
          class="my-2"
        >
          <v-col class="py-1">
            <v-card variant="outlined">
              <v-card-title class="text-body-1">{{
                suggestion.name
              }}</v-card-title>
              <v-card-subtitle
                v-if="suggestion.description"
                class="text-wrap pb-2"
              >
                {{ suggestion.description }}
              </v-card-subtitle>
              <v-card-text class="pt-0">
                <v-chip
                  v-for="step in suggestion.steps"
                  :key="step.id"
                  size="small"
                  class="mr-1 mb-1"
                >
                  {{ step.name }} ({{ step.image }})
                </v-chip>
              </v-card-text>
              <v-card-actions>
                <v-spacer />
                <v-btn
                  variant="flat"
                  color="primary"
                  size="small"
                  :loading="usingIndex === index"
                  @click="useSuggestion(suggestion, index)"
                >
                  Use this
                </v-btn>
              </v-card-actions>
            </v-card>
          </v-col>
        </v-row>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" size="small" @click="dialogOpen = false">
          Close
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import pipelinesStore from "@/store/pipelines";
import { logError } from "@/utils/log";
import { IPipeline } from "@/store/model";

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "use-suggestion", pipeline: IPipeline): void;
}>();

const dialogOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const goal = ref("");
const loading = ref(false);
const hasSearched = ref(false);
const error = ref<string | null>(null);
const suggestions = ref<IPipeline[]>([]);
const usingIndex = ref<number | null>(null);

async function suggest() {
  loading.value = true;
  error.value = null;
  try {
    suggestions.value = await pipelinesStore.suggestPipelines(goal.value);
  } catch (err) {
    logError("Failed to fetch pipeline suggestions:", err);
    error.value =
      "Failed to fetch pipeline suggestions. See the console for details.";
    suggestions.value = [];
  } finally {
    hasSearched.value = true;
    loading.value = false;
  }
}

async function useSuggestion(suggestion: IPipeline, index: number) {
  usingIndex.value = index;
  error.value = null;
  try {
    await pipelinesStore.savePipeline(suggestion);
    emit("use-suggestion", suggestion);
    dialogOpen.value = false;
  } catch (err) {
    logError("Failed to save suggested pipeline:", err);
    error.value =
      "Failed to save the suggested pipeline. See the console for details.";
  } finally {
    usingIndex.value = null;
  }
}

defineExpose({
  goal,
  loading,
  suggestions,
  suggest,
  useSuggestion,
});
</script>
