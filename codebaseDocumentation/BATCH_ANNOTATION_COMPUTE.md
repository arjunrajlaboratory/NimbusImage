# Batch Annotation Compute

## Overview

Workers can be configured to iterate over all datasets in a collection/configuration. This is managed through a "batch mode" checkbox in the `AnnotationWorkerMenu.vue` component, which submits individual jobs for each dataset using the same tool settings.

## Architecture

### How it works

1. The `AnnotationWorkerMenu` fetches the count of datasets in the current configuration on mount (and whenever the configuration changes) using `findDatasetViews({ configurationId })`.
2. When the "Apply to all datasets in collection" checkbox is checked and the user clicks Compute, the component calls `computeAnnotationsWithWorkerBatch` on the annotation store instead of the normal `computeAnnotationsWithWorker`.
3. The batch action iterates over all datasets, submitting a separate worker job for each one. Workers pull their own context (dataset info, layers, etc.) so each job is self-contained.
4. RabbitMQ and the Girder Worker system handle concurrency on the backend. The frontend submits jobs sequentially (waiting for each to complete before submitting the next) to provide clear progress tracking.

### Key files

- **`src/components/AnnotationWorkerMenu.vue`** - UI component with batch checkbox, batch progress display, and cancel-all support.
- **`src/store/annotation.ts`** - Contains `computeAnnotationsWithWorkerBatch` (orchestrator) and `submitWorkerJobForDataset` (per-dataset job submission).
- **`src/store/AnnotationsAPI.ts`** - `computeAnnotationWithWorker` accepts `Pick<IDataset, "id">` so both single and batch paths can call it without type casting.
- **`src/store/model.ts`** - Defines `ProgressType.BATCH_ANNOTATION_COMPUTE` for the overall batch progress bar.

### Batch processing flow

```
AnnotationWorkerMenu.compute()
  -> if applyToAllDatasets:
       annotationStore.computeAnnotationsWithWorkerBatch()
         -> api.findDatasetViews({ configurationId })  // get all datasets
         -> api.batchResources({ folder: datasetIds })  // get dataset names
         -> for each dataset:
              submitWorkerJobForDataset()               // submit job
              await completionPromise                    // wait for it
              progress.complete(datasetProgressId)       // clear per-dataset progress
         -> fetchAnnotations()                           // refresh annotations
         -> loadLargeImages()                            // handle new large images
         -> onComplete callback
```

### Cancellation

When the user clicks "Cancel All" during batch processing:
1. The `isCancelled` flag is set to `true`.
2. All already-submitted jobs are cancelled via `api.cancelJob()`.
3. Remaining datasets in the loop are skipped (counted as cancelled).

## Dataset limit

There is a limit of 10 datasets for batch processing (`BATCH_DATASET_LIMIT = 10`). If the collection has more than 10 datasets, the checkbox is disabled with a tooltip explaining why. This limit exists to prevent accidental server overload and can be increased or removed later (marked with a TODO comment).

The batch checkbox is hidden when there is no configuration selected, the count is still loading, or the collection has only one dataset. It only shows as disabled (with tooltip) when the dataset count exceeds the limit.

## Job completion handling

After each per-dataset job completes, the per-dataset progress bar is cleared via `progress.complete(datasetProgressId)`. This happens in both success and error paths.

After the entire batch loop finishes:
1. The batch progress bar is completed.
2. `fetchAnnotations()` refreshes annotations for the currently viewed dataset.
3. `loadLargeImages(true)` checks for new large images created by the worker. If found, tile frames, max merge cache, and histogram cache are scheduled.
4. The `onComplete` callback notifies the UI with success/failure/cancellation counts.

This mirrors the single-job completion path in `computeAnnotationsWithWorker`.

## Race condition fix (jobs.getPromiseForJobId)

A key lesson learned: `jobs.addJob()` returns a completion promise, but fast-completing jobs can be removed from `jobInfoMap` before `jobs.getPromiseForJobId()` is called. The fix is to capture the promise at `addJob()` time and pass it back to the caller, rather than looking it up later from the map.

**Bad pattern:**
```typescript
jobs.addJob(computeJob);  // fire and forget
// ... later ...
const success = await jobs.getPromiseForJobId(job.jobId);  // may crash if job already finished
```

**Correct pattern:**
```typescript
const completionPromise = jobs.addJob(computeJob);  // capture promise immediately
// ... later ...
const success = await completionPromise;  // always safe
```

## Progress display

- **Overall batch progress**: A `v-progress-linear` bar showing `completed + failed + cancelled / total` datasets.
- **Per-dataset progress**: The existing single-job progress bar updates for each active job. Each per-dataset progress bar is cleared when its job finishes.
- **Status text**: Shows completed/failed/cancelled counts and the name of the currently processing dataset.
- The batch progress bar stays visible for 3 seconds after completion so users can see the final result.

## Error handling

- Errors on individual datasets do not stop the batch. The batch continues processing remaining datasets.
- Failed dataset count is tracked and displayed.
- Error details from individual jobs are accumulated and shown in the error display area.

## API type safety

The `computeAnnotationWithWorker` API method only uses `dataset.id`, so its parameter type is `Pick<IDataset, "id">` rather than the full `IDataset`. This allows the batch path to pass `{ id: datasetId }` directly without type casting, while the single-job path can still pass the full dataset object (since it satisfies the narrower type).
