import { IJob } from "@/store/model";
import { formatDateString, formatDuration } from "@/utils/date";

// Display metadata for each Girder job status code (see jobConstants.ts for
// the status values themselves). Shared by the settings Jobs & Logs table and
// the pipeline run panel's per-step log dialog.
export interface IJobLogStatusProperty {
  color: string;
  statusText: string;
  stateText: string;
}

export const jobLogStatus: { [key: number]: IJobLogStatusProperty } = {
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

export function getJobStatusColor(status: number): string {
  return jobLogStatus[status]?.color ?? "grey";
}

export function getJobStatusText(status: number): string {
  return jobLogStatus[status]?.statusText ?? "Unknown";
}

export function getJobStateText(status: number): string {
  return (
    jobLogStatus[status]?.stateText ?? "Job status: " + getJobStatusText(status)
  );
}

// A job's end timestamp is the first terminal-status entry (3 success,
// 4 error, 5 cancelled) in its timestamps list.
function findEndTimestamp(job: IJob) {
  return job.timestamps?.find((ts) => [3, 4, 5].includes(ts.status));
}

export function getJobEndTime(job: IJob): string {
  const endTimestamp = findEndTimestamp(job);
  if (endTimestamp) {
    return formatDateString(endTimestamp.time);
  }
  return job.status === 2 ? "Running..." : "N/A";
}

export function getJobDuration(job: IJob): string {
  const startDate = new Date(job.created).getTime();
  const endTimestamp = findEndTimestamp(job);
  if (endTimestamp) {
    return formatDuration(new Date(endTimestamp.time).getTime() - startDate);
  }
  if (job.status === 2) {
    return formatDuration(new Date().getTime() - startDate) + " (running)";
  }
  return "N/A";
}

// Human-readable header block prepended to a job's raw log text.
export function formatJobLogHeader(job: IJob): string {
  return (
    `=== Job ${job._id} (${job.title}) ===\n\n` +
    `Started: ${formatDateString(job.created)}\n` +
    `Ended: ${getJobEndTime(job)}\n` +
    `Duration: ${getJobDuration(job)}\n` +
    `Status: ${getJobStatusText(job.status)}\n` +
    `Type: ${job.type}\n\n` +
    `Arguments:\n${(job.args ?? []).join("\n")}\n\n` +
    `${getJobStateText(job.status)}\n\n`
  );
}
