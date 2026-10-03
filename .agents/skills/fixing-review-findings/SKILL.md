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
| **A rule applied to one of two symmetric paths** | Anywhere the same concept has two implementations | See below — this was the single most-repeated finding across a 10-round review |
| **Derived-state invalidation stops at the edited item** | Ordered pipelines, chained filters, dependent plots, wizard steps | Map the dependency closure: if item N changes the input to N+1, invalidate N (when its own derivation changed) and every downstream item; a toggle can preserve N's own result while still invalidating N+1..end |
| **Failed refresh retains state derived from different inputs** | Cached filters, search results, gates, projections | Record the exact derivation-input identity on successful commit. A failed identical retry may retain the result; if dataset/population/revision changed, invalidate before awaiting so failure cannot strand stale state. When active/filtering and visible-disabled consumers materialize different subsets, track their validity separately: a null active signature does not mean no visible derived state exists, and invalidating visible-only state must not drop still-valid active constraints. |
| **Correctness work coupled to display-only data** | Hidden panels whose data also powers filters/exports | Compute mandatory and visible-only input scopes separately. Hidden mode requests only mandatory inputs; failure of an optional widened fetch must not block correctness work that can use local fields or a cached mandatory subset. On that failure path, derive the resolution subset from the paths actually retained — do not feed a broad visible scope a narrow cache and publish plausible empty output for its missing inputs. Sign the actual required input set, not the visibility flag, and reuse a cached superset. |
| **Disabled work still treated as mandatory** | Persisted gates, filters, pipeline steps, hidden panels | Name each consumer's scope explicitly: hidden/filtering work may use the enabled subset, while visible counts/highlights may still materialize disabled entries and therefore must sign their inputs. Sweep fetch scope, derived-state resolution, and downstream query signatures. If disabled inputs are omitted, omit their derived outputs too; resolving them from a narrower active-only projection can publish plausible but false empty state. Re-enable/open transitions must wake the work when it becomes necessary. |
| **Cost before the guard** | Getters/handlers with a cheap precondition and expensive body | Does the cheap check run FIRST, in every consumer? A cap that filters or hashes 700K annotations to discover the limit was exceeded is doing the work it exists to prevent. Use a bounded walk (`limit + 1` as an overflow bit), then share that bounded result across the watcher, action, and renderer; checking `.length` after building the full collection is not a guard. |
| **A signature hashes values but not their structure** | Incremental hashes over nested rows, fields, or variable-length lists | Feed field/record boundaries into the hash, not only value separators and a final count; test two inputs with the same flattened values redistributed across records |
| **Display text used as identity** | Categorical plots, select options, persisted group/order state | Carry a collision-free raw key separately from its human-readable label. Test sentinel-label collisions, delimiter collisions, and duplicate display names; persist keys and render labels. For persisted migrations, store an explicit schema version — never infer the version from a prefix in user-controlled display text. |

#### The blast-radius sweep: who depended on what your fix changed?

The pattern sweep above asks *"where else does this bug exist?"* That is not
the question that keeps failing. On one 10-round review, **six of the last
eight findings were consequences of the previous round's fix** — not sibling
instances of the reported bug, but code that had encoded the invariant the
fix changed. Fixing the reported bug and sweeping for siblings caught none of
them.

So run a second sweep, on your own diff. Write the change as one sentence:

> **"X used to be true. Now Y is true instead."**

Then find everything that assumed X. The mechanical version — check all five,
because the last three are the ones that get missed:

| Surface | What to look for |
|---|---|
| Other code paths | Anything branching on, short-circuiting from, or caching the old fact. **Especially guards and early returns**, which encode "nothing else can be true here" |
| Tests | A test asserting X still passes and now pins the wrong behaviour |
| **User-facing strings** | Banners, tooltips, error text, tool descriptions. These state invariants in prose and nothing typechecks them |
| **Spec / doc prose** | `codebaseDocumentation/*.md` claims go stale silently; a wrong doc is a finding |
| **Comments** | A comment explaining why the old thing was safe is now an argument for a bug |

Worked examples, all from the same PR, all found by a reviewer *after* the fix
shipped:

