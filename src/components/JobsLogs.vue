<template>
  <v-expansion-panel>
    <v-expansion-panel-header>Jobs and Logs</v-expansion-panel-header>
    <v-expansion-panel-content>
      <v-container>
        <v-btn
          color="primary"
          @click="showJobs"
          v-description="{
            section: 'Jobs and Logs',
            title: 'Show Jobs and Logs',
            description: 'View recent job history and logs',
          }"
        >
          Show Jobs and Logs
        </v-btn>

        <v-dialog
          v-model="showJobsDialog"
          min-width="800px"
          max-width="1200px"
          width="90%"
        >
          <v-card>
            <v-card-title class="headline">
              Recent Jobs
              <v-spacer></v-spacer>
              <v-tooltip bottom>
                <template #activator="{ on, attrs }">
                  <v-btn
                    icon
                    v-bind="attrs"
                    v-on="on"
                    @click="fetchJobs"
                    :loading="loading"
                  >
                    <v-icon>mdi-refresh</v-icon>
                  </v-btn>
                </template>
                <span>Refresh jobs</span>
              </v-tooltip>
              <v-btn icon @click="showJobsDialog = false">
                <v-icon>mdi-close</v-icon>
              </v-btn>
            </v-card-title>
            <v-card-text>
              <v-data-table
                :headers="headers"
                :items="jobs"
                :items-per-page="10"
                class="elevation-1"
                :loading="loading"
              >
                <template #[`item.status`]="{ item }">
                  <v-chip
                    :color="getStatusColor(item.status)"
                    text-color="white"
                    small
                  >
                    {{ getStatusText(item.status) }}
                  </v-chip>
                </template>
                <template #[`item.created`]="{ item }">
                  {{ formatDateString(item.created) }}
                </template>
                <template #[`item.firstArg`]="{ item }">
                  {{ getFirstArg(item) }}
                </template>
                <template #[`item.endTime`]="{ item }">
                  {{ getEndTime(item) }}
                </template>
                <template #[`item.duration`]="{ item }">
                  {{ getDuration(item) }}
                </template>
                <template #[`item.actions`]="{ item }">
                  <v-btn small text color="info" @click="viewJobLog(item)">
                    <v-icon small left>mdi-text-box-outline</v-icon>
                    Log
                  </v-btn>
                </template>
              </v-data-table>
            </v-card-text>
          </v-card>
        </v-dialog>

        <!-- Job Log Dialog -->
        <v-dialog v-model="showLogDialog" max-width="800px">
          <v-card>
            <v-card-title class="headline">
              Job Log: {{ selectedJob ? selectedJob.title : "" }}
              <v-spacer></v-spacer>
              <v-tooltip bottom>
                <template #activator="{ on, attrs }">
                  <v-btn
                    icon
                    v-bind="attrs"
                    v-on="on"
                    @click="copyLogToClipboard"
                  >
                    <v-icon>mdi-content-copy</v-icon>
                  </v-btn>
                </template>
                <span>Copy to clipboard</span>
              </v-tooltip>
              <v-tooltip bottom>
                <template #activator="{ on, attrs }">
                  <v-btn
                    icon
                    v-bind="attrs"
                    v-on="on"
                    @click="refreshLog"
                    :loading="refreshingLog"
                  >
                    <v-icon>mdi-refresh</v-icon>
                  </v-btn>
                </template>
                <span>Refresh log</span>
              </v-tooltip>
              <v-btn icon @click="showLogDialog = false">
                <v-icon>mdi-close</v-icon>
              </v-btn>
            </v-card-title>
            <v-card-text>
              <pre class="job-log">{{ currentJobLog }}</pre>
            </v-card-text>
            <v-card-actions>
              <v-spacer></v-spacer>
              <v-btn color="primary" text @click="showLogDialog = false"
                >Close</v-btn
              >
            </v-card-actions>
          </v-card>
        </v-dialog>

        <!-- Snackbar for copy notification -->
        <v-snackbar
          v-model="showCopySnackbar"
          :timeout="2000"
          color="success"
          top
        >
          Log copied to clipboard
        </v-snackbar>
      </v-container>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { ref } from "vue";
import store from "@/store/index";
import { formatDateString, formatDuration } from "@/utils/date";
import { IJob } from "@/store/model";
import { logError } from "@/utils/log";

interface JobLogProperty {
  color: string;
  statusText: string;
  stateText: string;
}

const jobLogStatus: { [key: number]: JobLogProperty } = {
  0: { color: "grey", statusText: "Inactive", stateText: "Job is inactive." },
  1: { color: "blue", statusText: "Queued", stateText: "Job is queued." },
  2: {
    color: "orange",
    statusText: "Running",
    stateText: "Job is still running...",
  },
  3: {
    color: "green",
    statusText: "Success",
    stateText: "Job completed successfully.",
  },
  4: {
    color: "red",
    statusText: "Error",
    stateText: "Job failed with errors.",
  },
  5: {
    color: "purple",
    statusText: "Cancelled",
    stateText: "Job was cancelled.",
  },
  824: {
    color: "yellow",
    statusText: "Cancelling",
    stateText: "Job is being cancelled...",
  },
};

