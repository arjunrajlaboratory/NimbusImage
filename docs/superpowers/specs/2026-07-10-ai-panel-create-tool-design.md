# AI Panel `create_tool` — Design

**Date:** 2026-07-10
**Branch:** `claude/ai-panel-interface-spec-9k6gsv`

## Problem

The AI panel can list, select, and run *existing* tools, but cannot create a
new one. So "Set up a DAPI manual blob tool for me" is unachievable — there is
no tool-creation executor. This adds one.

## Decisions (confirmed with user)

- **Scope:** manual tools (blob/point/line) **and** worker tools (Cellpose,
  Piscis, …) — the full creatable catalog.
- **Gating:** gated (requires user approval, like `run_worker`), because it
  mutates the shared collection config.

## Approach: reuse the tool-suggestions builders

`src/store/toolSuggestions.ts` already constructs an `IToolConfiguration` from a
catalog entry + channel (`buildToolConfiguration`, `buildCatalog`,
`layerIdForChannelName`, `buildAnnotationSetup`, `toolNameForSuggestion`). Rather
than duplicate this in the executor (CLAUDE.md: extract shared logic, don't
copy-paste), extract these into a shared module and have both the
suggestion flow and the agent path use it.

### Components

1. **`src/tools/creation/toolFromCatalog.ts` (new, extracted)**
   - `buildCatalog(): IToolSuggestionCatalogEntry[]`
   - `buildToolConfiguration(entry, opts: { channelName?: string; name?: string }): IToolConfiguration | null`
     — generalized from the current `(entry, suggestion)` signature to take a
     plain options object (the suggestion flow passes `{ channelName: suggestion.channelName }`).
   - helpers: `layerIdForChannelName`, `buildAnnotationSetup`, `toolName…`.
   - `MANUAL_CATALOG` extended: blob (polygon) + point + line.
   - `toolSuggestions.ts` imports these; its existing 600-line test suite
     guards the refactor.

2. **`create_tool` executor** (`src/agent/executors.ts`), `gated: true`:
   - Input: `manualShape` (`"polygon" | "point" | "line"`) **XOR**
     `workerImage` (string); optional `channelName`, optional `name`.
   - Validation: exactly one of manualShape/workerImage (reject both/neither);
     `requireLogin()`; require an open configuration; unknown `workerImage`
     (not in `buildCatalog()`) → `ToolExecutionError` ("use list_workers").
   - Build via the shared builder (resolving `channelName` → layer), then
     `await main.addToolToConfiguration(tool)`.
   - Return `{ toolId, name, type, channelName }`.
   - Does NOT auto-select the tool or join the revert snapshot (config change,
     not view state — like annotation edits). The model can `select_tool` after.

3. **Schema + surfacing:**
   - `create_tool` entry in `girder_claude_chat/agent_tools.json`.
   - `describeAgentToolCall` case → e.g. "Set up a DAPI Blob tool".
   - One line in `agent_system_prompt.txt` noting it can set up manual/worker
     tools (and to bind a channel with `channelName`).

## Testing

- Executor tests (`executors.test.ts`): create a manual tool bound to a channel;
  create a worker tool by image; reject both-provided; reject neither-provided;
  reject unknown worker image; `isGatedTool("create_tool") === true`.
- Existing `toolSuggestions.test.ts` covers the extracted builders (must stay
  green through the refactor).
- `agent_tools.json` remains valid JSON (tox `testAgentEndpointLoadsPackagedAssets`).

## Deploy note

The schema and prompt ship inside the plugin package, so a `docker compose
build girder && up -d girder` is required to make `create_tool` live. The
executor is frontend (dev-server hot-reload).

## Out of scope

- Manual shapes beyond blob/point/line (rectangle/circle/ellipse) — trivial to
  add to `MANUAL_CATALOG` later.
- Setting worker interface parameter values at creation time — worker tools are
  created with defaults; `run_worker` handles parameters at run time.
- Editing/deleting existing tools.
