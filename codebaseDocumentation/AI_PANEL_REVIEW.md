# AI Panel — Code Review Findings

Review of the `claude/ai-panel-interface-spec-9k6gsv` branch (AI panel agent).
Tracker for the fixing-review-findings workflow. Status values: `open`,
`fixed <commit>`, `stale`, `by-design`, `needs-decision`, `deferred — <reason>`.

Verified against current code on 2026-07-10 (post-commit 1e386703). All six
confirmed real and current.

---

## [P1] #1 Tool execution not bound to the originating dataset
**Location:** `src/store/aiPanel.ts:248` (turn snapshot), `src/agent/executors.ts:1010` (revert)
**Status:** fixed — snapshot now captures `datasetId`/`configurationId`/`datasetViewId`; new exported `viewIdentityChangedSince()`. `restoreViewState` throws if identity changed; `revertViewChanges` shows a clean "can't revert, switched datasets" message; the `sendUserMessage` loop aborts (with synthetic tool_results so the wire stays valid) if the dataset changed before running the response's tools. Tests: executors "view identity binding" (4) + aiPanel "dataset binding" (2).

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
**Status:** fixed — `resolveAnnotationTargetIds` now rejects any `target` that isn't `"selection"` or a valid query object (new `validateAnnotationQuery` checks field types + unknown keys). Swept the sibling: `select_annotations` validates a provided query too (omitted still = all, reversible). Tests: "rejects malformed edit targets", "still resolves valid edit targets", "validates select_annotations queries".

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
**Status:** fixed — moved both assets into `girder_claude_chat/`, load from `PACKAGE_DIR` (`AGENT_PROMPT_PATH`/`AGENT_TOOLS_PATH`), removed `PLUGIN_DIR`, added `*.json` to `package_data`. New test `testAgentEndpointLoadsPackagedAssets` (red→green under fresh tox sdist). Swept: no remaining root-relative asset loads.

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
**Status:** fixed — new `handleAuthenticatedUserChange(userId)` action clears the conversation when the user id changes; wired to a `watch` on `store.girderUser?._id` in `App.vue`. `clearConversation(force)` force-clears mid-run, and `sendUserMessage` bails on a `conversationGeneration` mismatch so a late response can't leak into the next user's history. Tests in new `src/store/aiPanel.test.ts` (3, incl. mid-run leak).

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
**Status:** fixed — decided: login + `VITE_AI_PANEL_ENABLED` flag (default enabled), AI panel only; chat button unchanged (decision 2026-07-10). `App.vue` gates the button and panel behind `canUseAiPanel` (`aiPanelFeatureEnabled && store.isLoggedIn && !!store.girderUser`); `toggleAiPanel` no-ops when disallowed; a watcher closes the panel if the gate closes (logout). No runtime capability probe (option C not chosen).

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

---

# Round 2 — /branch-review 2026-07-10 (post view/settings + property tools)

Second review round after the view/settings, property-chain, and `create_tool`
tools landed. All five verified real and current before fixing.

## [R2-1] `get_property_values` RangeError on large datasets
**Location:** `src/agent/executors.ts` (get_property_values stats loop)
**Severity:** Medium · **Status:** fixed

`Math.min(...values)` / `Math.max(...values)` spread an uncapped per-annotation
array, throwing `RangeError` past the engine's argument limit (~65k) — reachable
on the large datasets this tool targets. Replaced with a single-pass loop
computing sum/min/max. Test: "get_property_values handles a very large value set
without RangeError" (200k values). Sweep: only spread-on-unbounded-array in the
branch diff (`git diff master…HEAD | grep 'Math\.(min|max)\(\.\.\.'`).

## [R2-2] `set_scale` mutated shared config but was not gated or revertable
**Location:** `src/agent/executors.ts` (set_scale entry), `src/store/aiPanel.ts` (VIEW_STATE_TOOLS)
**Severity:** Medium · **Status:** fixed — decided: **gate it** (2026-07-10)

`set_scale` changes the shared collection's physical units for every user and
reprojects every physical-unit measurement, yet was neither gated nor captured
by the per-turn revert snapshot (scales are configuration, not view state). Per
the user's decision, added `gated: true` so it requires confirmation like the
other shared-config mutators (`create_tool`, `create_property`). Spec "as-built"
note updated. Test: `isGatedTool("set_scale") === true`.

## [R2-3] Duplicate `case "set_camera"` made the fit label dead code
**Location:** `src/agent/executors.ts` (describeAgentToolCall)
**Severity:** Low · **Status:** fixed

Two `case "set_camera"` labels; the second (fit-aware) was unreachable, so a
`{fit}` call rendered "Move the camera" instead of "Fit the view to …". Merged
`fit` into the first case and deleted the duplicate. Test: describeAgentToolCall
set_camera fit/zoom. Sweep: no other duplicate switch labels in executors.ts.

