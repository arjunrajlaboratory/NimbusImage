import {
  getModule,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

/**
 * "Apply to all datasets" batch runs, keyed by the configuration they run
 * over and what they run: a worker tool (AnnotationWorkerMenu) or a property
 * (AnalyzeDialog).
 *
 * This state used to live in those components, so a menu or dialog remounted
 * mid-batch (the worker menu is keyed by tool, palettes remount) lost the
 * batch's progress and its cancel function, and its in-flight guard with
 * them: it showed only the current dataset's job, could not cancel the batch
 * and let a second batch start. Here it outlives the component.
 *
 * Runs are scoped by configuration (collection) as well: tool and property
 * ids are copied into duplicated collections, so an id alone would show one
 * collection's batch (and its Cancel All) in another. Every getter takes the
 * configuration it reports on. The module outlives logout, so logout clears
 * it (`resetBatchRuns`); the jobs a batch submitted keep running on the
 * server.
 *
 * Start a batch with `runBatch`, which claims the run before anything is
 * awaited and releases it on every exit.
 */

export interface IBatchProgress {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  currentDatasetName: string;
}

export interface IBatchResults {
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface IBatchRun {
  // The configuration (collection) the batch runs over
  configurationId: string;
  // From the moment the batch is claimed until it settles
  inFlight: boolean;
  // Shown while the batch runs and for a few seconds after it ends
  progress: IBatchProgress | null;
  // Set once the batch action hands it over; null after the batch settles
  cancel: (() => void) | null;
}

export type BatchKind = "workerTool" | "property";

// How long a finished batch's progress stays on screen
export const BATCH_PROGRESS_LINGER_MS = 3000;

// The key of a run: what it runs within one configuration
function runKey(configurationId: string, id: string) {
  return `${configurationId}:${id}`;
}

@Module({ dynamic: true, store, name: "batchRuns" })
export class BatchRuns extends VuexModule {
  workerTool: { [runKey: string]: IBatchRun } = {};
  property: { [runKey: string]: IBatchRun } = {};

  get batchRun() {
    return (
      kind: BatchKind,
      configurationId: string | null,
      id: string,
    ): IBatchRun | null =>
      configurationId === null
        ? null
        : this[kind][runKey(configurationId, id)] ?? null;
  }

  get anyInFlight() {
    return (kind: BatchKind, configurationId: string | null): boolean =>
      Object.values(this[kind]).some(
        (run) => run.configurationId === configurationId && run.inFlight,
      );
  }

  // The one batch of a kind in a configuration that a single progress
  // display shows: a running one first, else a finished one whose progress
  // is still lingering.
  get shownRun() {
    return (
      kind: BatchKind,
      configurationId: string | null,
    ): IBatchRun | null => {
      const runs = Object.values(this[kind]).filter(
        (run) => run.configurationId === configurationId,
      );
      return (
        runs.find((run) => run.inFlight) ??
        runs.find((run) => run.progress !== null) ??
        null
      );
    };
  }

  @Mutation
  startRun({
    kind,
    configurationId,
    id,
    total,
  }: {
    kind: BatchKind;
    configurationId: string;
    id: string;
    total: number;
  }) {
    this[kind] = {
      ...this[kind],
      [runKey(configurationId, id)]: {
        configurationId,
        inFlight: true,
        progress: {
          total,
          completed: 0,
          failed: 0,
          cancelled: 0,
          currentDatasetName: "Starting...",
        },
        cancel: null,
      },
    };
  }

  @Mutation
  setRunProgress({
    kind,
    configurationId,
    id,
    progress,
  }: {
    kind: BatchKind;
    configurationId: string;
    id: string;
    progress: IBatchProgress;
  }) {
    const run = this[kind][runKey(configurationId, id)];
    if (run?.inFlight) {
      run.progress = { ...progress };
    }
  }

  @Mutation
  setRunCancel({
    kind,
    configurationId,
    id,
    cancel,
  }: {
    kind: BatchKind;
    configurationId: string;
    id: string;
    cancel: () => void;
  }) {
    const run = this[kind][runKey(configurationId, id)];
    if (run?.inFlight) {
      run.cancel = cancel;
    }
  }

  @Mutation
  finishRun({
    kind,
    configurationId,
    id,
    keepProgress,
  }: {
    kind: BatchKind;
    configurationId: string;
    id: string;
    keepProgress: boolean;
  }) {
    const run = this[kind][runKey(configurationId, id)];
    if (run) {
      run.inFlight = false;
      run.cancel = null;
      if (!keepProgress) {
        run.progress = null;
      }
    }
  }

  @Mutation
  hideFinishedRunProgress({
    kind,
    configurationId,
    id,
  }: {
    kind: BatchKind;
    configurationId: string;
    id: string;
  }) {
    const run = this[kind][runKey(configurationId, id)];
    if (run && !run.inFlight) {
      run.progress = null;
    }
  }

  @Mutation
  resetBatchRunState() {
    this.workerTool = {};
    this.property = {};
  }
}

const batchRuns = getModule(BatchRuns);
export default batchRuns;

// Pending hides of finished batches' progress, one per run. A new batch of
// the same run cancels its predecessor's, so it never hides the new progress.
const progressHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Advanced by every reset. A batch started before a reset (a logout) stops
// submitting (sessionEndedSignal), and while it winds down must not write
// into the cleared module or into a later run with the same key, nor
// schedule a hide.
let resetGeneration = 0;

// For whatever waits on a tracked job (a batch loop, a single run, a tool's
// outcome icon): true once a reset (a logout) has ended the session it
// started in. Logout settles the tracked job as not successful, and without
// this check a loop would take that for an ordinary failure and submit its
// next job, and a run would report a failure for a job that is still
// running server-side. Unlike a cancel, stopping leaves submitted jobs alone.
export function sessionEndedSignal(): () => boolean {
  const generation = resetGeneration;
  return () => generation !== resetGeneration;
}

function cancelProgressHide(timerKey: string) {
  const timer = progressHideTimers.get(timerKey);
  if (timer !== undefined) {
    clearTimeout(timer);
    progressHideTimers.delete(timerKey);
  }
}

export interface IBatchHooks {
  onBatchProgress: (progress: IBatchProgress) => void;
  onCancel: (cancel: () => void) => void;
  onComplete: (results: IBatchResults) => void;
}

/**
 * Run one batch for a worker tool or a property over a configuration.
 *
 * Refuses (returns `{ started: false }`) while a batch of the same run is in
 * flight. Otherwise claims the run before anything is awaited, passes the
 * batch action the hooks that keep its progress and cancel function in the
 * store, and releases the run however the action ends. A finished batch's
 * progress lingers for BATCH_PROGRESS_LINGER_MS; a batch that throws, or
 * whose action returns `false` (it refused to start), leaves no progress.
 * Rethrows what the action throws.
 */
export async function runBatch(
  kind: BatchKind,
  configurationId: string,
  id: string,
  total: number,
  start: (hooks: IBatchHooks) => Promise<unknown>,
): Promise<{ started: boolean; results: IBatchResults | null }> {
  if (batchRuns.batchRun(kind, configurationId, id)?.inFlight) {
    return { started: false, results: null };
  }
  const run = { kind, configurationId, id };
  const timerKey = `${kind}:${runKey(configurationId, id)}`;
  const generation = resetGeneration;
  const current = () => generation === resetGeneration;
  cancelProgressHide(timerKey);
  batchRuns.startRun({ ...run, total });

  let results = null as IBatchResults | null;
  let keepProgress = false;
  try {
    const outcome = await start({
      onBatchProgress: (progress) => {
        if (current()) {
          batchRuns.setRunProgress({ ...run, progress });
        }
      },
      onCancel: (cancel) => {
        if (current()) {
          batchRuns.setRunCancel({ ...run, cancel });
        }
      },
      onComplete: (batchResults) => {
        results = batchResults;
      },
    });
    keepProgress = outcome !== false;
  } finally {
    if (current()) {
      batchRuns.finishRun({ ...run, keepProgress });
      if (keepProgress) {
        progressHideTimers.set(
          timerKey,
          setTimeout(() => {
            progressHideTimers.delete(timerKey);
            batchRuns.hideFinishedRunProgress(run);
          }, BATCH_PROGRESS_LINGER_MS),
        );
      }
    }
  }
  return { started: true, results };
}

// Forget every batch run and pending hide (logout, tests). Batches still
// running keep their server jobs, but stop reporting here and submit nothing
// further (sessionEndedSignal).
export function resetBatchRuns() {
  ++resetGeneration;
  for (const timer of progressHideTimers.values()) {
    clearTimeout(timer);
  }
  progressHideTimers.clear();
  batchRuns.resetBatchRunState();
}

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
