import {
  VuexModule,
  Module,
  Mutation,
  Action,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import jobs from "./jobs";
import { ProgressType, PROGRESS_TYPE_ORDER, IProgress } from "./model";
import { jobStates } from "./jobs";
import { v4 as uuidv4 } from "uuid";

// These are the endpoints that are sent to the fetchAllJobs call. We can capture them to
// create appropriate progress items for them.
const ENDPOINT_MAPPINGS: Record<string, { type: ProgressType; title: string }> =
  {
    upenn_annotation: {
      type: ProgressType.ANNOTATION_FETCH,
      title: "Fetching annotations", // TODO: If we decide that this will always be the same for all progresses of this type, we can remove this title and just use the default
    },
    annotation_connection: {
      type: ProgressType.CONNECTION_FETCH,
      title: "Fetching connections",
    },
    annotation_property_values: {
      type: ProgressType.PROPERTY_FETCH,
      title: "Fetching property values",
    },
    // Can add other endpoint mappings as needed
  };

function determineTypeAndTitle(payload: {
  type?: ProgressType;
  endpoint?: string;
  title?: string;
}): { type: ProgressType; title: string } {
  if (payload.title) {
    // If title is provided, use it directly with the provided type (if any)
    return {
      type: payload.type || ProgressType.GENERIC,
      title: payload.title,
    };
  }

  if (payload.endpoint) {
    // If endpoint is provided, look up the mapping
    const mapping = ENDPOINT_MAPPINGS[payload.endpoint];
    if (!mapping) {
      return {
        type: ProgressType.GENERIC,
        title: `Fetching ${payload.endpoint}`,
      };
    }
    return {
      type: mapping.type,
      title: mapping.title,
    };
  }

  if (payload.type) {
    // If only type is provided, use a default title for that type
    const type = payload.type;
    let title: string;
    switch (type) {
      case ProgressType.ANNOTATION_FETCH:
        title = "Fetching annotations";
        break;
      case ProgressType.CONNECTION_FETCH:
        title = "Fetching connections";
        break;
      case ProgressType.PROPERTY_FETCH:
        title = "Fetching properties";
        break;
      case ProgressType.VIEW_FETCH:
        title = "Fetching dataset view";
        break;
      case ProgressType.HISTOGRAM_CACHE:
        title = "Computing histograms";
        break;
      case ProgressType.HISTOGRAM_SCHEDULE:
        title = "Scheduling histogram cache";
        break;
      case ProgressType.MAXMERGE_CACHE:
        title = "Caching max-merge";
        break;
      default:
        title = "Operation in progress";
    }
    return { type, title };
  }

  // Fallback
  return {
    type: ProgressType.GENERIC,
    title: "Operation in progress",
  };
}

@Module({ dynamic: true, store, name: "progress" })
class Progress extends VuexModule {
  items: IProgress[] = [];

  @Mutation
  private ADD_PROGRESS(progress: IProgress) {
    this.items.push(progress);
  }

  @Mutation
  private UPDATE_PROGRESS({
    id,
    progress,
    total,
    title,
  }: {
    id: string;
    progress: number;
    total: number;
    title?: string;
  }) {
    const item = this.items.find((p) => p.id === id);
    if (item) {
      item.progress = progress;
      item.total = total;
      if (title) {
        item.title = title;
      }
    }
  }

  // Reactive progresses are for fast updates that react to quick UI changes
  // They are replaced on every update and are removed when the progress is complete
  @Mutation
  private ADD_REACTIVE_PROGRESS(progress: Omit<IProgress, "id">) {
    // For reactive progress, we can use a predictable ID based on the type
    const id = `reactive-${progress.type}`;
    // Remove any existing reactive progress of this type and replace it
    this.items = this.items.filter((p) => p.id !== id);
    if (progress.progress < progress.total) {
      this.items.push({ ...progress, id, isReactive: true });
    }
  }

  @Action
  updateReactiveProgress(payload: {
    type: ProgressType;
    progress: number;
    total: number;
    title: string;
    metadata?: Record<string, any>;
  }) {
    this.ADD_REACTIVE_PROGRESS({
      type: payload.type,
      progress: payload.progress,
      total: payload.total,
      title: payload.title,
      metadata: payload.metadata || {},
    });
  }

  @Mutation
  private REMOVE_PROGRESS(id: string) {
    this.items = this.items.filter((p) => p.id !== id);
  }

  @Action
  create(payload: {
    type?: ProgressType;
    endpoint?: string;
    title?: string;
    metadata?: Record<string, any>;
  }) {
    const id = uuidv4();
    const { type, title } = determineTypeAndTitle(payload);

    this.ADD_PROGRESS({
      id,
      type,
      progress: 0,
      total: 0,
      title,
      metadata: payload.metadata || {},
    });

    // For reactive progresses, we remove them after 1 second
    // This is to prevent orphaned progresses from hanging around
    setTimeout(() => {
      const item = this.items.find((p) => p.id === id && p.isReactive);
      if (item) {
        this.REMOVE_PROGRESS(id);
      }
    }, 1000); // 1 second timeout

    return id;
  }

  @Action
  async trackHistogramJob(jobId: string) {
    const progressId = await this.create({
      type: ProgressType.HISTOGRAM_CACHE,
      title: "Waiting for histogram precomputation",
    });

    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return;
    }

    const totalFrames = main.dataset
      ? main.dataset.z.length *
        main.dataset.time.length *
        main.dataset.xy.length *
        main.dataset.channels.length
      : 0;

    await jobs.addJob({
      jobId,
      datasetId,
      eventCallback: (jobInfo) => {
        // Check for completion first
        if (
          [jobStates.success, jobStates.error].includes(jobInfo.status || 0)
        ) {
          this.complete(progressId);
          return;
        }

        // If we have text with a frame number, treat it as progress
        // Note that the jobStates.running only comes on the first "running"
        // progress update, so we can't just use that to determine if we're
        // still running.
        const frameMatch = jobInfo.text?.match(/{'frame': (\d+)/);
        if (frameMatch) {
          const currentFrame = parseInt(frameMatch[1]);
          this.update({
            id: progressId,
            progress: currentFrame + 1,
            total: totalFrames,
            title: "Precomputing histograms",
          });
        }
      },
    });

    // Sometimes the job completes before the callback even fires (for small images)
    // So we check the status here to make sure we don't leave a progress item hanging
    const status = await jobs.getJobStatus(jobId);
    if ([jobStates.success, jobStates.error].includes(status)) {
      this.complete(progressId);
    }
  }

  @Action
  async trackMaxMergeJob(jobId: string) {
    const progressId = await this.create({
      type: ProgressType.MAXMERGE_CACHE,
      title: "Waiting for max-merge precomputation",
    });

    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return;
    }

    await jobs.addJob({
      jobId,
      datasetId,
      eventCallback: (jobInfo) => {
        // Check for completion
        if (
          [jobStates.success, jobStates.error].includes(jobInfo.status || 0)
        ) {
          this.complete(progressId);
          return;
        }

        // jobInfo.title comes when the job starts.
        // Title will be e.g. "Large Image Conversion: multi-source2.json_maxmerge_z.yaml"
        // From which we want to extract the type of the job, which could be z, t, or zt
        const typeMatch = jobInfo.title?.match(/_([zt])/);
        if (typeMatch) {
          const type = typeMatch[1];
          this.update({
            id: progressId,
            progress: 0,
            total: 0,
            title: `Max-Merging ${type}`,
          });
        }

        // jobInfo.text comes when the job updates (and a few other instances)
        // For instance: "Processing frame 1/4"
        // We can use this to update the progress
        const frameMatch = jobInfo.text?.match(/Processing frame (\d+)\/(\d+)/);
        if (frameMatch) {
          const currentFrame = parseInt(frameMatch[1]);
          const totalFrames = parseInt(frameMatch[2]);
          this.update({
            id: progressId,
            progress: currentFrame,
            total: totalFrames,
          });
        }
      },
    });
  }

  @Action
  update(payload: {
    id: string;
    progress: number;
    total: number;
    title?: string;
  }) {
    this.UPDATE_PROGRESS(payload);
  }

  @Action
  complete(id: string) {
    this.REMOVE_PROGRESS(id);
  }

  get activeProgresses() {
    return [...this.items].sort((a, b) => {
      const priorityA = PROGRESS_TYPE_ORDER.get(a.type) ?? Number.MAX_VALUE;
      const priorityB = PROGRESS_TYPE_ORDER.get(b.type) ?? Number.MAX_VALUE;
      return priorityA - priorityB;
    });
  }

  get hasActiveProgresses() {
    return this.items.length > 0;
  }
}

export default getModule(Progress);
