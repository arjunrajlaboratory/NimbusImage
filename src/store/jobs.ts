import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import { toRaw } from "vue";
import { isAxiosError } from "axios";
import store from "./root";
import {
  IComputeJob,
  IErrorInfo,
  IErrorInfoList,
  IJobEventData,
  IProgressInfo,
  MessageType,
  NotificationType,
} from "./model";

import main from "./index";

import { logError, logWarning } from "@/utils/log";
import { quotaExceededMessage } from "@/utils/quota";
import { jobStates } from "./jobConstants";

export { jobStates };

// Create a function that can be used as eventCallback of a job
// It will parse the events and update the progress object
export function createProgressEventCallback(progressObject: IProgressInfo) {
  return (jobData: IJobEventData) => {
    const text = jobData.text;
    if (!text || typeof text !== "string") {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) {
        continue;
      }
      try {
        const progress = JSON.parse(line);
        // Skip error messages, let them be handled by error callback
        if (progress.error) {
          continue;
        }
        // The only required property is "progress"
        if (typeof progress.progress === "number") {
          for (const [k, v] of Object.entries(progress)) {
            (progressObject as any)[k] = v;
          }
        }
      } catch {}
    }
  };
}

export function createErrorEventCallback(errorObject: IErrorInfoList) {
  return (jobData: IJobEventData) => {
    const text = jobData.text;
    if (!text || typeof text !== "string") {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) {
        continue;
      }
      try {
        const error = JSON.parse(line);
        // Skip progress messages
        if (error.progress) {
          continue;
        }
        if (error.error || error.warning) {
          // Create new error info object
          const newError: IErrorInfo = {
            title: error.title,
            error: error.error,
            warning: error.warning,
            info: error.info,
            type:
              error.type ||
              (error.error ? MessageType.ERROR : MessageType.WARNING),
          };
          errorObject.errors.push(newError);
          import("./progress").then(({ default: progress }) =>
            progress.createNotification({
              type:
                newError.type === MessageType.ERROR
                  ? NotificationType.ERROR
                  : NotificationType.WARNING,
              title:
                newError.title ||
                (newError.type === MessageType.ERROR ? "Error" : "Warning"),
              message:
                newError.error ||
                newError.warning ||
                "An issue occurred during job execution",
              info: newError.info,
              timeout: 0, // Requires manual dismissal for errors/warnings
            }),
          );
        }
      } catch {}
    }
  };
}

const FINISHED_JOB_STATUSES: number[] = [
  jobStates.cancelled,
  jobStates.success,
  jobStates.error,
];

const GIVEN_UP_POLL_MS = 15000;
let givenUpPollTimer: ReturnType<typeof setTimeout> | null = null;

// A stream counts as working once it has stayed open this long. Resetting
// the error count on open alone would let a server that accepts and then
// closes at once (Girder with its pub/sub down) be retried forever.
const STABLE_OPEN_MS = 10000;
let stableOpenTimer: ReturnType<typeof setTimeout> | null = null;

// The server has no record of the job (deleted, or never existed).
const JOB_MISSING = "missing";

// The job's status, JOB_MISSING when the server answered that it has no such
// job, or null when the status could not be read. Girder answers an unknown
// job id with 400 ("Invalid job id"), not 404. Only an answer from the server
// says the job is gone: a network failure (no response) or an auth failure
// says nothing about the job.
async function readJobStatus(
  jobId: string,
): Promise<number | typeof JOB_MISSING | null> {
  try {
    const response = await main.girderRest.get(`job/${jobId}`);
    return response.data.status;
  } catch (error) {
    logError(`Failed to get status for job ${jobId}`);
    if (
      isAxiosError(error) &&
      (error.response?.status === 400 || error.response?.status === 404)
    ) {
      return JOB_MISSING;
    }
    return null;
  }
}

interface IJobInfo {
  listeners: IComputeJob[];
  successPromise: Promise<boolean>;
  successResolve: (success: boolean) => void;
  log: string;
}

// Scoped by user: this module outlives logout, and a run the previous
// account started must not lock the tool for the next one.
export function toolRunKey(
  userId: string | undefined,
  datasetId: string | null,
  toolId: string,
) {
  return [userId, datasetId, toolId].join(":");
}

@Module({ dynamic: true, store, name: "jobs" })
export class Jobs extends VuexModule {
  notificationSource: WebSocket | null = null;
  latestNotificationTime: number = 0;