- *"Invalidation was all-or-nothing; now it is per plot."* → the refusal
  banner still said "the viewer shows everything the other filters allow"
  (**user-facing string**), and a `stale.length === 0` early return still
  skipped clearing the error (**guard**).
- *"Gate ids were chained; now they are pure."* → the per-plot drop was
  correct, but a whole-request signature one layer up threw the preserved ids
  away anyway (**caller encoding the old fact**).
- *"`null` was the decoder's `not-a-key` sentinel; now it is a legal category."*
  → `isEncodedAnalysisCategoryKey` rejected a key the encoder could now
  produce, silently discarding persisted gates.
- *"This helper was synchronous; now it awaits the backend."* → a capacity
  check above it became a TOCTOU, and the store's `addAnalysisPlot` no-ops
  rather than throwing, so the tool reported creating something it had not.

**The async sub-case deserves its own check.** Making a function `await`
anything inserts a suspension point into every caller. Walk each call site and
ask what was read *before* the new await and acted on *after* it — a check,
a cap, a length, an index, a "current dataset" assumption. A concept grep
cannot see this; only reading the call sites can. If the value can change
during the await, re-derive it or confirm the effect landed. Prefer confirming
the effect (*"is my plot actually in the list?"*) over re-reading the
precondition, which is the same check-then-act one tick later.

**Weakening an invariant is as dangerous as strengthening one.** Making a
value legal that used to be impossible, a failure partial that used to be
total, or state per-item that used to be global all widen the space of
reachable states, and every consumer written against the narrower space is a
candidate bug.

#### The symmetric-path pattern

By far the most repeated finding in this repo's review history: a rule is added
to one path and its twin is left behind. Four separate rounds of one review
flagged four instances of it —

- `drawNewConnections` stopped gating on hydration; `clearOldAnnotations` kept doing it, so every draw deleted what the last one created.
- Features were styled at construction; the retained-feature restyle loop overwrote it on the next redraw.
- Timelapse click precedence was fixed for hover (`setHoveredAnnotationFromCoordinates`) and not for selection (`selectAnnotations`).
- Deleting pruned `selectedConnectionIds` and left `hoveredConnectionId` dangling.
- Selection was reflected on the timelapse layer (by rebuilding it) and hover was not, so the row click — which highlights via hover — did nothing there.

When you fix something, ask **"what is the other one?"** before moving on:

| If you changed… | Its twin is… |
|---|---|
| how something is drawn | how it is retained / cleared |
| how something is styled on creation | how it is restyled on update |
| the hover/highlight path | the click/selection path (and vice versa) |
| one piece of paired state (selection) | the other (hover, expansion, page) |
| the flat rendering branch | the grouped/track branch |
| one scope/mode branch | the other three |
| how one render path reflects a state | how the *other* render path reflects it |
| creating a throttled/debounced callback | cancelling it in `onBeforeUnmount` |

**A test that enumerates today's instances cannot catch tomorrow's.** The
teardown-cancel test named the five throttles that existed when it was written,
so adding a sixth and forgetting its `cancel()` left the suite green — and a
seventh had been missing all along. Where the invariant is "every X does Y",
discover the Xs at runtime instead of listing them.

**Then check where the discovery gets its list from.** The first rewrite scanned
the component's exposed surface for `typeof v.cancel === 'function' && typeof
v.flush === 'function'` — which only moved the hand-maintained list from the
test to `defineExpose`. A throttle nobody exposed stays invisible, and the
already-exposed ones keep any count floor satisfied, so the test reads as
comprehensive while covering exactly the cases that were never at risk. Codex
caught this one round after the rewrite.

Record instances **where they are created**, not where they are published — mock
the constructor (`vi.mock("lodash", …)` delegating to `importOriginal` so timing
behaviour is unchanged) and push each wrapper into an array:

```ts
const createdThrottles = vi.hoisted(() => [] as any[]);
vi.mock("lodash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lodash")>();
  const record = (w: any) => { createdThrottles.push(w); return w; };
  return { ...actual,
    throttle: (...a: any[]) => record((actual.throttle as any)(...a)),
    debounce: (...a: any[]) => record((actual.debounce as any)(...a)) };
});
```

Keep a count floor (the recording can break too) and label failures with the
exposed name when there is one, `unexposed#N` otherwise — the label is what
turns a red test into a fix. Verify the test can fail on the case that motivated
it: here, un-exposing *and* un-cancelling one throttle, which the exposed-surface
version passed and this one reports as `unexposed#4`.

