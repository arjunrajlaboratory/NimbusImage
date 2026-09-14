---
name: branch-review
description: "Use when reviewing code changes on a feature branch before merging, or when the user asks for a code review, PR review, or branch diff analysis. Compares against a base branch (default: master). Checks both frontend and backend: looped DB/API calls (the #1 review issue), API vs model layer separation (models must not raise RestException), raw PyMongo usage, missing exc=True on model loads, broad exception handling, access control and permission escalation, code factorization, redundant validation, naming clarity, API calls in Vue components instead of GirderAPI.ts, unnecessary temporary variables, and TypeScript type safety. Use this skill even for small PRs — single-file backend changes often have layer violations or missing batch queries."
---

# Branch Code Review

Review code changes on a feature branch, checking for:
- Pattern consistency with existing codebase
- Code duplication that should be factored out
- Unnecessary temporary variables
- Proper use of existing functions and utilities
- Potential N+1 query patterns or looped API/DB calls (frontend AND backend)
- Type safety issues (avoiding `as any` casts)
- Error handling consistency
- API vs model layer separation (backend)
- Raw PyMongo usage instead of Girder Model methods (backend)
- Missing `exc=True` on model loads (backend)
- Broad exception handling (backend)
- Access control and permission escalation (backend)
- Redundant validation that duplicates framework behavior
- API calls placed directly in Vue components instead of API files (frontend)
- Frontend code compensating for backend issues
- Symmetric-path twins changed on only one side (create↔update, draw↔clear, client↔server)
- Three-state list contracts (`[]` vs `null`) and failures indistinguishable from empty results
- Lossy change-identity signatures and derived state that outlives its inputs
- Hidden-but-mounted palette work and overlay stacking combinations
- Regressions introduced by earlier review-round fixes on the same branch

## Usage

```
/branch-review [base-branch]
```

**Arguments:**
- `base-branch` (optional): The branch to compare against. Defaults to `master`.

## Review Process

### Step 1: Gather Context

```bash
git diff [base-branch]...HEAD --stat
git diff [base-branch]...HEAD
git log [base-branch]..HEAD --oneline
```

If the log shows commits addressing earlier review rounds ("Address review", "Address Codex round N"), treat those fixes as the riskiest part of the diff — see Cross-Cutting check 3.

### Step 2: Read Changed Files

For each significantly changed file, read the full file to understand context:
- Use the `Read` tool to examine new/modified files
- Look at surrounding code to understand existing patterns
- Check imports and dependencies

### Step 3: Load Feature Documentation

Check `references/feature-documentation-index.md` to find relevant architecture docs for the feature area being changed. Read those docs before reviewing to understand expected patterns.

### Step 4: Pattern Analysis

Compare new code against existing patterns:

1. **Store Modules**: Check `vuex-module-decorators` patterns
2. **API Clients**: Verify error handling patterns, check that API calls live in API files (not components)
3. **Vue Components**: Ensure structure consistency (props, computed, methods order)
4. **Backend API**: Check for looped DB queries, proper input conversion at API boundary, `exc=True` usage
5. **Backend Models**: Check Girder plugin patterns, verify no `RestException` imports, no HTTP concerns
6. **Access Control**: Verify mutation endpoints check WRITE/ADMIN access, consider permission escalation

Codebase-specific review guidelines are in `CLAUDE.md` - read them before reviewing.

### Step 5: Provide Actionable Feedback

Produce a single, numbered list of findings — do not split issues into separate "major" and "minor" sections. Use a Severity column instead (High / Medium / Low / Nit). For each finding, include:

1. A numeric ID (Finding 1, Finding 2, …)
2. A short title
3. The specific code location (`file:line`)
4. The severity (High / Medium / Low / Nit) and one category from the **Issue Categories** table
5. Current code, suggested code, and a brief rationale

