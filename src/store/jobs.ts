import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
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
}

@Module({ dynamic: true, store, name: "jobs" })
export class Jobs extends VuexModule {
  notificationSource: WebSocket | null = null;
  latestNotificationTime: number = 0;

  messageStore: { [jobId: string]: IJobEventData[] } = {};

  private jobInfoMap: { [jobId: string]: IJobInfo } = {};

  connectionErrors: number = 0;

  get getPromiseForJobId() {
    return (jobId: string) => this.jobInfoMap[jobId].successPromise;
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

  @Action
  async getJobStatus(jobId: string): Promise<number> {
    try {
      const response = await main.girderRest.get(`job/${jobId}`);
      return response.data.status;
    } catch (error) {
      logError(`Failed to get status for job ${jobId}`);
      return jobStates.error;
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
    if (!this.notificationSource) {
      await this.initializeNotificationSubscription();
    }
    this.rawAddJob(job);
    // If there are messages in the message store for this job, handle them now
    if (job.jobId in this.messageStore) {
      for (const jobEvent of this.messageStore[job.jobId]) {
        await this.handleJobEventImp(jobEvent);
      }
      this.clearStoredMessages(job.jobId);
    }
    return this.jobInfoMap[job.jobId].successPromise;
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
    if (
      !status ||
      ![jobStates.cancelled, jobStates.success, jobStates.error].includes(
        status,
      )
    ) {
      return;
    }

    const success = status === jobStates.success;
    if (!success) {
      logError(
        `Compute job with id ${jobId} ${
          status === jobStates.cancelled ? "cancelled" : "failed"
        }`,
      );
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
    logError(
      "[jobs] WebSocket error, attempt:",
      this.connectionErrors + 1,
      event,
    );
    this.setConnectionErrors(this.connectionErrors + 1);
    if (this.connectionErrors <= 3) {
      await this.initializeNotificationSubscription();
    } else {
      // Can't connect after 3 attempts
      logError("Can't connect to girder notification stream");
      await this.closeNotificationSubscription();
    }
  }

  @Action
  async handleOpen() {
    this.setConnectionErrors(0);
  }

  @Action
  async initializeNotificationSubscription() {
    await this.closeNotificationSubscription();
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/notifications/me?token=${main.girderRest.token}`;
    const notificationSource = new WebSocket(wsUrl);
    notificationSource.onmessage = this.handleJobEvent;
    notificationSource.onerror = this.handleError;
    notificationSource.onopen = this.handleOpen;
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

export default getModule(Jobs);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
