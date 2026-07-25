---
name: fixing-review-findings
description: "Use when the user pastes code-review findings (Codex comments, /branch-review output, PR review comments) and asks to fix or address them, or points at a review/findings doc in codebaseDocumentation/ to work through. Trigger phrases: 'here are some codex comments', 'fix these findings', 'address the review', 'go over those and fix as needed'."
---

# Fixing Review Findings

## Overview

Review findings arrive in rounds (Codex, /branch-review, PR comments) and the user usually clears context between review and fix. The workflow below is what this repo's history shows works: track findings in a committed doc, verify each against current code before fixing, fix with TDD one at a time, and generalize each finding into a branch-wide pattern check so the same mistake doesn't surface one instance per round.

## Workflow

### 1. Get the findings into a doc

If the findings exist only in chat, write them to `codebaseDocumentation/<FEATURE>-REVIEW.md` first: one entry per finding with severity, location (`file:line`), a one-line summary, and a **Status** field (`open` / `fixed <commit>` / `stale` / `by-design` / `deferred — <reason>`). Update the doc as each finding is resolved — it is the tracker that survives context clears.

If a review doc already exists, work from it and keep updating it.

### 2. Verify each finding against current code BEFORE fixing

Findings are frequently stale (already fixed in a prior round) or describe a deliberate design choice. For each finding, read the cited code as it exists now and classify:

- **fix** — real and current → proceed
- **stale** — code has changed / already fixed → mark stale with evidence (commit or current line)
- **by-design** — the behavior was a deliberate choice → don't fix; note the rationale and surface it to the user (e.g. "P1 is the point-stub hydration design decision, not a bug")
- **needs-decision** — fixable multiple ways with real trade-offs (caps, limits, rate limiting, defaults) → present options with a recommendation instead of silently picking

Never blindly implement a finding just because a reviewer asserted it. Reviewers are sometimes wrong; the user has overruled findings (rate limiting → "handled by the proxy", tag index → "want direct evidence of slow queries first").

### 3. Fix one at a time, with TDD

For each `fix` finding: write the failing test first (backend: `test/test_*.py` via tox; frontend: vitest `*.test.ts`), then the fix, then update the doc's Status line. Don't batch five findings into one sweep — interleaved fixes make it impossible to tell which change broke what.

### 4. Generalize each finding into a pattern sweep

A reviewer flags **one instance** of a pattern per round. After fixing it, grep the whole branch diff for other instances of the same pattern and fix those too — otherwise the next round flags the next instance. Recurring patterns in this repo's review history:

| Pattern | Where it recurs | Check |
|---|---|---|
| Public endpoint input validation missing | `@access.public` endpoints in AnnotationPlugin | Every `.get()`/`len()`/`int()` on request data guarded by an inline `isinstance` check raising `RestException(code=400, ...)`; ids parsed with `ObjectId(...)`/`except InvalidId` → 400; limits clamped to a module-level `MAX_*` constant (see nimbus-backend skill) |
| Malformed ObjectId → uncaught 500 | Any endpoint converting caller-supplied id strings | `except InvalidId` (from `bson.errors` — it is NOT a ValueError) → `RestException(400)` at the API boundary |
| Stale selection driving bulk destructive actions | List/selection UIs with filters | Does the selected set survive a filter change and then feed a delete/tag/bulk action? |
| Budget/lazy-mode bypass on select-all paths | Anything calling hydrate/fetch with a user-controlled id set | Is there a cap, or can one click request 700K items? |
| Stale comments/tests describing pre-fix behavior | Wherever behavior changed | Grep for the old function contract in comments and test names |
| Partial persistence: one change writing the same config key twice | Handlers that change several fields of one resource | All inputs validated *before* the first write? Two actions in the handler both syncing the same key? (see nimbus-frontend skill) |
| Store action throws/propagates without `rawError: true` | Any `src/store/*.ts` | Audit **every** store module and the **whole** chain — errors re-wrap at each `@Action` boundary, and an action needs the flag when it merely propagates (no `throw` of its own) |

When you generalize, check the *shape* of your sweep too, not just its target. A grep for `throw` in action bodies found the deliberate throwers and missed every pure propagator — so the sweep reported "clean" and the next Codex round flagged the one it missed. If a sweep comes back clean, ask what the query structurally cannot see.

### Codex round mechanics

Codex does **not** review on push. It reviews on PR open, on draft→ready, or on a `@codex review` comment — so pushing a fix and waiting will wait forever. Post the trigger comment (safe to do without asking if Codex has already reviewed that PR; otherwise ask first, since it's outward-facing).

Its three response signals are easy to confuse when polling:

| Signal | Meaning |
|---|---|
| 👀 on your trigger comment | Picked it up, working — **not** a verdict. Removed when done. |
| 👍 | Reviewed, no suggestions. |
| A plain PR comment ("Didn't find any major issues") | Also a clean result — arrives as an issue comment, *not* a review object with inline comments. |

Poll for all three. Watching only for a new review object plus 👍 reports a false timeout when the answer arrived as a comment. Findings themselves come as inline review comments (`/pulls/{n}/comments`), not in the review body, which only holds boilerplate.

### 5. Gates before claiming done

- Frontend: `pnpm tsc`, `pnpm lint:ci`, `pnpm test` (ignore failures under `.tox/**` paths — vitest glob artifact, see nimbus-frontend skill).
- Backend: `tox` (includes flake8) **and** `docker compose build girder && docker compose up -d girder` before any curl/browser verification — `restart` does NOT load plugin code changes; tox passes against source even when the live API is stale.
- User-facing changes: verify in the browser (see in-browser-testing skill) — unit tests green ≠ working UI.

### 6. Report and hold the commit

Report per-finding outcomes (fixed / stale / by-design / needs-decision) keyed to the doc. **Do not commit until the user has verified live**, unless they've explicitly said to commit — this user checks fixes in the browser before committing. Reply on the PR only when asked.

## Common mistakes

| Mistake | Reality |
|---|---|
| Fixing all findings as stated without verification | Some are stale or by-design; you'll churn correct code |
| Fixing only the flagged instance | Next review round flags the sibling instance you left |
| Verifying backend fixes with curl after only `docker compose restart girder` | Plugin is baked into the image; you're testing stale code |
| Committing right after tests pass | User verifies live first in this repo's workflow |
| Silently choosing a cap/limit/default | Those are user decisions — recommend, then ask |