The general rule: when a test discovers what it checks, ask what feeds the
discovery, and whether that feed is itself a list a human has to remember to
update.

A performance decision can create this shape on its own. Skipping work for one
state ("hover won't rebuild the layer — too expensive") is a correctness
decision wearing a cost argument: it is only safe if nothing user-facing depends
on that state. Write down which gesture drives each piece of state before
deciding one of them is cheap to ignore, and prefer a cheaper *reflection* (an
in-place restyle) over no reflection at all.

Grep for the twin by concept, not by identifier: the two implementations rarely
share a name, which is exactly why they drift.

#### The transitive-invalidation pattern

Derived state can depend on more than the object that stores it. In an ordered
chain, item N's cached result may be computed from every predecessor, so editing
item 0 invalidates a suffix even when items 1..N were not directly edited. A
one-key cache delete looks locally correct and leaves every dependent result
stale; a later failed recomputation can make that stale state permanent.

Write down the dependency direction before fixing the flagged mutator, then
sweep every operation that changes the chain: editing inputs, replacing the
derived rule, removing an item, reordering, and enable-state toggles. Preserve
results that remain mathematically valid — toggling an item can keep its own
result when that result depends only on predecessors, while still invalidating
all following items because their input population changed. Prefer one
suffix-invalidation helper and a three-item regression that exercises every
mutation path; a two-item test proves only the immediate neighbor, not the full
dependency closure.

#### The cost-before-guard pattern

A cheap precondition placed *after* the expensive work it was meant to avoid.
Three instances in one review: a 500-item cap that first resolved every selected
annotation; scope filtering that materialized all 709K stubs to build a set of
ids it then used to filter a much smaller collection; and a set of all
connection ids rebuilt on every selection change rather than cached against the
connections. Check the ordering inside any getter with both a guard and a scan,
and prefer iterating the **smaller** collection — resolve the few endpoints of N
connections, don't enumerate all M objects.

When you generalize, check the *shape* of your sweep too, not just its target. A grep for `throw` in action bodies found the deliberate throwers and missed every pure propagator — so the sweep reported "clean" and the next Codex round flagged the one it missed. If a sweep comes back clean, ask what the query structurally cannot see.

### Codex round mechanics

