# Implicit state machines in the UI

An audit (2026-11-10) of places where a small set of mutually exclusive states
(idle / running / failed, wizard steps, interaction modes) is encoded as several
independent booleans, nullable refs, timers or "is X non-null" checks instead of
one explicit state value, with transitions scattered across handlers.

Line numbers refer to the tree at the time of the audit (master at `70f82cbb`).
Every finding comes from reading the code. "Verified" means the path was traced
end to end; "suspicion" means the code allows it but the trigger was not traced.

## The four recurring shapes

Almost every finding below is one of these. Check for them when adding any
flag that tracks "what is this component doing right now".

1. **Reset after an `await`, with no `try/finally`.** The flag is set, something
   is awaited, and the reset is the next statement. A rejection skips the reset
   and the UI is stuck (spinner forever, button disabled or dead).
2. **A boolean where concurrent requests need a count or a token.** Two
   overlapping requests share one `loading` flag; the first to finish clears it
   while the other is in flight, or an older response overwrites a newer one.
3. **One question answered from several sources.** "Is this property
   computing", "is this a quick import", "which tool is armed" each have two or
   three independent answers that drift.
4. **Partial reset.** A reset function clears some of the variables that
   jointly encode the state, or two reset functions clear different subsets.

Patterns already in the codebase that get this right, to copy:

- `src/components/ConnectedAppsSection.vue`: explicit `status` union plus a
  `loadToken` for latest-wins.
- `src/components/ShareDataset.vue`: `dialogGeneration` / `claimDialog`, one
  `resetDatasetState`, shared pending registries.
- `IObjectSegmentationStatus.phase` and `TLayerMode` in `src/store/model.ts`.
- The `datasetViewNavigation` token in `setDatasetViewId` (`src/store/index.ts`).
- `ensureVisiblePropertyValues` in `src/store/properties.ts`: the sequence token
  is claimed before any early return.

## Tier 1: a concrete path leaves the UI stuck or wrong

### J1. Job completion tracking (`src/store/jobs.ts`)

- **Encoded as:** `notificationSource` (116) and its `readyState`,
  `connectionErrors` (123), `jobInfoMap[jobId]` presence (121) with its
  `successPromise`, `messageStore`, `latestNotificationTime`.
- **Real states:** stream closed / connecting / open / retrying / given up;
  job unknown-buffered / tracked-running / settled.
- **Problems (verified):**
  - A job's promise resolves only on a terminal WebSocket event (388). The
    give-up path (404-410) closes the socket and leaves every `jobInfoMap`
    entry pending forever.
  - No `onclose` handler (431-433), so a clean server close never reconnects
    until the next `addJob`, and a terminal event missed in the gap is lost.
  - `connectionErrors` resets only in `handleOpen`, so after a give-up the
    next single error gives up again.
  - Everything downstream hangs on that promise: `AnnotationWorkerMenu.running`,
    `propertyStatuses[id].running`, the pipeline lock (`pipelines.ts:751`),
    progress entries.
  - Precedent for the fix: `supplyMissedJobEnd` (`index.ts:462-493`) reads the
    job when the stream misses an end, but only for transcodes;
    `agent/executors.ts:1287-1321` polls `fetchJobStatus`.
- **Direction:** reconcile tracked jobs by fetching their status on reconnect,
  on close and on give-up; settle the promise from that.

### J2. Worker tool run (`src/components/AnnotationWorkerMenu.vue`)

- **Encoded as:** `fetchingWorkerInterface` (279), `running` (280),
  `currentJob`, `previousRunStatus`, `progressInfo`, `errorInfo`,
  `batchProgress`, `batchCancelFunction`, a 3 s timer (479); in the store,
  `jobs.jobIdForToolId` (since removed; the dataset-scoped
  `jobIdForToolInDataset` is the one answer) and `jobs.toolJobOutcomes` answer the same question.
- **Problems (verified):**
  - `compute()` sets `running = true` (422) and awaits with no `try/finally`.
    In `computeAnnotationsWithWorker` (`annotation.ts:2358-2377`) a failed POST
    rejects before the callback runs: spinner forever, Cancel disabled.
  - The post-job `.then` (`annotation.ts:2405-2423`) has no catch.
  - `computeBatch` (458) has the same shape; several awaits in
    `computeAnnotationsWithWorkerBatch` sit outside any `try`.
  - Line 559-562 is `await fetch(...).finally()` with an empty `finally`; a
    rejection leaves `fetchingWorkerInterface` true and blocks every reload.
  - State belongs to the component instance, not the tool: `Toolset.vue:149-153`
    mounts one un-keyed instance, so switching tools mid-run shows tool A's
    `running`, log and Cancel under tool B, and remounting offers Compute while
    the job is still running.
  - The 3 s timer is never cancelled, so a batch started within 3 s loses its
    progress display.

### J3. Pipeline run (`src/store/pipelines.ts`, `src/components/pipelines/usePipelineRun.ts`)

- **Encoded as:** `runningPipelineId` (182) plus closure-local `isCancelled` /
  `currentJob`; in the controller `activePipelineId`, `stepStatuses`, `result`,
  `lastRunWasBatch`, `batchProgress`, `runNotice`, `cancelFn`,
  `cancelledByUser`, a 3 s timer (292).
- **Problems (verified):**
  - A single run takes the lock before any await (544-548). `runPipelineBatch`
    awaits `findDatasetViews` (1007) and `batchResources` (1033) first and locks
    at 1039. In that window Run is enabled; a second click starts a second run
    and nulls the first run's `cancelFn`.
  - Those two awaits are outside the `try` (1059).
  - Cancelled-versus-failed is tracked twice (`isCancelled` in the store,
    `cancelledByUser` in the controller).
  - ~~`lastRunWasBatch` is set (205) before the batch branch is certain
    (208).~~ Refuted during the fix pass: `canApplyToAllDatasets` already
    requires a selected configuration, so the flag and the branch cannot
    disagree.
  - The 3 s timer is never cancelled.
  - `IPipelineStepRunStatus` (`pipelines.ts:56`) is unused; the controller
    redeclares it as `TStepStatus`.

### J4. New dataset pipeline (`src/views/dataset/NewDataset.vue`)

- **Encoded as:** `uploading` (536), `configuring` (532), `creatingView` (533),
  `hideUploader`, `dataset != null`, `pipelineError` (550), `processingError`,
  `failedDataset`, `showBatchErrorDialog`, and `path` (both the chosen location
  and the upload destination).
