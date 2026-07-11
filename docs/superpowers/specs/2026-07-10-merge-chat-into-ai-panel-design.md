# Merge Nimbus Chat into the AI Panel — Design

**Date:** 2026-07-10
**Branch:** `claude/ai-panel-interface-spec-9k6gsv`

## Problem

Two Claude surfaces now coexist. **Nimbus Chat** (`ChatComponent.vue`,
`chat.ts`, the `claude_chat` endpoint) is Q&A + vision with a large NimbusImage
knowledge base (`system_prompt_2.txt`, ~14k tokens) and IndexedDB-persisted
history. **The AI Panel** (`AiPanel.vue`, `aiPanel.ts`, `AgentAPI.ts`, the
`claude_agent` endpoint) is a superset in capability — it answers questions,
sees screenshots, *and* drives the interface via ~28 tools — but its system
prompt is terse and its history is in-memory only.

The panel is a strict capability superset of chat except for two gaps:
**knowledge grounding** and **persistent history**. Closing those lets us retire
chat entirely, leaving one entry point.

## Decisions (confirmed with user)

1. **Knowledge = hybrid.** A small curated *concepts core* is concatenated into
   the cached agent system prompt (always on); the depth lives in per-topic
   `.md` files fetched on demand by a new **`read_help_topic`** tool.
2. **Keep the walkthroughs.** The procedural "how do I do this myself in the UI"
   content is *not* dropped — it becomes one of the help topics, so a user who
   wants to learn to do it by hand still gets a real answer. It just stays out
   of the always-on prompt so it doesn't reshape the agent's action-first
   behavior.
3. **Topic files live in the backend package** (single source of truth, shipped
   the same way as `agent_system_prompt.txt` / `agent_tools.json`).
4. **Persist both** the display transcript and the wire history, so a reloaded
   conversation is continuable (the model still remembers).
5. **Cut screenshots before persisting** (reuse `pruneOldScreenshots`).
6. **Do not persist** `turnSnapshot` / `canRevert` — session-only.
7. **One conversation per user** (keyed by user id). Chosen for simplicity and
   because the chatbot will likely extend across the whole interface later, not
   stay dataset-bound.

## Knowledge architecture

`system_prompt_2.txt` becomes *source material*, curated and split, then deleted:

- **Concepts core → agent system prompt** (backend, cached prefix, ~1–2k
  tokens): the vocabulary the agent needs — objects, connections, properties,
  tags, datasets vs collections, what a property/annotation worker is. Derived
  from the prompt's "Core Concepts" section.