## [R2-4] Rate limiter never evicted idle keys
**Location:** `devops/girder/plugins/girder-claude-chat/girder_claude_chat/rate_limit.py`
**Severity:** Nit · **Status:** fixed

`_request_times` (defaultdict keyed by user id) kept stale timestamps for
abandoned keys forever — a slow, single-process leak. Added `_sweep_expired`,
run at most once per window from `check()`. Tests: `testEvictsIdleKeys`,
`testActiveKeyIsNotEvicted` (existing 4 still pass).

## [R2-5] `scale as any` discarded the validated unit type
**Location:** `src/agent/executors.ts` (set_scale apply)
**Severity:** Nit · **Status:** fixed

Replaced `scale as any` with a narrowing cast to
`IScaleInformation<TUnitLength | TUnitTime>` (the unit is validated against the
allowed list immediately above). tsc-covered; no runtime test.

**Gates:** `pnpm tsc` clean · eslint clean · vitest `executors.test.ts` 58/58 ·
rate_limit tests 6/6 · flake8 clean.

---

# Round 3 — external review 2026-07-10 (2×P1, 5×P2)

Seven findings from an external review. All verified real and current before
fixing. Two P1s held approval; both fixed.

## [R3-1] Dataset identity checked only once per tool batch (P1)
**Location:** `src/store/aiPanel.ts` (sendUserMessage tool loop)
**Status:** fixed

The pre-loop `viewIdentityChangedSince` check ran once; switching datasets while
the first async tool ran let later tools in the same response execute against
the new dataset. Folded the check **into** the per-tool loop: once identity
changes, the remaining tools are declined (with valid tool_results so the wire
stays consistent) instead of executed. Test: aiPanel "stops running later tools
when the dataset changes mid-batch".

## [R3-2] "Auto-approve worker runs" auto-approves every gated action (P1)
**Location:** `src/components/AiPanel.vue` (auto-approve switch)
**Status:** fixed

The label implied a narrow scope, but the toggle bypasses confirmation for all
gated tools (worker runs, property computation, tool/property/scale creation).
Relabeled to "Auto-approve all actions" with a tooltip listing exactly what it
covers. Copy/markup only; tsc + lint cover it.

## [R3-3] Revert omitted property filters (P2)
**Location:** `src/agent/executors.ts` (snapshot/restore)
**Status:** fixed

`set_annotation_filter` can add/clear property filters, but the snapshot only
captured tag + current-frame filters, so "Revert view changes" reported success
while property filters stayed altered. Added `propertyFilters` to
`IViewStateSnapshot`; restore disables filters added since the snapshot and
re-applies the captured ones. Test: "reverts property filters added or changed
during the turn". Sweep: audited all VIEW_STATE_TOOLS against the snapshot — this
was the only omission.

## [R3-4] Forced conversation clear could hang at an approval prompt (P2)
**Location:** `src/store/aiPanel.ts` (clearConversation)
**Status:** fixed

A forced clear (e.g. account change) set `stopRequested` but didn't resolve
`approvalResolver`, leaving the loop suspended on a pending approval. Now
resolves it as declined (same as `requestStop`). Test: "resolves a pending
approval so a forced clear doesn't hang the loop". Sweep: `requestStop` and the
panel `onBeforeUnmount` already resolved it; this was the last gap.

## [R3-5] compute_property reported success when no job started (P2)
**Location:** `src/agent/executors.ts` (compute_property)
**Status:** fixed

