<template>
  <section class="settings-section">
    <h4 class="settings-section-title">Jobs & Logs</h4>
    <div class="settings-section-body">
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        @click="showJobs"
        v-description="{
          section: 'Jobs and Logs',
          title: 'Show Jobs and Logs',
          description: 'View recent job history and logs',
        }"
      >
        Show jobs and logs
      </v-btn>

      <v-dialog
        v-model="showJobsDialog"
        width="90vw"
        max-width="1400px"
        class="wide-dialog"
      >
        <v-card>
          <v-toolbar density="compact" color="transparent">
            <v-toolbar-title>Recent Jobs</v-toolbar-title>
            <v-spacer></v-spacer>
            <v-tooltip location="bottom">
              <template #activator="{ props: activatorProps }">
                <v-btn
                  icon="mdi-refresh"
                  variant="text"
                  size="small"
                  v-bind="activatorProps"
                  @click="fetchJobs"
                  :loading="loading"
                />
              </template>
              <span>Refresh jobs</span>
            </v-tooltip>
            <v-btn
              icon="mdi-close"
              variant="text"
              size="small"
              class="mr-2"
              @click="showJobsDialog = false"
            />
          </v-toolbar>
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
                  size="small"
                >
                  {{ getStatusText(item.status) }}
                </v-chip>
              </template>
              <template #[`item.created`]="{ item }">
                {{ formatDateString(item.created) }}
              </template>
              <template #[`item.endTime`]="{ item }">
                {{ getEndTime(item) }}
              </template>
              <template #[`item.duration`]="{ item }">
                {{ getDuration(item) }}
              </template>
              <template #[`item.actions`]="{ item }">
                <v-btn
                  variant="text"
                  color="info"
                  size="small"
                  @click="viewJobLog(item)"
                >
                  <v-icon size="small" start>mdi-text-box-outline</v-icon>
                  Log
                </v-btn>
              </template>
            </v-data-table>
          </v-card-text>
        </v-card>
      </v-dialog>

      <!-- Job Log Dialog -->
      <v-dialog
        v-model="showLogDialog"
        width="80vw"
        max-width="1000px"
        class="wide-dialog"
      >
        <v-card>
          <v-toolbar density="compact" color="transparent">
            <v-toolbar-title>
              Job Log: {{ selectedJob ? selectedJob.title : "" }}
            </v-toolbar-title>
            <v-spacer></v-spacer>
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
                  @click="refreshLog"
                  :loading="refreshingLog"
                />
              </template>
              <span>Refresh log</span>
            </v-tooltip>
            <v-btn
              icon="mdi-close"
              variant="text"
              size="small"
              class="mr-2"
              @click="showLogDialog = false"
            />
          </v-toolbar>
          <v-card-text>
            <pre class="job-log">{{ currentJobLog }}</pre>
          </v-card-text>
          <v-card-actions>
            <v-spacer></v-spacer>
            <v-btn variant="text" size="small" @click="showLogDialog = false"
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
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import store from "@/store/index";
import { formatDateString } from "@/utils/date";
import { IJob } from "@/store/model";
import { logError } from "@/utils/log";
import {
  formatJobLogHeader,
  getJobDuration,
  getJobEndTime,
  getJobStatusColor,
  getJobStatusText,
} from "@/utils/jobLog";
import { copyTextToClipboard } from "@/utils/clipboard";

const showJobsDialog = ref(false);
const showLogDialog = ref(false);
const showCopySnackbar = ref(false);
const selectedJob = ref<IJob | null>(null);
const currentJobLog = ref("");
const jobs = ref<IJob[]>([]);
const loading = ref(false);
const refreshingLog = ref(false);

const headers = [
  { title: "Title", key: "title" },
  { title: "Type", key: "type" },
  { title: "Status", key: "status" },
  { title: "Started", key: "created" },
  { title: "Ended", key: "endTime" },
  { title: "Duration", key: "duration" },
  { title: "Actions", key: "actions", sortable: false },
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

const getStatusColor = getJobStatusColor;
const getStatusText = getJobStatusText;
const getEndTime = getJobEndTime;
const getDuration = getJobDuration;

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

    currentJobLog.value =
      formatJobLogHeader(jobWithLog) +
      (jobWithLog.log || "No log content available.");
  } catch (error) {
    logError("Error fetching job log:", error);
    currentJobLog.value = "Error fetching job log. Please try again.";
  }
}

async function copyLogToClipboard(): Promise<void> {
  if (await copyTextToClipboard(currentJobLog.value)) {
    showCopySnackbar.value = true;
  }
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
  font-family: var(--nimbus-font-mono, monospace);
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>
