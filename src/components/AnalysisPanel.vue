<template>
  <div ref="rootEl">
    <v-card class="analysis-panel">
      <div class="analysis-header">
        <v-icon size="18" class="mr-2">mdi-chart-scatter-plot</v-icon>
        <span class="analysis-title">AI Analysis</span>
        <div class="analysis-header-actions">
          <v-btn icon variant="text" size="small" @click="emit('close')">
            <v-icon size="small">mdi-close</v-icon>
          </v-btn>
        </div>
      </div>
      <v-card-text>
        <v-alert
          v-if="propertyStore.computedPropertyPaths.length === 0"
          type="warning"
          density="compact"
          variant="tonal"
          class="analysis-alert"
        >
          No computed property values found for this dataset — compute
          properties first.
        </v-alert>
        <div v-if="runs.length === 0" class="analysis-hint">
          Describe an analysis of the computed property values, e.g. "Plot
          intensity vs area colored by tag and summarize the correlation."
        </div>
        <div class="analysis-results">
          <div v-for="run in reversedRuns" :key="run.id" class="analysis-run">
            <div class="user">{{ run.instructions }}</div>
            <template v-if="run.status === 'pending'">
              <div class="analysis-progress">
                <v-progress-circular
                  indeterminate
                  size="20"
                  width="2"
                  color="primary"
                />
                <span>Analyzing… the agent is querying property values</span>
              </div>
            </template>
            <template v-else-if="run.status === 'error'">
              <div class="error">{{ run.error }}</div>
            </template>
            <template v-else-if="run.result">
              <div
                class="assistant"
                v-html="renderMarkdown(run.result.summary)"
              ></div>
              <analysis-plot
                v-for="plot in run.result.plots"
                :key="plot.id"
                :plot="plot"
              />
              <v-expansion-panels
                v-if="run.result.toolLog.length > 0"
                variant="accordion"
                class="analysis-tool-log"
              >
                <v-expansion-panel>
                  <v-expansion-panel-title>
                    Agent steps ({{ run.result.toolLog.length }})
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <div
                      v-for="(entry, index) in run.result.toolLog"
                      :key="index"
                      class="tool-log-entry"
                    >
                      <strong>{{ entry.tool }}</strong>
                      <div>{{ entry.summary }}</div>
                    </div>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
            </template>
          </div>
        </div>
      </v-card-text>
      <v-card-actions>
        <div class="bottom-inputs">
          <v-textarea
            v-model="instructions"
            class="analysis-input"
            placeholder="What should the agent analyze?"
            rows="2"
            auto-grow
            max-rows="5"
            density="compact"
            variant="outlined"
            hide-details
            :disabled="isRunning"
            @keydown="handleKeydown"
          />
          <v-btn
            variant="flat"
            color="primary"
            size="small"
            :loading="isRunning"
            :disabled="isRunning || !instructions.trim()"
            @click="runAnalysis"
          >
            Run analysis
          </v-btn>
        </div>
      </v-card-actions>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { logError } from "@/utils/log";
import store from "@/store";
import propertyStore from "@/store/properties";
import { IAnalysisResult } from "@/store/AnalysisAPI";
import AnalysisPlot from "@/components/AnalysisPlot.vue";

interface IAnalysisRun {
  id: string;
  instructions: string;
  status: "pending" | "done" | "error";
  result?: IAnalysisResult;
  error?: string;
}

const emit = defineEmits<{
  (e: "close"): void;
}>();

const rootEl = ref<HTMLElement>();
const instructions = ref("");
const isRunning = ref(false);
const runs = ref<IAnalysisRun[]>([]);
// Newest run first in the results list.
const reversedRuns = computed(() => [...runs.value].reverse());

let nextRunId = 0;

function renderMarkdown(text: string): string {
  // The summary is model-generated; sanitize so HTML smuggled through the
  // agent (e.g. via a crafted property name) can't run in our origin.
  return DOMPurify.sanitize(marked(text) as string);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    runAnalysis();
  }
}

