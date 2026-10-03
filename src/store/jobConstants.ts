export const jobStates = {
  inactive: 0,
  queued: 1,
  running: 2,
  success: 3,
  error: 4,
  cancelled: 5,
  cancelling: 824,
};

// Statuses after which a job will not change again.
const TERMINAL_JOB_STATES: ReadonlySet<number> = new Set([
  jobStates.success,
  jobStates.error,
  jobStates.cancelled,
]);

export function isTerminalJobStatus(status: number | null | undefined) {
  return status != null && TERMINAL_JOB_STATES.has(status);
}