Then produce two numbered tables (see **Example Output Format** below):
- A **Findings Summary** table whose rows correspond 1-to-1 with the findings list, in the same order, sharing the same numeric IDs.
- A **Checklist Coverage** table that lists each review category as a row and marks it pass / warn / n/a; warn rows cite the finding number(s) that caused the warning.

Routing rules — do not invent new top-level sections:
- Positive confirmations or "nothing wrong here" notes → fold into **Overall Assessment**, not into findings.
- Actionable nits / stylistic suggestions → make them a finding with **Severity: Nit**.
- Open questions that need user input (and aren't actionable as-is) → **Questions for Clarification**.

This keeps every actionable item discoverable from the Findings Summary table by number, and the Checklist Coverage table answers "what was checked vs. what was flagged" without overlapping content.

## Issue Categories

| Category | Description |
|----------|-------------|
| **Pattern Consistency** | Code that doesn't follow established patterns |
| **Code Duplication** | Logic that should be extracted to shared utilities |
| **Unnecessary Variables** | Temporary variables used only once |
| **Missing Abstractions** | Opportunities to use existing utilities |
| **Performance Issues** | N+1 queries, looped API/DB calls, missing batch endpoints |
| **Type Safety** | `as any` casts, missing types, unsafe assertions |
| **Error Handling** | Inconsistent or duplicate error handling |
| **Layer Violation** | API concerns in models or model concerns in API |
| **Security / Access Control** | Missing permission checks, bypassed access control |
| **Raw PyMongo** | Using `Model().collection.find()` instead of `Model().find()` |
| **Redundant Validation** | Checks that duplicate framework behavior |
| **API calls in Vue components** | Direct `this.girderRest.get(...)` / `this.girderRest.post(...)` in components instead of an API file (`GirderAPI.ts`, `AnnotationsAPI.ts`, etc.) |
| **Frontend compensating for backend** | Frontend fallback logic that masks backend issues or duplicates backend access control |
| **Store Organization** | New state added to `src/store/index.ts` instead of a focused store module |
| **Naming** | Generic variable names or function names that no longer match their behavior |
| **Partial Persistence** | One logical change issuing several writes of the same key, so a mid-sequence failure leaves the resource partially updated |
| **Error Message Mangling** | Store action throwing or propagating without `rawError: true`, so callers get `ERR_ACTION_ACCESS_UNDEFINED` instead of the reason |
| **Symmetric Path Drift** | One of two twin paths changed: create-styling ↔ update-restyling, draw ↔ retain/clear, register ↔ teardown, one guarded call site ↔ its siblings, client ↔ server end of a contract |
| **Empty-State Contract** | Two of the three list states merged, in either direction (`if ids:` in Python; `ids?.length` guards or `?? []` defaults in TS), or a failure return indistinguishable from an empty success |
| **Lossy Change Identity** | Signature/hash that misses changes it exists to detect: sampled elements, undelimited nested lists, content changes with stable membership |
| **Stale Derived State** | Derived ids/caches surviving an input replacement or upstream change; sequence-guard token claimed after early returns |
| **Stale String Reference** | `dispatch("...")`/event-name string not updated when the member was renamed |
| **Hidden-Mounted Work** | Expensive work in hidden-but-mounted content not gated on visibility: mount-time work in `FloatingPalette` slots, per-scrub computeds in palettes or once-opened `VWindowItem` tabs |
| **Overlay Stacking** | New floating palette/panel absent from the shared right-edge clearance computation |

## Cross-Cutting Checks

These apply to the whole diff, frontend and backend alike. All three shapes recurred across the multi-round reviews of PRs #1279, #1288 and #1298.

### 1. Symmetric-Path Twin Sweep
The most repeated finding shape in this repo: a rule applied to one of two symmetric paths. For every behavior the diff adds or changes, name its twin and check the twin — the two implementations rarely share a name, so search by concept:
- styling-on-create ↔ restyling-on-update (a rebuilt selected feature silently loses its highlight)
- drawing ↔ retention/clearing predicates (mismatched criteria defeat incremental rendering)
- hover ↔ selection, highlight ↔ click paths
- registering a throttle/listener ↔ cancelling it in teardown (`onBeforeUnmount`)
- one guarded call site ↔ its sibling call sites (see Cross-Cutting check 3)
- one mode branch ↔ the other modes (timelapse on/off, unroll, server/local list mode, 2D/3D)
- the client end ↔ the server end of a wire contract

### 2. "Empty" Is Not a Signal — Three-State List Contracts
An optional id-list parameter has three meanings: absent/null = "no constraint", non-empty = "these", present-but-empty = "none". Merging any two of those states silently rescopes the operation, in the direction of the merge: empty → absent turns "act on zero matches" into "act on everything"; absent → empty turns "act on everything" into "act on nothing" when the receiver honors the contract. In PR #1298 the two composed: exporting an empty filtered set silently downloaded the entire dataset — the client's `annotationIds || []` merged "no constraint" (null) into `[]` before the request, and the server's `if annotationIds:` read `[]` back as "no constraint". Check:
- Any expression that merges two of the three states, in either direction. Python: `if ids:` treats `[]` as absent. TypeScript: arrays are always truthy, so `if (ids)` is safe — the merges are `if (ids?.length)` / `ids.length > 0 ? ids : undefined` (empty → absent) and `|| []` / `?? []` defaults (absent → empty, erasing "no constraint" before it reaches the wire).
- **Both ends of the wire** — fixing one end and not the other is a twin-sweep miss.
- Failure vs empty: an API helper that catches errors and returns `{}`/`[]`/`null`-as-data makes a transient network error indistinguishable from a real empty result. In #1298 this became "every gate resolves to zero matches and the whole dataset disappears"; in #1279 a failed batch POST was misreported as successful deduplication. Failures must propagate (return null or throw), and the caller must leave existing derived state alone on failure.
- An empty *prerequisite* is not "nothing to do": "no property values to fetch" still requires resolving categorical-only gates. Skip the fetch, never the downstream resolve.

### 3. Review-Fix Commits Are the Riskiest Part of the Diff
When the branch contains commits addressing earlier review rounds, review those fixes as first-class changes, not as settled ground. Across four rounds on PR #1298, most later findings were consequences of earlier fixes rather than of the original feature. For each fix ask:
- **Does it interact with a sibling fix?** "Leave ids alone when the fetch fails" × "drop old ids only when the gate is null" = a failure right after re-lassoing strands the stale constraint permanently.
- **Does it guard call sites when the invariant belongs at the boundary?** An invariant like "never POST an empty constraint" belongs in the API client or the store action every caller funnels through. Round 2 guarded the two page fetches; round 3 found the sibling `fetchMatchingIds` still posting the rejected payload. A diff adding the same guard at two call sites is a finding even when no bug is visible yet.
- **Did it fix half the problem?** Allowing two palettes to be open together (eviction) without adding the pair to the stacking layout (geometry) left the second palette covered.

## Backend-Specific Checks

When reviewing changes to `devops/girder/plugins/AnnotationPlugin/`, apply these additional checks:

### 1. Looped Database Queries
Search for patterns like `for ... in ...: Model().load(` or `[Model().load(id) for id in ids]`. These should use `$in` queries instead.

### 2. API vs Model Layer
- **Models** (`server/models/`) must NOT import or raise `RestException`. They should raise `ValueError` or `ValidationException`.
- **API files** (`server/api/`) should handle all input parsing/conversion at the top of the method, then pass clean data to models.
- Input conversion (string → ObjectId, JSON body parsing) should happen once at the API boundary, not in utility functions or models.

### 3. Raw PyMongo Access
Flag any use of `Model().collection.find()` — should be `Model().find()`. The only exception is `collection.aggregate()` for aggregation pipelines.

### 4. Model Loading
- Flag `Model().load(id, ...)` followed by `if result is None: raise ...`. Should use `exc=True` parameter instead.
- Flag `Model().load(id, force=True)` unless there's a clear comment explaining why access checks are bypassed.

### 5. Broad Exception Handling — and Silent Exception Handling
Flag `except Exception:` or bare `except:`. These swallow errors like KeyboardInterrupt, MemoryError, etc. Catch specific exception types.

Even where a broad catch is justified (best-effort cleanup that must not mask the original error), **the exception message must be surfaced, not just the fact that something failed** (pchoisel, PR #1225):
- Inside the handler, log with `logger.exception(...)` — it appends the message *and* traceback; a `logger.error("cleanup failed")` with no exception info, or a bare `pass`, hides the one thing a debugger needs. (`logger.exception` outside an `except` block logs `NoneType: None` — use it only inside the handler.)
- When converting to another error (`ValueError` → `RestException`, cleanup failure → `RuntimeError`), include `str(e)` in the message or chain with `raise ... from exc`.
- A deliberate skip (`except X: pass`) must catch the *narrow* exception the skip is designed for (e.g. `girder_client.HttpError` for an inaccessible resource), with a comment; `except Exception: pass` silently eats real bugs.

### 6. Access Control
- Check that mutation endpoints (POST, PUT, DELETE) verify the user has `WRITE` or `ADMIN` access on the affected resource.
- Check for permission escalation: can a user with WRITE access grant themselves broader access?
- Security enforcement must be in the backend. Frontend permission checks are cosmetic, not security.

### 7. Code Factorization
- Flag identical code blocks appearing in multiple API files — extract to a shared helper.
- Flag functions that re-fetch data already available in the calling context — pass as parameter instead.

### 8. Redundant Validation
- Flag ObjectId validity checks before `ObjectId()` conversion (the conversion itself raises on invalid input).
- Flag null checks after `Model().load(..., exc=True)` (exc=True already raises).

### 9. Naming
- Flag functions whose names reference parameters they no longer use.
- Flag generic variable names like `id`, `item`, `data` when a more specific name is possible.

### 10. Public Endpoint Input Validation (most-recurring external-review finding)
For every new or modified `@access.public` endpoint:
- Any `.get()` / `len()` / `int()` / indexing on request data must be validated at the API boundary via the shared helpers in `server/helpers/validation.py` (`requireObjectBody`, `requireList`, `requireObjectId`, `requireInt`, `validateListInputs`, ...), which raise `RestException(code=400, ...)`. Flag new/edited endpoints that hand-roll inline `isinstance` guards instead of calling these. A malformed payload must produce a clean 400, never an uncaught 500. (Applies to `@access.user` endpoints too, not only `@access.public`.)
- Caller-supplied ObjectId strings converted with `except (bson.errors.InvalidId, TypeError)` at the API boundary (InvalidId for a bad hex string, TypeError for a non-string like `{"datasetId": 123}`; InvalidId is NOT a ValueError). `requireObjectId` already does this.
- Counts/limits clamped to a `MAX_*` constant — unauthenticated callers must not be able to force unbounded DB or serialization work.
- When one endpoint has the gap, check sibling public endpoints in the same file — this pattern recurs in clusters.

### 11. Decorator and Signature Hygiene (from Paul's PR #1203 review round)
- `@memoizeBodyJson` is justified ONLY when the endpoint is also `@recordable` **and** its `findDatasetIdFn` reads `memoizedBodyJson`. On any other endpoint it is noise: use a plain `def handler(self, params)` signature and call `self.getBodyJson()` directly (pattern: `datasetView.py::create`). Flag `*args, **kwargs` endpoint signatures that exist only to receive the memoized kwarg.
- Flag hand-rolled lazy caching of Girder model instances (`getattr(self, "_cache", None)` properties). Girder's `Model()` constructor already returns a cached singleton (`_ModelSingleton` metaclass) — construct it in `__init__` like the existing `self._annotationModel = AnnotationModel()` idiom.
- Class-level constants (allowed-field sets, collection names, `MAX_*`) belong at the top of the class definition, not between methods mid-file.
- Aggregation `$count` output fields should be named `count`, not a cryptic short name — easier to debug. Dense `$addFields`/`$cond`/`$ifNull` stages need a comment explaining what the stage computes and why.

### 12. Girder Built-Ins, Python Idioms, and Reviewer Questions (pchoisel's recurring comments, PRs #1071–#1247, #1225)
The backend's human reviewer flags these reliably; catch them first.

**Girder provides it — don't hand-roll it.** These get flagged with a link to the Girder source:
- `self.getCurrentUser()` returns the already-loaded user document — don't re-load it by id afterward.
- `getServerMode()` answers "is this production?" — don't invent env flags or tox-level configuration for it.
- `Model()` construction is a cached singleton (see check 11) — no lazy-loading properties.
- When a change needs plumbing (user loading, env detection, caching), search girder/girder for an existing mechanism before writing one.

**girder_client provides it too — check before raw `gc.get`/`gc.post`.** The same rule applies client-side in the `nimbusimage/` package (pchoisel, PR #1225): a hand-rolled `gc.get("folder", parameters={...})` + client-side scan was a one-call `gc.listFolder(parentId, parentFolderType="user", name=...)`, and a raw `gc.post("folder", ...)` with manually `json.dumps`-ed metadata was `gc.createFolder(..., metadata=dict)` (it JSON-encodes metadata itself). Before writing a raw REST call, check `girder_client.GirderClient` for a method covering the operation (`listFolder`, `listItem`, `createFolder`, `createItem`, `uploadFileToFolder`, `listResource`, `addMetadataToFolder`, ...) — server-side filtering via their parameters beats fetching everything and scanning.

**Python stdlib idioms for float checks:** `math.isnan(x)` / `math.isinf(x)`, never the `x != x` NaN trick or equality against `float("inf")` (pchoisel, PR #1225).

**Factorization habits:**
- N near-identical consecutive statements → a for-loop over a small spec list.
- A block that duplicates logic in another function (or that other API files will want) → a shared helper — and apply the new helper to the *existing* call sites in the same file, not just the new one.

**Python idioms for readability:**
- Grouping into a dict of lists → `collections.defaultdict(list)`, not conditional-insert dances.
- Copies → `mylist.copy()` / `mydict.copy()`, not `list(x)` / `dict(x)`.
- Parallel arrays that must stay index-aligned (e.g. column names + per-column quoted flags) → one dataclass/object per row, so adding or reordering a field can't desynchronize them.

**Signature hygiene** (extends check 11):
- No `self` on a function that isn't a method — move it to module level.
- No decorator whose benefit can't be stated for *this* endpoint (memoization on a request that runs once per file).

**No in-band sentinels:** a reserved value *inside* a user-data field (a magic tag name in a `values` list that switches behavior) collides with legitimate user data — the mode belongs in a separate request argument. The sibling-field shape is the correct resolution, not a violation: the list-filter `tags` field `{values: string[], exclusive: boolean}` was questioned in review and ruled by-design, because `exclusive` is already a separate argument and a tag literally named "exclusive" works fine (`codebaseDocumentation/PR1203-PAUL-REVIEW.md`). Flag only values that live inside the data itself and change behavior.

**Answer the reviewer's questions before review does.** For each new parameter or data path, the questions asked in past rounds: can this be `None`? What happens on re-run/re-import when the data already exists (overwrite, duplicate, or delete-old)? What happens to non-scalar values (a dict landing in a CSV cell)? Handle it in code, or say why not in a comment.

**Why-comments on non-obvious mechanisms** ("for future us"): anything relying on subtle semantics — aggregation stages, context-manager/GC behavior — needs a comment saying why it matters, written for a reader who doesn't know that corner of Python or Mongo.

### 13. Function Placement — does this function belong in this file?
For every *new* function or method in the diff, ask where it belongs before reviewing what it does (pchoisel, PR #1225 flagged a generic boolean-body parser defined as a staticmethod in an API resource class):
- **Generic input validators/parsers** (no domain knowledge beyond "this is a request field") defined in `server/api/*.py` belong in `server/helpers/validation.py`, next to `requireInt`/`requireObjectId`/`optionalBoolean` — where the other API files can find and reuse them. Endpoint-specific schema validators (ones encoding this endpoint's field names, dimensions, or messages) may stay in the API file.
- **Logic shared or shareable across API files** belongs in `server/helpers/` or the model layer, not copy-pasted or parked in whichever API file needed it first.
- **A staticmethod that never touches `self` or the class** is a hint it is a utility that belongs at module level or in a helper module.
- Frontend equivalents already covered below: API calls belong in `src/store/*API.ts`, shared utilities in `src/utils/`.
The test: "if a second endpoint needed this tomorrow, would it import from here?" If importing from an API module feels wrong, the function is in the wrong place today.

## Frontend-Specific Checks

When reviewing changes to `src/`, apply these additional checks:

### 1. API Calls in Components
Flag any direct `this.girderRest.get(...)` or `this.girderRest.post(...)` calls in Vue components. These should be methods in `GirderAPI.ts`, `AnnotationsAPI.ts`, or the appropriate API file.

### 2. Looped Frontend API Calls
Flag `Promise.all(items.map(item => api.updateItem(item)))` patterns. Suggest using or creating a batch endpoint instead.

### 3. Frontend Compensating for Backend
Flag fallback patterns like "try new API, catch error, try old API". The frontend should trust the backend API. Double implementations create maintenance debt.

### 4. Store Organization
New state for distinct feature areas should go in a new store module, not `src/store/index.ts` (already 2000+ lines).

### 5. Unintended Behavior/Default Changes
Diff-scan for defaults that changed as a side effect: items-per-page values, initial slider/config values, prop defaults, sort orders. The user has caught these post-merge more than once (e.g. a list default silently going 10 → 50). If a default changed and the change isn't the point of the branch, flag it.

### 6. Generated-File and Doc Churn
Flag diffs in generated or documentation trees the branch shouldn't touch (e.g. `codebaseDocumentation/api_documentation/` regenerated by a docs tool). Ask whether they're intentional rather than assuming.

### 7. Stale Selection / State Feeding Bulk Actions
For list/selection UIs: can a selected set survive a filter or mode change and then feed a bulk destructive action (delete/tag/hydrate)? Check that selection is scoped or cleared when the visible set's definition changes, and that select-all paths respect lazy-mode/budget caps instead of operating on the entire dataset.

### 8. Partial Persistence: One Logical Change Writing the Same Key Twice
`syncConfiguration(key)` PUTs the whole key, so N single-field calls in one operation = N writes of the same key, and a failure part-way leaves the shared collection partially updated **while the operation reports failure**. Distinct from the looped-call check (#2): the repeats here are sequential `await`s on *different* fields, not a `.map()`, so they don't look like a loop.

For any handler that changes several fields of one resource, check:
- Are all inputs **validated before** the first write? Interleaved validation is the easier half to miss — it produces a partial update with no backend failure involved, so backend-rejection tests can't catch it.
- Do two different actions in the same handler both end up syncing the same key? (`changeLayer` and `saveContrastInConfiguration` both write `layers`.)
- Writes to genuinely different resources (configuration vs dataset view) can't be merged — expect a comment saying so, don't flag it.

### 9. Store Actions That Throw or Propagate Without `rawError: true`
`vuex-module-decorators` replaces any error escaping a bare `@Action` with a generic `ERR_ACTION_ACCESS_UNDEFINED` message. Flag a new/edited action if it throws **or merely propagates** (awaits an API call or another action) and any caller reads `error.message`. Errors are re-wrapped at every boundary they cross, across modules, so check the whole chain, not just the action in the diff. `tsc`/lint/tests stay green either way, and a test that mocks the action bypasses the decorator entirely — so a real-dispatch test asserting the **exact** message is the only regression guard (substring assertions pass regardless; the wrapper embeds the original message in its stack). See nimbus-frontend skill.

### 10. Lossy Change-Identity Signatures
Any signature/hash whose comparison decides "skip the refetch / skip the recompute / skip clearing the selection" must change for every change it exists to detect (`src/utils/signatures.ts`). Flag:
- **Sampling**: length + first/middle/last element is not an identity — two same-length id sets can differ anywhere else, and every watcher keyed on the signature then silently skips its work. In #1298 that meant both the server-list refetch and the selection-clearing watcher, leaving hidden rows for a later bulk action. Hash every element (PR #1298 uses `cyrb53`, memoized by array identity because these arrays are replaced wholesale).
- **Undelimited nesting**: `[["a"], ["b"]]` and `[["a","b"], []]` must hash differently — feed a boundary marker or the row's id per row.
- **Membership-only identity when content matters**: a tag edit keeps the id set identical while moving the point to another category; a server-side property recompute changes nothing the client can diff at all. The identity needs a content hash of the fields the feature actually reads, or a revision counter bumped on fetch (not on every mutation).
- Watchers keying off filter state must never `JSON.stringify` it — id-membership filters hold tens of thousands of ids and those getters rebuild on every frame scrub.

### 11. Async Refresh Actions: Stale Requests and Derived-State Invalidation
For any action shaped "read inputs → maybe bail out → fetch → commit derived state":
- **Claim the sequence-guard token first**, before every early return. A bail-out that doesn't invalidate the in-flight request leaves it "current", and its late response commits derived state for inputs that no longer apply — reinstating exactly what the bail-out cleared. Found twice in `filters.ts` on one branch; correct precedent: `properties.ts::ensureVisiblePropertyValues`.
- **Invalidate on every input change, replacement included.** Dropping derived ids only when the new input is null keeps the old constraint active while the new one resolves — and permanently if the resolve fails. When inputs chain (plot n derives from plots 0..n−1), a change to link n must also invalidate every downstream dependent, including on axis, removal and enable-state changes.
- **Unresolved must contribute no constraint**: the interim state should show more than the final answer, never something wrong.
- **One owner per refresh**: an explicit dispatch alongside a watcher on the same signature issues the identical expensive request twice; the sequence guard discards a response, not the backend work.

### 12. String-Keyed References After Renames
`dispatch("name")`, `commit("name")` and event names are invisible to `tsc`: after a rename, the stale string logs an unknown-action error and resolves as a silent no-op, usually masked by a watcher doing similar work. When the diff renames a store member, sweep every string reference against the declared members. PR #1298 adds `src/__tests__/dispatchedActions.test.ts` to police dispatch names — check that a rename updates it rather than gets exempted from it.

### 13. Hidden-but-Mounted Work
Two container lifecycles hide content without unmounting it, with different cost profiles — don't conflate them:
- `FloatingPalette` mounts its slot content immediately and hides it with `display: none`, so `onMounted` runs at every dataset load and computeds re-evaluate on every store change **even if the panel has never been opened** (#1298: an invisible WebGL Plotly render at dataset startup; #1288: a full connection scan not gated on timelapse mode).
- An inactive `VWindowItem` tab mounts **lazily on first activation**, then stays mounted and is hidden with `v-show` (documented in `AnnotationBrowser.vue`), so its cost starts at first open but persists from the hidden tab afterward (#1279: scoped counts scanning every annotation per scrub once the Connections tab had been opened).

The shape recurred in three consecutive feature PRs. Flag:
- Mount-time heavy work (dynamic imports, WebGL contexts, full-collection scans) in palette content not gated on a `:visible` prop.
- Per-scrub or per-store-change computeds inside palette/tab content not gated on visibility, tab activation, or mode.
- Caps evaluated after the expensive work they exist to prevent — a 500-object cap that first materializes every selected annotation prevents nothing.

### 14. Overlay and Palette Stacking Combinations
A new floating palette or edge-anchored panel must join the shared right-edge clearance/stacking computation, and the check is combinatorial: consider every palette that can be open at the same time, not just the pair the feature was tested with. Recurred in #1288 (clearance computed from two of five right-edge palettes; action panels unhittable at 1280 px beneath a z-index-1006 palette) and #1298 (the Analysis panel covered the Filters panel — the very panel its own over-cap message told the user to open). Check both geometry (offsets, max-height) and z-index tiers (`FloatingPalette` 1006 vs action panels 1000).

## Example Output Format

The output has exactly four sections, in this order: **Overall Assessment**, **Findings**, **Findings Summary**, **Checklist Coverage**. **Questions for Clarification** is optional and appears only if there are open questions. There is no separate "Minor Observations" section — small items become findings with Severity Nit.

The two tables are numbered and serve different purposes:
- **Findings Summary** — one row per finding, sharing IDs with the Findings list above.
- **Checklist Coverage** — one row per review category, showing what was checked. Cite finding numbers in the row(s) that warn so the reader can jump from "this category warned" → "because of finding #N".

```markdown
## Code Review: [branch-name]

### Overall Assessment
[1–3 sentences: scope of the diff, overall quality, and anything notable that is NOT a finding — e.g. positive confirmations such as "backend access control is intact" or "no looped DB calls introduced". Do not list issues here.]

### Findings

#### Finding 1: [Short title]
- **File:** `src/store/example.ts:42`
- **Severity:** High | Medium | Low | Nit
- **Category:** [one of the Issue Categories rows, e.g. Pattern Consistency]

**Current:**
\`\`\`typescript
// problematic code
\`\`\`

**Suggested:**
\`\`\`typescript
// improved code
\`\`\`

**Rationale:** [Why this change improves the code]

---

#### Finding 2: [Short title]
- **File:** `…`
- **Severity:** …
- **Category:** …

**Current:** … **Suggested:** … **Rationale:** …

---

### Findings Summary
| # | Severity | Category | Location | Summary |
|---|----------|----------|----------|---------|
| 1 | Low | Pattern Consistency | `src/store/example.ts:42` | one-line restatement of Finding 1 |
| 2 | Nit | Code Duplication | `src/components/Foo.vue:17` | one-line restatement of Finding 2 |

### Checklist Coverage
| Category | Status | Findings |
|----------|--------|----------|
| Pattern Consistency | warn | #1 |
| Code Duplication | warn | #2 |
| Unnecessary Variables | pass | — |
| Missing Abstractions | pass | — |
| Performance Issues (looped DB/API) | pass | — |
| Type Safety | pass | — |
| Error Handling | pass | — |
| Layer Violation (API vs model) | n/a | — |
| Security / Access Control | pass | — |
| Raw PyMongo | n/a | — |
| Redundant Validation | pass | — |
| API calls in Vue components | pass | — |
| Frontend compensating for backend | pass | — |
| Store Organization | pass | — |
| Naming | pass | — |
| Partial persistence (same key written twice) | pass | — |
| Actions that throw/propagate without rawError | pass | — |
| Symmetric path drift | pass | — |
| Empty-state contract ([] vs null, failure vs empty) | pass | — |
| Lossy change identity | pass | — |
| Stale derived state | pass | — |
| Stale string reference | pass | — |
| Hidden-mounted work | pass | — |
| Overlay stacking | pass | — |

### Questions for Clarification
[Only include this section if there are open questions. Otherwise omit it.]
- [Question that needs the author's input]
```

Notes on the tables:
- Use `n/a` for categories that don't apply to the diff (e.g. backend-only checks on a frontend-only PR).
- Sort the Findings list and Findings Summary by descending severity (High → Nit). Tie-break by file path.
- Keep the **Summary** column in the Findings Summary to one line. The detailed reasoning belongs in the Findings entry above.

## References

- Codebase-specific review guidelines: `CLAUDE.md`
- Feature documentation index: `references/feature-documentation-index.md`