async function runAnalysis() {
  const trimmedInstructions = instructions.value.trim();
  if (isRunning.value || !trimmedInstructions) {
    return;
  }

  const run: IAnalysisRun = {
    id: `run-${nextRunId++}`,
    instructions: trimmedInstructions,
    status: "pending",
  };
  runs.value.push(run);
  instructions.value = "";
  isRunning.value = true;

  try {
    if (!store.dataset) {
      throw new Error("No dataset is open.");
    }
    const request = {
      datasetId: store.dataset.id,
      instructions: trimmedInstructions,
      properties: propertyStore.properties.map((property) => ({
        id: property.id,
        name: property.name,
      })),
      propertyPaths: propertyStore.computedPropertyPaths.map((path) => ({
        path,
        fullName: propertyStore.getFullNameFromPath(path),
      })),
    };
    run.result = await store.analysisAPI.runAnalysis(request);
    run.status = "done";
  } catch (error) {
    logError("Analysis run failed", error);
    run.error = error instanceof Error ? error.message : String(error);
    run.status = "error";
  } finally {
    isRunning.value = false;
  }
}

defineExpose({
  instructions,
  isRunning,
  runs,
  runAnalysis,
});
</script>

<style scoped>
/* === Card container === */
.analysis-panel {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 640px;
  height: 720px;
  max-height: 720px;
  z-index: 2000;
  background-color: rgba(var(--v-theme-surface-bright), 0.88);
  backdrop-filter: blur(12px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  border: 1px solid var(--nimbus-border-strong);
  border-radius: var(--nimbus-radius-lg);
}

/* === Header === */
.analysis-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.analysis-title {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.9;
}

.analysis-header-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

/* === Body === */
:deep(.v-card-text) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px;
}

.analysis-alert {
  flex-shrink: 0;
  margin-bottom: 8px;
}

.analysis-hint {
  flex-shrink: 0;
  font-size: 0.82rem;
  opacity: 0.7;
  padding: 8px 4px;
}

.analysis-results {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  gap: 12px;
  padding: 4px;
}

.analysis-run {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* === Message bubbles (shared look with chat) === */
.user {
  align-self: flex-end;
  color: #ffffff;
  background-color: rgba(33, 150, 243, 0.25);
  border: 1px solid rgba(33, 150, 243, 0.3);
  padding: 8px 12px;
  border-radius: 12px 12px 2px 12px;
  max-width: 80%;
  width: fit-content;
  font-size: 0.85rem;
  line-height: 1.4;
}

.assistant {
  align-self: flex-start;
  color: rgba(255, 255, 255, 0.92);
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 10px 14px;
  border-radius: 12px 12px 12px 2px;
  max-width: 100%;
  width: 100%;
  font-size: 0.85rem;
  line-height: 1.5;
}

.analysis-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.82rem;
  opacity: 0.8;
  padding: 4px 2px;
}

.system,
.error {
  text-align: center;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.7);
  background-color: rgba(255, 80, 80, 0.15);
  border: 1px solid rgba(255, 80, 80, 0.2);
  border-radius: 8px;
  padding: 6px 12px;
  margin: 2px 0;
}

/* === Markdown (v-html needs :deep) === */
.assistant :deep(h1),
.assistant :deep(h2),
.assistant :deep(h3),
.assistant :deep(h4) {
  font-size: 0.9rem;
  font-weight: 700;
  margin: 0.6em 0 0.2em;
}

.assistant :deep(p) {
  margin: 0.25em 0;
}

.assistant :deep(ul),
.assistant :deep(ol) {
  padding-left: 1.4em;
  margin: 0.25em 0;
}

.assistant :deep(li) {
  margin: 0.1em 0;
}

.assistant :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.82rem;
}

.assistant :deep(pre) {
  background: rgba(0, 0, 0, 0.3);
  padding: 0.5em;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.4em 0;
}

.assistant :deep(pre code) {
  background: none;
  padding: 0;
}

/* === Tool log === */
.analysis-tool-log {
  font-size: 0.8rem;
}

.tool-log-entry {
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.tool-log-entry:last-child {
  border-bottom: none;
}

/* === Input area === */
:deep(.v-card-actions) {
  flex-direction: column;
  align-items: stretch;
  flex-shrink: 0;
  padding: 0;
}

.bottom-inputs {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.analysis-input {
  flex: 1;
}
</style>