- **Real states:** selecting → creating dataset → uploading → configuring →
  creating view → done, with an error exit from each; batch mode loops.
- **Problems (verified):**
  - `pipelineError` is terminal: its only reset is 1073 (batch skip). The
    template re-enables the form when it is set, but the Upload button's
    `:disabled` ignores it and `submit()` aborts on it (867-870), so Upload is
    enabled and does nothing.
  - Error paths that set `pipelineError` and leave the phase flag on:
    `configureDataset` (1158-1164), `handleCollectionGenerationDone(null)`
    (1183-1187), `createView(null)` (1225-1229) all leave `configuring` true;
    `createView` (1248-1258) leaves `creatingView` true.
  - Line 1165 awaits the child's init with no `try/catch`; a rejection leaves
    `configuring` true with no error shown.
  - `interruptedUpload` (1119-1122) clears `uploading` but not `dataset` or
    `path`; `path` was repointed at the new folder (913), so pressing Upload
    again creates a second dataset inside the first.
  - `advanceToNextDataset` (984-999) is a partial reset: not `uploading`,
    `creatingView`, `failedDataset` or `progressStatusText`.
  - `submitSingleDataset` (925-948) is a dead duplicate of `submit`.

### J5. Upload workflow mode (`NewDataset.vue`, `store.uploadWorkflow`)

- **Problems (verified unless noted):**
  - The `newdataset` route passes only `route.params`, so `props.quickupload`
    is always false there. The template reads the raw prop at lines 3, 17, 59,
    69 and the store-aware `isQuickImport` at 108, 139, 235, so the two always
    disagree on the routed path.
  - `completeUploadWorkflow` is called only from batch paths (1006, 1052).
    After a single import `active` stays true with the old `fileGroups`.
    Traced consequences (not reproduced): Back to `#/…/new` auto-submits a
    duplicate; `AddDatasetToCollection.vue` embeds `<new-dataset>` and inherits
    the stale store.
  - The prop-only batch branch reads a local `currentDatasetIndex` (560) that
    nothing writes.

### J6. Multi-source init (`src/views/dataset/MultiSourceConfiguration.vue`)

- **Encoded as:** `initializing` (732), `initialized`, module-level
  `reinitializeFlag`, `initError`, init counters, metadata null-ness.
- **Problems (verified):**
  - `initialize()` (1468-1479) has no `try/finally`. "Init failed" is encoded
    as `initializing === true && initError !== null`, and the template relies
    on it (170-224). Later `initialize()` calls hit the re-entrancy guard and
    never run; `reinitializeAndApplyStrategy` busy-waits on `initializing`
    (2001-2003) forever, which hangs a batch upload.
  - Failure is reported on two channels: `generationError`, then an
    unconditional `generatedJson(null)` (1713).
  - `reinitializeAndApplyStrategy` and the `initialize()` loop reset different
    subsets.

### J7. Dataset and view load lifecycle (`src/store/index.ts`, `src/store/sync.ts`)

- **Encoded as:** `selectedDatasetId`, `dataset`, `selectedConfigurationId`,
  `configuration`, `datasetView`, `sync.datasetLoading`, the module-level
  `datasetViewNavigation` token, `unrollXY/Z/T` versus `datasetUnroll`.
- **Problems (verified by the audit, not independently re-read):**
  - The latest-wins token only guards `setDatasetViewId` (2459-2573).
    `setSelectedDataset` (2354-2427) and `setSelectedConfiguration` (2429-2456)
    write the same state with no token, so an overtaken navigation can land
    last: `dataset = X` with `datasetView` pointing at Y.
  - Whichever load finishes first clears `datasetLoading` (2415) while another
    is in flight; ImageViewer gates drawing on that flag.
  - `loggedOut` (1653-1661) nulls `dataset` and `configuration` but not
    `datasetView`, `currentLargeImage` or `selectedTool`.
  - `loggedIn` (1603-1604) loads, then `login` / `initialize` load again.

### J8. Server sync indicator (`src/store/sync.ts`, `src/components/ServerStatus.vue`)

- **Problems (verified):** `lastError` is never cleared, so one failed request
  shows the error icon at every idle moment until reload. `loading` and
  `saving` are booleans written from about 40 call sites; concurrent requests
  clear each other's indicator.

### J9. Alt-drag move (`src/components/AnnotationViewer.vue`)

- **Encoded as:** `isDragging`, `dragStartPosition`, `draggedAnnotation`,
  `dragGhostAnnotation`, `dragOriginalCoordinates` (275-282, 310).
- **Real states:** idle → dragging → saving → idle; "saving" has no
  representation.
- **Problems (verified):** `handleDragEnd` awaits the save (4902) before the
  reset (4913-4918), with no `try/finally`: a failed save leaves the ghost and
  `isDragging`. A second alt-mousedown during the await overwrites the refs and
  orphans a ghost. A null ghost from the factory (4852) leaves `isDragging`
  true forever. No reset on layer swap, unmount or tool change.

### J10. Shift-capture gesture (`src/components/ImageViewer.vue`)

- **Encoded as:** `mouseState` (448) plus `isMouseMovePreviewState`; the commit
  is inferred in `AnnotationViewer.onMousePathChanged` (4398-4411) from the
  watcher's old/new pair.
- **Problems (verified):** no pointer capture and no window-level mouseup;
  `mouseLeave` (1141) ignores the capturing state. Releasing outside the map
  leaves capture on. On re-entry `mouseMove` never checks `evt.buttons`, keeps
  appending and stops propagation (pan and hover dead), and the next mouseup
  commits a spurious lasso, SAM prompt or segmentation example. There is no
  cancel transition: every capturing → null is a commit.

## Tier 2: real, lower impact or narrower trigger

### K1. Property compute status (`src/store/properties.ts`, `AnalyzeDialog.vue`)

Three sources for "is this property computing": `propertyStatuses[id].running`
(UI runs only), `jobs.jobIdForPropertyId` (since removed for the
dataset-scoped `jobIdForPropertyInDataset`), and the pipeline check.
`computePropertyBatch` sets `running` at 1172 after three awaits, with no
`try/finally`; `onComputePropertyBatch` has no in-flight guard, so a second
batch overwrites `batchCancelFunction`. `running` is a boolean, not a count.

