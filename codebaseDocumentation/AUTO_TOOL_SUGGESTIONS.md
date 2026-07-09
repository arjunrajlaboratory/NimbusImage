# Automatic Tool Suggestions

> **Status: first pass / scaffold.** This feature works end-to-end but was
> built quickly and deliberately left rough in a few places (timing, prompt
> tuning, tests). This doc is written so Opus (or anyone) can pick it up and
> polish it later. Search the code for `AUTO_TOOL_SUGGESTIONS.md` to find the
> touch points that reference this doc.

## What it does

When a user opens a **freshly created collection** (a configuration with no
tools yet), NimbusImage:

1. Takes a screenshot of the image in the viewport.
2. Sends it, plus a catalog of the tools it can set up, the dataset's channel
   names, and display-layer metadata (layer color + visibility), to a backend
   endpoint. The layer metadata lets Claude map rendered colors back to channel
   names without cloning the full browser UI.
3. Claude (Sonnet 5) looks at the image and returns a structured list of
   suggested tools (e.g. Cellpose-SAM on the nuclear channel if it sees nuclei,
   a blob tool if it sees blobs, Piscis if it sees spots).
4. The frontend resolves each suggestion into a ready-to-add
   `IToolConfiguration` and shows them in a small floating panel in the viewer.
   The user clicks **Add** (or **Add all**) to add them to the toolset, or
   **Not now** to dismiss.

Suggestions are human-in-the-loop by design: nothing is added to the
configuration until the user accepts it.

## Files

### Backend — `devops/girder/plugins/girder-claude-chat/girder_claude_chat/__init__.py`

- `CLAUDE_MODEL` — single constant for the model id. **This is where the model
  is set for the whole plugin.** Currently `claude-sonnet-5` (migrated from
  `claude-sonnet-4-6`).
- `ClaudeChatResource` (existing chat endpoint, `POST /claude_chat`) — updated
  to use `CLAUDE_MODEL`, `max_tokens=8192`, and to collect **text blocks** from
  the response instead of assuming `content[0]` is text (Sonnet 5 runs adaptive
  thinking by default, so a thinking block can come first).
- `ClaudeSuggestToolsResource` (new endpoint, `POST /claude_suggest_tools`) —
  takes `{ images, catalog, channels, layers }`, builds a single user message
  with the image blocks + a text description, and uses a **forced tool call**
  (`tool_choice = {type: 'tool', name: 'suggest_tools'}`) to get structured
  output. Thinking is disabled here because forced `tool_choice` is incompatible
  with extended thinking. Returns `{ suggestions: [...] }`.
  - `SUGGEST_TOOLS_SYSTEM_PROMPT` — inline system prompt (the chat endpoint
    loads its prompt from `system_prompt_2.txt`; this one is inline for now — a
    follow-up could move it to a file for consistency).
  - `SUGGEST_TOOLS_TOOL` — the JSON schema for the forced tool call.

### Frontend

- `src/utils/interfaceCapture.ts` — shared screenshot helpers
  (`captureInterfaceScreenshot`, `captureViewportScreenshot`,
  `dataUrlToBase64`) used by both chat and automatic tool suggestions.
  (The name is `interfaceCapture` because `utils/screenshot.ts` already exists
  and is about image *download* URLs, unrelated to this.)
- `src/store/ChatAPI.ts` —
  `getToolSuggestions({ images, catalog, channels, layers })` posts to
  `claude_suggest_tools` and returns the raw suggestions.
- `src/store/model.ts` — new types: `IToolSuggestionCatalogEntry`,
  `IToolSuggestion`, `IResolvedToolSuggestion`, `TToolSuggestionStatus`.
- `src/store/toolSuggestions.ts` — new Vuex module. This is the brain:
  - `AUTO_SUGGEST_ENABLED` — feature flag (top of file).
  - `buildCatalog()` — catalog from `properties.workerImageList` (annotation
    workers) + a fixed `MANUAL_CATALOG` (the blob tool).
  - `buildToolConfiguration()` — turns a catalog entry + suggestion into an
    `IToolConfiguration`, mirroring what `ToolTypeSelection.vue` does (drops the
    `dockerImage` submenu element for worker tools, seeds `values.image.image`,
    builds the annotation setup, and maps a suggested channel name to a
    configuration layer id).
  - `maybeSuggestForCurrentConfiguration()` — the guarded entry point. Runs only
    if: feature enabled, configuration + dataset present, configuration has **no
    tools**, and we haven't already suggested for this configuration id this
    session (`seenConfigurationIds`).
  - `suggestForCurrentConfiguration()` — captures the viewport screenshot,
    sends display-layer context, calls the API, resolves suggestions. It only
    falls back to a full-interface screenshot if the viewport screenshot is not
    available, because `html2canvas` can trip on browser-extension CSS.
  - `acceptSuggestion()` / `acceptAllSuggestions()` — call
    `main.addToolToConfiguration()`.
- `src/components/ToolSuggestions.vue` — the floating panel (loading / error /
  list states, Add / Add all / Not now / dismiss).