const showJobsDialog = ref(false);
const showLogDialog = ref(false);
const showCopySnackbar = ref(false);
const selectedJob = ref<IJob | null>(null);
const currentJobLog = ref("");
const jobs = ref<IJob[]>([]);
const loading = ref(false);
const refreshingLog = ref(false);

const headers = [
  { text: "Title", value: "title" },
  { text: "Image", value: "firstArg" },
  { text: "Type", value: "type" },
  { text: "Status", value: "status" },
  { text: "Started", value: "created" },
  { text: "Ended", value: "endTime" },
  { text: "Duration", value: "duration" },
  { text: "Actions", value: "actions", sortable: false },
];

async function showJobs() {
  showJobsDialog.value = true;
  await fetchJobs();
}

async function fetchJobs() {
  loading.value = true;
  try {
    jobs.value = await store.api.getUserJobs(20);
  } catch (error) {
    logError("Failed to fetch jobs:", error);
  } finally {
    loading.value = false;
  }
}

function getStatusColor(status: number): string {
  if (status in jobLogStatus) {
    return jobLogStatus[status].color;
  }
  return "grey";
}

function getStatusText(status: number): string {
  if (status in jobLogStatus) {
    return jobLogStatus[status].statusText;
  }
  return "Unknown";
}

function getJobState(status: number): string {
  if (status in jobLogStatus) {
    return jobLogStatus[status].stateText;
  }
  return "Job status: " + getStatusText(status);
}

function getFirstArg(job: IJob): string {
  return job.args && job.args.length > 0 ? job.args[0] : "";
}

function getEndTime(job: any): string {
  const endTimestamp = job.timestamps?.find((ts: any) =>
    [3, 4, 5].includes(ts.status),
  );

  if (endTimestamp) {
    return formatDateString(endTimestamp.time);
  }

  return job.status === 2 ? "Running..." : "N/A";
}

function getDuration(job: any): string {
  const endTimestamp = job.timestamps?.find((ts: any) =>
    [3, 4, 5].includes(ts.status),
  );

  if (endTimestamp) {
    const startDate = new Date(job.created).getTime();
    const endDate = new Date(endTimestamp.time).getTime();
    const duration = endDate - startDate;
    return formatDuration(duration);
  }

  if (job.status === 2) {
    const startDate = new Date(job.created).getTime();
    const now = new Date().getTime();
    const duration = now - startDate;
    return formatDuration(duration) + " (running)";
  }

  return "N/A";
}

async function viewJobLog(job: IJob): Promise<void> {
  selectedJob.value = job;

  if (!refreshingLog.value) {
    currentJobLog.value = "Loading job log...";
    showLogDialog.value = true;
  }

  try {
    const jobWithLog = await store.api.getJobInfo(job._id);

    if (!jobWithLog) {
      currentJobLog.value = "Failed to load job log.";
      return;
    }

    const endTime = getEndTime(jobWithLog);
    const duration = getDuration(jobWithLog);

    const logHeader =
      `=== Job ${jobWithLog._id} (${jobWithLog.title}) ===\n\n` +
      `Started: ${formatDateString(jobWithLog.created)}\n` +
      `Ended: ${endTime}\n` +
      `Duration: ${duration}\n` +
      `Status: ${getStatusText(jobWithLog.status)}\n` +
      `Type: ${jobWithLog.type}\n\n` +
      `Arguments:\n${jobWithLog.args.join("\n")}\n\n` +
      `${getJobState(jobWithLog.status)}\n\n`;

    currentJobLog.value =
      logHeader + (jobWithLog.log || "No log content available.");
  } catch (error) {
    logError("Error fetching job log:", error);
    currentJobLog.value = "Error fetching job log. Please try again.";
  }
}

function copyLogToClipboard(): void {
  if (currentJobLog.value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(currentJobLog.value)
        .then(() => {
          showCopySnackbar.value = true;
        })
        .catch(() => {
          copyToClipboardFallback(currentJobLog.value);
        });
    } else {
      copyToClipboardFallback(currentJobLog.value);
    }
  }
}

function copyToClipboardFallback(text: string): void {
  const tempTextArea = document.createElement("textarea");
  tempTextArea.value = text;
  tempTextArea.style.position = "fixed";
  document.body.appendChild(tempTextArea);
  tempTextArea.select();

  try {
    document.execCommand("copy");
    showCopySnackbar.value = true;
  } catch (err) {
    logError("Failed to copy text: ", err);
  }

  document.body.removeChild(tempTextArea);
}

async function refreshLog(): Promise<void> {
  if (!selectedJob.value) return;

  refreshingLog.value = true;
  try {
    await viewJobLog(selectedJob.value);
  } finally {
    refreshingLog.value = false;
  }
}

defineExpose({
  showJobs,
  showJobsDialog,
  getStatusColor,
  getStatusText,
  getFirstArg,
  getDuration,
  headers,
});
</script>

<style lang="scss" scoped>
.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: monospace;
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>