  messageStore: { [jobId: string]: IJobEventData[] } = {};

  private jobInfoMap: { [jobId: string]: IJobInfo } = {};

  connectionErrors: number = 0;

  // Outcome of each tool's last finished job, shown as the Tools palette's
  // status icon. Kept here rather than in ToolItem because pinning or
  // unpinning moves a tool to another section, which remounts its ToolItem.
  // Each outcome records the toolJobScope its job started in and is only
  // reported while that scope is current: tool ids are shared by every
  // dataset in a collection and copied into duplicated collections, and this
  // module outlives logout, so an unscoped outcome would show one user's or
  // one dataset's result somewhere else.
  toolJobOutcomes: {
    [toolId: string]: { scope: string; success: boolean };
  } = {};

  // Single tool runs in flight, from the moment the run is requested until
  // it settles, counted per user, dataset and tool. A job is only tracked
  // (jobIdForToolInDataset) once its submission returns, and the tool's menu
  // is replaced when another tool is selected, so until then nothing else
  // records that the run exists.
  toolRunsInFlight: { [key: string]: number } = {};

  get isToolRunInFlight() {
    return (toolId: string, datasetId: string | null): boolean =>
      (this.toolRunsInFlight[
        toolRunKey(main.girderUser?._id, datasetId, toolId)
      ] ?? 0) > 0;
  }

  // The completion promise for a tracked job, or undefined if the job is not
  // tracked — either it was never registered with addJob, or it already
  // settled (handleJobEventImp drops the entry once it resolves). Callers must
  // handle undefined rather than assume a live job.
  get getPromiseForJobId() {
    return (jobId: string): Promise<boolean> | undefined =>
      this.jobInfoMap[jobId]?.successPromise;
  }

  // The tracked job for a tool on one dataset. Tool ids are shared by every
  // dataset of a collection, so a per-tool lookup alone would report another
  // dataset's run.
  get jobIdForToolInDataset() {
    return (toolId: string, datasetId: string | null): string | null => {
      for (const jobId in this.jobInfoMap) {
        for (const listener of this.jobInfoMap[jobId].listeners) {
          if (
            "toolId" in listener &&
            listener.toolId === toolId &&
            listener.datasetId === datasetId
          ) {
            return jobId;
          }
        }
      }
      return null;
    };
  }

  get toolJobScope() {
    return [
      main.girderUser?._id,
      main.dataset?.id,
      main.configuration?.id,
    ].join(":");
  }

  // The last job outcome for a tool in the current scope, or undefined.
  get toolJobOutcome() {
    return (toolId: string): boolean | undefined => {
      const outcome = this.toolJobOutcomes[toolId];
      return outcome?.scope === this.toolJobScope ? outcome.success : undefined;
    };
  }

  // The tracked job for a property on one dataset. Property ids live in a
  // configuration shared by every dataset of a collection, so, as for tools,
  // a per-property lookup alone would report another dataset's run.
  get jobIdForPropertyInDataset() {
    return (propertyId: string, datasetId: string | null): string | null => {
      for (const jobId in this.jobInfoMap) {
        for (const listener of this.jobInfoMap[jobId].listeners) {
          if (
            "propertyId" in listener &&
            listener.propertyId === propertyId &&
            listener.datasetId === datasetId
          ) {
            return jobId;
          }
        }
      }
      return null;
    };
  }

  get getJobLog() {
    return (jobId: string) => this.jobInfoMap[jobId]?.log || "";
  }

  // The job's status straight from the server, or null when it could not be
  // read (network failure, deleted job, bad id) — a transient failure must not
  // be mistaken for a failed job.
  @Action
  async fetchJobStatus(jobId: string): Promise<number | null> {
    const status = await readJobStatus(jobId);
    return status === JOB_MISSING ? null : status;
  }

  @Mutation
  rawAddJob(job: IComputeJob) {
    let jobData: IJobInfo | undefined = this.jobInfoMap[job.jobId];
    if (!jobData) {
      // Create a promise and extract the "resolve" from it
      let successResolve!: (success: boolean) => void;
      const successPromise = new Promise<boolean>(
        (resolve) => (successResolve = resolve),
      );
      jobData = {
        listeners: [],
        successPromise,
        successResolve,
        log: "",
      };
      this.jobInfoMap[job.jobId] = jobData;
    }
    jobData.listeners.push(job);
  }