### K2. Import dialog (`src/components/AnnotationBrowser/AnnotationImport.vue`)

`submit()` (310) guards on `isJsonLoaded` and `isOverwriteBlocked` but not
`isImporting`, and the button is not disabled while importing: a double click
runs two imports (two delete-and-inserts with overwrite on). No sequence guard
on file parsing (261-285). Closing the dialog does not reset the overwrite
flags. An import failure is only logged.

### K3. Interaction mode (`AnnotationViewer.vue`)

The armed GeoJS mode is recomputed imperatively in `setNewAnnotationMode`
(3685-3811) from five inputs, triggered from six places. ROI-draw has no exit:
`watchFilter` refreshes only when `roiFilter` becomes truthy (4173-4177) and
`cancelROISelection` (`filters.ts:359`) has no callers, so clearing the empty
ROI filter leaves the layer in polygon mode with no tool. The tagging click
handler was bound only if a tagging tool was selected at bind time (4530-4532);
on closer reading it was redundant with the state-event path and tagged the
same click twice, so the fix removed it.
`addAnnotationFromSnapping` re-reads the selected tool after an await (3313).

### K4. Two-click tools (`AnnotationViewer.vue`)

`selectedTool.state.selectedAnnotationId` is read and written through `as any`
(3090-3155, 3193-3229). Combine has no in-flight state: a click during the
await at 3212 starts a second combine. Line 3223 writes to the tool state after
the await without re-checking that the tool is still selected.

### K5. Line scan (`AnnotationViewer.vue`, `src/store/lineScan.ts`)

"Segment start placed" is stored three ways (local ref, `segmentStartPlaced`,
`points.length === 1`). Switching between line-scan tools (5266-5276) clears
the start but not `points` or the preview. One viewer unmounting clears the
shared store (5459-5460).

### K6. View lock (`ImageViewer.vue`)

`toggleViewLock` (2201-2223) only touches maps that exist at toggle time;
`_setupMap` never consults `isViewLocked`, so after a dataset change the icon
says locked while the map pans freely.

### K7. SAM prompt session (`src/pipelines/samPipeline.ts`, `SamToolMenu.vue`)

The prompt list lives in a `markRaw` node, so `samPrompts` and `prompts`
computeds do not update, while `consumeMouseState` reads the node directly.
Runtime errors leave `NoOutput`, identical to "no prompts". `submit()` resets
prompts even when coordinates are null.

### K8. Snapshots panel (`src/components/Snapshots.vue`)

One `downloading` boolean (797) covers three flows with different rules:
`handleMovieDownload` (2525-2570) has no entry guard and never touches
`downloadError`. Movie capture steps `store.setTime` per frame (2450) with no
cancel and no restore. The bounding-box overlay is encoded as
`bboxLayer != null` and can point at a layer on a destroyed map.

### K9. AI panel run loop (`src/store/aiPanel.ts`)

Well guarded overall. Gaps: after a forced clear mid-run, `executeToolUse`
pushes a tool card (584-591) before its `stopRequested` check and with no
generation check; the clear nulls `turnSnapshot`, which switches off every
`turnSnapshot && …` identity guard; `sendUserMessage` returns silently while
`hydrating` (401) after the input was already cleared.

### K10. Session identity (`src/store/index.ts`)

`girderUser`, `hasUserLoggedOut`, `authRestored`, `shareLinkSession`.
`isLoggedIn` is true for a share-link bearer and each caller excludes that
case separately (`OAuthConsent.vue:128` and `UserMenu.vue:127` do;
`App.vue:800` and `App.vue:207` do not). `authRestored` is set from five
places, each with a "would spin forever" comment.

### K11. Analysis gate resolution (`src/store/filters.ts`)

`analysisLoading` can stick true: the above-cap path sets it (1313) and, if
superseded, returns without clearing it (1325-1328), while a newer refresh
that finds nothing stale returns early (1272-1291) without touching it. The
chained/pure mode is spread across `analysisGateIdsArePure` and which
signature field is non-null.

### K12. Home upload name validation (`src/views/Home.vue`)

`nameTaken`, `checkingName`, `nameError`, `batchMode`, `nameConflicts`,
`validatingNames`, a debounce timer. No latest-wins token in the `datasetName`
watcher (1217-1256). Switching mode leaves the other mode's verdict live. A
location change clears `nameTaken` without re-checking. `validateDatasetNames`
calls `checkDatasetNameExists` in a loop (790).

### K13. ShareProject confirm (`src/components/ShareProject.vue`)

`executeConfirmedAction` (373-379) nulls `pendingAction` after the await, so a
second confirm opened meanwhile is silently dropped. `userLoading` holds one
id. `resetState` (324-334) does not reset the loading flags or pending action.
`ShareDataset.vue` already solves all three.

### K14. Smaller ones

- **`useRouteMapper`** (`src/utils/useRouteMapper.ts`): two global counters
  stand in for a sync direction; a store → URL write skipped during a route
  change is dropped, not replayed (256, 274).
- **Layer readiness** (`ImageViewer.vue:402, 2190-2198`): one-shot `onIdle`
  closures capture an index with no generation token.
- **Object segmentation status**: `progress` and `error` sit beside the
  explicit `phase` and can disagree with it.
- **Object Browser open state** is mirrored in `App.vue:765` and
  `store.isAnnotationPanelOpen`; embed mode leaves them out of sync.
- **`JobsLogs.vue:218-241`**: no sequence guard on `viewJobLog`.
- **`FileManagerOptions.vue`**: "awaiting confirmation" is a non-null resolver;
  dismissing the dialog never resolves it.

## Looked at and fine

`ConnectedAppsSection`, `ShareDataset`, `ProjectList`, `ZenodoTokenDialog`,
`ZenodoPublish` (guarded by hand at three sites, no invalid path found),
`CustomFileManager`, the pending-annotation submit closure in
`store/annotation.ts`, the annotation overview load states in `ImageViewer`,
`VolumeViewer` build serial, `MontageView`, the `AnalysisPanel` histogram
queue, `ValueSlider` drag (every exit resets all three variables), the welcome
tour, `layerMode`, `selectedTool.state`, `PipelineEditor`, `PipelineList`,
`AnnotationCSVDialog`, `AnnotationExport`, `PropertyBody`.