Codex does **not** review on push. It reviews on PR open, on draft→ready, or on a `@codex review` comment — so pushing a fix and waiting will wait forever. Post the trigger comment (safe to do without asking if Codex has already reviewed that PR; otherwise ask first, since it's outward-facing).

Its three response signals are easy to confuse when polling:

| Signal | Meaning |
|---|---|
| 👀 on your trigger comment | Picked it up, working — **not** a verdict. Removed when done. |
| 👍 | Reviewed, no suggestions. |
| A plain PR comment ("Didn't find any major issues") | Also a clean result — arrives as an issue comment, *not* a review object with inline comments. |

**A review object with an empty body is not a clean result.** Codex's review
body is the same 621-character boilerplate whether or not it found anything;
the findings are inline comments. Reading `gh pr view --json reviews` and
seeing only boilerplate reports "no findings" while P2s sit in
`/pulls/N/comments`. This misled two consecutive rounds of one review before
it was noticed. Judge a round by the inline-comment count, paginated, never
by the review body.

Poll for all three. Watching only for a new review object plus 👍 reports a false timeout when the answer arrived as a comment. Findings themselves come as inline review comments (`/pulls/{n}/comments`), not in the review body, which only holds boilerplate.

**The bot's login differs between the two GitHub APIs.** GraphQL (`gh pr view --json reviews`) reports `author.login` as `chatgpt-codex-connector`; REST (`gh api .../reviews`, `.../comments`) reports `user.login` as **`chatgpt-codex-connector[bot]`**. A REST poll filtering on the GraphQL spelling matches nothing and reports "no review yet" forever — this produced a confident false negative after the review had already landed. Match on a prefix, and prefer polling by timestamp rather than by author:

```bash
# Robust: newer than a known timestamp, author matched by prefix.
gh api repos/OWNER/REPO/pulls/N/reviews \
  --jq "[.[] | select((.user.login|startswith(\"chatgpt-codex-connector\")) and .submitted_at > \"$LAST\")] | length"

# The findings themselves. --paginate is NOT optional:
gh api repos/OWNER/REPO/pulls/N/comments --paginate \
  --jq ".[] | select(.created_at > \"$LAST\") | \"=== \(.path):\(.line // .original_line)\n\(.body)\""
```

**Always `--paginate` the comments endpoint.** It returns 30 per page, and a
long review thread passes that quickly — after which the *newest* finding is
on page two and an unpaginated query reports zero. On a 13-round PR this
produced a confident "the round was clean" when a P2 had in fact landed
against the current head (30 comments returned vs 31 with `--paginate`).
Sanity-check by counting both ways when a round reports clean:

```bash
gh api repos/$OWNER/pulls/$PR/comments --jq 'length'             # capped at 30
gh api repos/$OWNER/pulls/$PR/comments --paginate --jq 'length'  # the real count
```

Sanity-check a "nothing yet" result against `gh pr view N --json reviews` (GraphQL) before reporting it — if the two disagree, the filter is wrong, not the bot. Turnaround is 1–8 minutes and grows with diff size.

**A poll that only looks for a review object is wrong**, because the clean result is not one. Three separate polls in one session reported a false "nothing yet": one filtered on the GraphQL login spelling, one gave up at 5 minutes, and one checked the clean-comment form only *inside* the branch that had already found a review. A fourth failed the other way — a hand-typed local-clock cutoff matched the previous round and reported a finding already fixed. Every one of these was a *confident* wrong answer, so check every signal on every iteration and derive the cutoff from the API:

**Never hand-write `LAST`.** This machine's clock is UTC-4 and GitHub timestamps
are UTC, so a cutoff typed from the local clock sits four hours in the past and
the loop matches the *previous* round's review on its first iteration — a false
"the verdict arrived", re-reporting a finding already fixed. Derive it from the
API, and print the matched review's `commit_id` so a stale match is obvious:

```bash
LAST=$(gh api repos/$OWNER/pulls/$PR/reviews \
  --jq '[.[] | select(.user.login|startswith("chatgpt-codex-connector"))] | last | .submitted_at')
```

```bash
PR=1279; OWNER=arjunrajlaboratory/NimbusImage   # LAST from the command above
for i in $(seq 1 20); do
  sleep 30
  # 1. a review object with inline findings
  N=$(gh api repos/$OWNER/pulls/$PR/reviews --jq "[.[] | select((.user.login|startswith(\"chatgpt-codex-connector\")) and .submitted_at > \"$LAST\")] | length")
  # 2. the clean result — a plain ISSUE comment, never a review
  C=$(gh api repos/$OWNER/issues/$PR/comments --jq "[.[] | select((.user.login|startswith(\"chatgpt\")) and .created_at > \"$LAST\")] | length")
  # 3. 👀 present = still working; its DISAPPEARANCE means done, look for 1 or 2
  R=$(gh api repos/$OWNER/issues/$PR/reactions --jq '[.[].content]|@json')
  echo "$i: reviews=$N cleanComments=$C prReactions=$R"
  [ "$N" -gt 0 ] || [ "$C" -gt 0 ] && break
done
# Confirm the match is for the CURRENT head, not a carried-over earlier round:
gh api repos/$OWNER/pulls/$PR/reviews \
  --jq ".[] | select(.submitted_at > \"$LAST\") | \"\(.submitted_at) commit=\(.commit_id[0:10])\""
git rev-parse --short HEAD
```

**Pull the findings by review id, not by timestamp.** An inline comment is
created a second or so *after* its review's `submitted_at`, so
`created_at > <previous review's submitted_at>` re-lists that review's own
findings and a clean round looks like it repeated last round's complaint. Take
the id of the review you just matched (or, for the clean-comment form, expect no
inline comments at all):

```bash
gh api repos/$OWNER/pulls/$PR/comments \
  --jq ".[] | select(.pull_request_review_id == $NEW_REVIEW_ID) | \"=== \(.path):\(.line // .original_line)\n\(.body)\""
```

A comment's own `commit_id` is no help for telling rounds apart — GitHub
re-points it at the current head while the comment is still tracked, so a
finding from two rounds ago can report the sha you just pushed.

The eyes-reaction transition is the most useful signal: while 👀 is on the trigger comment it is still working, and the moment it clears the verdict exists somewhere — as inline comments, as a "Didn't find any major issues" issue comment, or as 👍 on the PR.

### 5. Gates before claiming done

**Run the blast-radius sweep here, per fix, before the automated gates** — it
is the one check that catches nothing on its own and everything on the next
round. For each behavioural change in the diff, write the sentence *"X used to
be true; now Y is"*, then grep for the five surfaces above (code paths and
guards, tests, user-facing strings, doc prose, comments). Two greps that pay
for themselves every time:

