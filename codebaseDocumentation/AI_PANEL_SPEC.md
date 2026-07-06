# AI Panel — Agent-Driven Interface Control (Design Spec)

> **Status: Option A implemented on this branch (first pass).** What exists:
> the `POST /claude_agent` relay endpoint with server-held system prompt and
> tool definitions (`girder-claude-chat/agent_tools.json`), the executor
> registry (`src/agent/executors.ts`), the agent-loop store
> (`src/store/aiPanel.ts`), and the panel UI (`src/components/AiPanel.vue`)
> with transcript cards, Run/Cancel gating, stop, and per-turn view revert.
> Tier 3 currently ships `run_worker` only; `add_tool`, `compute_property`,
> `create_annotations`/`delete_annotations`, `save_contrast`, `navigate`,
> `set_display_options`, `get_property_summary` and the `fit` variant of
> `set_camera` are not yet implemented. Streaming, token budgets and
> IndexedDB persistence remain Phase 4.
>
> This document specifies an
> "AI panel" where a user converses with an agent that can *drive the
> NimbusImage interface* — move to a location, recolor layers and
> annotations, apply filters, select tools, run workers — through a curated
> set of tool definitions rather than the full REST API. It builds on the
> chat integration (`ChatComponent.vue` / `girder-claude-chat`), the
> tool-suggestion work in PR
> [#1224](https://github.com/arjunrajlaboratory/NimbusImage/pull/1224), the
> `nimbusimage` Python API (`codebaseDocumentation/NIMBUSIMAGE_API.md`), and
> the MCP design thoughts (`codebaseDocumentation/NIMBUSIMAGE_MCP_DESIGN.md`).

## 1. Motivation

NimbusImage already has three ways an LLM touches the app:

1. **NimbusChat** (`ChatComponent.vue` + `POST /claude_chat`) — Claude *sees*
   the interface (two screenshots per message) and answers questions, but
   cannot *do* anything.
2. **Tool suggestions** (PR #1224, `POST /claude_suggest_tools`) — Claude
   looks at the viewport and proposes tool configurations via a forced tool
   call; the frontend resolves them into real `IToolConfiguration` objects
   the user can accept. One-shot, single-purpose.
3. **`nimbusimage` Python API** — full programmatic access to the *data*
   (annotations, images, workers), designed for notebooks/workers/MCP, but
   it operates on the backend and knows nothing about the live UI a user is
   looking at.

The AI panel is the missing quadrant: **conversational + acts on the live
interface**. The user says *"go to the third timepoint, show only the DAPI
layer, and color all the nuclei annotations that touch the edge red"* and
watches it happen in their own viewport. This is a genuinely different
interaction modality from both chat (passive) and the Python API (headless):
the agent and the user share a screen, and every agent action is immediately
visible, inspectable, and (where possible) undoable.

Guiding principles:

- **Curated tools, not the full API.** The agent gets a small, purpose-built
  tool surface that maps 1:1 onto existing Vuex actions — the same actions
  the UI's own buttons call. No new capabilities are invented; the agent can
  only do what a user could do by clicking.
- **The user's session, the user's permissions.** Every action executes in
  the browser with the user's Girder token. The agent can never do something
  the logged-in user couldn't.
- **Visible and reversible by default.** Actions render in an action
  transcript in the panel; annotation mutations ride the existing undo
  history; view-state changes are snapshotted before the agent runs so a
  single "revert" restores where you were.

## 2. UX design

### 2.1 The panel

A dockable side panel (reusing the floating-card pattern of
`ChatComponent.vue`, or docked like the annotation browser), opened from the
app bar next to the existing chat button. Contents:

- **Conversation** — user messages and assistant text, markdown-rendered
  (same as NimbusChat).
- **Action transcript** — interleaved with the conversation, each tool call
  renders as a compact card: icon + human-readable description
  ("Moved to Z=4, T=2", "Set layer *DAPI* to #4477FF", "Started worker
  *Cellpose-SAM* on channel 1") + status (running / done / failed) + a
  revert affordance where applicable.
- **Composer** — text input, image attach/paste (reuse from ChatComponent),
  a stop button while the agent is running, and an *auto-approve* toggle
  (see §7).
- **Context chips** — small indicators of what the agent currently sees:
  current dataset/collection, whether a screenshot was captured this turn.

### 2.2 Example interactions

```
User: What am I looking at?
Agent: [get_interface_state, capture_screenshot]
       You're on dataset "000001HCR", collection "spots-v2", at XY=0, Z=3,
       T=0, with 3 of 4 layers visible. The image shows ~40 DAPI-stained
       nuclei with cytoplasmic FISH spots in the Cy3 channel.

User: Hide everything except DAPI and brighten it a bit.
Agent: [update_layer ×3 (visible=false), update_layer (contrast)]
       Done — only DAPI is visible now, white point pulled down to the 95th
       percentile.

User: Color the selected annotations by tag: nucleus=blue, spot=yellow.
Agent: [get_annotation_summary, color_annotations ×2]
       Colored 220 nucleus annotations blue and 1,834 spot annotations
       yellow.

User: Run Piscis on the Cy3 channel across all Z.
Agent: [list_workers, get_worker_interface, run_worker]  ← gated, asks first
       Piscis takes ~2 min for this dataset. Start it?   [Run] [Cancel]
       ... (job progress streams into the transcript) ...
       Done — 1,912 spot annotations created on channel Cy3.
```

### 2.3 Relationship to NimbusChat

The AI panel supersedes NimbusChat in the long run — a chat that can also
act is strictly more useful than one that can't. Plan: build the panel as a
separate component behind a feature flag, sharing the capture helpers
(`utils/interfaceCapture.ts` from PR #1224) and message rendering; once
stable, fold NimbusChat's Q&A role into it and retire the old panel. Chat
history stays client-side in IndexedDB initially (same `ChatHistoryDB`
pattern), moving server-side only if/when sessions need to survive across
devices (see §10).

## 3. The tool surface

Tools are grouped in three tiers. Tier 1 and 2 execute **in the browser**
against Vuex; tier 3 executes **on the backend** (data operations that don't
need the live UI). Every tool maps onto an existing store action or API
method — the executor registry (§6) is a thin table, not new logic.

### 3.1 Tier 1 — Read / grounding tools (auto-approved, side-effect free)

| Tool | Returns | Maps to |
|------|---------|---------|
| `get_interface_state` | Structured snapshot: dataset/collection ids+names, location (xy/z/time + maxes), layer mode, camera, layers (id, name, channel, color, contrast, visible), selected tool, active filters, annotation counts by shape/tag, selection count | assembled from `main`, `filters`, `annotation` getters |
| `capture_screenshot` | `{interface?, viewport?}` images, pushed into the conversation as image blocks | `captureInterfaceScreenshot` / `captureViewportScreenshot` (PR #1224 helpers) |
| `get_annotation_summary` | Counts grouped by tag/shape/channel, optionally within current filters or current frame | `annotation`/`filters` getters |
| `list_annotations` | Paged, trimmed annotation records (id, shape, tags, location, centroid, color) matching a filter query | `filters.filteredAnnotations` / annotation store |
| `list_tools` | Tools in the current configuration + available tool templates | `main.tools`, `main.toolTemplateList` |
| `list_workers` | Available worker images with labels/descriptions | `properties.workerImageList` |
| `get_worker_interface` | Parameter schema for a worker image | `properties.fetchWorkerInterface` |
| `get_property_summary` | Property definitions + basic stats/histogram for a property path | `properties`, `filters.getHistogram` |

`get_interface_state` is the workhorse: it is cheap, textual (no image
tokens), and precise where screenshots are fuzzy. The system prompt
instructs the agent to prefer it and to reserve `capture_screenshot` for
questions about *image content* (what's in the field of view) rather than
*app state*.

### 3.2 Tier 2 — UI action tools (auto-approved by default; all reversible)

| Tool | Parameters (abridged) | Maps to |
|------|----------------------|---------|
| `set_location` | `{xy?, z?, time?}` (absolute or `{delta}`) | `main.setXY/setZ/setTime` |
| `set_camera` | `{center?, zoom?}` or `{fit: "annotations" \| "selection" \| "full"}` | `main.setCameraInfo` / GeoJS map |
| `set_layer_mode` | `{mode: "single"\|"multiple"\|"unroll", unroll?: {xy?, z?, t?}}` | `main.setLayerMode`, `setUnroll*` |
| `update_layer` | `{layerId, color?, visible?, contrast?, name?, channel?}` | `main.changeLayer` |
| `set_layer_visibility` | `{visibleLayerIds: string[]}` (declarative — hides the rest) | `main.changeLayer` loop |
| `save_contrast` | `{layerId, contrast, scope: "view"\|"configuration"}` | `saveContrastInView/Configuration` |
| `select_annotations` | `{query: {tags?, shape?, channel?, currentFrameOnly?, ids?}, mode: "replace"\|"add"\|"remove"}` | `annotation.setSelected` etc. |
| `color_annotations` | `{target: "selection"\|query, color: string\|null, randomize?}` | `annotation.colorAnnotationIds` |
| `tag_annotations` | `{target, tags, mode: "add"\|"remove"\|"replace"}` | `annotation.addTagsByAnnotationIds` etc. |
| `set_annotation_filter` | `{tags?: {tags, exclusive}, currentFrameOnly?, propertyFilters?, clear?}` | `filters.setTagFilter`, `updatePropertyFilter`, ... |
| `set_display_options` | `{drawAnnotations?, annotationOpacity?, showScalebar?, backgroundColor?, ...}` | the `main.set*` display mutations |
| `select_tool` | `{toolId \| null}` | `main.setSelectedToolId` |
| `navigate` | `{to: "datasetview"\|"dataset"\|"configuration"\|"project", id}` | `router.push` + `setSelectedDataset/Configuration` |
| `undo` / `redo` | `{}` | `annotation.undoOrRedo` |

Reversibility notes:

- Annotation color/tag changes go through the backend and are on the
  **existing history stack** — `undo` genuinely reverts them.
- View state (location, camera, layer colors/contrast/visibility, mode,
  filters, selection) has **no history stack**. Before the first Tier-2
  call of each agent turn, the executor snapshots the relevant slices
  (location, cameraInfo, layer array, layerMode, filter state, selection)
  into panel-local state; the transcript exposes **"Revert view changes"**
  per turn. This is a plain restore of captured values — no new store
  infrastructure needed. (The existing `addSnapshot`/`loadSnapshotLayers`
  collection snapshots are user-facing and persisted; we deliberately do
  not pollute them.)

### 3.3 Tier 3 — Mutating / long-running tools (gated: require confirmation)

| Tool | Parameters (abridged) | Maps to | Why gated |
|------|----------------------|---------|-----------|
| `run_worker` | `{image, channel?, tags?, location scope, workerInterface values}` | `annotation.computeAnnotationsWithWorker` (+ `jobs.addJob` for progress) | compute cost, creates many annotations |
| `compute_property` | `{propertyId \| create: {...}}` | `properties.computeProperty` | compute cost |
| `add_tool` | `{templateId \| catalogEntry, name, channel/layer targeting, values}` | `main.addToolToConfiguration` (reuse `buildToolConfiguration` from PR #1224's `toolSuggestions.ts`) | mutates shared configuration |
| `create_annotations` | `{annotations: [...]}` (bulk) | annotation store bulk create | data mutation (undoable, but bulk) |
| `delete_annotations` | `{target: selection\|query}` | bulk delete | destructive (undoable, but scary) |
| `edit_layers` | `{add?, remove?, group?}` | `main.addLayer/removeLayer/groupLayers` | mutates shared configuration |

Gating UX: the tool call renders in the transcript with **Run / Cancel**
buttons and a plain-language summary of what will happen ("Run
`cellpose-sam:latest` on channel 2, all Z, tagged `nucleus` — creates
annotations"). Cancel returns a structured `{declined: true, reason}` tool
result so the agent can re-plan rather than erroring. The auto-approve
toggle (§7) can lift the gate for a session.

### 3.4 What is deliberately *not* in the surface (v1)

- Sharing/permissions changes (`set_public`, `share`) — high blast radius,
  low conversational value.
- Dataset upload/import — huge frontend workflow, separate project.
- Raw REST escape hatch — defeats the purpose of a curated surface.
- Freeform pixel/geometry computation — this is where the **managed agent /
  code execution** option comes in (§5, Option B); the tool surface stays
  curated and code execution is a separate, contained capability.

### 3.5 Schema conventions

- Tool names are snake_case verbs; every description states *visible
  effect* + *reversibility* ("Changes are visible immediately. Reversible
  via revert-view.") so the model can reason about caution.
- Annotation-targeting tools share one `query` sub-schema (tags, shape,
  channel, currentFrameOnly, ids) resolved by a single frontend helper
  against `filters.filteredAnnotations` — one implementation, used by
  select/color/tag/delete.
- Layer references accept `layerId` **or** `layerName`/`channelName`
  (resolved with the same channel-name mapping PR #1224 uses); the model
  usually knows names from `get_interface_state`, not ids.
- All Tier-2/3 tools return a short structured result
  (`{ok, summary, affectedCount?, jobId?}`), which becomes the `tool_result`
  content — cheap for the model to verify against.

Full JSON Schemas live in a single frontend module (see §6) so the tool
definitions, the executor registry, and the TypeScript types cannot drift
apart.

Example (representative of the pattern):

```jsonc
{
  "name": "color_annotations",
  "description": "Set the display color of annotations. Pass color=null to clear the override so annotations fall back to their layer color. Undoable via the undo tool.",
  "input_schema": {
    "type": "object",
    "properties": {
      "target": {
        "oneOf": [
          { "const": "selection" },
          { "$ref": "#/definitions/annotationQuery" }
        ]
      },
      "color": { "type": ["string", "null"], "description": "#RRGGBB or null" },
      "randomize": { "type": "boolean", "default": false }
    },
    "required": ["target", "color"]
  }
}
```

## 4. What the model sees (context assembly)

Each agent turn is assembled as:

1. **System prompt** — role, tool-usage guidance (prefer
   `get_interface_state`; screenshot only for image content; confirm before
   gated tools; keep replies short since actions are self-evidencing), and
   NimbusImage domain vocabulary (layers vs channels, collections vs
   configurations, tags, workers). Stored as a file in the plugin like
   `system_prompt_2.txt`, versioned with the repo.
2. **Conversation history** — prior user/assistant/tool messages for this
   panel session (client holds them; see §6 transport).
3. **A fresh `get_interface_state` snapshot** injected into the first user
   message of each turn (cheap, keeps the model grounded without it having
   to burn a tool round-trip on every turn).
4. **Screenshots on demand** — *not* auto-attached every message (unlike
   NimbusChat). The `capture_screenshot` tool returns them mid-loop when
   the agent decides it needs eyes. This keeps token cost proportional to
   need; image blocks are the dominant cost in the current chat.

## 5. Architecture options

The central question: **where does the agent loop run?** Three options,
plus the recommendation. In all options the Anthropic API key stays
server-side and tools execute in the browser with the user's session.

### Option A — Backend relay, frontend-driven loop ("thin proxy")

Extend `girder-claude-chat` with an agent endpoint; the **frontend owns the
loop**, the backend is a stateless proxy that adds the API key, the system
prompt, and the tool definitions.

```
Browser (AI panel)                    Girder (girder-claude-chat)      Anthropic
──────────────────                    ───────────────────────────      ─────────
POST /claude_agent  {messages}   ──►  attach key+system+tools     ──►  messages.create
                                 ◄──  {content, stop_reason}      ◄──  (tool_use blocks)
execute tool_use via registry
  (Vuex actions, user's token)
POST /claude_agent  {messages +
  assistant turn + tool_results} ──►  ...loop until stop_reason
                                       != "tool_use" or max iters
```

- Conversation state lives in the browser (IndexedDB), exactly like chat
  today. The backend stays stateless — no sessions, no storage.
- Streaming: v1 can be non-streaming per round-trip (tool loops make
  perceived latency acceptable because actions appear in the transcript as
  they execute). v2 adds SSE pass-through for token streaming.
- Backend work is small: one new resource class, `CLAUDE_MODEL` reuse,
  tool definitions loaded from a JSON file (or fetched from the request —
  see the trust note in §7).
- Limitations: no code execution; every model round-trip re-sends history
  (mitigated with prompt caching, which the plugin already uses for the
  system prompt); loop dies if the tab closes (acceptable — the whole point
  is the user is watching; running workers survive anyway since jobs are
  backend-side and `jobs` re-attaches via WebSocket).

### Option B — Managed agent service (Claude Agent SDK + code execution)

A new long-lived service in `docker-compose` (like the workers) running the
**Claude Agent SDK**. The agent loop runs server-side; the browser connects
over a WebSocket. UI tools are implemented as *custom tools that relay to
the browser*: the service sends `{tool_call}` frames, the panel executes
them against Vuex and replies with `{tool_result}` frames.

```
Browser (AI panel) ◄─WebSocket─► Agent service (Agent SDK, sandboxed)
     │ executes UI tools              │ agent loop, code execution,
     │ renders transcript             │ nimbusimage Python API
     ▼                                ▼
  Vuex / GeoJS                     Girder REST (user's token, forwarded)
```

What this buys beyond Option A:

- **Code execution**: the agent writes and runs Python in a sandbox with
  `import nimbusimage as ni`, using the user's token. Freeform analysis
  ("compute the ratio of spot count to nucleus area per cell and tag the
  top decile") without pre-building a tool for every question. This is the
  "other stuff" a managed agent enables and the single biggest capability
  gap between the options.
- Long-running autonomy: loops survive tab refresh/close; the panel
  reconnects to a session.
- Subagents, file workspace, richer orchestration (Agent SDK features).

Costs:

- A new stateful service: session lifecycle, auth handoff (mint a scoped
  Girder token for the session), scale-out and idle reaping.
- **Sandboxing is load-bearing**: code execution with a user token must be
  containerized per session (the Girder Worker docker plumbing is precedent,
  but per-session interactive containers are a different shape from batch
  jobs).
- The browser bridge (relay tool calls over WS, await results, handle
  disconnects mid-call) is real protocol work.
- Operationally heaviest of the options for self-hosted installs.

### Option C — Direct from browser to Anthropic

The panel calls the Anthropic API directly (user-supplied key or
`anthropic-dangerous-direct-browser-access`). Rejected: the deployment's
key cannot ship to browsers; per-user keys are a non-starter for lab users;
and it forfeits server-side prompt/tool versioning, caching, logging, and
rate limiting. Mentioned only for completeness.

### Option D (variant of B) — MCP instead of bespoke protocol

Rather than a bespoke WS protocol, the browser bridge is an **MCP server
living in the panel** (MCP has a streamable-HTTP/WS transport; the browser
exposes `ui_*` tools), and the agent service is any MCP client — the Agent
SDK, Claude Code, or claude.ai connectors. The `nimbusimage` MCP server
from `NIMBUSIMAGE_MCP_DESIGN.md` plugs into the same session for data
tools. This maximizes reuse (the same UI tool surface would work from
Claude Code during development!) at the cost of MCP plumbing in the
browser. Worth keeping in mind as the *shape* of Option B rather than a
separate destination.

### Comparison

| | A: Backend relay | B: Managed agent | C: Direct | D: MCP variant of B |
|---|---|---|---|---|
| Agent loop location | Browser drives | Service | Browser | Service |
| Backend state | None | Sessions | None | Sessions |
| Code execution | No | **Yes (sandboxed)** | No | Yes |
| Survives tab close | No (jobs do) | Yes | No | Yes |
| New infra | ~1 endpoint | New service + sandbox + WS | None | New service + MCP bridge |
| Key safety | Server-side | Server-side | **Exposed / per-user** | Server-side |
| Reuses PR #1224 pattern | Directly | Partially | Partially | Partially |
| Time to first demo | **Days** | Weeks | Days | Weeks |
| OSS/self-host friction | Low | Medium-high | Low | Medium-high |

### Recommendation: A first, designed so B slots in

Build **Option A** now. Its critical property: the valuable, hard-won parts
— the tool definitions, the frontend executor registry, the transcript UI,
the gating/approval model, revert — are **transport-independent**. The
executor registry doesn't care whether a tool call arrived from an HTTP
response body (A) or a WebSocket frame (B/D); it maps
`{name, input} → store action → result` either way.

When code execution earns its keep (users hitting the ceiling of the
curated surface), add the managed agent service as a *second transport*
plus one new capability (`run_python`), keeping everything else. Decide
B-vs-D (bespoke WS vs MCP bridge) then, when the MCP browser-transport
story is more settled.

## 6. Option A design details

### 6.1 Backend: `girder-claude-chat` additions

- `ClaudeAgentResource` → `POST /claude_agent` (`@access.user`), body
  `{messages}` where `messages` is already in Anthropic wire format
  (extending `toClaudeApiMessages`, which must learn `tool_use` /
  `tool_result` blocks).
- Server attaches: `CLAUDE_MODEL` (constant from PR #1224's branch —
  coordinate so both land compatibly), `max_tokens`, the **server-held
  system prompt** (`agent_system_prompt.txt`, `cache_control: ephemeral`),
  and the **server-held tool definitions** (`agent_tools.json`).
- Returns the raw `{content, stop_reason, usage}` — the frontend
  understands Anthropic content blocks (it nearly does already).
- Thinking: enable adaptive/interleaved thinking (this is a free-choice
  tool loop, not a forced tool call, so the PR #1224 incompatibility does
  not apply). Frontend must skip non-text/non-tool_use blocks when
  rendering — same fix the PR made for chat — and pass thinking blocks
  back verbatim in the next request per API requirements.
- Guardrails: cap request size, per-user rate limit (see
  `API_RATE_LIMITING_AUDIT.md` patterns), log usage per user.

### 6.2 Frontend: new modules

```
src/store/aiPanel.ts            Vuex module: session state, agent loop,
                                turn snapshots for revert, gating state
src/store/AgentAPI.ts           postAgentMessage(messages) → claude_agent
                                (Anthropic-wire-format aware)
src/agent/tools.ts              Tool schemas + TS input types (single
                                source of truth; a script exports the JSON
                                the backend serves, or backend serves this
                                file's JSON build artifact)
src/agent/executors.ts          Registry: name → async (input) => result
                                (thin: each entry calls existing store
                                actions; the annotationQuery resolver and
                                layerName resolution helpers live here)
src/components/AiPanel/         Panel, transcript cards, approval card,
                                revert control
```

Loop sketch (in `aiPanel.ts`):

```typescript
async runTurn(userText: string) {
  this.snapshotViewState();                 // for per-turn revert
  push(userMessage(userText, interfaceStateSnapshot()));
  for (let i = 0; i < MAX_ITERATIONS; i++) { // e.g. 20
    const res = await agentAPI.postAgentMessage(this.wireMessages);
    push(assistantMessage(res.content));
    if (res.stop_reason !== "tool_use") break;
    const results = [];
    for (const block of toolUseBlocks(res.content)) {
      results.push(await this.executeGated(block)); // sequential: order matters for UI
    }
    push(toolResultMessage(results));
    if (this.stopRequested) break;          // user hit Stop
  }
}
```

Tool calls execute **sequentially** — UI actions are order-dependent
(set location, then screenshot). `executeGated` renders the transcript
card, awaits approval for Tier-3 tools, catches executor exceptions and
returns them as `is_error` tool results so the model can recover.

`run_worker` inside a turn: the executor submits the job and returns
`{jobId, started: true}` immediately; job progress streams into the
transcript via the existing `jobs.addJob` callback. The agent may end its
turn with the job running; when the job's promise resolves, the panel
offers ("Worker finished — 1,912 annotations. Ask the agent to review?")
rather than auto-resuming the loop (keeps turns bounded and user-paced).

### 6.3 Errors

Executor failures, declined gates, and unresolvable references
(`layerName: "DAPI"` not found) all return structured tool_result errors
with what *is* available ("no layer 'DAPI'; layers: DAPI-368, Cy3, ...").
The model is instructed to correct and retry once, then ask the user.

## 7. Safety, permissions, trust

- **Authority = the user's.** All executors run in the browser against the
  user's Girder session; the backend endpoint requires `@access.user`.
  There is no service account, no privilege escalation surface. Backend
  security remains where it belongs (backend); the panel adds *friction*,
  not *enforcement*.
- **Tool definitions are server-held** (Option A): the browser does not
  tell the backend which tools exist, preventing a tampered client from
  turning the endpoint into a general-purpose Claude proxy with arbitrary
  tools. (The client-side executor obviously runs client-side; a malicious
  user can already call their own Vuex actions — the server-held list
  protects the *API-key-bearing endpoint*, not the browser.)
- **Gating tiers** (§3) with an auto-approve toggle: off by default;
  enabling it is per-session and surfaced in the composer ("Auto-approving
  worker runs and configuration changes"). Delete-type tools stay gated
  even under auto-approve in v1.
- **Turn budget**: `MAX_ITERATIONS` per turn, and a per-user daily token
  budget on the backend (usage is in every API response; accumulate per
  user in Mongo, refuse politely over budget).
- **Prompt-injection surface**: screenshots and annotation names/tags are
  attacker-influenceable in shared datasets. Mitigation: gated tiers for
  anything mutating shared state, and the system prompt treats dataset
  content as data, not instructions. Residual risk is bounded by "the agent
  can only do what this user could do".
- **Feature flag**: `VITE_AI_PANEL_ENABLED` (build-time) + graceful
  degradation when the backend lacks `ANTHROPIC_API_KEY` (panel hidden,
  same as chat today).

## 8. Cost & latency notes

- `get_interface_state` instead of screenshots-per-message is the main cost
  lever vs. NimbusChat (a 1080p screenshot ≈ 1,100+ tokens; the state
  snapshot is a few hundred, cacheable, and more accurate for app state).
- System prompt + tool definitions are stable per release → prompt cache
  them (`cache_control` on the system block and on the last tool, as the
  plugin already does for chat's system prompt).
- Model: `CLAUDE_MODEL` constant (currently `claude-sonnet-5` on the PR
  branch) — right latency/capability class for interactive UI driving. Not
  a place for a smaller model: tool selection against 25+ tools with domain
  vocabulary is exactly where quality pays.

## 9. Implementation plan

**Phase 0 — land/borrow PR #1224 pieces** (prerequisite): shared
`interfaceCapture.ts`, `CLAUDE_MODEL`, text-block-collection fix. If #1224
merges first, this is free; otherwise cherry-pick the utilities.

**Phase 1 — skeleton loop (1 tool)**: `POST /claude_agent` with
`get_interface_state` + `set_location` only; panel with conversation +
transcript cards; loop, stop button, max-iterations. Proves the wire format
end-to-end.

**Phase 2 — Tier 1+2 surface**: full read + UI-action tools, the
`annotationQuery` resolver, layer name resolution, per-turn view snapshot +
revert, error-as-tool_result.

**Phase 3 — Tier 3 + gating**: approval cards, auto-approve toggle,
`run_worker`/`compute_property`/`add_tool` (reusing PR #1224's
`buildToolConfiguration`), job progress in transcript.

**Phase 4 — polish**: streaming (SSE), token budgets, IndexedDB
persistence of panel sessions, prompt tuning with real transcripts,
retire-NimbusChat decision.

**Phase 5 (separate project) — managed agent transport (Option B/D)**:
session service, browser bridge, sandboxed `run_python` with
`nimbusimage`. Re-uses tools/executors/transcript unchanged.

## 10. Open questions

1. **Screenshot fidelity** — `html2canvas` misses WebGL canvases in some
   configurations; the viewport capture via GeoJS `map.screenshot` is
   reliable, the full-interface one less so. May need the GeoJS capture +
   `get_interface_state` to fully replace the interface screenshot.
2. **Multi-map / unroll** — camera and screenshot tools assume
   `maps[0]`; unroll mode and future multi-view need a `mapIndex` param or
   explicit unsupported-in-v1 statement.
3. **Session persistence** — is per-browser IndexedDB history acceptable
   (chat precedent says yes), or do agent sessions belong server-side from
   the start? Server-side becomes necessary anyway for Option B.
4. **Concurrent edits** — agent acting while the user also clicks around:
   last-write-wins via Vuex is probably fine (same as two hands on one
   keyboard), but revert snapshots may capture mixed state. Punt in v1;
   note in transcript that revert restores pre-turn state.
5. **Voice** — this modality is a natural fit for dictation ("go to the
   next timepoint"); browser SpeechRecognition into the composer is a cheap
   later add.
6. **When does code execution earn Option B?** Proposed trigger: recurring
   user requests that reduce to per-annotation math the tool surface can't
   express, or demand for unattended multi-step pipelines.
