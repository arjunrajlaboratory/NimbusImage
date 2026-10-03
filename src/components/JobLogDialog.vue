<template>
  <v-dialog v-model="dialogOpen" width="80vw" max-width="1000px">
    <v-card>
      <v-toolbar density="compact" color="transparent">
        <v-toolbar-title>{{ title }}</v-toolbar-title>
        <v-spacer />
        <v-tooltip location="bottom">
          <template #activator="{ props: activatorProps }">
            <v-btn
              icon="mdi-content-copy"
              variant="text"
              size="small"
              v-bind="activatorProps"
              @click="copyLogToClipboard"
            />
          </template>
          <span>Copy to clipboard</span>
        </v-tooltip>
        <v-tooltip location="bottom">
          <template #activator="{ props: activatorProps }">
            <v-btn
              icon="mdi-refresh"
              variant="text"
              size="small"
              v-bind="activatorProps"
              :loading="loading"
              @click="fetchLog"
            />
          </template>
          <span>Refresh log</span>
        </v-tooltip>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          class="mr-2"
          @click="dialogOpen = false"
        />
      </v-toolbar>
      <v-card-text>
        <pre class="job-log">{{ displayedLog }}</pre>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" size="small" @click="dialogOpen = false">
          Close
        </v-btn>
      </v-card-actions>
    </v-card>

    <v-snackbar v-model="showCopySnackbar" :timeout="2000" color="success" top>
      Log copied to clipboard
    </v-snackbar>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import store from "@/store/index";
import jobsStore from "@/store/jobs";
import { formatJobLogHeader } from "@/utils/jobLog";
import { copyTextToClipboard } from "@/utils/clipboard";
import { logError } from "@/utils/log";

// Generic job-log viewer: give it a jobId and it fetches the persisted log
// from the backend (works for finished jobs) and overlays the live SSE log
// while the job is still streaming (the persisted log lags slightly).
const props = defineProps<{
  modelValue: boolean;
  jobId: string | null;
  title?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const dialogOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const loading = ref(false);
const fetchedHeader = ref("");
const fetchedLog = ref("");
const fetchError = ref<string | null>(null);
const showCopySnackbar = ref(false);
let latestFetchRequest = 0;

// Live log streamed over SSE while the job runs; empty once the job's
// jobInfoMap entry is cleaned up after completion.
const liveLog = computed(() =>
  props.jobId ? jobsStore.getJobLog(props.jobId) : "",
);

const displayedLog = computed(() => {
  if (fetchError.value) {
    return fetchError.value;
  }
  if (loading.value && !fetchedLog.value && !liveLog.value) {
    return "Loading job log…";
  }
  // Prefer whichever body is longer: the live SSE log leads while running,
  // the persisted log is authoritative after completion.
  const body =
    liveLog.value.length > fetchedLog.value.length
      ? liveLog.value
      : fetchedLog.value;
  return fetchedHeader.value + (body || "No log content available.");
});

async function fetchLog() {
  const jobId = props.jobId;
  if (!jobId) {
    return;
  }
  const request = ++latestFetchRequest;
  loading.value = true;
  fetchError.value = null;
  try {
    const job = await store.api.getJobInfo(jobId);
    if (request !== latestFetchRequest || props.jobId !== jobId) {
      return;
    }
    if (!job) {
      fetchError.value = "Failed to load job log.";
      return;
    }
    fetchedHeader.value = formatJobLogHeader(job);
    fetchedLog.value = job.log || "";
  } catch (error) {
    if (request !== latestFetchRequest || props.jobId !== jobId) {
      return;
    }
    logError("Error fetching job log:", error);
    fetchError.value = "Error fetching job log. Please try again.";
  } finally {
    if (request === latestFetchRequest) {
      loading.value = false;
    }
  }
}

watch(
  () => [props.modelValue, props.jobId],
  ([open]) => {
    if (open) {
      fetchedHeader.value = "";
      fetchedLog.value = "";
      fetchLog();
    } else {
      latestFetchRequest++;
      loading.value = false;
    }
  },
);

async function copyLogToClipboard() {
  if (await copyTextToClipboard(displayedLog.value)) {
    showCopySnackbar.value = true;
  }
}

defineExpose({ displayedLog, fetchLog });
</script>

<style lang="scss" scoped>
.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: var(--nimbus-font-mono, monospace);
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>