Dead flags noticed along the way: `snapshotPanelFull` (`App.vue:764`),
`store.isHelpPanelOpen`, `annotationPanelBadge`, `isProcessing` in
`AnnotationCSVDialog.vue`.

## Fix status

Fixed on the branch that added this document: J1-J10, K1-K9, K11-K14, and the
items the first pass left open (logout reset, large-image stale guard, one
init reset in multi-source, batch state outliving its component, line scan
ownership across viewers, visible SAM failures, a way out of a pending ROI
selection). Each fix has a test that fails without it.

Still open:

- **K10 session identity.** Whether a share-link bearer counts as "logged in"
  for the AI panel and upload is a product decision.
- **No batch endpoint** exists for job status by id or for dataset-name
  checks, so job reconciliation and batch name validation issue one request
  per item. Backend work.
- **Worker menu per-job detail** (progress title, last outcome mark) is still
  component state: a menu remounted mid-batch shows the batch, its progress
  and Cancel All, but not those.
- **`propertyStatuses[id].running` is per property, not per dataset.** A run
  on one dataset shows the Run spinner for that property on another dataset
  of the same collection, and refuses a second start there. The store's rule
  is one run of a property at a time, so this is the current design; the job
  lookup is dataset-scoped. When such a run finishes it refreshes values for
  whichever dataset is open at that moment.
- **Breadcrumbs** clear the owner and collection names before their
  "nothing changed" skip, so a query-only URL change (a location write)
  blanks them without refilling. Predates the branch.
- **A load failure in "add dataset to collection"** shows its error but has
  no retry control; the user switches the radio or closes the dialog.
- **A canceled max-merge job** leaves its progress entry up
  (`progress.trackMaxMergeJob` treats only success and error as terminal).
- **Tours** pull every navigation back to the current step's route while a
  tour is open. That is how tours work; it surprised the live pass.
- **A canceled worker job can still write its annotations** if it had already
  produced them. Worker and backend, not UI state.
- **An upload's transcoding job retired at logout** reports "the transcoding
  job failed" to the sync indicator after the logout.
- **A worker's own error and warning lines** are written into the kept
  status while a run is in flight, so they show on another dataset of the
  collection until the run ends. Only the end outcome is scoped.
- **State that outlives the login session** (also on master). Store modules
  and module-level variables live as long as the page, and `logout()` resets
  them one by one. Not reset today:
  - `progress.ts` notifications: a sticky "Job Failed" or worker error toast
    of the previous account is shown to the next one.
  - `girderResources.ts` resource cache: a cached private collection renders
    on `#/configuration/<id>` for the next person at the tab with no
    request. (Datasets and views are fetched fresh and refused.)
  - `projects.ts`: a cached private project renders on `#/project/<id>`.
  - `datasetMetadataImport.ts`: an abandoned Zenodo import's annotations and
    collection file are applied to the next upload in the tab (reachable
    without a logout too; nothing calls `clearAllFiles`).
  - `progress.trackHistogramJob` / `trackMaxMergeJob` create their entry and
    then return without completing it when the dataset is gone.

  The fix that closes the class is a full page reload at logout; a per-store
  reset fixes each item but cannot show that the list is complete. Not
  decided.
- **Transitions the upload page does not own** (also on master, all narrow):
  the uploader's "Clear all" during dataset creation starts an upload of no
  files; `MultiSourceConfiguration`'s Submit is clickable again while the
  page finalizes a batch's first dataset; "Skip and Continue" and "Add
  dataset" have no double-click guard.
- **The AI run loop's `catch`** has no generation check, so a request that
  fails after a forced clear adds its error to the new conversation.

## Live verification (2026-11-10)

Run against the local Girder from this branch's dev server, as the local test
admin, in a visible tab. Writes to real datasets were replaced by stubbed API
methods; real writes went only to a scratch dataset created for the pass.
Drags and map clicks were synthetic mouse events; buttons were real clicks.

First pass:

- **J7** five view switches inside 100 ms, twice: the last one wins, dataset,
  view and configuration agree, the loading overlay clears. A fresh page load
  fetches the dataset folder and the configuration once each.
- **J8** two overlapping saves keep "saving" on until the second ends; a
  rejected save shows its error; the next success clears it.
- **J9** alt-drag with a rejected save resets and the next drag works; a real
  drag persisted to the server with one request.
- **J10** shift-lasso released over the map, over the toolbar and outside the
  window selects; window blur and a missed release cancel.
- **K6** view lock holds across a dataset switch and on maps created by
  unrolling; unlock restores navigation.
- **J1** a tracked job whose event was missed settles on reconnect from one
  status request; the error count returns to zero after a stable open.
- **J2** Compute double-clicked with a rejected submit: one request, run state
  cleared, failure shown on the button.
- **K1** "Compute all" double-clicked with a rejected submit: one request, and
  the dialog returns to "Compute all".
- **J4 / J5 / J6** quick import of a TIFF ends in the viewer with the workflow
  closed. A file the server never registers as a large image ends in a
  visible error, and leaving the page closes the workflow.
- **K2** Import double-clicked: four annotations imported once, dialog closed.

Second pass, after the remaining fixes:

- **J9** a drag released over the toolbar, and a window blur mid-drag, remove
  the ghost at once and save nothing; a normal release still saves once.
- **J7** the view document is fetched once on navigation.
- **Line scan (K5)** segment and freehand scans draw, plot from `raw_region`
  and complete; switching tools with a complete line or a half-placed segment
  clears it; deselecting the tool clears the state and hides the panel.
- **Pipelines (J3)** a one-step pipeline on the scratch dataset with the
  local random-squares worker: Run double-clicked submits one job, its
  annotations arrive, the lock releases; a rejected submit reports one failed
  step and releases; Cancel during a pending submit cancels the job, reports
  one cancelled step and releases.
- **Snapshots movie (K8)** on a 145-frame time-lapse, with annotations:
  Download Movie double-clicked produces one ZIP, steps through the frames,
  returns to the starting time point and clears its busy state.
- **AI panel (K9)** Enter pressed twice sends one message; a tool call moves
  the viewer; Stop mid-run ends the run before the next tool executes and
  leaves the panel usable.

Found live and fixed:

- The property status object. On a property's first run in a session the
  store wrote `running` to the raw object, so the spinner stayed after a
  rejected submit. Predates the branch.