```bash
# Prose and strings that may still describe the old behaviour.
git diff <base>...HEAD --stat -- '*.md'      # docs you changed behaviour under
grep -rn "<phrase from the old invariant>" src/ codebaseDocumentation/
```

If the fix made anything `async`, additionally walk its call sites for a value
read before the new await and acted on after it.

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
| Reverting a fix in a chained `cp bak && revert && test && cp back` command | An interrupt or a rejected call between the revert and the restore leaves the fix silently removed from the working tree. Use `git stash` / `git checkout -- <file>` to restore, and `git diff` against HEAD before continuing |
| Trusting a probe that passed against drifted state | Re-verify from a **fresh load**: a churn probe reported "no problem" only because everything had hydrated by the time it ran, and a live behavior check disagreed with a passing unit test because the working tree had lost the fix |

### A test written alongside a fix must contradict the OLD source of truth

The recurring failure is not "the test is wrong" — it is that the test sets
up the one state in which **both** the old and new code agree, so it passes
against the bug it was written for.

The sharpest case: when a fix changes **where** a value comes from, the test
must make the OLD source **empty or wrong**. On PR #1302 an open gate bound
moved from `propertyStore.propertyValues` (empty in the stub-only regime the
feature exists for) to a server histogram. The accompanying test populated
`propertyValues` *and* `annotations` — the single configuration in which the
old code worked. It passed against a production path that always took the
broken branch. The replacement sets `annotations = []` and
`propertyValues = {}` and asserts the bound still reaches past the data.

Two more from the same round:

- **A hand-maintained list of things-to-check silently omits the new thing.**
  `describeAgentToolCall`'s "never throws on malformed input" test iterated a
  literal array of tool names. The two new tools weren't in it, so the test
  that exists for exactly that bug class couldn't see the bug. Derive such
  lists from the registry/enum (`AGENT_TOOL_NAMES`) so they cannot drift.
- **Paired mock state drifts like paired product state.** In one mock
  `propertyValuesRevision` was wired to the reactivity signal and
  `contentRevision`, on the adjacent line of the same signature, was a plain
  constant — so half the signature was untestable and nobody noticed.

Mechanically: after writing the test, restore the pre-fix behaviour (`git
stash`, or a scripted edit you undo from a backup) and **watch it fail**.
"It would obviously fail" has been wrong here more than once.

### Verifying a fix live: pick a fixture that actually exercises it

A live check on the wrong dataset is worse than none — it produces a confident result about nothing. Before claiming live verification, confirm the fixture has the property under test:

- Timelapse/track behavior needs a dataset with **>1 timepoint**. Forcing `showTimelapseMode` on a single-timepoint dataset "works" but proves nothing about tracks.
- Stub/lazy-loading behavior needs a dataset over the stub threshold, checked from a **fresh load** (everything hydrates as you interact, and the bug disappears with it).
- Duplicate/degenerate-data behavior needs a dataset that actually contains duplicates or self-loops — query MongoDB to find one rather than assuming.

When no fixture has the property, **create one**: annotations and connections can be made in seconds via `store.dispatch('createMultipleAnnotations', bases)` and `store.dispatch('createConnectionsFromBases', bases)` (both take a bare array, not a wrapper object). Build the edge cases deliberately — a multi-frame track, a same-frame pair, an off-location pair — rather than hoping existing data covers them.
