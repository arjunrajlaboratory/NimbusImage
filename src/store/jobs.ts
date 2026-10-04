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

import { logError } from "@/utils/log";
import { quotaExceededMessage } from "@/utils/quota";
import {
  isTerminalJobStatus,
  jobStates,
  UNFINISHED_JOB_STATUSES,
} from "./jobConstants";

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
  // Set the moment a terminal status is handled, so a second report of the
  // end (the stream and a status check can both deliver it) is ignored. The
  // entry itself stays until the end is fully handled: watchers such as
  // ToolItem's and the job-log panels read it after the current tick.
  settled?: boolean;
  // When the job last showed signs of life (registered, or any event);
  // jobs quiet for JOB_QUIET_MS get their status checked.
  lastEventAt: number;
  // The user who started it. Status checks only cover the current user's
  // jobs: another session's jobs (before a logout or a token expiry) must
  // not be settled, running their listeners, in this one.
  userId: string | undefined;
}

// A job as GET job/:id returns it: the event fields plus its log (the
// server keeps only the tail of a very long one).
interface IJobRecord extends IJobEventData {
  log?: string[];
}

// Reconnect delay after the notification stream closes unexpectedly:
// doubles per consecutive failure, capped, and gives up after
// RECONNECT_MAX_ATTEMPTS (addJob reconnects on demand after that). The
// failure count resets only once a connection has stayed open for
// STABLE_CONNECTION_MS, so a server that accepts and immediately drops the
// socket still backs off.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const STABLE_CONNECTION_MS = 10000;
// Safety net for events lost in ways the socket cannot tell us about (a
// drop and reconnect while the job's request was in flight, a stream that
// stays open but goes silent, giving up on reconnecting): every
// JOB_POLL_INTERVAL_MS, jobs quiet for JOB_QUIET_MS are checked against one
// list of the user's unfinished jobs.
const JOB_POLL_INTERVAL_MS = 15000;
const JOB_QUIET_MS = 30000;
// High enough that a long queue (e.g. a batch property computation) does
// not push tracked jobs off the list and into one read each.
const UNFINISHED_JOBS_LIMIT = 1000;

// Timer handles are not store state.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function cancelReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cancelStableTimer() {
  if (stableTimer !== null) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

// Stops the quiet-job poll (it also stops itself once nothing is tracked).
export function stopJobPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// The part of the server's log not yet in ours. The server keeps only the
// tail of a very long log, so when it does not simply extend ours, find the
// longest end of ours that the start of its log repeats (KMP: the prefix
// function of the server log, then a scan of our end against it -- linear
// time). With no overlap at all, everything it has came after what we saw.
export function unseenLogSuffix(seenLog: string, serverLog: string): string {
  if (serverLog.startsWith(seenLog)) {
    return serverLog.slice(seenLog.length);
  }
  // Only our last `length` characters can overlap the start of its log, and
  // only its first `length` can be the overlap.
  const length = Math.min(seenLog.length, serverLog.length);
  const seenEnd = seenLog.slice(seenLog.length - length);
  // prefix[i]: length of the longest proper prefix of serverLog[0..i] that
  // is also a suffix of it.
  const prefix = new Int32Array(length);
  for (let i = 1; i < length; ++i) {
    let k = prefix[i - 1];
    while (k > 0 && serverLog[i] !== serverLog[k]) {
      k = prefix[k - 1];
    }
    if (serverLog[i] === serverLog[k]) {
      k += 1;
    }
    prefix[i] = k;
  }
  // A full match can only end at our end, since seenEnd is `length` long.
  let matched = 0;
  for (let i = 0; i < length; ++i) {
    while (matched > 0 && seenEnd[i] !== serverLog[matched]) {
      matched = prefix[matched - 1];
    }
    if (seenEnd[i] === serverLog[matched]) {
      matched += 1;
    }
  }
  return serverLog.slice(matched);
}