- A lost alt-drag release left the ghost until the next mouse press.
- `addJob` on an open stream did not read the job's status.
- A failed quick import still said "in Progress" and offered only a disabled
  Upload button.
- A file the server cannot open as an image reported "item(s) not ready".
- The view document was fetched twice on a fresh page load.
- A rejected worker submit reached the pipeline log as vuex-module-decorators'
  generic `ERR_ACTION_ACCESS_UNDEFINED` text instead of the reason.
- A finished pipeline's result banner stayed after switching to a dataset
  whose configuration has no such pipeline.
- The run banner shifted the pipeline list down, so the second click of a
  double-click on Run landed on "New pipeline".

Third pass, on the code after the review fixes: logout from a loaded viewer
resets view, dataset, tool, large image, recents and annotations with no
load or save left in flight; six quick view switches end on the last one
with no uncaught overview errors; the pipeline list does not move when the
run banner appears, and the banner is gone after switching to another
configuration; a failed quick import reads "Quick Import Failed", names the
unreadable file, "Try again" (clicked twice) reads the files once more
without creating a second dataset, and "Back to home" closes the workflow.

That pass also found the last bug: from view S, opening view T and going
back to S within about 10 ms ended on T. The route mapper skipped the
return to S because the store still held S, and T's load, still fetching
its view, then won. Master does the same. The first fix asked the store
"is any navigation fetching its view?", and the second review showed that
was too wide: a switch started by a snapshot or the breadcrumbs leaves the
URL on the old view until it lands, so any URL write in that window (a z or
time change) would have re-set the old view and cancelled the switch. The
route mapper now tracks only its own `set` calls still in flight
(`pendingSets` in `useRouteMapper.ts`). Live: go-back ends on S in three of
three trials (5 to 20 ms), and a store-driven switch right after a time
change still lands.

Not exercised live (unit tests only): batch upload and its skip dialog,
ShareProject, SAM, combine, tagging and ROI tools, multi-viewer line scan
(a line cannot be drawn while unrolled).

A second independent review, of the review fixes only, with mutation
testing on a copy of the tree: one regression in the newest fix (the
navigation hook above, reworked before commit), stale "already computing"
alerts after a run, and nine fixes with no test that failed without them.
It also surfaced two older gaps the branch's doc had papered over: property
run state was wiped by every dataset switch, and a multi-property batch
followed the user into another collection. All fixed, with tests.

A Codex CLI review of the committed branch found four more, all consequences
of this branch's own fixes: keying the worker menu by tool lost the only
record of a submission in flight (a duplicate run); keeping in-flight
property statuses across navigation also kept them across logout; Cancel
preferred a finished job the menu still remembered over the run in flight;
and the movie capture restored its time point into whichever view was open.
All fixed, with tests.

Checking those four live (2026-11-12) confirmed three and showed the fourth
was understated. Codex assumed a navigation makes the capture reject; live,
the old map kept answering, so the loop carried on calling `setTime` in the
new view for every remaining frame. The loop now stops when its view is no
longer current. Note for next time: the Browser pane was not displayed, so
`requestAnimationFrame` never fired and the capture hung until it was
replaced with a timer before the capture started; the checks were driven
with scripted clicks for the same reason.

A second pass the same day, in a visible Chrome tab with real clicks and
real animation frames, confirmed all four again (the Cancel check against a
real 60,000-square job, canceled 1.6 s in). It found one more bug, also on
master: logging out with the Snapshots panel open threw in the panel's
close watcher (`setBoundingBox` read the dataset the logout had just
cleared), the throw landed in the app's render, and the viewer stayed on
screen under a logged-out header. It also showed an open item live: the
canceled job still wrote 1,278 annotations.

A second Codex CLI pass over the whole branch found one P2, the twin of the
property run lock above: tracked jobs are looked up by dataset and tool
alone and were not dropped at logout, so on a shared dataset the previous
account's job held the next account's tool "running" for as long as its
status could not be read. Logout now retires every tracked job
(`retireTrackedJobs` in `jobs.ts`). The sweep after the first finding
cleared the property statuses and missed the job map they are derived
beside: "dropped at logout" has to be checked per store, not per symptom.

A third Codex CLI pass found two P2s, both consequences of earlier fixes on
this branch. Retiring tracked jobs at logout settles each one as not
successful, and the "apply to all" loops (worker tool and property) took
that for a failed dataset and submitted the next one after logout; they now
check `sessionEndedSignal` (`batchRuns.ts`) and count the rest as cancelled.
Pipelines already stop there, because logout clears the configuration they
check. And a property status kept across navigation showed dataset A's
failed run on dataset B of the same collection; a run that ends on another
dataset now releases the lock without recording an outcome.

A fourth round (Codex CLI, and an independent regression pass over the fix
commits) found more of the same: every waiter on a tracked job's promise had
to be read after logout began settling it.

- `addJob` awaited the status read it starts for a job added on an open
  stream, so a slow read held back an outcome the stream had already
  delivered (Codex). The read is no longer awaited.
- A single property run that logout ended raised a persistent "Property
  computation failed" toast for a job still running server-side. Runs,
  pipelines and the tool outcome icon now check `sessionEndedSignal` before
  reporting, writing the configuration or recording an outcome.
- The dataset check of the previous round read `main.dataset`, which is the
  dataset being left until the next one has loaded. It reads
  `shownDatasetId` (`store/index.ts`) now.
- Movie capture compared view ids only; leaving and returning to the same
  view replaces the map, and the loop went on capturing from the old one.

A fifth Codex CLI pass found one P2 in the first commit's upload flow, not
in a later fix: the Girder uploader shows its own "Resume Upload" button
beside an upload error, and that button calls the uploader's `startUpload`
directly, past the parent's `submit()`. The resumed upload ran with
`failedPhase` still set, so the import went on under "Quick Import Failed"
and a later failure was recorded as the upload's. `NewDataset.vue` now
follows the uploader's `uploading` flag into its own phase.

After five rounds that each found one more instance, the findings were
reduced to three causes and the whole branch was swept for each by two
fresh-context reviewers, every report checked against the code:

1. **State outlives the login session**, and logout resets it piecemeal.
   Every store and module-level variable was listed with a verdict, and
   every waiter on a tracked job was read for what it does once logout
   settles the job. The waiters are all guarded; the stores still not reset
   are on master too and are listed under "Still open".