  @Action
  async addJob(job: IComputeJob) {
    const subscribing =
      !this.notificationSource ||
      this.notificationSource.readyState == WebSocket.CLOSED ||
      this.notificationSource.readyState == WebSocket.CLOSING;
    if (subscribing) {
      await this.initializeNotificationSubscription();
    }
    const alreadyTracked = job.jobId in this.jobInfoMap;
    this.rawAddJob(job);
    // Save promise reference before replaying buffered events, since replay
    // of a terminal event will remove the entry from jobInfoMap.
    const { successPromise } = this.jobInfoMap[job.jobId];
    // If there are messages in the message store for this job, handle them now
    if (job.jobId in this.messageStore) {
      for (const jobEvent of this.messageStore[job.jobId]) {
        await this.handleJobEventImp(jobEvent);
      }
      this.clearStoredMessages(job.jobId);
    }
    // A job that ended before it was tracked had its terminal event go by
    // unbuffered (or before this page loaded), so on an open stream nothing
    // would settle it until the next reconnect. A stream that is still
    // connecting reconciles every tracked job when it opens, so read only on
    // one already open. A job tracked before was read when it was added.
    // Not awaited: the caller waits on this action before it gets the
    // completion, so a slow read would hold back an outcome the stream has
    // already delivered. (readJobStatus does not reject.)
    if (
      !subscribing &&
      !alreadyTracked &&
      this.notificationSource?.readyState === WebSocket.OPEN &&
      job.jobId in this.jobInfoMap
    ) {
      void this.reconcileJobs([job.jobId]);
    }
    return successPromise;
  }

  @Mutation
  toolRunStarted(key: string) {
    this.toolRunsInFlight[key] = (this.toolRunsInFlight[key] ?? 0) + 1;
  }

  @Mutation
  toolRunEnded(key: string) {
    const remaining = (this.toolRunsInFlight[key] ?? 0) - 1;
    if (remaining > 0) {
      this.toolRunsInFlight[key] = remaining;
    } else {
      delete this.toolRunsInFlight[key];
    }
  }

  @Mutation
  setNotificationSource(source: WebSocket | null) {
    this.notificationSource = source;
  }

  @Mutation
  setLatestNotificationTime(time: number) {
    this.latestNotificationTime = time;
  }

  @Mutation
  setConnectionErrors(value: number) {
    this.connectionErrors = value;
  }

  @Mutation
  storeMessage(payload: { jobId: string; event: IJobEventData }) {
    if (!(payload.jobId in this.messageStore)) {
      this.messageStore[payload.jobId] = [];
    }
    this.messageStore[payload.jobId].push(payload.event);
  }

  @Mutation
  clearStoredMessages(jobId: string) {
    delete this.messageStore[jobId];
  }

  @Mutation
  setToolJobOutcome({
    toolId,
    scope,
    success,
  }: {
    toolId: string;
    scope: string;
    success: boolean;
  }) {
    this.toolJobOutcomes = {
      ...this.toolJobOutcomes,
      [toolId]: { scope, success },
    };
  }

  @Mutation
  removeJobInfo(jobId: string) {
    delete this.jobInfoMap[jobId];
  }

  @Action
  async handleJobEvent(event: MessageEvent) {
    let data: any;
    try {
      data = window.JSON.parse(event.data);
    } catch {
      logError("Invalid event JSON");
      return;
    }
    const notificationTime = data._girderTime;
    if (notificationTime < this.latestNotificationTime) {
      return;
    }
    this.setLatestNotificationTime(notificationTime);

    const jobEvent = data.data;
    const jobId = jobEvent?._id;
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (!jobInfo) {
      if (jobId) {
        this.storeMessage({ jobId, event: jobEvent });
      }
      return;
    }

    this.handleJobEventImp(jobEvent);
  }

