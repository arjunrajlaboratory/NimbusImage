# AI Panel — Code Review Findings

Review of the `claude/ai-panel-interface-spec-9k6gsv` branch (AI panel agent).
Tracker for the fixing-review-findings workflow. Status values: `open`,
`fixed <commit>`, `stale`, `by-design`, `needs-decision`, `deferred — <reason>`.

Verified against current code on 2026-07-10 (post-commit 1e386703). All six
confirmed real and current.

---

## [P1] #1 Tool execution not bound to the originating dataset
**Location:** `src/store/aiPanel.ts:248` (turn snapshot), `src/agent/executors.ts:1010` (revert)
**Status:** fixed (pending commit) — snapshot now captures `datasetId`/`configurationId`/`datasetViewId`; new exported `viewIdentityChangedSince()`. `restoreViewState` throws if identity changed; `revertViewChanges` shows a clean "can't revert, switched datasets" message; the `sendUserMessage` loop aborts (with synthetic tool_results so the wire stays valid) if the dataset changed before running the response's tools. Tests: executors "view identity binding" (4) + aiPanel "dataset binding" (2).

`sendUserMessage` snapshots view state at turn start, but tool execution and
revert use whatever dataset/configuration/datasetView is *currently* active.
Navigating from dataset A to B during an API round-trip lets tools mutate B
using A's context. `restoreViewState` → `setViewContrastOverrides` writes A's
per-view contrast into B's `datasetView`. `snapshotViewState` captures no
dataset/config/view identity to detect the change.

**Fix direction:** capture `dataset.id` / `configuration.id` / `datasetView.id`
in the snapshot and at turn start; before each tool execution and before
revert, abort (and disable revert) if any changed.

---

## [P1] #2 Malformed annotation targets default to all annotations
**Location:** `src/agent/executors.ts:126` (`resolveAnnotationTargetIds`)
**Status:** fixed (pending commit) — `resolveAnnotationTargetIds` now rejects any `target` that isn't `"selection"` or a valid query object (new `validateAnnotationQuery` checks field types + unknown keys). Swept the sibling: `select_annotations` validates a provided query too (omitted still = all, reversible). Tests: "rejects malformed edit targets", "still resolves valid edit targets", "validates select_annotations queries".

Any `target` other than the string `"selection"` is passed to
`queryAnnotations(target)`. A missing target → `queryAnnotations(undefined)` →
default empty query → matches every annotation. A garbage string likewise
resolves to "all" (its `.ids`/`.tags` are undefined). Model tool inputs are not
runtime-validated, and `color_annotations` / `tag_annotations` are **not gated**,
so a malformed call mass-edits the whole dataset with no approval.

**Fix direction:** validate `target` before resolving — accept only `"selection"`
or a plain object; reject `undefined`/`null`/non-object (and validate query
field shapes). Applies to every `resolveAnnotationTargetIds` caller.

---

## [P1] #3 Packaged Girder installs omit the agent prompt and tool schemas
**Location:** `devops/girder/plugins/girder-claude-chat/girder_claude_chat/__init__.py:37` (`PLUGIN_DIR`), `MANIFEST.in`, `setup.py` `package_data`
**Status:** fixed (pending commit) — moved both assets into `girder_claude_chat/`, load from `PACKAGE_DIR` (`AGENT_PROMPT_PATH`/`AGENT_TOOLS_PATH`), removed `PLUGIN_DIR`, added `*.json` to `package_data`. New test `testAgentEndpointLoadsPackagedAssets` (red→green under fresh tox sdist). Swept: no remaining root-relative asset loads.

`agent_system_prompt.txt` and `agent_tools.json` live at the plugin *root*.
`PLUGIN_DIR = dirname(PACKAGE_DIR)` loads them from there. But `MANIFEST.in`
only `graft`s `girder_claude_chat/` and `package_data` includes only package-
local `*.txt`. A non-editable install (tox sdist, PyPI-style) ships neither
file → `self.tools = []` → `/claude_agent` returns 503.

