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

1. **Knowledge = hybrid, but near-lossless.** A small *concepts core* is
   concatenated into the cached agent system prompt (always on); the depth lives
   in per-topic `.md` files fetched on demand by a new **`read_help_topic`**
   tool. The split is a **reorganization, not a compression** — the topic files
   preserve the original `system_prompt_2.txt` prose essentially verbatim (only
   dropping genuine duplication and re-pointing "click here" UI directions where
   the agent now has a tool). We are not trying to shrink the knowledge base;
   progressive disclosure just controls *when* it enters context, not *how much*
   of it exists.
2. **Keep the walkthroughs.** The procedural "how do I do this myself in the UI"
   content is *not* dropped — it becomes one of the help topics, so a user who
   wants to learn to do it by hand still gets a real answer. It just stays out
   of the always-on prompt so it doesn't reshape the agent's action-first
   behavior.
3. **Topic files live in the backend package** (single source of truth, shipped
   the same way as `agent_system_prompt.txt` / `agent_tools.json`).
4. **Persist both** the display transcript and the wire history to browser-local
   IndexedDB, so a reloaded conversation is continuable (the model still
   remembers).
5. **Cut screenshots before persisting** (reuse `pruneOldScreenshots`).
6. **Do not persist** `turnSnapshot` / `canRevert` — session-only.
7. **Single stored conversation, wiped when a different user logs in.** One slot,
   tagged with the owning user id; the same user (incl. after a reload) restores
   it, a different user wipes it. No per-user history map.
8. **Durable/backend persistence is explicitly deferred.** Storing conversations
   server-side (cross-device, shareable, in Mongo) is a plausible future want but
   out of scope here — browser-local IndexedDB is all v1 needs.

## Knowledge architecture

`system_prompt_2.txt` is **split, not summarized**: its sections move into the
files below with their prose intact. Nothing is deleted except literal
duplication; the source file is removed only once its content lives in the new
layout.

- **Concepts core → agent system prompt** (backend, cached prefix): the
  vocabulary the agent needs to reason and to route to topics — objects,
  connections, properties, tags, datasets vs collections, what a property/
  annotation worker is. This is the prompt's "Core Concepts" section carried
  over, lightly trimmed; keep it faithful rather than terse.
- **Depth → `help/*.md` topic files** (backend package), each a near-verbatim
  slice of the original, self-contained:
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
(own DB, e.g. `AgentConversationDB`, a **single** stored record, not a per-user
map). No Vuex reactivity (native IDB objects break under proxies, same
constraint chat had). Record: `{ userId, items, wireMessages, updatedAt }`.

- **Save**: after each completed turn in `sendUserMessage`; `pruneOldScreenshots
  (wireMessages)` runs before write so base64 images never hit disk. The record
  is tagged with the current user id.
- **Restore + wipe rule**: on load (and whenever `handleAuthenticatedUserChange`
  fires), compare the stored record's `userId` to the current user. Same user →
  restore `items` + `wireMessages` into memory. Different user (or no stored
  record) → wipe the record and start empty. So a reload by the same user keeps
  the conversation; a different user logging in clears it (decision #7).
- **Clear button** wipes the in-memory conversation **and** the stored record.
- **Not persisted**: `turnSnapshot`, `canRevert`, pending approvals — restoring
  them stale is meaningless; on reload `canRevert` is false.
- Login-gated (`canUseAiPanel` requires a user), so there is no anonymous bucket.
- **Deferred (decision #8):** durable server-side storage in Mongo. IndexedDB is
  the whole persistence story for v1; no backend schema, endpoint, or migration.

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
- `aiPanel.ts`: same-user restore rehydrates `items` + `wireMessages`; a
  different-user id wipes the stored record; clear wipes persistence; a restored
  wire history is resent verbatim on the next turn.
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

- **Faithful split** is the real work: moving `system_prompt_2.txt` into the
  concepts core + topics without losing content (decision #1 — reorganize, don't
  compress). Worth a human read of the generated `help/*.md` against the original
  to confirm nothing was silently dropped.
- **Persistence semantics** (same-user restore vs different-user wipe vs per-turn
  save vs clear-button wipe) are the fiddliest part; the implementation plan
  should pin the exact `handleAuthenticatedUserChange` / `clearConversation`
  control flow, including the load-then-identity-check order on first mount.
- Continuing a persisted conversation after reloading on a *different* dataset
  relies on the existing dataset-identity guards (round-1 finding #1 / round-3
  R3-1) — no new mechanism needed, but worth a live check.