  @Action
  async handleJobEventImp(jobEvent: IJobEventData) {
    const jobId = jobEvent._id;
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (!jobInfo) return;
    // Append to the log if there's text
    if (jobEvent.text && typeof jobEvent.text === "string") {
      jobInfo.log = jobInfo.log + jobEvent.text;
    }

    for (const listener of jobInfo.listeners) {
      listener.eventCallback?.(jobEvent);
      listener.errorCallback?.(jobEvent);
    }
    const status = jobEvent.status;
    if (!status || !FINISHED_JOB_STATUSES.includes(status)) {
      return;
    }

    const success = status === jobStates.success;
    if (!success) {
      logError(
        `Compute job with id ${jobId} ${
          status === jobStates.cancelled ? "cancelled" : "failed"
        }`,
      );
      if (status === jobStates.error) {
        // Surface the failure to the user. In particular, detect storage
        // quota breaches: server-side uploads (transcoding jobs, worker
        // outputs) fail with a quota message that only appears in the job
        // log, and would otherwise be invisible to the user.
        const jobTitle = jobEvent.title || "Job";
        const quotaMessage = quotaExceededMessage(jobInfo.log);
        const { default: progress } = await import("./progress");
        progress.createNotification({
          type: NotificationType.ERROR,
          title: quotaMessage ? "Storage Quota Exceeded" : "Job Failed",
          message: quotaMessage ?? `${jobTitle} failed.`,
          info: quotaMessage
            ? undefined
            : "See the job log for details about the failure.",
          timeout: 0, // Requires manual dismissal
        });
      }
    } else {
      // Create success notification
      const jobTitle = jobEvent.title || "Job";
      const { default: progress } = await import("./progress");
      progress.createNotification({
        type: NotificationType.INFO,
        title: "Job Completed Successfully",
        message: `${jobTitle} has completed successfully.`,
        timeout: 5, // Auto-dismiss after 5 seconds
      });
    }
    jobInfo.successResolve(success);
    this.removeJobInfo(jobId);
    // A job that worked has left results in the Object Browser. If it is not
    // showing, App.vue marks its toggle until the user looks (the panel
    // registry's `relevant` rule). A failed job has its own notification.
    if (success && !main.isAnnotationPanelOpen) {
      main.setAnnotationPanelBadge(true);
    }
  }

  // Settles every tracked job the server reports finished. The stream can
  // miss a job's terminal event while it is down (between a close and the
  // reconnect, or after giving up), and that event is the only other thing
  // that settles a job's promise. Girder's job list cannot filter by id, so
  // each tracked job is read on its own; only a handful are tracked at once.
  @Action
  async reconcileTrackedJobs() {
    await this.reconcileJobs(Object.keys(this.jobInfoMap));
  }

  // Reads each job's status and settles those that finished. A job the
  // server has no record of fails and stops being tracked: otherwise the
  // given-up poll would read it every 15 s for as long as the page is open.
  @Action
  async reconcileJobs(jobIds: string[]) {
    const statuses = await Promise.all(jobIds.map(readJobStatus));
    for (const [index, jobId] of jobIds.entries()) {
      const status = statuses[index];
      if (status === JOB_MISSING) {
        this.settleMissingJob(jobId);
      } else if (status != null && FINISHED_JOB_STATUSES.includes(status)) {
        // null: unreadable, so leave the job tracked rather than fail it
        await this.handleJobEventImp({ _id: jobId, status });
      }
    }
  }

  // Not routed through handleJobEventImp: there is no log to show and the
  // job did not fail, so its "Job Failed" notification would mislead. Its
  // listeners still get a terminal (error) event: some end their state from
  // the event (a progress entry) rather than from the promise.
  @Action
  settleMissingJob(jobId: string) {
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (!jobInfo) return;
    logWarning(`Job ${jobId} no longer exists on the server`);
    this.endTrackingWithoutOutcome(jobId);
  }

  // Stops tracking a job whose outcome will never be known here. Its promise
  // resolves false, which is what releases the waiters' progress entries and
  // run locks; listeners get an ended event. A waiter that reports failures
  // must tell this from one (sessionEndedSignal at logout).
  @Action
  endTrackingWithoutOutcome(jobId: string) {
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (!jobInfo) return;
    const jobEvent: IJobEventData = { _id: jobId, status: jobStates.error };
    for (const listener of jobInfo.listeners) {
      listener.eventCallback?.(jobEvent);
    }
    jobInfo.successResolve(false);
    this.removeJobInfo(jobId);
  }

  // At logout. This module outlives the session, and tracked jobs are looked
  // up by dataset and tool or property alone: left tracked, the previous
  // account's job would hold the next account's tool "running" on a shared
  // dataset for as long as its status cannot be read (403). The jobs
  // themselves keep running server-side.
  @Action
  retireTrackedJobs() {
    for (const jobId of Object.keys(this.jobInfoMap)) {
      this.endTrackingWithoutOutcome(jobId);
    }
  }