Discarded `computeProperty`'s nullable return and always reported `started:
true`, and lacked run_worker's existing-job guard (allowing duplicate expensive
jobs). Now guards on `jobsStore.jobIdForPropertyId` and throws when the job
didn't start. Tests: "does not double-submit a running property job",
"reports failure when no job starts". Sweep: run_worker was the only other
job-starter and already correct.

## [R3-6] Property worker not validated against the requested shape (P2)
**Location:** `src/agent/executors.ts` (create_property)
**Status:** fixed

Checked only `isPropertyWorker`, letting the agent define an unusable property
whose worker doesn't operate on the chosen shape. Now mirrors
`PropertyCreation.vue`'s filter: `annotationShape` must equal the shape or be
`AnnotationShape.Any`. Tests: shape-mismatch rejection + `any`-shape acceptance;
updated the existing create_property test to declare a matching shape.

## [R3-7] Unknown channel names silently created a channel-0 tool (P2)
**Location:** `src/agent/executors.ts` (create_tool)
**Status:** fixed

An unresolved `channelName` left the tool unbound (worker exec defaults to
channel 0) while the result echoed the requested channel as if it bound. Now
rejects an unresolved channelName, listing the available channels. Test:
"rejects a channelName that doesn't resolve to a layer". **Sweep note:** the
auto tool-suggestion flow (`toolSuggestions.ts`) shares `buildToolConfiguration`
and has the same silent channel-0 behavior, but it predates this branch and is
user-confirmed in a panel — left as-is, noted here.

**Gates:** `pnpm tsc` clean · eslint clean · vitest executors 64/64 + aiPanel
7/7 + wireConversation 7/7.

---

# Review Round 4 (external, 2 P1 + 2 P2)

All four verified against current code and fixed. Prior seven findings confirmed
still fixed.

## [R4-1] Auth hydration could restore the wrong user's conversation (P1)
**Location:** `src/store/aiPanel.ts` (`handleAuthenticatedUserChange`)
**Status:** fixed

Awaited `loadStoredConversation()` without rechecking identity afterward, so a
rapid A→B switch could let A's slow load restore A's transcript into B's
session, and a turn started mid-load could be clobbered when the stored history
landed. Now captures `conversationGeneration` before the await and bails if the
generation changed or `lastKnownUserId` moved; a `hydrating` guard blocks
`sendUserMessage` until the load settles. Tests: "does not restore an earlier
user's conversation after a rapid switch", "blocks sending until hydration
finishes"; existing user-change tests updated to `await` the (async) change.

## [R4-2] Dataset switch during approval / async tool ran on the wrong dataset (P1)
**Location:** `src/store/aiPanel.ts` (`executeToolUse`) + `src/agent/executors.ts`
(`runWorkerTool`, `IAgentToolContext`)
**Status:** fixed

The per-tool pre-check couldn't catch a navigation that happened while a gated
tool's approval prompt was open, or between `run_worker`'s interface fetch and
its job submission. Now `executeToolUse` rechecks `viewIdentityChangedSince`
after the approval await (gated tools only — non-gated ones don't await, so the
loop pre-check covers them), and the context exposes `hasViewIdentityChanged`
so `run_worker` rechecks immediately before submitting the job. Tests:
"declines a gated tool approved after the dataset changed", run_worker
submit/abort pair. **Sweep:** `color/tag/compute_property` resolve
synchronously then do a single mutation await, so the pre-execution recheck
covers them; only `run_worker` has the two-await fetch-then-submit gap.

## [R4-3] Fractional list_annotations limit stalled pagination (P2)
**Location:** `src/agent/executors.ts` (`list_annotations`)
**Status:** fixed

`limit: 0.5` sliced to zero rows yet reported a fractional `nextOffset` that
normalized back to 0 — an infinite stall. Now floors the requested limit and
clamps to at least 1. Test: "floors a fractional page limit so pagination can't
stall". **Sweep:** `list_annotations` is the only slice+`nextOffset` paging path.

## [R4-4] Malformed agent request body produced a backend 500 (P2)
**Location:** `girder_claude_chat/__init__.py` (`agent_message`)
**Status:** fixed

`data.get('messages')` (and `_add_message_cache_breakpoint`) assumed a dict body
with dict messages, so `null` or `{"messages":["x"]}` raised an AttributeError
(500). Extracted a testable `_parse_agent_messages` that validates the body is a
dict with a non-empty list of dict messages, raising 400 otherwise. Tests:
`testAgentRejectsMalformedBodies` (6 payloads) + `testAgentParsesValidBody`.
**Sweep:** `suggest_tools_imp` already validates its dict body (existing test).

**Gates:** `pnpm tsc` clean · eslint clean · vitest aiPanel 15/15 + executors
71/71 · backend `tox` lint OK + 25 tests (7 new). Committed as `b26a39f0`;
malformed-body 400s verified live after a girder rebuild.

---

# Help-topic accuracy audit (2026-07-11, commit `a7810ddc`)

Not a code-review round: the Nimbus AI agent gave a factually wrong answer to
"how do I upload a folder of images" (it invented a "Batch Dataset Mode" and
missed that a dropped folder becomes one multi-file dataset by default). Audited
all 14 `help/*.md` topics — the on-demand knowledge served by `read_help_topic`
— against the app source (`src/views/Home.vue`, `ServerStatus.vue`,
`DataIOMenu.vue`, `PropertyCreation.vue`, `annotationsTo3D.ts`, etc.) and the
maintained gitbook in `../NimbusImageGitBook`.

Fixed HIGH-impact inaccuracies that would have sent users to nonexistent UI:
the upload flow (folder → one dataset; real Quick/Advanced Import + collection
checkbox); the sync indicator (database icon, not a green/red floppy disk);
worker errors via Settings → Jobs & Logs → Log (no "Show details"); export via
the top-bar Import/export icon (not an "ACTIONS" menu); property creation via
"Create Property" (runs on creation); contrast controls; all four shapes render
in 3D; floating palettes (not push-panels). Added verified-missing features (3D
loft surfaces, line-scan tool, Solidity/Rectangularity, registration "None",
deconvolution single-Z caveat). Only `interacting-with-objects.md` needed no
change. Verified live end-to-end after a girder rebuild (folder-upload and
CSV-export questions now answered correctly).