2. **A transition the machine's owner did not write**: a child component's
   own button, an exposed method, a dismissal, a second instance. Three
   fixed here: a late error from a superseded upload attempt labeled a
   finished upload as failed (`nextStep` now drops an upload failure); a
   failed folder read after dataset creation set `path` to null, which
   unmounted the uploader and left Upload enabled with nothing to do
   (`enterDatasetFolder`); and Cancel All pressed during a property batch's
   closing refresh cancelled nothing and so did not stop the remaining
   properties (`runBatch` reports `cancelRequested`).
3. **A newly added `await` its callers did not expect.** Every function that
   gained one on the branch was read with its callers; none remains.

A sixth Codex CLI pass then found the one session-end case this document
had listed as open: a worker or property submission still unanswered when
logout retires the tracked jobs was tracked afterwards, and held the tool
"running" for the next account. Every submit site in `annotation.ts` and
`properties.ts` now tracks through `trackJob`, which checks the session the
submission started in.

Independent review of the whole diff (three fresh-context reviewers, one per
area) found no High findings and one Medium, the import dialog's file spinner
sticking after an invalid file (a regression from this branch's own parse
token). That and the Low findings are fixed; each has a checklist line below.

## Regression checklist

Change any of the code below, re-check these.

### Jobs, workers, properties

- A tracked job settles from its server status when the notification stream
  gives up: *"settles a tracked job from its server status when the stream gives up"*
- A clean socket close reconnects and settles what finished meanwhile:
  *"reconnects on a clean close and settles a job that finished meanwhile"*
- Events from a replaced socket are ignored (compare with `toRaw`; state holds
  a proxy): *"ignores the close of a socket it already replaced"*
- Giving up does not poison the next subscription:
  *"gives a later subscription fresh attempts after giving up"*
- A rejected worker request still calls back and ends the run:
  *"calls back with failure when the worker request rejects"*,
  *"ends the run when starting the worker job rejects"*
- The interface spinner clears on a failed fetch:
  *"stops showing the interface spinner when fetching the interface rejects"*
- Run state belongs to the tool, not the component instance:
  *"gives each worker tool its own worker menu instance"*,
  *"shows a run the jobs store still tracks for the tool after remounting"*
- A linger timer never hides the next batch's progress:
  *"keeps a new batch's progress when the previous batch's hide timer fires"*
- Property batch releases `running` on every exit:
  *"releases the running state when listing the batch's datasets fails"*,
  *"does not start a second batch while one is running"*
- A status the run itself creates is written through the store, so the UI
  sees it stop (found live, see below):
  *"tells the UI a first batch run stopped after the API rejects"*,
  *"tells the UI a first single run stopped after the API rejects"*

### Pipelines

- The batch run locks before its first await:
  *"takes the run lock before looking up the collection's datasets"*
- Every early exit releases the lock:
  *"releases the run lock when the dataset lookup rejects"*
- Step status comes from the runner, cancelled included:
  *"shows the step status the runner reports, cancelled included"*
- *"does not let a finished batch's linger timer hide the next batch's progress"*

### Upload flow

- No phase runs beside an error:
  *"leaves no phase running beside the error when the default view fails"*,
  *"stops configuring and shows why when the files cannot be read"*
- A retry never creates a dataset inside a half-created one:
  *"resumes an interrupted upload into the same dataset instead of creating another"*,
  *"does not create a second dataset once the files are uploaded"*
- Batch advance resets the whole phase:
  *"resets everything the pipeline set for the previous dataset"*
- One answer for quick import, and the workflow ends on every exit:
  *"uses the store's quick-import mode in the template on the routed path"*,
  *"completes the workflow when the page is left"*
- Multi-source init failure clears `initializing`, keeps the error visible and
  keeps Submit disabled:
  *"clears initializing and keeps the error when initialization fails"*
- Failure reaches the parent once:
  *"reports a failure once, as generationError, without a generatedJson"*
- Name checks are latest-wins:
  *"keeps only the latest single-name check's verdict"*

### Dataset load and sync indicator

- An overtaken load never lands after a newer one:
  *"an overtaken navigation's dataset does not land after the newer view's"*,
  *"an overtaken navigation's configuration does not land after the newer view's"*
- `datasetLoading` clears once, when the newest load settles:
  *"keeps datasetLoading set until the newest dataset load settles"*
- Login loads once: *"restoring a login reloads the selected dataset once"*
- The indicator counts requests and the error clears on success:
  *"keeps saving while another save is still in flight"*,
  *"clears the last error on the next success"*
- **Every `sync.setSaving(true)` needs a `finally`.** The indicator is a
  count, so an unbalanced start now sticks forever instead of being hidden by
  the next request: *"addMultiSourceMetadata ends its save when the upload succeeds"*

### Viewer interaction

- Alt-drag returns to idle on every exit and never orphans a ghost:
  *"removes the ghost and returns to idle when the save fails"*,
  *"ignores an alt-mousedown while the previous move is saving"*,
  *"removes the ghost on unmount"*
- A shift-capture commits only on an explicit commit:
  *"does not consume a cancelled capture, only clears the preview"*,
  *"a release outside the map commits the capture"*,
  *"cancels a capture whose button was released while away, without blocking pan or hover"*
- The window listeners are removed: *"removes its window listeners on unmount"*
- The view lock applies to new maps: *"locks a map created while the view is locked"*
- Combine is not re-entrant: *"ignores clicks while a combine is in flight"*
- ROI-draw has an exit:
  *"leaves ROI polygon mode when the empty ROI filter is cleared"*
- A tagging click is handled once:
  *"binds no separate tagging click handler, even when a tagging tool is selected at bind time"*
- SAM prompts are read from the reactive mirror, never from the `markRaw` node:
  *"mirrors the prompt list into reactive state"*,
  *"keeps the prompts when submitting with no output"*

### Dialogs and panels

- Import cannot be submitted twice: *"ignores a second submit while an import is running"*
- Closing the import dialog resets it:
  *"resets the overwrite choices when the dialog closes"*
- ShareProject never drops a confirmed action:
  *"runs a second confirmed action opened while the first is running"*
- A late response never writes into a new dialog session:
  *"ignores an access list from a previous dialog session"*
- Movie capture restores the time point, on failure too:
  *"returns to the original time point when a frame capture fails"*
