# Worker Pipelines

## Status

**Implemented and shipped** on the worker-pipelines branch. This document began
as a design spec, and the later sections still read that way — they are kept as
design rationale. This section tracks what actually shipped and what is
outstanding. (Where a design decision had genuine trade-offs, the recommended
option is stated first and marked **(recommended)**; alternatives are listed so
they aren't re-litigated.)

### What shipped

- **Data model + persistence.** `IPipeline` + `IAnnotationPipelineStep` /
  `IPropertyPipelineStep`, stored on the configuration under `meta.pipelines` on
  the `upenn_collection` document (its own MongoDB collection, not a folder;
  extra `meta` keys are allowed, so **no backend changes** were needed).
- **Runner** (`src/store/pipelines.ts`): sequential submit-and-await with
  stop-on-failure / `continueOnError` / cancellation, lazy materialized-property
  reuse + cleanup, and **batch across datasets** (≤ 50) with one end-of-run
  refresh.
- **UI**: a single entry point — the **Pipelines** button in the Tools panel —
  opens a two-view dialog: a **list** and a unified **editor** where you both
  build and run (per-step live status + inline job logs, Save + Run in one view).
  A run-status strip shows in every view; overall progress rides the app's global
  progress widget. Steps can be built from an annotation worker, a property
  worker, or an **existing worker-backed tool**. Tag auto-wiring joins property
  steps to the nearest upstream annotation step.
- **Linked steps** (§3.4): a step added from an existing tool or an existing
  property is *linked* to it, so the pipeline runs with the same parameters as
  the individual tool or property instead of a diverging copy. A linked step's
  settings are read-only in the pipeline editor (edit the tool in the Tools
  panel); a property-linked step computes the user's own property and never
  replaces or deletes it. Each linked step keeps a saved copy used only when its source is
  deleted, and **Unlink** turns it into an independent step.

### Removed / superseded

- **AI pipeline suggestion** (the `claude_pipeline` backend route, the suggest
  dialog / store action / `ChatAPI` method, and the `origin: "ai"` badge) was
  **removed**, pending a replacement in a separate update that refactors the
  chat/suggest system. §6 below is retained as historical design only; none of it
  is wired up. The distinct **tool**-suggester (`claude_suggest_tools`, the
  lightbulb in the Tools panel) is unaffected, and the backend is byte-for-byte
  master.

### Follow-ups / TODO

- [ ] **Re-add pipeline suggestion** in the separate chat/suggest refactor PR —
      this branch intentionally carries none.
- [ ] **Live end-to-end smoke test on a real worker stack.** A UI-triggered run
      on a warm container has completed reporting success while creating **0**
      annotations; confirm real worker output end-to-end before relying on it.
- [ ] **Reconnect run progress after a full page reload.** The jobs continue
      server-side, but the dialog's per-step live status is in-memory and rebuilds
      to a baseline on reload — mid-run reload loses the live tracking (results
      still land; a manual refresh shows them).

### By design (not TODO)

- Pipelines are **collection-wide** (stored on the shared configuration), not
  per-dataset.
- Batch runs are capped at **50 datasets** (a guard against accidental large runs).
- Property steps compute only on **materializable shapes** (point / line /
  polygon); other shapes clamp to polygon.

## Motivation

Today every worker computation is a single, manually-triggered step. A typical
analysis is several steps in sequence:

1. Run **Cellpose SAM** (an annotation worker) to segment nuclei → produces blob
   annotations tagged `nuclei`.
2. Run **Blob metrics** (a property worker) on those blobs → area, perimeter,
   eccentricity, etc.
3. Run **Blob intensity** (a property worker) on those blobs → mean/max/min
   intensity per channel.

The user must run each step by hand, wait for it to finish, wire up the tags so
step 2 and 3 see step 1's output, and remember the correct order. **Worker
Pipelines** lets a user define this sequence once, run it with a single click,
and re-run it on new datasets. (A secondary feature that used an LLM to
*auto-suggest* pipelines was removed pending a replacement — see Status above and
§6.)

## Terminology

| Term | Meaning |
|------|---------|
| **Annotation worker** | A Docker worker that *produces annotations* (Cellpose SAM, Piscis, StarDist). Runs via the `segmentation` tool path. Docker label `isAnnotationWorker`. |
| **Property worker** | A Docker worker that *computes property values* on existing annotations (Blob metrics, Blob intensity). Runs via the property path. Docker label `isPropertyWorker`. |
| **Pipeline** | An ordered, named list of **steps**, stored on a configuration. |
| **Step** | One worker invocation: an annotation-worker step or a property-worker step, plus its parameters and tag wiring. |
| **Data contract** | Steps do **not** pass data in memory. Each step writes annotations / property values back to the dataset; downstream steps read them back. The join key between steps is **tags + annotation shape**. This is the single most important fact in this document. |

---

## 1. What already exists (build on this, don't reinvent)

The pipeline feature is almost entirely an *orchestration layer* over
machinery that already works. Every citation below is load-bearing.

### 1.1 Two execution paths, one launcher

There is no `worker` tool type. Annotation workers are `type: "segmentation"`
(`src/store/model.ts:58-66`; `WORKER_TOOL_TYPE = "segmentation"` in
`src/tools/toolsets/Toolset.vue:146`). Property workers are not a tool type at
all — they are `IAnnotationProperty` documents.

Both paths funnel through **one** backend launcher,
`runJobRequest(image, datasetId, params, request)` in
`devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/helpers/tasks.py:19-57`,
which calls `girder_worker.docker.tasks.docker_run.apply_async(...)`. The
`request` argument is a verb: `"compute"`, `"interface"`, or `"preview"`. The
same image handles all three. `pull_image` is `False` — images must be present
locally.

```
Annotation worker:  POST upenn_annotation/compute?datasetId=...
  api/annotation.py:429  →  models/annotation.py:239 (compute)  →  runJobRequest(image, datasetId, tool, "compute")

Property worker:    POST annotation_property/:id/compute?datasetId=...
  api/property.py:62    →  models/property.py:68 (compute)      →  runJobRequest(image, datasetId, params, "compute")
```

### 1.2 Frontend single-step execution

- **Annotation:** `annotation.ts::computeAnnotationsWithWorker`
  (`src/store/annotation.ts:1328-1415`) → `AnnotationsAPI.computeAnnotationWithWorker`
  (`src/store/AnnotationsAPI.ts:214-272`), which POSTs
  `{ datasetId, type, id, name, image, channel, assignment, tags, tile, connectTo, workerInterface, scales }`.
- **Property:** `properties.ts::computeProperty`
  (`src/store/properties.ts:381-462`) → `PropertiesAPI.computeProperty`
  (`src/store/PropertiesAPI.ts:76-90`), which POSTs `{ ...property, scales }` to
  `annotation_property/:id/compute`. **A property compute requires a persisted
  property document with an `_id`** — this constrains the design (see §3.3).
- Both take `response.data[0]?._id` as the Girder job id and register it with
  `jobs.addJob(...)`.

### 1.3 Job tracking is already promise-based (this is the chaining hook)

`src/store/jobs.ts`:

- `jobs.addJob(computeJob)` (`:191-212`) registers the job and **returns a
  `Promise<boolean>`** that resolves `true` on `jobStates.success`, `false` on
  error/cancel. Terminal detection is in `handleJobEventImp` (`:275-323`).
- Transport is a **WebSocket** to `/notifications/me?token=...`
  (`:347-364`) — not SSE, despite older docs. Events arriving before a job is
  registered are buffered in `messageStore` and replayed (`:204-210`).
- Workers report progress by printing JSON lines (`{"progress": 0.5, ...}` /
  `{"error": ...}`) to stdout; `createProgressEventCallback` / `createErrorEventCallback`
  (`:28-104`) parse them.

**The batch runner is the template for the pipeline runner.**
`computeAnnotationsWithWorkerBatch` (`src/store/annotation.ts:1417-1689`) already
does exactly the sequencing shape we need: submit a job, `await` its
`completionPromise`, then submit the next, with per-item progress, aggregate
progress, and immediate cancel wiring via an `onCancel` callback. Read it before
implementing §4. The key lesson it encodes (`BATCH_ANNOTATION_COMPUTE.md`):
capture the promise returned by `addJob` *immediately*, because a fast job can be
removed from `jobInfoMap` before you could look it up later.

### 1.4 Where tools/properties/config live

`IDatasetConfigurationBase` (`src/store/model.ts:411-418`):

```ts
export interface IDatasetConfigurationBase {
  compatibility: IDatasetConfigurationCompatibility;
  layers: IDisplayLayer[];
  tools: IToolConfiguration[];
  snapshots: ISnapshot[];
  propertyIds: string[];
  scales: IScales;
}
```

Configuration mutations sync with `main.syncConfiguration(key)`
(`src/store/index.ts:1943`), which PUTs the changed key back to the Girder
configuration document. Tools are added/edited via
`addToolToConfiguration` / `editToolInConfiguration` (`src/store/index.ts:858-908`).
Properties are created and their ids appended to `propertyIds`
(`src/store/index.ts:1938`).

### 1.5 Worker discovery and interfaces

- `GET worker_interface/available` → `IWorkerImageList` (`{ image: IWorkerLabels }`),
  cached in `propertiesStore.workerImageList` (`src/store/properties.ts:80`,
  fetched by `fetchWorkerImageList`). `IWorkerLabels` (`src/store/model.ts:1339-1351`)
  carries `isAnnotationWorker`, `isPropertyWorker`, `interfaceName`,
  `interfaceCategory`, `annotationShape`, `description`, `hasPreview`, etc.
- The per-image *parameter* schema (`IWorkerInterface`, `src/store/model.ts:1331`)
  is discovered lazily via `fetchWorkerInterface` (`src/store/properties.ts:196-220`):
  `GET worker_interface?image=`, and if missing/`noCache`,
  `POST worker_interface/request` (runs the image with `--request interface`),
  then re-GET. Values are `IWorkerInterfaceValues` (`{ [id]: value }`,
  `src/store/model.ts:1335`).

### 1.6 The LLM path

There is a working backend Anthropic proxy already: plugin
`devops/girder/plugins/girder-claude-chat/`, endpoint `POST /api/v1/claude_chat`
(`girder_claude_chat/__init__.py`, `@access.user`). It reads
`ANTHROPIC_API_KEY` server-side, uses the official `anthropic` Python SDK,
calls `client.messages.create(model='claude-sonnet-4-6', max_tokens=4096, system=[...cache_control ephemeral...], messages=...)`,
and returns `{'response': text}`. The frontend never calls Anthropic directly
(`src/store/ChatAPI.ts`, `src/store/chat.ts`). **No tool-use / structured-output
pattern exists in the repo yet** — the pipeline-suggest feature (§6) introduces
it.

---

## 2. Design overview

A **Pipeline** is a new, self-contained, ordered list of steps stored on the
dataset configuration. Each step embeds its own worker configuration rather than
depending on existing `tools[]` / `propertyIds[]` entries. (A step added from an
existing tool or property *also* records a link to it and runs with the source's
current values — see §3.4. The embedded configuration remains as the fallback,
so the properties below still hold.) Rationale:

- **Portability.** A pipeline can be copied between configurations, shipped as a
  built-in preset, or generated wholesale by the LLM without first creating N
  tool/property documents.
- **No dangling references.** Deleting a tool won't silently break a pipeline.
- **Self-describing for the LLM.** The suggest feature emits and consumes the
  same embedded shape.

The runner **materializes** what each path needs at run time:

- Annotation steps → build a *transient* `IToolConfiguration` in memory and call
  the existing annotation-worker path. No persisted tool needed.
- Property steps → property compute requires a persisted property `_id`, so the
  runner *lazily creates* a property document the first time the step runs and
  caches its id on the step (see §3.3).

```
┌─ Configuration ─────────────────────────────────────────────┐
│  pipelines: IPipeline[]        ← NEW field, synced to backend │
│  tools, propertyIds, layers, scales, ...   (unchanged)        │
└──────────────────────────────────────────────────────────────┘

Pipeline "Nuclei + metrics"
  ├─ Step 1  annotation  image=cellpose-sam   outputTags=[nuclei]         ─┐ writes
  ├─ Step 2  property    image=blob-metrics   inputTags=[nuclei] shape=polygon  reads ◄┘
  └─ Step 3  property    image=blob-intensity inputTags=[nuclei] shape=polygon  reads ◄┘

Run: for each enabled step → submit job → await completionPromise → next
Data flows through the dataset via tags, never in memory.
```

---

## 3. Data model

Add to `src/store/model.ts`.

### 3.1 Step and pipeline interfaces

```ts
export type TPipelineStepKind = "annotation" | "property";
// Extensible later: "connection", "tagging".

export interface IPipelineStepBase {
  // Stable id, unique within the pipeline. Generate with the same id scheme
  // used for tools (see how IToolConfiguration.id is created in index.ts).
  readonly id: string;
  kind: TPipelineStepKind;
  // Display name, defaults to the worker's interfaceName label.
  name: string;
  // Docker image tag, e.g. "properties/blob_metrics:latest".
  image: string;
  // The user-picked runtime parameters for this worker image (same shape the
  // single-step UIs persist today).
  workerInterfaceValues: IWorkerInterfaceValues;
  // Skipped by the runner when false. UI shows a disabled/greyed step.
  enabled: boolean;
}

export interface IAnnotationPipelineStep extends IPipelineStepBase {
  kind: "annotation";
  // Mirrors tool.values.annotation (IAnnotationSetup). Drives channel/location
  // resolution (getAnnotationLocationFromTool) and the tags applied to OUTPUT
  // annotations. `annotation.tags` ARE this step's output tags.
  annotation: IAnnotationSetup;
  // Mirrors tool.values.connectTo (optional connection wiring). Optional.
  connectTo?: {
    tags: string[];
    layer: string | null;
    exclusive?: boolean;
  };
  // Mirrors tool.values.jobDateTag.
  jobDateTag?: boolean;
  // Linked to this configuration tool (§3.4). The fields above are then a
  // saved copy of the tool's values.
  sourceToolId?: string;
}

export interface IPropertyPipelineStep extends IPipelineStepBase {
  kind: "property";
  // Which annotations this property computes on.
  shape: AnnotationShape;
  // Tag filter selecting INPUT annotations. Normally set to the output tags of
  // an upstream annotation step (see §5 tag wiring).
  inputTags: { tags: string[]; exclusive: boolean };
  // Set lazily by the runner on first successful run: the id of the persisted
  // IAnnotationProperty this step created. Reused on subsequent runs. May be
  // cleared if the referenced property no longer exists (runner re-creates).
  materializedPropertyId?: string;
  // Linked to this existing property (§3.4): the runner computes it directly
  // instead of materializing one. Never set together with a live
  // materializedPropertyId.
  sourcePropertyId?: string;
}

export type TPipelineStep = IAnnotationPipelineStep | IPropertyPipelineStep;

export interface IPipeline {
  readonly id: string;
  name: string;
  description?: string;
  steps: TPipelineStep[];
  // Provenance, for UI badges. (The "ai" origin was removed with the
  // AI-suggestion feature — see §6.)
  origin?: "user" | "preset";
}
```

`IAnnotationSetup` is defined in
`src/tools/creation/templates/AnnotationConfiguration.vue` (exported): `{ tags,
coordinateAssignments: { layer, Z, Time }, shape, color }`. Reuse it.

### 3.2 Configuration field

Extend `IDatasetConfigurationBase` (`src/store/model.ts:411`):

```ts
export interface IDatasetConfigurationBase {
  // ...existing...
  pipelines: IPipeline[];   // NEW
}
```

- Default to `[]` in the configuration factory (mirror how `tools: []` is
  seeded — see `src/store/model.ts:1937`).
- **Backwards compatibility:** existing configuration documents won't have
  `pipelines`. Read it as `config.pipelines ?? []` everywhere; the sync path
  will persist it once first written. No backend migration required — the
  configuration document is schemaless JSON (verify against
  `server/models/configuration.py` and add `pipelines` to any JSON schema there
  if one gates writes).

### 3.3 Materialized properties — the one real subtlety

The property compute endpoint is `annotation_property/:id/compute`; it needs a
real property document. Options:

- **(recommended) Lazy materialization.** On the first run of a property step,
  the runner creates an `IAnnotationProperty` (via the existing property-create
  path — `POST annotation_property`, then append to `propertyIds` and
  `syncConfiguration("propertyIds")`) from
  `{ name: step.name, image: step.image, tags: step.inputTags, shape: step.shape,
  workerInterface: step.workerInterfaceValues }`, stores the returned id on
  `step.materializedPropertyId`, and syncs the pipeline. Subsequent runs reuse
  it (updating its worker interface values first if the step changed). This
  reuses **all** existing property infrastructure and keeps property values
  visible in the normal Annotation Browser property columns.
- (alternative) Add a backend endpoint that computes a property from an inline
  spec without a persisted document. More invasive (new endpoint + worker
  contract unchanged but caller changes); rejected for v1.

**Cleanup:** when a pipeline or a property step is deleted, offer to delete the
materialized property too (it will otherwise linger in the Annotation Browser).
Reuse `deleteProperty` (`PropertiesAPI.ts:115`). Make this a confirm, not
automatic — the user may want to keep the computed values.

### 3.4 Linked steps

**Why.** Users expected a pipeline step built from a tool they had already tuned
to *be* that tool: change the tool's threshold and the pipeline should use it.
The original design (§2) only copied the tool's values into the step once, at
"Add step" time, and property steps always materialized a property of their own
— so a dataset ended up with two "Blob metrics" properties with independent
parameters. Options considered:

- **Keep copies, flag drift** (record the source, show "out of sync", offer
  update-from / push-to buttons). Cheapest, but values still diverge silently
  until someone clicks.
- **Reference only** (a step holds just `toolId` / `propertyId`). Matches user
  expectation exactly, but breaks the portability and no-dangling-reference
  properties of §2: deleting a tool would break the pipeline.
- **(chosen) Linked, with a saved copy as fallback, read-only in the
  pipeline.** Described below.

An earlier iteration of the chosen option also let the user edit a
tool-linked step's settings in the pipeline editor and wrote them back to the
tool on Save. It was removed: nearly every review finding on this feature came
from that write-back (pending edits going stale while the tool changed
elsewhere, merging onto the tool's current values, save ordering and partial
failure, rollback, a race with the tool menu's own debounced save, child
editors that change their props in place). The user asked for the pipeline
and the tool to use the same values, which linking alone delivers; the tool is
edited where it lives.

**Model.** `IAnnotationPipelineStep.sourceToolId` and
`IPropertyPipelineStep.sourcePropertyId` mark a linked step. The step's ordinary
fields (image, parameters, annotation setup / tags, shape) are kept as a
*saved copy* of the source. Steps built from a raw worker image are unlinked and
behave exactly as before. Pure helpers live in `src/utils/pipelineLinks.ts`
(`resolveLinkedStep`, `stepLinkState`, `toolLinkedFields`,
`propertyLinkedFields`, `samePersistedValue`).

| | Linked to a live tool | Linked to a live property | Source deleted |
|---|---|---|---|
| What runs | The tool's current image, parameters, annotation setup, `connectTo`, `jobDateTag` (transient tool built from `resolveLinkedStep`) | The property itself (`submitPropertyJob` on its id); no materialization | The step's saved copy (a property step materializes from it as before). Before treating a linked property as deleted, the runner reloads the configuration's properties once (`loadMissingLinkedProperties`, after taking the run lock — it never rejects, so it cannot leave the lock held; once per batch; the editor does the same on open), so one that simply had not loaded yet is computed, not duplicated. If that reload fails, the step fails rather than materializing a possible duplicate. A step already running its fallback, or whose property a reload already confirmed missing in this configuration, is not rechecked (the record is per configuration, since one property can be registered in several; and while the loaded property list is not this configuration's, every linked step is checked); a reload overlapped by a configuration switch confirms nothing and counts as failed. A batch resolves linked steps once, so every dataset runs the settings in effect when it started |
| Editor: worker image | Locked | Locked | Locked |
| Editor: parameters / tags | Locked: "edit them in the Tools panel, or Unlink to customize this step" | Locked: "Unlink to customize this step" (properties are immutable in the UI) | Locked |
| Header chip | link icon + tool name | link icon + property name | "source deleted" for a tool, "source unavailable" for a property (it may only not be loaded yet; the runner reloads before deciding), or "tool has no worker" for a tool that still exists without a worker image (also unusable, so the saved copy runs) |
| Auto-wiring (§5) | Its output tags feed downstream steps as usual — **also at run time**: the runner re-applies auto-wiring (`computeAutoWiredSteps`, `src/utils/pipelineWiring.ts`) to the resolved steps, so a tool whose output tags changed since the last save still feeds the property steps after it. Only steps flagged `autoWired: true` are rewired. If the tool's output tags change, a wired step's pipeline-created property no longer matches, so the next run replaces it (`ensureMaterializedProperty` drift, as when tags are edited in the pipeline) | Skipped: computes on the property's own tags/shape | Same as when live |

