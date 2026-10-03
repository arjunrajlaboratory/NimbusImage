import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import { toRaw } from "vue";
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

import { logError } from "@/utils/log";
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

interface IJobInfo {
  listeners: IComputeJob[];
  successPromise: Promise<boolean>;
  successResolve: (success: boolean) => void;
  log: string;
  // Set once a terminal status has been handled. The same outcome can
  // arrive twice -- from the notification stream and from a status check --
  // and must only be acted on once.
  settled?: boolean;
}

const TERMINAL_JOB_STATES: number[] = [
  jobStates.cancelled,
  jobStates.success,
  jobStates.error,
];

// Reconnect delay after the notification stream closes unexpectedly:
// doubles per consecutive failure, capped.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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

  // The completion promise for a tracked job, or undefined if the job is not
  // tracked — either it was never registered with addJob, or it already
  // settled (handleJobEventImp drops the entry once it resolves). Callers must
  // handle undefined rather than assume a live job.
  get getPromiseForJobId() {
    return (jobId: string): Promise<boolean> | undefined =>
      this.jobInfoMap[jobId]?.successPromise;
  }

  get jobIdForToolId() {
    const jobsPerToolId: { [tooldId: string]: string } = {};
    for (const jobId in this.jobInfoMap) {
      const listeners = this.jobInfoMap[jobId].listeners;
      for (const listener of listeners) {
        if ("toolId" in listener) {
          jobsPerToolId[listener.toolId] = jobId;
          continue;
        }
      }
    }
    return jobsPerToolId;
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

  get jobIdForPropertyId() {
    const jobsPerPropertyId: { [propertyId: string]: string } = {};
    for (const jobId in this.jobInfoMap) {
      const listeners = this.jobInfoMap[jobId].listeners;
      for (const listener of listeners) {
        if ("propertyId" in listener) {
          jobsPerPropertyId[listener.propertyId] = jobId;
          continue;
        }
      }
    }
    return jobsPerPropertyId;
  }

  get getJobLog() {
    return (jobId: string) => this.jobInfoMap[jobId]?.log || "";
  }

  // The job's status straight from the server, or null when it could not be
  // read (network failure, deleted job, bad id) — a transient failure must not
  // be mistaken for a failed job.
  @Action
  async fetchJobStatus(jobId: string): Promise<number | null> {
    try {
      const response = await main.girderRest.get(`job/${jobId}`);
      return response.data.status;
    } catch (error) {
      logError(`Failed to get status for job ${jobId}`);
      return null;
    }
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
    if (
      !this.notificationSource ||
      this.notificationSource.readyState == WebSocket.CLOSED ||
      this.notificationSource.readyState == WebSocket.CLOSING
    ) {
      await this.initializeNotificationSubscription();
    }
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
    // The job may have finished before its events could reach us: a
    // request that runs the job in-process (e.g. transcoding with
    // localJob=true) only returns once it is done, and if the notification
    // stream was down meanwhile (a server restart, a network drop) the
    // terminal event is gone for good. Ask the server once.
    if (this.jobInfoMap[job.jobId]) {
      await this.reconcileJob(job.jobId);
    }
    return successPromise;
  }

  // The job record straight from the server, or null when it could not be
  // read (network failure, deleted job, bad id).
  @Action
  async fetchJob(jobId: string): Promise<IJobEventData | null> {
    try {
      return (await main.girderRest.get(`job/${jobId}`)).data;
    } catch (error) {
      logError(`Failed to get job ${jobId}`);
      return null;
    }
  }

  // Settle a tracked job from its server record if it has already finished;
  // used when its terminal event may have been missed.
  @Action
  async reconcileJob(jobId: string) {
    if (!this.jobInfoMap[jobId]) {
      return;
    }
    const job: any = await this.fetchJob(jobId);
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (
      !job ||
      !jobInfo ||
      jobInfo.settled ||
      !TERMINAL_JOB_STATES.includes(job.status)
    ) {
      return;
    }
    // Deliver whatever part of the log has not been seen, so listeners
    // (progress, quota detection) see the same text the stream would have
    // carried.
    const serverLog = Array.isArray(job.log) ? job.log.join("") : "";
    const unseenLog = serverLog.startsWith(jobInfo.log)
      ? serverLog.slice(jobInfo.log.length)
      : serverLog;
    await this.handleJobEventImp({
      ...job,
      _id: jobId,
      text: unseenLog || undefined,
    });
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
    } catch (error) {
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
    if (!jobInfo || jobInfo.settled) return;
    // Append to the log if there's text
    if (jobEvent.text && typeof jobEvent.text === "string") {
      jobInfo.log = jobInfo.log + jobEvent.text;
    }

    for (const listener of jobInfo.listeners) {
      listener.eventCallback?.(jobEvent);
      listener.errorCallback?.(jobEvent);
    }
    const status = jobEvent.status;
    if (!status || !TERMINAL_JOB_STATES.includes(status)) {
      return;
    }
    // Before any await, so a second terminal report is ignored.
    jobInfo.settled = true;

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
    // A job is done, add badge to annotation panel if it is closed
    if (!main.isAnnotationPanelOpen) {
      main.setAnnotationPanelBadge(true);
    }
  }

  @Action
  async handleError(event: Event) {
    // A close always follows an error; reconnecting is handleClose's job.
    logError("[jobs] WebSocket error", event);
  }

  // The stream closed without us asking (server restart, network drop):
  // reconnect with backoff. Events sent meanwhile are lost, so handleOpen
  // re-checks every tracked job once the stream is back.
  @Action
  async handleClose(event: CloseEvent) {
    // toRaw: the state may hold a reactive proxy of the socket.
    if (event.target !== toRaw(this.notificationSource)) {
      return; // closed deliberately, or superseded by a newer connection
    }
    this.setNotificationSource(null);
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.connectionErrors,
    );
    this.setConnectionErrors(this.connectionErrors + 1);
    setTimeout(() => {
      // Unless something else reconnected in the meantime.
      if (!this.notificationSource) {
        this.initializeNotificationSubscription();
      }
    }, delay);
  }

  @Action
  async handleOpen() {
    const reconnected = this.connectionErrors > 0;
    this.setConnectionErrors(0);
    if (reconnected) {
      for (const jobId of Object.keys(this.jobInfoMap)) {
        await this.reconcileJob(jobId);
      }
    }
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
    const source = this.notificationSource;
    if (source) {
      // Cleared first, so handleClose sees a deliberate close.
      this.setNotificationSource(null);
      source.close();
    }
  }
}

export default getModule(Jobs);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