- The bounding box never acts on another map's layer:
  *"does not act on the old map's layer through a replacement map"*
- Gate loading clears when a superseding refresh has nothing to fetch:
  *"clears loading when a superseding refresh has nothing left to fetch"*
- AI panel: nothing from a cleared run reaches the new conversation:
  *"does not push a later tool's card into the conversation that replaced it"*,
  *"keeps the typed message when sending while a stored conversation loads"*

### Second pass: the remaining machines and the review findings

Jobs and runs:

- A job that finished before it was tracked settles at once on an open
  stream, with one request:
  *"settles a job that finished before it was tracked on an already open stream"*,
  *"leaves reading a job added while the stream connects to the open"*
- A job the server no longer has fails and stops being polled; a network
  error is not evidence it is gone:
  *"fails and stops polling a tracked job the server no longer has"*,
  *"keeps tracking a job whose status read fails on the network"*
- Batch state outlives the component that started it:
  *"shows, cancels and guards a batch started before the menu remounted"*,
  *"shows, cancels and guards a batch started before the dialog remounted"*
- Batch state is scoped to its configuration and cleared on logout:
  *"keeps one collection's batch out of another that shares its ids"*,
  *"does not show the previous session's batch after logging out"*
- One property never runs twice at once:
  *"refuses a batch while a single run of the property is running"*,
  *"refuses a second single run until the first finishes"*
- "Is this tool running?" has one dataset-scoped answer:
  *"does not show the tool busy for its run on another dataset"*,
  *"runs a worker whose only running job is on another dataset"*
- A failed worker submit keeps its real reason through the store:
  *"rejects a pipeline step's worker submit with the request's own error"*
- A pipeline result does not follow the user to another configuration, and a
  run in flight is not cleared:
  *"forgets a finished run once its configuration is no longer selected"*,
  *"keeps a run in flight across a switch, then forgets it when it settles"*
- The run banner never moves the list under the cursor:
  *"reserves its place, hidden, before any run so a run does not shift the list"*

- "Is this property running?" is dataset-scoped too:
  *"is scoped to the dataset it runs on"*,
  *"currentJobId ignores the property's run on another dataset"*
- A job the server no longer has tells its listeners it ended:
  *"tells a missing job's listeners it ended, without a failure notification"*
- A refused property batch shows on the property's status while the run it
  was refused for is running, and is dropped when that run ends:
  *"records a refused batch on the property's status, without a toast"*,
  *"drops a refusal when the run it was refused for succeeds"*,
  *"drops a refusal recorded during a batch when the batch ends"*
- A run in flight keeps its status across a dataset switch or refresh, so
  the same property cannot be started twice and the spinner stays true:
  *"refuses a second start after a reset while the first run is in flight"*,
  *"keeps an in-flight status reactive across a reset"*,
  *"drops a settled status on reset"*
- A multi-property batch stays in the collection it started in and stops on
  Cancel All:
  *"stops when the user moves to another collection"*,
  *"stops after Cancel All"*
- A tool whose batch is running is busy everywhere, not only in its menu:
  *"does not start a worker whose batch over the collection is running"*,
  *"shows the tool busy while its batch over the collection runs"*
- A single tool run is held in the store from the request, so replacing the
  tool's menu before the submission is answered cannot start it twice
  (found by Codex):
  *"marks the run in flight from the request until the job settles"*,
  *"ends the run when the worker request rejects or the job cannot be tracked"*,
  *"is in flight for its user, dataset and tool until every run ends"*,
  *"is running while a run another menu instance requested is unanswered"*,
  *"does not start a worker whose run from the menu is still being submitted"*
- Cancel stops the run in flight, never a finished job the menu still
  remembers (found by Codex):
  *"cancels the tracked job, not a finished job this menu submitted"*,
  *"does not cancel a finished job when nothing is running"*
- State kept across navigation is still dropped at logout (found by Codex):
  *"drops the previous session's property run locks"*,
  *"stops tracking the previous session's jobs"*,
  *"stops tracking every job at logout and tells their listeners"*
- A batch loop submits nothing after logout, although logout settles the
  job it was waiting on (found by Codex):
  *"submits no further dataset once the session has ended"*,
  *"submits no further batch dataset once the session has ended"*
- A run that ends while another dataset is open releases its lock without
  showing an outcome there (found by Codex):
  *"does not show a run's outcome on another dataset"*,
  *"is the dataset being loaded, then the loaded one"*
- A job whose submission is answered after logout is not tracked (found by
  Codex):
  *"is not tracked by a single run, which ends"*,
  *"is not tracked by a pipeline step's submit"*,
  *"does not track a job whose submission is answered after logout"*,
  *"does not track a batch job whose submission is answered after logout"*
- Logout settling a job is not a failure: no toast, no configuration write,
  no outcome icon (found by the independent pass):
  *"reports no failure for a run that logout ended"*,
  *"does not write a materialized property id after a logout"*,
  *"records no outcome for a job that logout ended"*
- A status read never holds back an outcome the stream delivered (found by
  Codex):
  *"settles from the stream while the status read is still pending"*
- Movie capture stops when the map it captures from is replaced:
  *"stops capturing once the map has been replaced"*
- A child component's own control cannot move the flow past the parent's
  phase: the uploader's "Resume Upload" button (found by Codex):
  *"clears the failure and returns to the uploading phase"*,
  *"leaves a failure of a later phase alone"*,
  *"drops an upload failure once every file is uploaded"*
- Upload still works after the new dataset's folder could not be read:
  *"keeps Upload working when the new dataset's folder cannot be read"*
- Cancel All stops a run of several batches even when it cancelled no job:
  *"reports that its cancel was called, whatever the results count"*,
  *"stops after a Cancel All that had nothing left to cancel"*
- A cleanup that restores a value restores it only where it was captured
  (found by Codex):
  *"leaves the time alone when another view opened during the capture"*
- A loop that steps the viewer stops when the view it started in is gone
  (found live: the old map keeps answering screenshots, so the capture went
  on setting the time of the new view for every remaining frame):
  *"stops stepping the time once another view has opened"*
- A watcher that runs at teardown does not assume the dataset is still there
  (found live: closing the Snapshots panel at logout threw during the app's
  render and left the viewer on screen):
  *"hides the box without throwing once the dataset is gone"*

Upload flow:

- A failed quick import says so and has a way on, without a second dataset:
  *"says the quick import failed, not that it is in progress"*,
  *"reads the files again on Try again without creating another dataset"*,
  *"does not offer Try again once generating the configuration has failed"*
- Each batch dataset gets a fresh uploader:
  *"gives each batch dataset a fresh uploader"*
- One reset for every multi-source load, and a superseded load's failure does
  not block the new one:
  *"does not keep the previous load's variables when initialize() runs again"*,
  *"loads the new dataset when the superseded load fails"*
- An unreadable file is named as such:
  *"names the files the server could not open as images once retries run out"*
- A configuration failure in "add dataset to collection" stays visible:
  *"keeps the configuration and its error on screen after a generation failure"*
- The newest claim of a token owns the flag it guards (found by review, twice):
  *"stops the file spinner when the picked file is not valid JSON"*,
  *"stops the file spinner when the file is cleared mid-read"*,
  *"clears the batch name check when the location loses its id mid-check"*

Session and load:

- Logout resets the whole session and nothing in flight lands after it:
  *"resets the previous session's view, image, tool and recent views"*,
  *"a view load in flight at logout does not commit after it"*
- Large images belong to the dataset on screen:
  *"a previous dataset's images do not land after the next dataset's"*,
  *"the current large image follows a dataset switch"*
- One request per view, never shared across sessions:
  *"concurrent reads of one view share a single request"*,
  *"does not share a request across sessions"*
- An awaited navigation resolves when its target has landed, or, when a
  different target overtook it, as soon as its own fetch returns (without
  waiting for the newer load):
  *"a navigation whose dataset is already loading resolves once it lands"*,
  *"a dataset load superseded by a reload of the same dataset resolves once the reload lands"*,
  *"a dataset load superseded by another dataset resolves without waiting for it"*,
  *"stops when its view landed but the view's dataset is not loaded"*
- The breadcrumbs read the view once per view, not per session change:
  *"does not refetch the view when the session token changes"*
- The breadcrumbs show the view on screen, not the one whose fetch landed
  last:
  *"keeps the newer view's breadcrumbs when the older view's fetch lands last"*,
  *"clears the previous view's breadcrumbs when the next view cannot be fetched"*
- A failed step in a load still releases what waits on it:
  *"a dataset load whose browser save fails still settles a navigation waiting on it"*,
  *"a view that cannot be fetched clears datasetLoading"*
- "The URL equals the store" is not "nothing to do" while another view is
  still being fetched: going back must overtake it:
  *"going back to the value the store still holds overtakes the navigation in flight"*,
  *"going back to the current view overtakes a navigation still fetching its view"*
- Only the mapper's own navigation counts: a store-driven switch is not
  cancelled by an unrelated URL write:
  *"does not re-set the current value for a URL change while nothing of its own is in flight"*
- A store change made during a route change still reaches the URL:
  *"writes a store change skipped during a route change once it settles"*

Viewer:

- A drag ends when its release happens anywhere, and a release over the map
  still commits:
  *"cancels a drag whose release the map never sees"*,
  *"still commits a release over the map that the window hears first"*,
  *"cancels a drag when the window loses focus"*,
  *"leaves a drag that is saving to its save on window blur or release"*
- The line scan belongs to the viewer that drew it:
  *"keeps the line and the tool state when another of several viewers unmounts"*,
  *"clears the line, but not the tool state, when the viewer that drew it unmounts"*
- A pending ROI selection can be left, and Escape meant for something else
  is not taken:
  *"cancels a pending ROI selection on Escape"*,
  *"keeps a tool picked while an ROI selection is pending, and drops the selection"*,
  *"keeps a pending ROI selection on an Escape something else handled"*
- A replaced layer cannot mark the new draw ready:
  *"ignores a replaced layer going idle after a map reset"*
- A SAM failure is a visible state, and it clears when its cause goes away:
  *"reports a failed model load as a reactive failure, and a retry that succeeds clears it"*,
  *"shows a failed model load with a retry button"*,
  *"clears a run failure whose input went away while it ran"*
- Scan progress does not outlive the scan:
  *"clears scan progress when computing ends without proposals"*

- The overview survives a half-done dataset switch (the layers still belong
  to the previous configuration) and never applies an older URL (seen live as
  uncaught `LayerSelectionError`s in the console; predates the branch):
  *"shows no overview image when the layers have no image here"*,
  *"does not apply an overview URL a newer one has replaced"*

Smaller ones:

- *"a refused Object Browser request in embed mode does not leave the store open"*
- *"keeps the newest job's log when an older log request resolves last"*
- *"dismissing the assetstore confirmation cancels it, and the next one opens"*

### Process rules this pass proved

- A test must fail without its fix. Several first drafts passed either way
  (asserting `showError` instead of `errorString`; spying on an exposed
  function that the closure never calls).
- Shared store mocks are plain objects; a watcher on `store.maps` or a SAM
  state only fires in a test if the mock is `reactive(...)`.
- State holds reactive proxies. Compare a stored socket, map or layer with an
  event target through `toRaw`, never `===`.
- An assignment expression yields the raw right-hand side, not the store's
  proxy: `const x = state[k] ?? (state[k] = make())` leaves every later write
  to `x` invisible to the UI on the first run. Assign, then read back.
- Claiming a sequence token makes the older request unable to clear the
  flag it set. Whoever claims must leave the flag right on every exit,
  early returns included. Review found this twice in code this branch wrote.
- A fix agent's file list is a blast-radius boundary, not a correctness one:
  three of the review findings were twins in files the fixing agent was not
  allowed to touch. Sweep across owners before calling a shape fixed.
- A live pass needs the fixture the feature needs (a time-lapse for the
  movie, a worker image for pipelines); the first pass skipped both for want
  of one.
- An equality skip ("already this value") reads committed state. While a
  change is in flight the committed value is about to be replaced, so the
  skip drops the one request that should have overtaken it. Ask "is anything
  of MINE pending?" before skipping: the first version asked "is anything
  pending?" and would have let an unrelated URL write cancel a switch someone
  else started. The second review caught that before it shipped.
- Review the review fixes. The second independent pass over the fixes found
  a regression in the newest one, and mutation testing found nine fixes with
  no test that failed without them.
- A store-state assertion is not a UI assertion. The property batch read
  `running: false` in the store while the dialog still showed the spinner;
  only reading the rendered dialog caught it.