**Editor behaviour** (`PipelineEditor.vue`, `PipelineStepEditor.vue`):

- **Shown live, read-only.** `localPipeline` holds the step list and every
  unlinked value. What is shown (`displayedPipeline`) is each linked step
  resolved against its **live** source, then auto-wired, so a tool edited
  elsewhere shows through at once. A linked step's settings are locked
  (`v-defaults-provider` with a global `disabled` default plus `inert`), and
  `PipelineStepEditor` emits nothing for it but a new name, enabled flag or
  Unlink (its locked child editors still re-emit).
- **Viewing writes nothing.** A linked step's unset parameters *show* the
  worker's defaults (as the tool's own menu does) without writing them; an
  unlinked step is still seeded on mount. An emit that changes nothing changes
  no state: child editors re-emit whenever their value's identity changes, and
  a linked step's shown values are rebuilt when its copy differs from its
  source.
- **Unsaved changes** are computed, not snapshotted: the displayed pipeline is
  compared with the stored pipeline shown the same way (same live sources,
  ignoring the runner's `materializedPropertyId` write-backs), so a source
  changed elsewhere is not an unsaved change. Equality ignores `undefined` keys
  (`samePersistedValue`): `AnnotationConfiguration` always emits `color`, while
  values loaded from Girder JSON have no such key.
- **Save** stores each linked step with its source's current values, so the
  deleted-source fallback runs its last settings as of the last save. It
  captures what it saves before its first await, so an edit made during the
  save stays unsaved.
- **Unlink** removes `sourceToolId` / `sourcePropertyId` and keeps the shown
  values (including displayed defaults and any saved parameter the worker no
  longer declares) as an independent, editable step. Unlinking a step from a
  live property means the pipeline computes its own copy of that property
  from then on (the banner says so): reusing the user's property would let a
  later settings change replace and delete it. The step is renamed
  "<name> (pipeline copy)" so that property is told apart from the original. An unlinked property step gets
  `autoWired: false` (it keeps the property's tags). It never takes the user's
  property as its `materializedPropertyId`, so its next run materializes a new
  property and the user's property is never touched; a property the fallback
  already materialized for it (after the linked property was deleted) is the
  pipeline's own and is reused.
- "Add step" offers **Existing tool** (links via `sourceToolId`) and **Existing
  property** (links via `sourcePropertyId`, listing the configuration's
  properties except those a pipeline materialized: the pipeline that owns one
  may replace or delete it).

**Never delete a user's property.** A linked property is never assigned to
`materializedPropertyId`, so drift replacement in `ensureMaterializedProperty`,
pipeline deletion and property-step removal cannot reach it.
`isPropertyReferencedByPipelineStep` (renamed from
`isMaterializedPropertyReferenced`) also counts `sourcePropertyId`, so a
pipeline-materialized property that another step links to is not deleted when
its own pipeline replaces or drops it.

**Removing a linked property in the Properties panel.** Removing a property
only unregisters it from the configuration's `propertyIds`; the document stays
on the server. A step linked to it then treats its source as deleted and, on
its next run, materializes a pipeline-owned property from its saved copy. The
delete dialog (`PropertyBody.vue`) therefore:

- **Warns** when pipeline steps use the property
  (`pipelinesStore.pipelineStepsLinkedToProperty`): steps linked to it
  (`sourcePropertyId`) and steps that created it (`materializedPropertyId`),
  disabled ones included and marked, since they use it again once re-enabled.
  Each would create a new pipeline-owned property on its next run. The dialog
  names each pipeline and step, and the confirm button reads "Remove anyway".
- **Reports a refused removal.** `deleteProperty` can be refused (this
  configuration's properties have not loaded) or fail to save. The removal
  takes the property out of the list before it saves, which unmounts this row
  and its dialog, so the reason goes to a global notification as well as the
  dialog. "Also delete the computed values" targets the dataset the removal
  started on (captured before the await, passed to `deletePropertyValues`),
  not whichever is open when the save completes.
- **Blocks** the removal while a run or batch computes the property
  (`pipelinesStore.runningPipelineComputingProperty`): the pipeline in
  `runningPipelineId` has an enabled property step whose `sourcePropertyId` or
  `materializedPropertyId` is the property. Removing either mid-run would make
  the remaining steps or datasets compute into a new property, splitting the
  results. Read from the stored pipeline, which both run entry points submit;
  the handler re-checks, since a run can start while the dialog is open.

Freezing the linked property for the duration of a batch (suggested on #1430)
would not prevent the split: a frozen batch keeps computing into a property no
longer in the configuration, where the user can't see the values. The guard is
in the component, not in `propertiesStore.deleteProperties`, because the
running pipeline itself removes a drifted-away property through that action.

**Overwriting properties on import.** An annotation import with "Overwrite
properties" (`AnnotationImport.vue`, `src/utils/annotationImport.ts`)
unregisters every property of the configuration once the import succeeds, so
it applies the same two rules over all of them:

- **Warns**: with the option checked, the import dialog lists the steps that
  use any of those properties (`pipelineStepsUsingOverwrittenProperties`, each
  link with the property's name), and the overwrite confirmation counts the distinct steps.
- **Blocks** while a running pipeline computes one of them
  (`runningPipelineComputingOverwrittenProperty`): the Import button is
  disabled with the reason, and `importAnnotationsFromData` refuses the
  overwrite itself before creating anything, so no caller can bypass it. The
  import awaits the backend before it removes anything, and a run can start in
  that window, so the removal re-checks each property: one a run started
  computing is kept, with a warning notification naming it, rather than failing
  an import that already succeeded; the rest go in one `deleteProperties` call.
  The project-creation import (`NewDataset.vue`) never overwrites, and the
  GeoJSON import creates no properties.

**Not linked (by design).** The step *name* and *enabled* flag stay per-step.
A locked section disables every control in it, so parameter help tooltips are
unavailable on linked steps.

---

## 4. Execution engine

New Vuex module `src/store/pipelines.ts` (per CLAUDE.md guidance to not grow
`index.ts`). Follow the dynamic-module + HMR-accept pattern used by
`src/store/jobs.ts`.

### 4.1 Refactor single-step submitters to return promises (small, do this first)

The pipeline runner must `await` each step. Extract promise-returning submitters
so the runner never duplicates job wiring:

- **Annotation:** `computeAnnotationsWithWorker` currently owns progress + the
  `.then()` completion side effects. Add (or reuse `submitWorkerJobForDataset`,
  `src/store/annotation.ts:1610-1689`, which already returns
  `{ job, completionPromise }`) a variant that accepts a **transient tool** and a
  target `datasetId`, returns `{ job, completionPromise }`, and does **not**
  itself run `fetchAnnotations` / `loadLargeImages` (the runner does those once
  at the end — see §4.4). `submitWorkerJobForDataset` is already 95% this; make
  it usable with a transient tool and expose it.
- **Property:** add `submitPropertyJob(property, datasetId)` returning
  `{ job, completionPromise }`, factored out of `computeProperty`
  (`src/store/properties.ts:381-462`) so the runner can await it without the
  built-in `fetchPropertyValues` after every step.

Building a transient tool for an annotation step:

```ts
function buildTransientTool(step: IAnnotationPipelineStep): IToolConfiguration {
  return {
    id: step.id,                 // fine for jobIdForToolId bookkeeping
    name: step.name,
    hotkey: null,
    type: "segmentation",
    values: {
      image: { image: step.image },
      workerInterfaceValues: step.workerInterfaceValues,
      annotation: step.annotation,
      connectTo: step.connectTo ?? {},
      jobDateTag: step.jobDateTag ?? false,
    },
    // A minimal template is enough for the compute path; it never re-renders
    // the creation UI. Reuse the segmentation template from templates.json if a
    // full IToolTemplate is required by types.
    template: SEGMENTATION_TEMPLATE,
  };
}
```

### 4.2 The runner action

```ts
@Action
async runPipeline({
  pipeline,
  datasetId,               // defaults to main.dataset.id
  onStepStart,             // (stepIndex, step) => void
  onStepProgress,          // (stepIndex, progress: IProgressInfo) => void
  onStepError,             // (stepIndex, errors: IErrorInfoList) => void
  onStepComplete,          // (stepIndex, success: boolean) => void
  onCancel,                // (cancel: () => void) => void   ← wire immediately
  onComplete,              // (result: IPipelineRunResult) => void
  continueOnError = false, // if true, a failed step doesn't abort the rest
}): Promise<IPipelineRunResult>
```

Behavior (mirror `computeAnnotationsWithWorkerBatch`):

1. Guard on `main.dataset && main.configuration && main.isLoggedIn`.
2. Create a top-level progress entry `ProgressType.PIPELINE_COMPUTE` titled
   `Pipeline: <name>` with `total = enabledSteps.length` (new enum value in
   `src/store/model.ts` ProgressType, `:206-231`).
3. Build a `cancel()` closure that sets an `isCancelled` flag and cancels the
   currently-running job (`main.api.cancelJob(jobId)`); hand it to `onCancel`
   *before* the loop starts (avoids the timing bug documented in
   `BATCH_ANNOTATION_COMPUTE.md`).
4. For each enabled step, in order:
   - If `isCancelled`, mark remaining as canceled and break.
   - Create a per-step progress entry (`ANNOTATION_COMPUTE` or
     `PROPERTY_COMPUTE`) titled `<pipeline>: <step.name>`.
   - **Annotation step:** `buildTransientTool(step)` → submit via the refactored
     submitter → `await completionPromise`.
   - **Property step:** `ensureMaterializedProperty(step)` (create-or-reuse per
     §3.3, updating its worker interface values from the step) → submit →
     `await completionPromise`.
   - Feed `onStepProgress` / `onStepError` from the job's event callbacks (reuse
     `createProgressEventCallback` / `createErrorEventCallback`).
   - On failure: if `!continueOnError`, stop; record which step failed.
   - **As implemented:** before submitting, if the loaded configuration is no
     longer the run's (another configuration was opened mid-run), the step
     fails with `CONFIGURATION_CHANGED_DURING_RUN` and the run stops, even
     with `continueOnError`. The steps read the loaded configuration's tools
     and properties and record materialized property ids on it, so after a
     switch they would look up, create or record properties in the wrong
     configuration while their jobs target this run's dataset. Ids
     materialized before the switch are saved to the run's own configuration
     (`api.updateConfigurationKey` on the captured object), not to the one
     now loaded; losing them would make its next run create the properties
     again. The run keeps its own list of the steps it materialized and
     merges their ids into the stored pipeline just before that save, since a
     switch away and back reloads the configuration from the server without
     the ids merged so far. A switch while `ensureMaterializedProperty` is
     creating a property: if it lands during the create request,
     `createProperty` registers the property nowhere and throws, so that step
     fails and the run stops. A property it does return is registered in the
     run's configuration and its id is recorded. After a switch the stale
     (drifted) property is not removed, because removal rewrites the loaded
     configuration's `propertyIds` from the loaded property list, which may
     still be the previous configuration's until the new one's fetch lands.
     The properties store enforces this for every caller: `setProperties`
     saves only a list that a fetch loaded for the loaded configuration
     (`propertiesConfigurationId`; it refuses one loaded for another
     configuration, and one no fetch has loaded yet), and skips the plot and
     track-label reconcile when a switch lands during its save. A failed save
     restores what the server holds, not its own snapshot (which a later save
     or a fetch may have superseded): `updateConfigurationProperties` and
     `updateConfigurationPipelines` go through `writeConfigurationKey`, which
     restores nothing until the last pending write of a key settles; then, if
     any of them failed, the key gets the last value the server confirmed (on
     the loaded object if it has the same id, since a switch away and back
     loads a new one). `setProperties` rebuilds the list from those ids at the
     same point, unless the list is now another configuration's. Its
     pending-save bookkeeping is per configuration, like
     `writeConfigurationKey`'s: a save still pending on one configuration must
     not hold back the rebuild after another configuration's save fails.
     A property the server registered itself (the gene-panel and
     neighborhood requests register it when they are made, not when their
     job finishes) is adopted as soon as the request returns, through
     `adoptServerConfirmedPropertyId`, which adds it to the confirmed value
     as well as the live list, so a failed pending save keeps it; a save
     sent before the adoption that succeeds also keeps it confirmed. Until a
     fetch loads the adopted property into the list, `setProperties` carries
     its id over, so a save in between does not unregister it. Not covered:
     a property save sent while such a request is in flight replaces the
     server's list without the id; only a server-side merge of propertyIds
     writes could prevent that.
   - `progress.complete(perStepProgressId)`; bump the top-level progress.
5. After the loop (once, not per step): `annotationStore.fetchAnnotations()`,
   `propertiesStore.fetchPropertyValues()`, `filters.updateHistograms()`, and
   `main.loadLargeImages(true)` + cache scheduling if a new large image appeared
   (mirror `annotation.ts:1398-1408`).
6. `progress.complete(topLevelId)`; call `onComplete` with counts and the failed
   step index (if any).

```ts
export interface IPipelineRunResult {
  succeeded: number;
  failed: number;
  cancelled: number;
  failedStepIndex: number | null;
}
```

### 4.3 Why sequential (not a Celery chain)

Steps must be strictly ordered and each must fully commit its annotations /
property values before the next reads them. The frontend already has clean
promise-based completion, so the simplest correct design is **frontend-driven
sequential await** — identical to the existing batch runner. A backend Celery
`chain` is possible but would require passing the user token through the chain,
new job-DAG plumbing (`girder_result_hooks` is currently commented out in
`tasks.py:50`), and duplicate progress modeling. Rejected for v1; note it as a
future scalability option (moves orchestration server-side so a pipeline
survives a browser refresh).

### 4.4 Persistence actions

In `src/store/pipelines.ts`, mutations + actions mirroring the tool CRUD in
`index.ts`:

- `addPipeline(pipeline)`, `editPipeline(pipeline)`, `removePipeline(id)`,
  `reorderPipelineSteps`, `addStep`, `editStep`, `removeStep`, `reorderSteps`.
- Each mutating action updates `main.configuration.pipelines` and calls
  `main.syncConfiguration("pipelines")`. (Keep the source of truth on
  `main.configuration`; the pipelines module holds *run-time* state — current
  run progress, cancel handle, per-step status — not the persisted list. This
  matches how `jobs.ts` holds run-time job state separate from configuration.)

### 4.5 Batch × pipeline (v2, spec now to avoid rework)

"Run this pipeline on all datasets in the collection" is the outer product of
the batch runner and the pipeline runner: for each dataset view
(`findDatasetViews({ configurationId })`), run the whole pipeline, awaiting it
before the next dataset. Add `ProgressType.BATCH_PIPELINE_COMPUTE`. Reuse the
`BATCH_DATASET_LIMIT` guard. Implement after v1 lands; the `runPipeline` action
already takes a `datasetId`, so the outer loop is thin.

**As implemented:** the batch captures the loaded configuration's id when it
starts and hands it to each dataset's run (`runPipeline`'s `configurationId`),
so a run that starts after a switch fails on its first step. The datasets left
after a switch are not run and count as failed. The batch reloads linked
properties (`loadMissingLinkedProperties`) only if its configuration is still
loaded when the reload starts: it awaits the dataset list first, and a reload
after a switch would check the other configuration's properties and record
this pipeline's sources as missing for the rest of the session.

---

## 5. Tag wiring (the data contract, made usable)

Steps communicate only through tags + shape (§Terminology). The editor UI must
make this correct-by-default so users don't have to reason about it:

- An annotation step's **output tags** = `step.annotation.tags`.
- A property step's **input filter** = `step.inputTags` + `step.shape`.
- **Auto-wire rule:** when a property step is added *after* an annotation step,
  default its `inputTags.tags` to the nearest preceding annotation step's output
  tags, and its `shape` to that step's `annotation.shape`. Surface this visually
  (draw a connector / show "reads `nuclei` from step 1").
- If the user edits an upstream step's output tags, prompt to update downstream
  input filters that were auto-wired (track an `autoWired` flag per property step
  to know which to offer updating; don't clobber manual edits).
- **As implemented:** auto-wired steps (`autoWired: true`) are re-wired
  automatically rather than prompted, by `computeAutoWiredSteps`
  (`src/utils/pipelineWiring.ts`) — in the editor whenever it shows the
  pipeline, and by the runner on the steps as they run (so a linked tool's
  changed output tags reach the property steps after it even when the
  pipeline is run from the list without being reopened). Only steps flagged
  `autoWired: true` are wired, in the editor and the runner alike: the editor
  sets the flag on every property step it adds (the flag shipped with
  pipelines), so an unflagged step was made elsewhere and its tags may be
  deliberate. A manual tag or shape edit sets `autoWired: false`. The editor
  keeps wired tags on its working copy, so a step keeps them if its upstream
  step is later removed or disabled.
- **Validation (warn, don't block):** before running, flag property steps whose
  `inputTags` match no upstream output tags and no pre-existing annotations —
  they'll compute on nothing. Show as a non-blocking warning in the editor.

Tags are free-form strings shared with the rest of the app; there's no tag
registry to update. A pipeline that outputs `nuclei` and one that filters
`nuclei` are wired purely by string equality on the dataset.

---

## 6. AI pipeline suggestion (Claude Sonnet)

> **Removed.** The AI pipeline-suggestion feature (the `claude_pipeline`
> backend route, the `PipelineSuggestDialog`, the `suggestPipelines` store
> action / `ChatAPI` method, and the `origin: "ai"` badge) has been removed
> pending a replacement in a separate update. The design below is retained as
> historical context only — none of it is wired up in the current code. The
> separate **tool**-suggestion feature (`claude_suggest_tools`, the lightbulb in
> the Tools panel) is unaffected and still uses `girder_claude_chat/common.py`.

### 6.1 Shape of the feature

Given (a) the worker images installed on the server, (b) the current dataset's
context (channel names, annotation shapes/tags already present), and (c) an
optional natural-language goal from the user ("count nuclei and measure their
intensity"), Claude returns **N suggested pipelines** as **structured JSON**
conforming to a schema. The user reviews suggestions, picks one, and it is
materialized into an editable `IPipeline` (nothing runs automatically).

### 6.2 Backend endpoint (extend `girder-claude-chat`)

Add a route to the existing plugin — it already owns the Anthropic client and
`ANTHROPIC_API_KEY`. **(recommended)** new resource route
`POST /api/v1/claude_chat/suggest_pipeline` (or a sibling resource
`claude_pipeline`), `@access.user`.

**Keep the backend thin:** the frontend already has `workerImageList`, cached
worker interfaces, layer/channel names, and existing tags. Have the frontend
assemble the *catalog + context + goal* and POST it; the backend's only job is
to call Claude with a forced-tool-use request and return validated JSON. This
avoids the backend querying the Docker daemon and keeps all NimbusImage domain
knowledge on the client.

Request body:

```jsonc
{
  "goal": "count nuclei and measure their intensity",   // optional, may be ""
  "context": {
    "channels": ["DAPI", "GFP", "Cy5"],
    "existingTags": ["nuclei"],
    "existingShapes": ["polygon"]
  },
  "annotationWorkers": [   // from workerImageList filtered isAnnotationWorker
    { "image": "...", "name": "Cellpose SAM", "description": "...",
      "annotationShape": "polygon",
      "interface": { /* IWorkerInterface: id -> {type, default, min, ...} */ } }
  ],
  "propertyWorkers": [     // filtered isPropertyWorker
    { "image": "...", "name": "Blob metrics", "description": "...",
      "interface": { /* ... */ } }
  ],
  "maxSuggestions": 3
}
```

Backend Claude call (net-new tool-use pattern; the SDK is already a dependency):

```python
response = self.client.messages.create(
    model=PIPELINE_MODEL,          # 'claude-sonnet-4-6' — see §6.5
    max_tokens=4096,
    system=[{'type': 'text', 'text': PIPELINE_SYSTEM_PROMPT,
             'cache_control': {'type': 'ephemeral'}}],   # cache the static rules
    tools=[SUGGEST_PIPELINES_TOOL],   # JSON schema, see §6.3
    tool_choice={'type': 'tool', 'name': 'suggest_pipelines'},  # force structured output
    messages=[{'role': 'user', 'content': json.dumps(request_body)}],
)
# Extract the tool_use block, return its validated `input`.
block = next(b for b in response.content if b.type == 'tool_use')
return {'suggestions': block.input['pipelines']}
```

Error handling: catch `anthropic.APIError` (and JSON/validation errors)
specifically — do **not** copy the existing `except Exception` in
`claude_chat` (CLAUDE.md forbids broad catches; see §8).

### 6.3 The tool schema

`SUGGEST_PIPELINES_TOOL` (Anthropic tool with `input_schema`). This *is* the
contract; the frontend re-validates against it before trusting a suggestion.

```jsonc
{
  "name": "suggest_pipelines",
  "description": "Return suggested analysis pipelines built ONLY from the provided worker images.",
  "input_schema": {
    "type": "object",
    "required": ["pipelines"],
    "properties": {
      "pipelines": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name", "rationale", "steps"],
          "properties": {
            "name": { "type": "string" },
            "rationale": { "type": "string" },
            "steps": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["kind", "image", "name"],
                "properties": {
                  "kind": { "enum": ["annotation", "property"] },
                  "image": { "type": "string" },   // MUST be one of the provided images
                  "name": { "type": "string" },
                  "outputTags": { "type": "array", "items": {"type": "string"} },  // annotation steps
                  "inputTags": { "type": "array", "items": {"type": "string"} },   // property steps
                  "shape": { "enum": ["point","line","polygon","rectangle","circle","ellipse","any"] },
                  "workerInterfaceValues": { "type": "object" },  // best-effort param values
                  "reason": { "type": "string" }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### 6.4 System prompt

A short, static ruleset (cached). It must instruct Claude to:

- Use **only** images present in the provided lists (never invent an image).
- Put annotation-producing steps before the property steps that depend on them.
- Wire tags: an annotation step's `outputTags` should be reused as the
  `inputTags` of downstream property steps that operate on those objects.
- Prefer parameter values within each interface element's declared `min/max`,
  else omit and let defaults apply.
- Return 1–`maxSuggestions` pipelines, most useful first, each with a one-line
  `rationale`.

The existing `system_prompt_1.txt` in `girder-claude-chat` already documents the
canonical workflows (Cellpose → blob metrics, Connect Sequential, etc.); reuse
that prose as source material, but the *authoritative* worker list comes from
the request payload, not the prompt (installed images vary per deployment).

### 6.5 Model id

`claude-sonnet-4-6` is the only model id in the repo, hardcoded in
`girder_claude_chat/__init__.py:53`. Introduce a module constant
`PIPELINE_MODEL = 'claude-sonnet-4-6'` (or a Girder Setting) so the two call
sites don't drift. Do not hardcode a third literal.

### 6.6 Frontend flow

- New API method in a suitable client (`ChatAPI.ts` is the natural home given it
  owns `girderRestProxy` and the chat endpoint, or a new `PipelineAPI.ts`):
  `suggestPipelines(goal, context)` → `POST claude_chat/suggest_pipeline`.
- The pipelines store assembles the catalog from `propertiesStore.workerImageList`
  + cached interfaces (`fetchWorkerInterface` for each, or send only labels and
  fetch interfaces on accept), plus channel/tag/shape context from `main`.
- **Validate every returned suggestion** against the installed image list; drop
  or flag steps whose `image` isn't installed. Never trust the model's image
  strings blindly.
- Render suggestions as cards (name + rationale + step chips). "Use this" →
  convert the suggestion JSON into an `IPipeline` (map `outputTags` →
  `annotation.tags`; `inputTags`/`shape` → property step filter; clamp/merge
  `workerInterfaceValues` against the real interface defaults) with
  `origin: "ai"`, open it in the builder for review/edit before the user runs it.

---

## 7. UI

**Entry point:** a single **Pipelines** button in `Toolset.vue`'s action row
(beside "Add new tool") calls `store.setIsPipelineDialogOpen(true)`. There is no
separate Pipelines palette and no Object Browser button — one way in.

`PipelineDialog.vue` hosts two views, **list** and **editor**. It creates one
run controller (`createPipelineRunController`, `usePipelineRun.ts`) and
`provide()`s it so the editor, the list, and the status strip share a single
in-flight run and it survives the dialog closing/reopening. Components under
`src/components/pipelines/`.

### 7.1 Run status strip (every view)

`PipelineRunStatus.vue` — a compact strip rendered above the content in **both**
views. Injects the controller; shows the running (or last-run) pipeline name,
current step, a mini progress bar, Cancel, and the result summary. The overall
progress bar lives in the app's global progress widget (the runner already
publishes a `PIPELINE_COMPUTE` progress entry), so this strip stays minimal.

### 7.2 Pipeline list

`PipelineList.vue` — lists `configuration.pipelines`. The row body opens the
editor; a quick **Run** (via the controller) and a ⋮ overflow (Duplicate /
Delete) sit at the right. "New pipeline" at the top. No Edit-vs-Run fork.
(The "Suggest with AI" entry point was removed — see §6.)

### 7.3 Editor (unified build + run)

`PipelineEditor.vue` — the single detail view where you both edit and run.

- Name/description, an ordered step list (up/down reorder), Add step,
  enable/disable, remove. Editing works on a local clone; auto-wiring (§5) runs
  on load and after every edit.
- "Add step" → annotation worker / property worker (via `DockerImageSelect.vue`),
  **Existing tool**, which adds an annotation step *linked* to a worker-backed
  tool (`type: "segmentation"`) — its image, `workerInterfaceValues`, annotation
  setup, `connectTo`, `jobDateTag` start as a copy of the tool's (the inverse of
  the runner's `buildTransientTool`) — or **Existing property**, which adds a
  property step linked to a configuration property. See §3.4.
- Per-step editor reuses `WorkerInterfaceValues.vue` and (for annotation steps)
  `AnnotationConfiguration.vue`. **Do not build new parameter widgets.**
- **Run status is inline on the same step rows**: a spinner while running, then
  ✓ / ✗, plus the running step's progress bar/errors and a **Logs** button
  (shown once the step's job exists — the runner reports job ids via
  `onStepJob`; opens the shared `JobLogDialog.vue`, which overlays the live SSE
  log and fetches the persisted log after completion).
- Footer: **Save** and **Run** (Run is enabled whenever the pipeline has an
  enabled step and nothing else is running). **Run saves first**, then runs the
  saved pipeline, so the run reflects on-screen edits and the runner's
  materialized-property write-back lands on the persisted pipeline.
- Run options: `continueOnError`, non-blocking pre-run warnings (§5), and "Apply
  to all datasets in collection" reusing the batch guard.

Follow `BUTTON_CONVENTIONS.md` (primary/secondary/etc. + required `variant`/`size`
and loading states) and log via `logError`/`logWarning`, not `console.*`
(nimbus-frontend skill).

---

## 8. Related cleanup (out of scope, but note in the PR)

The suggest work touches `girder-claude-chat`; flag (don't necessarily fix) the
pre-existing issues found during design so they aren't mistaken for new
regressions:

- `except Exception` broad catch in `claude_chat` (`__init__.py:65-69`) —
  violates CLAUDE.md. The new endpoint must not copy it.
- Hardcoded system-prompt path `/src/girder-claude-chat/system_prompt_2.txt`
  (`__init__.py:23`), and the `system_prompt_1.txt` vs `_2.txt` filename
  mismatch.
- Model id centralization (§6.5).

---

## 9. Implementation plan (ordered)

> _Historical: this is the original build order. Steps 1–5 and 8 shipped; steps 6
> and 7 (AI suggest) were built then removed — see **Status** at the top for the
> current state and open follow-ups._

1. **Model + persistence.** Add `IPipeline`/step interfaces and
   `pipelines: IPipeline[]` to `model.ts`; default `[]` in the config factory;
   read defensively as `?? []`. Add `pipelines` to `configuration.py`'s JSON
   schema if one exists. Add `ProgressType.PIPELINE_COMPUTE` (+ `BATCH_` for v2).
2. **Submitter refactor.** Expose promise-returning single-step submitters for
   annotation (transient tool) and property paths (§4.1). Verify the existing
   single-step UIs still work.
3. **Pipelines store.** New `src/store/pipelines.ts`: CRUD (sync to config) +
   `runPipeline` (§4.2) + `ensureMaterializedProperty` (§3.3). Unit-test the
   sequencing with mocked `jobs.addJob` promises.
4. **Builder + list + run UI** (§7), reusing `DockerImageSelect`,
   `WorkerInterfaceValues`, `AnnotationConfiguration`.
5. **Tag wiring** auto-defaults + pre-run validation (§5).
6. **AI suggest backend:** new route on `girder-claude-chat` with forced
   tool-use + schema (§6.2–6.4); centralize model id.
7. **AI suggest frontend:** catalog assembly, `suggestPipelines` API,
   suggestion cards, validate-then-materialize (§6.6).
8. **Batch × pipeline** (v2, §4.5).

Each of 1–3 is independently reviewable and testable before any UI exists.

## 10. Testing

- **Frontend unit (Vitest):** `runPipeline` sequencing — mock `addJob` to
  resolve promises in order; assert steps run in order, a failed step with
  `continueOnError=false` aborts the rest, cancel stops the loop and cancels the
  current job, and end-of-run refreshes fire once. Test `ensureMaterializedProperty`
  create-vs-reuse. Test suggestion→`IPipeline` conversion incl. dropping
  uninstalled images.
- **Backend (pytest/tox, `girder-claude-chat`):** the new endpoint with a mocked
  Anthropic client — assert it forces `tool_choice`, returns the tool `input`,
  and raises specific (not broad) exceptions on API/JSON errors. (The
  AnnotationPlugin compute paths are unchanged, so their existing tests cover the
  runner's building blocks.)
- **Manual (nimbus-local-ops):** define Cellpose SAM → Blob metrics → Blob
  intensity on a real dataset; confirm blobs get tagged, both properties compute
  on them, and property columns populate in the Annotation Browser.

## 11. Open decisions for the implementer

1. **UI home:** dedicated Pipelines panel vs a tab in the Annotation Browser vs a
   section in `Toolset.vue`. (Recommend a dedicated panel; least coupling.)
2. **Property cleanup on delete:** confirm-to-delete materialized properties vs
   always keep. (Recommend confirm.)
3. **Suggest endpoint placement:** new route on `girder-claude-chat` vs new
   resource. (Recommend a new route on the existing resource — least new
   plumbing.)
4. **Whether v1 ships batch-across-datasets** or defers to v2. (Recommend defer;
   the runner already takes `datasetId` so it's additive.)

## Regression checklist

Linked steps (§3.4):

- A tool-linked step runs with the tool's current values, not its saved copy —
  *"runs a linked annotation step with its tool's current values"*.
- With the tool deleted, it runs its saved copy —
  *"runs a linked annotation step from its saved copy when the tool is gone"*.
- A tool without a worker image is reported as such, not as deleted —
  *"stepLinkState distinguishes linked, missing and unlinked steps"*.
- A property-linked step computes the user's property directly: no
  materialization, no deletion, no configuration write —
  *"computes a linked property step on the existing property without materializing"*.
- With the property deleted, it materializes from its saved copy —
  *"materializes a linked property step from its saved copy when the property is gone"*;
  but a property that had not loaded yet is reloaded and computed, not
  duplicated (also in the editor), a failed reload fails the step without
  holding the run lock, and a step on its fallback is not rechecked —
  *"reloads properties once before treating a linked property as deleted"*,
  *"does not reload properties when every linked property is loaded"*,
  *"reloads properties on open when a linked property is missing"*,
  *"fails a missing linked property step when the reload fails, without materializing or holding the run lock"*,
  *"holds the run lock while it reloads linked properties"*,
  *"does not reload a linked property already running its fallback"*,
  *"runs a step already on its fallback when another step's reload fails"*.
- Removing a property in the Properties panel names the steps that use it
  (linked or created it, disabled ones included) and asks to "Remove anyway",
  is blocked while a running pipeline computes it (also in the handler), and
  reports a refused removal instead of closing —
  *"lists the pipeline steps that use a property"*,
  *"keeps the dialog open and says why when the removal is refused"*,
  *"deletes the computed values of the dataset the removal started on"*,
  *"finds the running pipeline that computes a property"*,
  *"names the pipeline steps linked to the property and offers Remove anyway"*,
  *"blocks removing a property while a pipeline that computes it is running"*.
- An import with "Overwrite properties" lists the steps that use the
  properties it would remove, is refused while a running pipeline computes one
  (the button and `importAnnotationsFromData` both), and keeps a property a run
  started computing during the import —
  *"lists the pipeline steps that use a property an overwrite would remove"*,
  *"lists the pipeline steps that use the properties an overwrite would remove"*,
  *"refuses to overwrite properties while a pipeline that computes one is running"*,
  *"disables the import while a pipeline that computes an overwritten property runs"*,
  *"keeps a property a pipeline started computing during the import"*.
- Drift replacement never deletes a property another step links to —
  *"does not delete a drifted-away property that another step links to"*.
- Deleting a pipeline never deletes a linked property, nor a property it
  materialized that another pipeline links to —
  *"never deletes a linked property when its pipeline is deleted"*,
  *"keeps a materialized property another pipeline links to when its own pipeline is deleted"*.
- A new materialized id reaches the stored step at once (the store's current
  copy), so a property every step drifted away from in one run is deleted, not
  orphaned —
  *"deletes a property both of whose steps drifted away from it in one run"*,
  *"records a new materialized id on the store's current copy of the pipeline"*.
- A batch runs every dataset with the linked settings resolved at its start,
  and a run whose steps can't be prepared fails without holding the lock —
  *"runs every dataset with the linked settings resolved when the batch started"*,
  *"fails the run without holding the lock when its steps can't be prepared"*.
- A property confirmed missing in a configuration is not refetched on every
  open or run there (but is in any other configuration, and while the loaded
  list is another configuration's), and a reload overlapped by a
  configuration switch confirms nothing —
  *"does not recheck a linked property a reload confirmed missing"*,
  *"does not carry a property found missing in one configuration to another"*,
  *"reloads linked properties while the loaded list is another configuration's"*,
  *"does not confirm a linked property missing when the configuration changes during the reload"*.
- A configuration switch mid-run stops the run: the next step fails (even with
  continue-on-error), a batch runs no further datasets, ids materialized
  before the switch (or a switch away and back) are saved to the run's own
  configuration, and nothing is written through the property list after a
  switch —
  *"fails the next step and stops when the configuration changes during a run"*,
  *"does not run a batch's remaining datasets after a configuration switch"*,
  *"fails a batch child that starts after the configuration switched"*,
  *"saves a materialized property id to the run's configuration after a switch"*,
  *"stops when the property creation sees a configuration switch"*,
  *"keeps a property created just before a switch and leaves the stale one"*,
  *"keeps ids materialized before a switch away and back"*,
  *"registers nothing when another configuration opens during the create request"*,
  *"refuses to save a property list loaded for another configuration"*,
  *"refuses to save a property list no fetch has loaded"*,
  *"keeps a list another configuration's fetch loaded during a failed save"*,
  *"keeps a later save's propertyIds when an earlier overlapping save fails"*,
  *"keeps a later save's pipelines when an earlier overlapping save fails"*,
  *"restores the configuration's propertyIds when the save fails"*,
  *"restores what the server holds when overlapping saves both fail (earlier first)"*,
  *"restores what the server holds when overlapping saves both fail (out of order)"*,
  *"restores the saved pipelines when overlapping saves both fail"*,
  *"rebuilds the list from the restored ids when a fetch landed during a failed save"*,
  *"ends on an earlier save's value when a later save fails before it is sent"*,
  *"restores onto the reloaded configuration after a switch away and back"*,
  *"rebuilds another configuration's list when its save fails while one on the first is pending"*,
  *"keeps a property adopted during a pending save when that save fails"*,
  *"keeps a property adopted during a save that succeeds when a later overlapping save fails"*,
  *"polls a scheduled job until it succeeds, adopting its property at once"*,
  *"schedules the job in pixels, polls it, and reloads the properties"*,
  *"carries over an adopted property no fetch has loaded yet when saving"*,
  *"sends a save queued behind a failed one"*,
  *"does not reconcile another configuration's plots after a switch during the save"*,
  *"does not reload linked properties for a batch whose configuration switched before the reload"*.
- The runner re-wires property steps to what a linked tool produces now, but
  never an unflagged step —
  *"re-wires a property step to the output tags its linked tool produces now"*,
  *"does not rewire a property step without an autoWired flag at run time"*.
- An unchanged re-emit changes no editor state (no render loop) —
  *"changes no editor state on an unchanged re-emit"*.
- The editor shows linked steps live, never reads that as unsaved —
  *"shows a linked step with its tool's live values on open, without marking it dirty"*,
  *"shows a tool change made elsewhere while the editor is open"*.
- What the editor derives from a live source follows it, not just the display.
  An auto-wired step keeps the wiring last shown when its upstream step is
  removed or disabled (only tags and shape: its exclusive-match setting stays
  its own), and a step editor loads the worker interface of an image that
  changed outside it, without writing a linked step's values —
  *"keeps the wiring last shown when the upstream step is removed"*,
  *"keeps the wiring last shown when the upstream step is disabled"*,
  *"keeps an exclusive-match change on an auto-wired step"*,
  *"loads the worker interface when a linked step's image changes"*,
  *"does not seed a step with the first image's defaults after another image was picked"*.
- A run submits what the editor shows. An annotation step's worker values get
  the interface default for any parameter they lack (as the tool's own menu
  does; an accepted AI tool suggestion is saved without values), loading the
  interface only if it was never fetched. A cancel during that load, or during
  the submit request, stops the job. Property steps are not filled: their
  values are the materialized property's parameters, compared for drift —
  *"submits a linked tool's interface defaults for parameters it has no value for"*,
  *"loads an uncached worker interface before filling defaults"*,
  *"does not refetch a worker interface the worker does not have"*,
  *"does not submit a step cancelled while its worker interface loads"*,
  *"cancels a job whose run was cancelled while it was being submitted"*.
- Nothing is read from another configuration's property list (right after a
  switch, before this one's fetch lands): the runner neither computes a
  linked property found there nor materializes from a miss there, and the
  editor neither shows nor offers its properties —
  *"does not compute a linked property from another configuration's list after a failed reload"*,
  *"does not materialize a property from another configuration's list"*,
  *"does not offer or show another configuration's properties while this one's are loading"*.
- A linked step is read-only: its settings are locked with a pointer to the
  Tools panel, and only its name and enabled flag change —
  *"locks a linked step's settings and says where to edit them"*,
  *"emits only name and enabled changes for a linked step"*,
  *"keeps a linked step's saved copy when a settings edit comes in"*,
  *"leaves an unlinked step's settings editable"*,
  *"keeps only the name and enabled flag from an edit to a linked step"*.
- Every control in a locked section renders disabled, not just inert. A child
  that forwards an explicit `disabled: false` overrides the provider's global
  default (TagPicker did, leaving the Tags field looking editable), so pass
  `undefined` when not disabled —
  *"inherits a disabled default from a v-defaults-provider"*.
- Viewing writes nothing, and re-emits change nothing —
  *"shows a linked step's defaults without writing them on mount"*,
  *"does not treat a child re-emitting a linked step with undefined keys as an edit"*,
  *"changes no editor state on an unchanged re-emit"*.
- Save refreshes linked steps' stored copies, and edits made during a save stay
  unsaved —
  *"refreshes a linked step's stored copy to its tool's settings on save"*,
  *"stays unsaved for edits made during a save"*.
- Unlink keeps the shown values, including parameters the worker no longer
  declares, and renames a property step —
  *"keeps the shown values when a linked step is unlinked"*,
  *"keeps saved parameters the worker no longer declares on unlink"*,
  *"renames a property step on unlink so its own property is told apart"*.
- Removing a step offers to remove the property the runner materialized even
  if the editor's copy predates it; pipeline-materialized properties are not
  offered for linking —
  *"offers to remove the property the runner materialized on the stored pipeline"*,
  *"does not offer a pipeline-materialized property to link to"*.
- Auto-wiring leaves property-linked and unflagged steps alone, and wired tags
  survive removing the upstream step —
  *"does not auto-wire a step linked to an existing property"*,
  *"does not auto-wire a property step without the autoWired flag"*,
  *"keeps a wired property step's tags when its upstream step is removed before saving"*.