- `src/views/datasetView/Viewer.vue` — renders `<tool-suggestions />` and calls
  `maybeSuggestForCurrentConfiguration()` when `ImageViewer` emits `layers-ready`
  (fired on the layers' `onIdle` false→true transition, i.e. once the image has
  actually finished rendering).
- `src/components/ImageViewer.vue` — emits `layers-ready` when its `layersReady`
  computed (derived from per-layer `onIdle` callbacks) first becomes true with
  at least one layer present.

## Data flow

```
Viewer.vue (config changes, map ready, empty tools, unseen)
  -> toolSuggestions.maybeSuggestForCurrentConfiguration()
     -> capture viewport screenshot (interfaceCapture.ts)
     -> buildCatalog() from worker images + manual tools
     -> buildLayerContext() from current display layers
     -> ChatAPI.getToolSuggestions({ images, catalog, channels, layers })
        -> POST /claude_suggest_tools
           -> Sonnet 5 forced tool call -> { suggestions: [{toolId, channelName, reason, confidence}] }
     -> resolve each suggestion -> IResolvedToolSuggestion { suggestion, catalogEntry, tool }
  -> ToolSuggestions.vue shows them
     -> user clicks Add -> main.addToolToConfiguration(tool)
```

## How the mapping works

- **Worker tools** (Cellpose-SAM, Piscis, etc.): discovered from
  `properties.workerImageList` — any image whose labels have
  `isAnnotationWorker` defined. Catalog id is `worker:<image>`. Claude matches
  "nuclei"→Cellpose-SAM and "spots"→Piscis by the worker's `interfaceName` /
  `description` labels, so the quality of those labels matters.
- **Blob tool**: a fixed `MANUAL_CATALOG` entry (`manual:blob`) that builds a
  manual `create` tool with polygon shape.
- **Channel targeting**: if Claude sets `channelName`, the frontend finds the
  dataset channel with that name (`dataset.channelNames`) and the configuration
  layer on that channel, and sets it as the annotation setup's `layer`.

## Resolved from Codex review (PR #1224)

- **Empty worker catalog on first open.** `properties.fetchWorkerImageList()`
  is otherwise only called by the tool-picker / worker-menu UI, so on a first
  open `workerImageList` was `{}` and the catalog contained only `manual:blob`
  — Cellpose/Piscis could never be suggested. `suggestForCurrentConfiguration`
  now awaits `fetchWorkerImageList()` before building the catalog.
- **Stale results after switching collections.** The action now captures the
  configuration id at the start and discards the result (status → idle) if
  `main.configuration` changed while the request was in flight, so suggestions
  computed for the old collection's channels/layers aren't applied to a new one.

## Known rough edges / TODO for the polish pass

1. ~~**Screenshot timing.** Fixed delay after the map appears.~~ **Done** — the
   trigger is now driven by `ImageViewer`'s `layers-ready` event, which fires
   off the layers' `onIdle` callbacks, so we capture once tiles have actually
   rendered rather than guessing with a timer.
2. **Trigger definition.** "New collection" is approximated as "configuration
   with zero tools that we haven't seen this session." That also fires for any
   pre-existing empty collection the user opens. If a stricter "just created"
   signal is wanted, thread a flag through the collection-creation flow
   (`DatasetInfo.createDefaultView` / `NewDataset.vue`).
3. **`seenConfigurationIds` is session-only** (Vuex state, lost on reload).
   Consider persisting per-configuration "already suggested / dismissed" so it
   doesn't re-prompt across reloads.
4. **Prompt tuning.** The system prompt is a first draft. The nuclei / blobs /
   spots guidance is hard-coded; consider deriving it from the catalog
   descriptions instead so new worker types get sensible treatment for free.
5. **Structured output.** The backend uses a forced tool call for structured
   output. Sonnet 5 also supports `output_config.format` (JSON schema) — could
   switch if the installed `anthropic` SDK version supports it, which would let
   us keep adaptive thinking on.
6. ~~**Duplication.** `ChatComponent.vue` still has its own screenshot
   functions.~~ **Done** — `ChatComponent.vue` now uses
   `utils/interfaceCapture.ts` (a thin `captureViewportScreenshot` wrapper is
   kept there so the component's no-arg exposed method still works for its
   test).
7. ~~**Tests.**~~ **Done (frontend).** `src/store/toolSuggestions.test.ts` and
   `src/components/ToolSuggestions.test.ts` cover the guards, resolution logic,
   accept flow, visibility, and confidence sort/chip. The **backend**
   `/claude_suggest_tools` endpoint still has no test — a good next candidate.
8. ~~**Confidence field** is returned but unused in the UI.~~ **Done** — the
   panel now shows a confidence chip and sorts high→medium→low. Could still
   additionally *filter out* low-confidence suggestions if desired.

## Model migration note

Both Claude calls in the plugin now use `claude-sonnet-5` via the `CLAUDE_MODEL`
constant. When migrating again, change that one constant. Sonnet 5 specifics
that affected this code:

- Adaptive thinking is on by default → the chat endpoint must collect `text`
  blocks rather than reading `content[0].text`.
- Forced `tool_choice` is incompatible with extended thinking → the suggestion
  endpoint sets `thinking={'type': 'disabled'}`.