// Tell the user how a job ended.
async function notifyJobEnd(jobEvent: IJobEventData, log: string) {
  const jobTitle = jobEvent.title || "Job";
  const status = jobEvent.status;
  if (status === jobStates.success) {
    const { default: progress } = await import("./progress");
    progress.createNotification({
      type: NotificationType.INFO,
      title: "Job Completed Successfully",
      message: `${jobTitle} has completed successfully.`,
      timeout: 5, // Auto-dismiss after 5 seconds
    });
    return;
  }
  logError(
    `Compute job with id ${jobEvent._id} ${
      status === jobStates.cancelled ? "cancelled" : "failed"
    }`,
  );
  if (status === jobStates.error) {
    // Surface the failure to the user. In particular, detect storage
    // quota breaches: server-side uploads (transcoding jobs, worker
    // outputs) fail with a quota message that only appears in the job
    // log, and would otherwise be invisible to the user.
    const quotaMessage = quotaExceededMessage(log);
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
        lastEventAt: Date.now(),
        userId: main.girderUser?._id,
      };
      this.jobInfoMap[job.jobId] = jobData;
    }
    jobData.listeners.push(job);
  }

  @Action
  async addJob(job: IComputeJob) {
    // Open the stream if it is down and no reconnect is pending (one is
    // pending during a backoff: leave it be, or each new job would undo the
    // backoff). A new job is a fresh reason to try, even after reconnecting
    // gave up. Either way, once the stream opens handleOpen checks this job
    // too (it is registered below, before any open event can arrive), so a
    // job that ended while the stream was down is still settled.
    if (
      reconnectTimer === null &&
      (!this.notificationSource ||
        this.notificationSource.readyState == WebSocket.CLOSED ||
        this.notificationSource.readyState == WebSocket.CLOSING)
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
    this.ensureJobPolling();
    return successPromise;
  }

  // Whether any tracked job is the current user's: only those are checked
  // (see IJobInfo.userId).
  get hasCheckableJobs() {
    const userId = main.girderUser?._id;
    return (
      userId !== undefined &&
      Object.values(this.jobInfoMap).some(
        (jobInfo) => jobInfo.userId === userId,
      )
    );
  }

  // Runs the safety-net poll (see JOB_POLL_INTERVAL_MS) while the current
  // user has tracked jobs.
  @Action
  ensureJobPolling() {
    if (pollTimer !== null || !this.hasCheckableJobs) {
      return;
    }
    pollTimer = setInterval(() => {
      if (!this.hasCheckableJobs) {
        stopJobPolling();
        return;
      }
      // Reconnecting gave up: try once more, gently (the failure count is
      // kept, so a failure gives up again at once), so running jobs get
      // their progress back once the server is reachable.
      if (
        !this.notificationSource &&
        reconnectTimer === null &&
        main.girderRest.token
      ) {
        this.initializeNotificationSubscription(true);
      }
      this.reconcileTrackedJobs(true);
    }, JOB_POLL_INTERVAL_MS);
  }

  // Settle a tracked job from its server record if it has already finished;
  // used when its terminal event may have been missed.
  @Action
  async reconcileJob(jobId: string) {
    if (!this.jobInfoMap[jobId]) {
      return;
    }
    let job: IJobRecord;
    try {
      job = (await main.girderRest.get(`job/${jobId}`)).data;
    } catch (error) {
      if (!isAxiosError(error) || error.response?.status !== 400) {
        // E.g. a network failure: try again later.
        logError(`Failed to get job ${jobId}`);
        return;
      }
      // Girder answers 400 for a job that no longer exists (deleted): it
      // will never end, so settle it as cancelled (no "Job Failed" pointing
      // to a log that is gone) rather than check it forever.
      job = { _id: jobId, status: jobStates.cancelled };
    }
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (
      !jobInfo ||
      jobInfo.settled ||
      // Re-checked after the request: the user may have changed meanwhile.
      jobInfo.userId !== main.girderUser?._id ||
      !isTerminalJobStatus(job.status)
    ) {
      return;
    }
    // Deliver the part of the log not seen yet, so listeners (progress,
    // quota detection, the job-log panels) get what the stream would have
    // carried, without repeating lines already handled.
    const unseenLog = unseenLogSuffix(jobInfo.log, (job.log ?? []).join(""));
    await this.handleJobEventImp({
      _id: jobId,
      status: job.status,
      title: job.title,
      text: unseenLog || undefined,
    });
  }

  // Settle tracked jobs that have finished without our hearing of it, with
  // one request listing the user's unfinished jobs (there is no batch status
  // endpoint) and a full read only of tracked jobs missing from that list.
  // Listing the unfinished rather than the finished jobs means a job that
  // ended long ago, behind many newer ones, is still found. A job missing
  // for another reason (the list was cut at its limit, someone else's job)
  // just costs a read that shows it still running.
  // With onlyQuiet, only jobs with no news for JOB_QUIET_MS are considered.
  @Action
  async reconcileTrackedJobs(onlyQuiet: boolean) {
    const now = Date.now();
    const userId = main.girderUser?._id;
    const jobIds = Object.keys(this.jobInfoMap).filter((jobId) => {
      const jobInfo = this.jobInfoMap[jobId];
      return (
        userId !== undefined &&
        jobInfo.userId === userId &&
        (!onlyQuiet || now - jobInfo.lastEventAt >= JOB_QUIET_MS)
      );
    });
    if (jobIds.length === 0) {
      return;
    }
    // Not again until they have been quiet for another full window.
    for (const jobId of jobIds) {
      this.jobInfoMap[jobId].lastEventAt = now;
    }
    let unfinished: Set<string>;
    try {
      const jobs = await main.api.getUnfinishedUserJobs(
        UNFINISHED_JOB_STATUSES,
        UNFINISHED_JOBS_LIMIT,
      );
      unfinished = new Set(jobs.map((job) => job._id));
    } catch (error) {
      logError("Failed to list unfinished jobs");
      return;
    }
    await Promise.all(
      jobIds
        .filter((jobId) => !unfinished.has(jobId))
        .map((jobId) => this.reconcileJob(jobId)),
    );
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
    jobInfo.lastEventAt = Date.now();
    // Append to the log if there's text
    if (jobEvent.text && typeof jobEvent.text === "string") {
      jobInfo.log = jobInfo.log + jobEvent.text;
    }

    for (const listener of jobInfo.listeners) {
      // A throwing listener must not keep the job from settling (it would
      // then be re-checked, and the listeners re-run, every poll).
      for (const callback of [listener.eventCallback, listener.errorCallback]) {
        try {
          callback?.(jobEvent);
        } catch (error) {
          logError(`A listener of job ${jobId} failed`, error);
        }
      }
    }
    const status = jobEvent.status;
    if (!isTerminalJobStatus(status)) {
      return;
    }
    // Before any await, so a second report of the end is ignored. The
    // entry is removed only once the end is handled (below): removing it
    // now, in the same tick it may have been added, would hide the job from
    // watchers that read it after this tick (ToolItem's outcome icon, the
    // job-log panels).
    jobInfo.settled = true;

    const success = status === jobStates.success;
    try {
      await notifyJobEnd(jobEvent, jobInfo.log);
    } catch (error) {
      // E.g. the notification's chunk failed to load. The job must settle
      // regardless: it is marked settled, so nothing else will.
      logError(`Failed to report the end of job ${jobId}`, error);
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
    cancelStableTimer();
    // Logged out (the token is gone), or failing for a long while: stop.
    // Logging in and addJob reconnect on demand.
    if (!main.girderRest.token) {
      return;
    }
    if (this.connectionErrors >= RECONNECT_MAX_ATTEMPTS) {
      logError("Can't connect to girder notification stream");
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.connectionErrors,
    );
    this.setConnectionErrors(this.connectionErrors + 1);
    cancelReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (main.girderRest.token) {
        this.initializeNotificationSubscription(true);
      }
    }, delay);
  }

  // Every (re)connection re-checks the tracked jobs, with one request for
  // all of them: whatever ended while no stream was open is otherwise never
  // heard of. At the first connection (made at login) nothing is tracked,
  // so this costs nothing.
  @Action
  async handleOpen() {
    cancelStableTimer();
    stableTimer = setTimeout(() => {
      stableTimer = null;
      this.setConnectionErrors(0);
    }, STABLE_CONNECTION_MS);
    // E.g. a user logging back in with jobs still tracked from before.
    this.ensureJobPolling();
    await this.reconcileTrackedJobs(false);
  }

  // isReconnect: a backoff reconnect, which keeps the failure count. Any
  // other (re)connection -- logging in, a new job -- is a fresh start, even
  // after reconnecting gave up.
  @Action
  async initializeNotificationSubscription(isReconnect: boolean = false) {
    if (!isReconnect) {
      this.setConnectionErrors(0);
    }
    // No await anywhere here: the new socket is in place before any other
    // caller (e.g. several addJobs at once) can look, so they share it
    // instead of each opening one.
    // Also cancels a pending reconnect: this is the connection now.
    cancelReconnect();
    cancelStableTimer();
    const previousSource = this.notificationSource;
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
    // Replaced before closing, so handleClose sees a deliberate close.
    this.setNotificationSource(notificationSource);
    previousSource?.close();
  }

  @Action
  async closeNotificationSubscription() {
    cancelReconnect();
    cancelStableTimer();
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
  // The re-run module starts with fresh timer handles; stop the old timers.
  import.meta.hot.dispose(() => {
    stopJobPolling();
    cancelReconnect();
    cancelStableTimer();
  });
}
