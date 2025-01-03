import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import Vue from "vue";

import {
  IComputeJob,
  IErrorInfo,
  IErrorInfoList,
  IJobEventData,
  IProgressInfo,
  MessageType,
} from "./model";

import main from "./index";

import { logError } from "@/utils/log";

export const jobStates = {
  inactive: 0,
  queued: 1,
  running: 2,
  success: 3,
  error: 4,
  cancelled: 5,
  cancelling: 824,
};

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
            Vue.set(progressObject, k, v);
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
          // Add to errors array while maintaining reactivity
          Vue.set(errorObject.errors, errorObject.errors.length, newError);
        }
      } catch {}
    }
  };
}

interface IJobInfo {
  listeners: IComputeJob[];
  successPromise: Promise<boolean>;
  successResolve: (success: boolean) => void;
}

@Module({ dynamic: true, store, name: "jobs" })
export class Jobs extends VuexModule {
  notificationSource: EventSource | null = null;
  latestNotificationTime: number = 0;

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
      };
      Vue.set(this.jobInfoMap, job.jobId, jobData);
    }
    jobData.listeners.push(job);
  }

  @Action
  async addJob(job: IComputeJob) {
    if (!this.notificationSource) {
      await this.initializeNotificationSubscription();
    }
    this.rawAddJob(job);
    return this.jobInfoMap[job.jobId].successPromise;
  }

  @Mutation
  rawRemoveJob(jobId: string) {
    Vue.delete(this.jobInfoMap, jobId);
  }

  @Action
  async removeJob(jobId: string) {
    this.rawRemoveJob(jobId);
    if (Object.keys(this.jobInfoMap).length <= 0) {
      await this.closeNotificationSubscription();
    }
    // A job is done, add badge to annotation panel if it is closed
    if (!main.isAnnotationPanelOpen) {
      main.setAnnotationPanelBadge(true);
    }
  }

  @Mutation
  setNotificationSource(source: EventSource | null) {
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
    const jobId = jobEvent._id;
    const jobInfo: IJobInfo | undefined = this.jobInfoMap[jobId];
    if (!jobInfo) {
      return;
    }
    for (const listener of jobInfo.listeners) {
      listener.eventCallback?.(jobEvent);
      listener.errorCallback?.(jobEvent);
    }
    const status = jobEvent.status;
    if (
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
    }
    this.removeJob(jobId);
    jobInfo.successResolve(success);
  }

  @Action
  async handleError() {
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
    const notificationSource = new EventSource(
      `${main.girderRest.apiRoot}/notification/stream?token=${main.girderRest.token}`,
    );
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