- **Depth → `help/*.md` topic files** (backend package), each self-contained:
  - `file-formats.md` — supported formats, uploading
  - `interface-navigation.md` — navigating the UI, basic viewing/manipulation,
    tool-creation UI (the **kept walkthroughs**, decision #2)
  - `annotation-tools.md` — manual / semi-automated / selection-editing tools
  - `automated-tools.md` — worker/segmentation tools
  - `image-processing.md` — crop, registration, histogram matching, blur,
    deconvolution
  - `connections.md` — manual / automated / timelapse connections
  - `analysis-measurements.md` — property workers, intensity/geometric/count/
    distance measurements, filtering results
  - `workflows.md` — segmentation & analysis, similar-object search, RNA spots
  - `sharing-projects-zenodo.md` — sharing, projects, Zenodo publishing

The base agent prompt lists the available topic slugs + one-line descriptions
(built by the backend from the `help/` dir at load) so the model knows what it
can pull. The terse **`claude_suggest_tools`** system prompt is unrelated and
stays as-is.

## New tool: `read_help_topic`

- **Schema** (29th entry in `agent_tools.json`): `{ topic: string }`, described
  as "read NimbusImage help on a topic when you need to explain how something
  works or how the user can do it themselves."
- **Backend route** `GET claude_agent/help?topic=<slug>` on `ClaudeAgentResource`
  (`@access.user`): validates the slug against the `help/` manifest (inline
  `isinstance`/membership check → `RestException(400)` for unknown/garbage,
  per the public-endpoint-validation pattern) and returns the markdown text.
- **Executor** (`executors.ts`, browser): calls `main.agentAPI.getHelpTopic(slug)`
  (new method in `AgentAPI.ts`) and returns the markdown as the tool-result
  text. Read-only; not gated; not in `VIEW_STATE_TOOLS`. Unknown slug → a
  `ToolExecutionError` listing valid slugs so the model can retry.

Topic text lands in the (cacheable) wire history and is *not* pruned (unlike
screenshots) — that's the point. Growth is bounded by the number of distinct
topics a conversation pulls; acceptable for v1.

## Persistence

New unit `src/agent/conversationStore.ts` — a small, testable IndexedDB wrapper
(own DB, e.g. `AgentConversationDB`, one object store keyed by user id). No
Vuex reactivity (native IDB objects break under proxies, same constraint chat
had). Record: `{ userId, items, wireMessages, updatedAt }`.

- **Save**: after each completed turn in `sendUserMessage` and after
  `clearConversation`; `pruneOldScreenshots(wireMessages)` runs before write so
  base64 images never hit disk.
- **Load**: `handleAuthenticatedUserChange(userId)` stops clearing blindly —
  when the id changes it loads that user's persisted conversation into the
  in-memory `items` + `wireMessages` (or empties them if none), so switching
  accounts swaps histories instead of just wiping.
- **Clear button** wipes the in-memory conversation **and** the persisted record
  for the current user (explicit user intent).
- **Not persisted**: `turnSnapshot`, `canRevert`, pending approvals — restoring
  them stale is meaningless; on reload `canRevert` is false.
- Login-gated (`canUseAiPanel` requires a user), so there is no anonymous bucket.

## Removals & relocations

- **Delete**: `src/components/ChatComponent.vue`, `src/store/chat.ts`, the
  `claude_chat` endpoint + `ClaudeChatResource`, `system_prompt_2.txt` (after
  curation), and the chat toolbar button + `chatbotOpen` wiring in `App.vue`.
  The `mutually-exclusive panels` logic in `App.vue` collapses to one panel.
- **Relocate**: `getToolSuggestions` moves out of `ChatAPI.ts` into a new
  `src/store/ToolSuggestionsAPI.ts` (it drives the auto tool-suggestion flow and
  must survive chat's deletion); `claude_suggest_tools` / `ClaudeSuggestTools
  Resource` stay. Shared backend helpers (`_make_anthropic_client`,
  `_list_param`) stay. `renderMarkdown.ts` and `interfaceCapture.ts` stay.

## Testing

- `conversationStore.ts`: save/load/clear round-trips against a fake/in-memory
  IndexedDB; screenshot pruning on write.
- `aiPanel.ts`: user-change loads the right persisted conversation; clear wipes
  persistence; a persisted wire history is resent verbatim on the next turn.
- `read_help_topic` executor: returns topic text; unknown slug → `ToolExecution
  Error` with the valid slugs.
- Backend: `help` route returns known topics, 400s on unknown/malformed slug,
  `@access.user`. Curation is content-only (no logic test).
- Live: the agent answers a "how do I …" question by pulling a topic; a reloaded
  conversation continues with memory; chat's removal leaves no dead imports.

## Deploy note

Curated prompt, `help/*.md`, the tool schema, and the new route all ship in the
plugin package — needs a `docker compose build girder && up -d` to go live
(restart won't reload plugin code). `setup.py` `package_data` gains `help/*.md`.

## Open items / risks

- **Curation quality** is the real work: faithfully compressing the concepts
  core and splitting topics without losing accuracy. Worth a human read of the
  generated `help/*.md` against the original.
- **Persistence semantics** (switch-user load vs clear-button wipe vs per-turn
  save) are the fiddliest part; the implementation plan should pin the exact
  `handleAuthenticatedUserChange` / `clearConversation` control flow.
- Continuing a persisted conversation after reloading on a *different* dataset
  relies on the existing dataset-identity guards (round-1 finding #1 / round-3
  R3-1) — no new mechanism needed, but worth a live check.
