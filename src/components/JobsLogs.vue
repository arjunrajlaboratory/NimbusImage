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

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import store from "@/store/index";
import main from "@/store/index";
import { formatDateString, formatDuration } from "@/utils/date";
import { IJob } from "@/store/model";
import { logError } from "@/utils/log";

@Component
export default class JobsLogs extends Vue {
  readonly store = store;

  showJobsDialog = false;
  showLogDialog = false;
  showCopySnackbar = false;
  selectedJob: IJob | null = null;
  currentJobLog = "";
  jobs: IJob[] = [];
  loading = false;
  refreshingLog = false;

  headers = [
    { text: "Title", value: "title" },
    { text: "Image", value: "firstArg" },
    { text: "Type", value: "type" },
    { text: "Status", value: "status" },
    { text: "Started", value: "created" },
    { text: "Ended", value: "endTime" },
    { text: "Duration", value: "duration" },
    { text: "Actions", value: "actions", sortable: false },
  ];

  async showJobs() {
    this.showJobsDialog = true;
    await this.fetchJobs();
  }

  async fetchJobs() {
    this.loading = true;
    try {
      this.jobs = await main.api.getUserJobs(20);
    } catch (error) {
      logError("Failed to fetch jobs:", error);
    } finally {
      this.loading = false;
    }
  }

  getStatusColor(status: number): string {
    switch (status) {
      case 0:
        return "grey"; // inactive
      case 1:
        return "blue"; // queued
      case 2:
        return "orange"; // running
      case 3:
        return "green"; // success
      case 4:
        return "red"; // error
      case 5:
        return "purple"; // cancelled
      case 824:
        return "yellow"; // cancelling
      default:
        return "grey";
    }
  }

  getStatusText(status: number): string {
    switch (status) {
      case 0:
        return "Inactive";
      case 1:
        return "Queued";
      case 2:
        return "Running";
      case 3:
        return "Success";
      case 4:
        return "Error";
      case 5:
        return "Cancelled";
      case 824:
        return "Cancelling";
      default:
        return "Unknown";
    }
  }

  formatDateString(dateString: string): string {
    return formatDateString(dateString);
  }

  getFirstArg(job: IJob): string {
    return job.args && job.args.length > 0 ? job.args[0] : "";
  }

  getEndTime(job: any): string {
    // Find the timestamp with status 3 (success), 4 (error), or 5 (cancelled)
    const endTimestamp = job.timestamps?.find((ts: any) =>
      [3, 4, 5].includes(ts.status),
    );

    if (endTimestamp) {
      return formatDateString(endTimestamp.time);
    }

    return job.status === 2 ? "Running..." : "N/A";
  }

  getDuration(job: any): string {
    // Find the timestamp with status 3 (success), 4 (error), or 5 (cancelled)
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
      // For running jobs, calculate duration from start until now
      const startDate = new Date(job.created).getTime();
      const now = new Date().getTime();
      const duration = now - startDate;
      return formatDuration(duration) + " (running)";
    }

    return "N/A";
  }

  async viewJobLog(job: IJob): Promise<void> {
    this.selectedJob = job;

    // Show loading in the log area if not refreshing
    if (!this.refreshingLog) {
      this.currentJobLog = "Loading job log...";
      this.showLogDialog = true;
    }

    try {
      // Fetch the job info with log
      const jobWithLog = await main.api.getJobInfo(job._id);

      if (!jobWithLog) {
        this.currentJobLog = "Failed to load job log.";
        return;
      }

      // Get end time and duration for the log header
      const endTime = this.getEndTime(jobWithLog);
      const duration = this.getDuration(jobWithLog);

      // Create a formatted log header
      const logHeader =
        `=== Job ${jobWithLog._id} (${jobWithLog.title}) ===\n\n` +
        `Started: ${formatDateString(jobWithLog.created)}\n` +
        `Ended: ${endTime}\n` +
        `Duration: ${duration}\n` +
        `Status: ${this.getStatusText(jobWithLog.status)}\n` +
        `Type: ${jobWithLog.type}\n\n` +
        `Arguments:\n${jobWithLog.args.join("\n")}\n\n` +
        `${
          jobWithLog.status === 3
            ? "Job completed successfully."
            : jobWithLog.status === 4
              ? "Job failed with errors."
              : jobWithLog.status === 2
                ? "Job is still running..."
                : "Job status: " + this.getStatusText(jobWithLog.status)
        }\n\n`;

      // Combine header with actual log content
      this.currentJobLog =
        logHeader + (jobWithLog.log || "No log content available.");
    } catch (error) {
      logError("Error fetching job log:", error);
      this.currentJobLog = "Error fetching job log. Please try again.";
    }
  }

  copyLogToClipboard(): void {
    if (this.currentJobLog) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(this.currentJobLog)
          .then(() => {
            this.showCopySnackbar = true;
          })
          .catch(() => {
            // Fallback for browsers that don't support the Clipboard API
            this.copyToClipboardFallback(this.currentJobLog);
          });
      } else {
        // Fallback for older browsers
        this.copyToClipboardFallback(this.currentJobLog);
      }
    }
  }

  copyToClipboardFallback(text: string): void {
    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = text;
    tempTextArea.style.position = "fixed"; // Avoid scrolling to bottom
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    try {
      document.execCommand("copy");
      this.showCopySnackbar = true;
    } catch (err) {
      logError("Failed to copy text: ", err);
    }

    document.body.removeChild(tempTextArea);
  }

  async refreshLog(): Promise<void> {
    if (!this.selectedJob) return;

    this.refreshingLog = true;
    try {
      await this.viewJobLog(this.selectedJob);
    } finally {
      this.refreshingLog = false;
    }
  }
}
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
