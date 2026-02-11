# Batch Processing Patterns (Detailed)

Shared patterns used in both batch annotation compute and batch property compute.

## onCancel Callback Pattern

The cancel function must be provided to the caller **before** the dataset loop starts. Otherwise, `await`ing the batch would delay setting the cancel function until after the batch finishes:

```typescript
// In store action
@Action
async computeBatch({
  onCancel,
  onComplete,
}: {
  onCancel: (cancelFn: () => void) => void;
  onComplete: (results: IBatchResults) => void;
}) {
  let isCancelled = false;
  const submittedJobIds: string[] = [];

  // Provide cancel function IMMEDIATELY (before loop)
  onCancel(() => {
    isCancelled = true;
    for (const jobId of submittedJobIds) {
      api.cancelJob(jobId);
    }
  });

  // Dataset loop
  for (const dataset of datasets) {
    if (isCancelled) break;
    // ... submit job, await completion
  }
}
```

```typescript
// In component
async startBatch() {
  this.isBatchRunning = true;
  await store.computeBatch({
    onCancel: (cancelFn) => {
      // Wire up Cancel button immediately
      this.cancelBatch = cancelFn;
    },
    onComplete: (results) => {
      this.batchResults = results;
      this.isBatchRunning = false;
    },
  });
}
```

## Promise Capture Race Condition Fix

`jobs.addJob()` returns a completion promise, but fast-completing jobs can be removed from `jobInfoMap` before `getPromiseForJobId()` is called. **Always capture the promise at `addJob()` time:**

```typescript
// BAD - race condition if job finishes fast
jobs.addJob(computeJob);
// ... later ...
const success = await jobs.getPromiseForJobId(job.jobId);
// May crash if job already finished and was removed

// GOOD - capture promise immediately
const completionPromise = jobs.addJob(computeJob);
// ... later ...
const success = await completionPromise;  // always safe
```

## BATCH_DATASET_LIMIT

Both batch annotation and batch property compute share a limit of 10 datasets (`BATCH_DATASET_LIMIT = 10` in `model.ts`).

UI behavior:
- **Hidden** when: no configuration selected, count loading, or only 1 dataset
- **Disabled with tooltip** when: dataset count exceeds the limit
- **Enabled** when: 2-10 datasets in the collection

## Progress Display Pattern

Both batch features use the same progress structure:

```typescript
// Overall batch progress (v-progress-linear)
const batchProgressId = progress.add(
  ProgressType.BATCH_ANNOTATION_COMPUTE, // or BATCH_PROPERTY_COMPUTE
  `Processing ${total} datasets`,
  total
);

// Per-dataset progress (individual progress bars)
for (const dataset of datasets) {
  const datasetProgressId = progress.add(
    ProgressType.ANNOTATION_COMPUTE,
    `Processing ${dataset.name}`,
    100
  );

  // Submit and await job...

  progress.complete(datasetProgressId);  // Clear per-dataset
  progress.update(batchProgressId, completed);  // Update overall
}

progress.complete(batchProgressId);  // Clear overall
```

The batch progress bar stays visible for 3 seconds after completion so users can see the final result.

## Error Handling

Errors on individual datasets do NOT stop the batch:

```typescript
for (const dataset of datasets) {
  if (isCancelled) { cancelled++; continue; }
  try {
    await submitAndAwait(dataset);
    completed++;
  } catch (error) {
    failed++;
    errors.push(`${dataset.name}: ${error}`);
  } finally {
    progress.complete(datasetProgressId);
  }
}
```

## Reference Files

- Batch annotation compute: `codebaseDocumentation/BATCH_ANNOTATION_COMPUTE.md`
- Batch property compute: `codebaseDocumentation/BATCH_PROPERTY_COMPUTE.md`
