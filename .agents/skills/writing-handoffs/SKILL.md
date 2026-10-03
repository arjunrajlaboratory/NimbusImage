---
name: writing-handoffs
description: "Use when the user asks for a handoff prompt, a continuation prompt, or a prompt to continue work in a fresh context window — often phrased as 'give me a handoff prompt', 'I'll clear context', 'so I can continue in a new session'. Also use when wrapping up a session on a multi-session feature branch and the user asks what's next."
---

# Writing Handoff Prompts

## Overview

A handoff prompt is a self-contained task brief for a fresh context that knows **nothing** about this session. The reader has the repo, CLAUDE.md, and the skills — but none of your conversation, none of your discoveries, and none of your failed attempts. Anything the task depends on must be restated in the prompt or pointed to in a committed doc.

The cost model: every `file:line` location, verified fact, and gotcha you omit is 10–30 minutes of rediscovery (and possibly a repeated dead end) in the next session. Narrative history is cheap to drop; locations and gotchas are not.

## The Contract — sections in order

A handoff prompt contains these parts, in this order:

1. **Task line** — one imperative sentence stating the deliverable. Not "continue working on X" — say what done looks like ("Implement C4 draw-path debounce + zoom-adaptive maxVisible").
2. **Branch state** — branch name; what is committed vs uncommitted vs pushed; hashes of the commits that just landed if the next session may need to inspect or revert them.
3. **Read-first pointers** — the authoritative roadmap/design doc in `codebaseDocumentation/` with the *specific sections* to read (e.g. "the top Status line, section C, and the recommended-order footer"), plus which skills to consult (`nimbus-frontend`, `nimbus-backend`, `nimbus-geojs`, …). Say "read this BEFORE coding."
4. **Why now / what just shipped** — 2–4 sentences linking this task to the roadmap and summarizing the immediately preceding work the task builds on.
5. **Findings with file:line** — root-cause hypotheses, key functions, the data flow. Every claim gets a `path/file.ext:line` anchor. Label anything unverified: "hypothesis — verify in-browser first, don't trust synthetic events."
6. **Scope** — explicit DO and DON'T. Name the adjacent items that are deferred ("B3 — DO NOT do; deferred") so the fresh context doesn't drift into them. State known regression risks to watch ("applyCameraInfo suppresses sync deliberately — don't break unroll views").
7. **Workflow gates** — TDD expectations (which pure logic to extract and test first, pointing at an existing test file as the pattern), the verification commands (`pnpm tsc`, `pnpm lint:ci`, `pnpm test`; `tox` + `docker compose build girder && docker compose up -d girder` if backend), and the dataset URL(s) to verify against in-browser.
8. **Key facts the fresh context won't know** — session-learned gotchas that aren't in any doc or skill yet (e.g. "editing src/store/*.ts breaks HMR — hard reload", "this dataset needs ~15s stub fetch before state is usable"). If a gotcha is durable, also add it to the relevant doc/skill before handing off.

Target **≤ 4,000 characters**. When trimming, cut section 4 narrative first, then compress section 5 prose — never cut the file:line anchors, scope DON'Ts, or gotchas.

Deliver it as a copy-pasteable block (fenced or indented), not woven into conversation.

## Example (compressed excerpt of a real one)

```
Task: Implement "B — progress indicators for long-loading steps" from
codebaseDocumentation/ANNOTATION-STUBS.md (section "B. Progress indicators").

Branch: feature/stub-annotations (already pushed; start from latest). Frontend-only.

WHY NOW: The big memory/perf work is done — stub-only mode, server-side list,
property-value lazy loading. What's left for good UX is feedback: several
multi-second steps are silent, which makes the app feel hung on large datasets.

SCOPE (do B1 and B2; B3 is explicitly deferred):
- B1 — progress bar for the 708K STUB FETCH. getAnnotationStubs()
  (src/store/AnnotationsAPI.ts:106) is a single big GET with NO progress UI.
  Count is already known (getAnnotationCount, same file:370). Mirror the
  EXISTING pattern: src/utils/fetch.ts fetchAllPages already drives
  src/store/progress.ts; ProgressBarGroup.vue renders them.
- B3 — DO NOT do; deferred.

KEY FILES: src/store/progress.ts, src/utils/fetch.ts (copy this pattern),
src/store/AnnotationsAPI.ts, src/store/annotation.ts (fetchAnnotations).

Workflow: TDD pure logic in src/utils/ (see loadingLabels.test.ts for the
pattern); gates: pnpm tsc, pnpm lint:ci, pnpm test; verify in-browser on
http://localhost:5173/#/datasetView/6a18deb286eb377626a51dc5/view (708K).

Facts you won't know: editing src/store/*.ts breaks HMR (duplicate getter
keys) — hard-reload the page after store edits.
```

## Common mistakes

| Mistake | Consequence | Fix |
|---|---|---|
| "Continue the annotation work" with no deliverable | Fresh session re-derives the plan, may pick a different task | One-sentence task with a done-state |
| No file:line anchors | 10–30 min of re-searching per location | Anchor every claim while it's cheap (you know them now) |
| Omitting what NOT to do | Scope creep into deferred/shelved items | Name deferred items explicitly with "DO NOT" |
| Stating hypotheses as facts | Fresh session builds on an unverified guess | Label: "hypothesis — verify first" |
| Gotchas only in your head | Next session hits the same wall (HMR, rebuild, slow dataset) | Section 8, and promote durable ones to docs/skills |
| Assuming uncommitted work survives | Fresh session diffs against wrong base | State committed/uncommitted/pushed explicitly |
| 8,000-character essay | User asked for ≤4K once already; long prompts bury the scope | Trim narrative, keep anchors |