The **Docker image works** only because it installs editable from `/src/...`
(the root files are present). Introduced by this branch. Note: the branch's
`testAgentEndpointStreamsAndShapesResponse` passes only because it calls
`_stream_agent_response` directly, bypassing the `if not self.tools` guard.

**Fix direction:** move both files into `girder_claude_chat/`, load from
`PACKAGE_DIR`, add `*.json` to `package_data`. Add a test that the installed
distribution loads a non-empty toolset.

---

## [P1] #4 Conversation state survives account changes
**Location:** `src/store/aiPanel.ts:76` (`wireMessages`)
**Status:** fixed (pending commit) — new `handleAuthenticatedUserChange(userId)` action clears the conversation when the user id changes; wired to a `watch` on `store.girderUser?._id` in `App.vue`. `clearConversation(force)` force-clears mid-run, and `sendUserMessage` bails on a `conversationGeneration` mismatch so a late response can't leak into the next user's history. Tests in new `src/store/aiPanel.test.ts` (3, incl. mid-run leak).

`wireMessages` is module-level and cleared only by `clearConversation`. Logout
is client-side (`store.logout()` → `loggedOut()` mutation → `router.push`), **no
page reload**, and `loggedOut()` does not touch the AI panel. After logout +
another login, the next request includes the prior user's prompts, annotation
results and interface metadata.

**Fix direction:** clear/cancel the conversation whenever the authenticated
user (`store.girderUser`) changes.

---

## [P2] #5 Configuration tools report success when persistence fails
**Location:** `src/agent/executors.ts:581` (`update_layer` → `changeLayer` → `syncConfiguration`)
**Status:** deferred — leave as-is (app-wide sync contract); tracked in [#1239](https://github.com/arjunrajlaboratory/NimbusImage/issues/1239) (decision 2026-07-10)

`syncConfiguration` (`store/index.ts:1983`) catches backend errors and routes
them to `sync.setSaving(error)` — it never re-throws. So `update_layer` awaits,
reads back the locally-mutated layer, and returns success even when the backend
rejected the write (read-only config, network failure). The transcript says
"done" and the model reports success.

**Nuance:** this is the **app-wide** sync contract — every `syncConfiguration`
caller behaves this way, surfacing failures through the global saving-state
indicator, not exceptions. A "propagate + rollback" fix in the executor alone
diverges from that contract.

**Options:** (a) read the `sync` saving-state after the sync and surface a
failure in the tool result (light, consistent) — *recommended*; (b) make
`syncConfiguration` throw (app-wide change, risky); (c) accept as-is.

---

## [P2] #6 AI panel exposed when it cannot work
**Location:** `src/App.vue:365` (button), `:383-384` (panels)
**Status:** fixed (pending commit) — decided: login + `VITE_AI_PANEL_ENABLED` flag (default enabled), AI panel only; chat button unchanged (decision 2026-07-10). `App.vue` gates the button and panel behind `canUseAiPanel` (`aiPanelFeatureEnabled && store.isLoggedIn && !!store.girderUser`); `toggleAiPanel` no-ops when disallowed; a watcher closes the panel if the gate closes (logout). No runtime capability probe (option C not chosen).

The AI-panel button and panel render unconditionally — for anonymous users
(`/claude_agent` is `@access.user` → 401) and for deployments without the
plugin/`ANTHROPIC_API_KEY` (503). `AI_PANEL_SPEC.md:505-507` requires a
`VITE_AI_PANEL_ENABLED` build-time flag **and** graceful degradation when the
backend lacks the key ("panel hidden, same as chat today"). Neither is
implemented.

**Options for the gate:** (a) login only; (b) login + `VITE_AI_PANEL_ENABLED`
build flag (matches spec); (c) login + flag + runtime capability probe of the
backend (detects missing API key at runtime). Also: does the existing chat
button need the same treatment (the spec says "same as chat today")?

---

## Pattern sweeps (skill step 4)
- #2 → sweep every `resolveAnnotationTargetIds` / `queryAnnotations` caller for
  unvalidated model input.
- #1 → sweep for any executor/revert path assuming the active dataset equals the
  turn's dataset.
- #3 → sweep for any other runtime asset loaded from `PLUGIN_DIR` rather than
  `PACKAGE_DIR`.