  // While the stream has given up, read tracked jobs' statuses periodically
  // so their promises still settle. Stops once nothing is tracked or a
  // stream exists again (whose open event reconciles instead).
  @Action
  async pollTrackedJobsWhileDisconnected() {
    if (givenUpPollTimer !== null) {
      clearTimeout(givenUpPollTimer);
      givenUpPollTimer = null;
    }
    if (
      this.notificationSource ||
      !main.isLoggedIn ||
      !Object.keys(this.jobInfoMap).length
    ) {
      return;
    }
    givenUpPollTimer = setTimeout(async () => {
      givenUpPollTimer = null;
      if (jobsModule.notificationSource) {
        return;
      }
      try {
        await jobsModule.reconcileTrackedJobs();
      } catch (error) {
        logError("[jobs] Could not read tracked job statuses", error);
      }
      await jobsModule.pollTrackedJobsWhileDisconnected();
    }, GIVEN_UP_POLL_MS);
  }

  // Shared by a socket error and an unexpected close: reconnect up to three
  // times, then give up and fall back to reading job statuses.
  @Action
  async retryNotificationSubscription() {
    this.setConnectionErrors(this.connectionErrors + 1);
    if (this.connectionErrors <= 3) {
      await this.initializeNotificationSubscription();
      return;
    }
    logError("Can't connect to girder notification stream");
    await this.closeNotificationSubscription();
    // The next subscription (the next addJob) gets fresh attempts, rather
    // than giving up on its first error.
    this.setConnectionErrors(0);
    await this.reconcileTrackedJobs();
    await this.pollTrackedJobsWhileDisconnected();
  }

  @Action
  async handleError(event: Event) {
    // Closing a socket that is still connecting (a resubscribe) makes it
    // emit an error; that socket is already replaced and is not a failure.
    if (event.target && event.target !== toRaw(this.notificationSource)) {
      return;
    }
    logError(
      "[jobs] WebSocket error, attempt:",
      this.connectionErrors + 1,
      event,
    );
    await this.retryNotificationSubscription();
  }

  // An error is followed by a close of the same socket, and closing a socket
  // ourselves also emits one; both have already replaced (or dropped) the
  // current socket, so only a close of the current one is unexpected (a
  // server restart, a proxy timeout). Before this handler existed such a
  // close was never noticed until the next addJob.
  @Action
  async handleClose(event: CloseEvent) {
    // toRaw: state holds a reactive proxy of the socket, never === target
    if (!event.target || event.target !== toRaw(this.notificationSource)) {
      return;
    }
    await this.retryNotificationSubscription();
  }

  @Action
  async handleOpen() {
    const openedSocket = toRaw(this.notificationSource);
    if (stableOpenTimer !== null) {
      clearTimeout(stableOpenTimer);
    }
    stableOpenTimer = setTimeout(() => {
      stableOpenTimer = null;
      if (toRaw(jobsModule.notificationSource) === openedSocket) {
        jobsModule.setConnectionErrors(0);
      }
    }, STABLE_OPEN_MS);
    // Terminal events sent while the stream was down are lost
    await this.reconcileTrackedJobs();
  }

  @Action
  async initializeNotificationSubscription() {
    await this.closeNotificationSubscription();
    const apiRoot = import.meta.env.VITE_GIRDER_URL || main.girderRest.apiRoot;
    let notificationURL = apiRoot.endsWith("/api/v1")
      ? apiRoot.slice(0, -6)
      : apiRoot;
    notificationURL = notificationURL.endsWith("/")
      ? notificationURL.slice(0, -1)
      : notificationURL;
    const notificationSource = new WebSocket(
      `${notificationURL}/notifications/me?token=${main.girderRest.token}`,
    );
    notificationSource.onmessage = this.handleJobEvent;
    notificationSource.onerror = this.handleError;
    notificationSource.onopen = this.handleOpen;
    notificationSource.onclose = this.handleClose;
    this.setNotificationSource(notificationSource);
  }

  @Action
  async closeNotificationSubscription() {
    if (this.notificationSource) {
      this.notificationSource.close();
      this.setNotificationSource(null);
    }
  }
}

const jobsModule = getModule(Jobs);
export default jobsModule;

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
