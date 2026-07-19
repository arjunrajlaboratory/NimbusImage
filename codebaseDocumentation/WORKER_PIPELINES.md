# Worker Pipelines

## Status

Design specification. Not yet implemented. This document is written to a level
of detail sufficient for a single engineer to implement without further
architectural decisions. Where a decision has genuine trade-offs, the
recommended option is stated first and marked **(recommended)**; alternatives
are listed so they aren't re-litigated during review.

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
and re-run it on new datasets. A secondary feature uses an LLM (Claude Sonnet)
to *auto-suggest* common pipelines from the worker images installed on the
server and the current dataset's contents.

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
dataset configuration. It does **not** reference existing `tools[]` / `propertyIds[]`
entries; each step embeds its own worker configuration. Rationale:

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
}

export type TPipelineStep = IAnnotationPipelineStep | IPropertyPipelineStep;

export interface IPipeline {
  readonly id: string;
  name: string;
  description?: string;
  steps: TPipelineStep[];
  // Provenance, for UI badges and analytics. "ai" = came from suggest feature.
  origin?: "user" | "ai" | "preset";
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
   - If `isCancelled`, mark remaining as cancelled and break.
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

---

## 5. Tag wiring (the data contract, made usable)

Steps communicate only through tags + shape (§Terminology). The builder UI must
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
- **Validation (warn, don't block):** before running, flag property steps whose
  `inputTags` match no upstream output tags and no pre-existing annotations —
  they'll compute on nothing. Show as a non-blocking warning in the run panel.

Tags are free-form strings shared with the rest of the app; there's no tag
registry to update. A pipeline that outputs `nuclei` and one that filters
`nuclei` are wired purely by string equality on the dataset.

---

## 6. AI pipeline suggestion (Claude Sonnet)

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
Delete) sit at the right. "New pipeline" and "Suggest with AI ✨" (§7.4) at the
top. No Edit-vs-Run fork.

### 7.3 Editor (unified build + run)

`PipelineEditor.vue` — the single detail view where you both edit and run.

- Name/description, an ordered step list (up/down reorder), Add step,
  enable/disable, remove. Editing works on a local clone; auto-wiring (§5) runs
  on load and after every edit.
- "Add step" → annotation worker / property worker (via `DockerImageSelect.vue`)
  or **Existing tool**, which imports a worker-backed tool (`type:
  "segmentation"`) from the configuration — copying its image,
  `workerInterfaceValues`, annotation setup, `connectTo`, `jobDateTag` into a new
  annotation step (the inverse of the runner's `buildTransientTool`).
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
