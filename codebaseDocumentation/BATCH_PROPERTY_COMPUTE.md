# Batch Property Compute

## Overview

Property computation can be configured to iterate over all datasets in a collection/configuration. This is managed through an "Apply to all datasets" checkbox in the `AnnotationProperties.vue` dialog, which submits individual property compute jobs for each dataset using the same property settings.

## Architecture

### How it works

1. The `AnnotationProperties` dialog fetches the count of datasets in the current configuration on mount (and whenever the configuration changes) using `findDatasetViews({ configurationId })`.
2. When the "Apply to all datasets" checkbox is checked and the user triggers a compute (via the play button, "Compute all", or "Compute upon creation"), child components emit `compute-property-batch` or `compute-properties-batch` events instead of calling `propertyStore.computeProperty()` directly.
3. The dialog handles these events by calling `propertyStore.computePropertyBatch()`, which iterates over all datasets and submits a separate compute job for each one.
4. Jobs are submitted sequentially (waiting for each to complete before submitting the next) to provide clear progress tracking.

### Key files

- **`src/components/AnnotationBrowser/AnnotationProperties.vue`** - Dialog with batch checkbox, batch progress display, cancel-all support, and event handling.
- **`src/components/AnalyzePanel.vue`** - Passes `applyToAllDatasets` prop through to children and forwards batch events.
- **`src/components/AnnotationBrowser/AnnotationProperties/Property.vue`** - Individual property play button; emits `compute-property-batch` in batch mode.
- **`src/components/AnnotationBrowser/AnnotationProperties/PropertyList.vue`** - "Compute all" button; emits `compute-properties-batch` in batch mode. Forwards `compute-property-batch` from children.
- **`src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue`** - "Compute upon creation"; emits `compute-property-batch` in batch mode.
- **`src/store/properties.ts`** - Contains `computePropertyBatch()` action that orchestrates the batch loop.
- **`src/store/model.ts`** - Defines `ProgressType.BATCH_PROPERTY_COMPUTE` for the overall batch progress bar.

### Component hierarchy and event flow

```
AnnotationProperties.vue  (dialog with checkbox + batch progress + Close button)
  └─ AnalyzePanel.vue      (passes applyToAllDatasets prop, forwards events)
       ├─ PropertyCreation.vue  (emits compute-property-batch event)
       └─ PropertyList.vue      (forwards compute-property-batch from children)
            └─ Property.vue     (emits compute-property-batch event)
```

### Batch processing flow

```
AnnotationProperties.onComputePropertyBatch(property)
  -> propertyStore.computePropertyBatch()
       -> api.findDatasetViews({ configurationId })  // get all datasets
       -> api.batchResources({ folder: datasetIds })  // get dataset names
       -> for each dataset:
            propertiesAPI.computeProperty()            // submit job
            jobs.addJob(computeJob)                    // track job
            await completionPromise                    // wait for it
            progress.complete(datasetProgressId)       // clear per-dataset progress
       -> fetchPropertyValues()                        // refresh property values
       -> filters.updateHistograms()                   // refresh histograms
       -> onComplete callback
```

### Three call sites that trigger batch

1. **Property.vue** `compute()` - Individual play button on each property
2. **PropertyList.vue** `computeUncomputedProperties()` - "Compute all" button
3. **PropertyCreation.vue** `createProperty()` - Compute upon creation checkbox

### Cancellation

The cancel function is provided to the caller via an `onCancel` callback that fires immediately when the batch action starts (before the dataset loop). This ensures the "Cancel All" button is wired up right away, avoiding a timing issue where `await`ing the full batch would delay setting the cancel function until after the batch finishes. The same pattern is used in `computeAnnotationsWithWorkerBatch`.

When the user clicks "Cancel All" during batch processing:
1. The `isCancelled` flag is set to `true`.
2. All already-submitted jobs are cancelled via `api.cancelJob()`.
3. Remaining datasets in the loop are skipped (counted as cancelled).

## Dataset limit

There is a limit of 10 datasets for batch processing (`BATCH_DATASET_LIMIT = 10`). If the collection has more than 10 datasets, the checkbox is disabled with a tooltip explaining why. This limit exists to prevent accidental server overload and can be increased or removed later.

The batch checkbox is hidden when there is no configuration selected, the count is still loading, or the collection has only one dataset. It only shows as disabled (with tooltip) when the dataset count exceeds the limit.

## "Compute all" in batch mode

When the user clicks "Compute all" with batch mode enabled, `PropertyList` emits a `compute-properties-batch` event with the array of uncomputed properties. `AnnotationProperties.onComputePropertiesBatch()` runs batch for each property sequentially (awaiting each `computePropertyBatch()` before starting the next).

## Job completion handling

After each per-dataset job completes, the per-dataset progress bar is cleared via `progress.complete(datasetProgressId)`. This happens in both success and error paths.

After the entire batch loop finishes:
1. The batch progress bar is completed.
2. `fetchPropertyValues()` refreshes property values for the currently viewed dataset.
3. `filters.updateHistograms()` refreshes histograms.
4. The property status is updated (running: false, previousRun based on results).
5. The `onComplete` callback notifies the UI.

## Race condition fix

Following the same pattern as batch annotation compute: the completion promise from `jobs.addJob()` is captured immediately and awaited, rather than looked up later from the job map.

```typescript
const completionPromise = jobs.addJob(computeJob);  // capture promise immediately
const success = await completionPromise;              // always safe
```

## Progress display

- **Overall batch progress**: A `v-progress-linear` bar showing `completed + failed + cancelled / total` datasets.
- **Per-dataset progress**: Individual progress bars appear in the progress module for each active job.
- **Status text**: Shows completed/failed/cancelled counts and the name of the currently processing dataset.
- The batch progress bar stays visible for 3 seconds after completion so users can see the final result.

## Error handling

- Errors on individual datasets do not stop the batch. The batch continues processing remaining datasets.
- Failed dataset count is tracked and displayed.
- The property status reflects the overall result (success only if at least one succeeded and none failed).
