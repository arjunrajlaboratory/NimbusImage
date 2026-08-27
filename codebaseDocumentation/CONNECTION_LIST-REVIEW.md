# Connection List — Track ID property: review findings tracker

Findings on PR [#1333](https://github.com/arjunrajlaboratory/NimbusImage/pull/1333)
(track labels from a worker-computed property, issue #1330). One entry per
finding; update the Status line as each is resolved. Companion to the feature
doc `CONNECTION_LIST.md`, whose regression checklist holds the durable
invariants extracted from these rounds.

## Internal branch-review round (2026-08-27)

### R1 — Sequence-guard token claimed after early returns
- **Where:** `ConnectionList.vue` `ensureTrackLabelValues`
- **Severity:** Medium
- **Summary:** The stale-response token was claimed only on the fetch path, so
  a bail-out that reset the cache key could be followed by a late response
  merging values fetched for the previous property path under the new key.
- **Status:** fixed adef9f64 — token claimed first, matching
  `ensureVisiblePropertyValues` in the properties store. Superseded by C5:
  the token is gone; each request now captures its cache key and merges only
  while that key is current, which covers every early return by construction.

### R2 — Fetcher blind to `stubOnlyMode`
- **Where:** `ConnectionList.vue` track-label watch sources
- **Severity:** Medium
- **Summary:** The labels computed branches on `annotationStore.stubOnlyMode`
  but the fetch watcher did not watch it; the mode (annotation fetch) and the
  tracks (connection fetch) settle in parallel, so a late flip to lazy mode
  left every track "no ID" with no fetch ever issued.
- **Status:** fixed adef9f64 — mode added to the watch sources; the test
  mock is `reactive()` so the flip can be driven post-mount. Test: *"fetches
  when lazy mode is determined after the tracks arrive"*.

## Codex round 1 (review 5038030993, on adef9f64)

### C1 — Long property labels displace the row's actions (P2)
- **Where:** `ConnectionList.vue:185` (`.track-title`)
- **Severity:** P2
- **Summary:** The now variable-width title inherits `white-space: nowrap`
  with no shrink/overflow constraint, so a long string value pushes the
  staleness badge, meta, Select menu and Delete button out of the panel.
  Only `.track-meta` was set up to shrink.
- **Status:** fixed — title capped with ellipsis (`max-width` +
  `flex-shrink: 0` + `text-overflow`), and the full formatted value moved
  into the title tooltip so an ellipsized label stays recoverable. First
  attempt used `min-width: 0`, which put the title in the flex shrink pool
  and squeezed short badged titles ("Track 0" → "Tra…") — caught live;
  `flex-shrink: 0` binds the cap to the title's own content only. CSS is not
  unit-testable; verified live.

### C2 — Split tracks that retain one worker ID are not badged (P2)
- **Where:** `ConnectionList.vue:524` (label resolution)
- **Severity:** P2
- **Summary:** Deleting a connection after the worker ran splits one
  component into two tracks whose members still unanimously carry the same
  old id. Each resolves independently as a clean `value`, so neither gets a
  staleness badge and the panel shows duplicate `Track 42` rows — a graph
  change the badges claimed to cover.
- **Status:** fixed — labels resolved as clean `value` that appear on more
  than one displayed track now badge `duplicate ID` (warning). Detection is
  across the displayed (scope-narrowed) rows: with the default
  "All connections" scope that is the whole dataset; a narrower scope can
  hide a duplicate's twin, which the tooltip wording allows for. Tests:
  *"badges tracks sharing one value after a split"*, *"does not badge
  distinct values as duplicates"*.

### C4 — Live property deletion leaves the label path orphaned (P2, round 2, review 5038415891)
- **Where:** `ConnectionList.vue:485` / `connectionList.ts`
- **Severity:** P2
- **Summary:** `resolveAnnotationBrowserConfig` drops an unknown-property path
  at hydration, but a live deletion had no twin: `setProperties` reconciled
  analysis plots only, so the panel kept labelling from the deleted property
  and a later browser save could persist the orphaned path until reload.
- **Status:** fixed — `reconcileTrackLabelPathForPropertyIds` (connectionList
  store) clears the path through the scheduling setter when its property id
  leaves the configuration; wired into `properties.setProperties` alongside
  the plot reconciliation (dynamic import for the same cycle reason). Tests:
  *"clears the path and persists when its property is deleted"*, *"keeps the
  path and stays silent while its property exists"*.

### C5 — Overlapping fetches resend ids and discard valid responses (P2, round 3, review 5038498551)
- **Where:** `ConnectionList.vue:646` (`ensureTrackLabelValues`)
- **Severity:** P2
- **Summary:** Lazy-mode tracks rebuild on every pan, re-entering the fetcher
  while a request is pending; each re-entry resent all still-missing ids and
  bumped the latest-only token, discarding the earlier valid response — so
  continued interaction piled up identical queries and labels never settled.
- **Status:** fixed — a pending-id set coalesces re-entries (only ids in
  neither the cache nor flight are requested), and the latest-only token is
  replaced by captured-key matching: values are immutable per path/revision,
  so every current-key response merges (coverage only grows) while a
  superseded-key response is dropped. A failure releases its pending ids so
  Retry or the next run can resend them. Test: *"coalesces fetches while one
  is in flight and merges its response"*.

### C6 — Obsolete request's failure strands the warning (P2, round 4, review 5038570740)
- **Where:** `ConnectionList.vue:648`
- **Severity:** P2
- **Summary:** Consequence of C3+C5: a request for tracks shown before a
  scope change can fail after a newer same-key request covered everything
  displayed. Its failure set `trackLabelFetchFailed`, and Retry found
  `missingIds.length === 0` and returned before the reset — a permanent
  false warning above fully resolved tracks.
- **Status:** fixed — the flag keys off `hasUncoveredTrackMember()` (a
  displayed member with no cache entry), set on failure only when one exists
  and cleared by the nothing-missing early return when none do. Test:
  *"clears a stale failure once every displayed member is covered"*.

### C7 — Settling request cleans the wrong pending set (P2, round 4, review 5038570740)
- **Where:** `ConnectionList.vue:655`
- **Severity:** P2
- **Summary:** Consequence of C5's cleanup: after a key change the current
  pending set belongs to the new key's request, which re-adds the same member
  ids; the old request's `finally` deleted them from that current set,
  stranding them as neither cached nor pending, so the next pan resent an
  identical batch.
- **Status:** fixed — cleanup deletes from the captured `pending` set the
  request added its ids to; after a key change that set is the discarded one,
  so the deletes are harmless. Test: *"a key change mid-flight does not
  strand the new request's pending ids"* (verified to fail against the
  pre-fix component via `git stash`).

### C8 — Success after a mid-flight failure leaves the warning stranded (P2, round 5, review 5038712578)
- **Where:** `ConnectionList.vue:659`
- **Severity:** P2
- **Summary:** Mirror of C6: request A fails while covering request B is
  still pending (flag correctly set at that instant); B then succeeds and
  populates the cache, but the flag was only cleared at request start, so
  "Couldn't load track ID values" stayed over fully resolved tracks until a
  pointless Retry.
- **Status:** fixed — the successful merge recomputes the flag
  (`hasUncoveredTrackMember()`), so every settle path converges the warning
  toward the truth. Test: *"clears the failure when the covering request
  succeeds after it"*.

### C9 — Quadratic distinct-value scan in label resolution (P2, round 5, review 5038712578)
- **Where:** `src/utils/connections.ts:456` (`resolveTrackLabelValue`)
- **Severity:** P2
- **Summary:** `distinct.includes(value)` scanned a growing array per member.
  The picker offers per-annotation paths (annotationId) where every member of
  a large track is unique, and resolution reruns on every scoped-tracks
  rebuild — quadratic per pan, a freeze on thousand-member tracks. (Flagged
  as a nit in the internal round and wrongly deferred; the per-annotation-path
  scenario makes it real.)
- **Status:** fixed — a `Set` handles membership while the ordered array
  keeps the mixed-status report. Test: *"resolves a large all-distinct track
  in linear time"* (100K members; the implicit test timeout is the cost
  guard).

### C10 — Duplicate detection misreads scoped fragments as splits (P2, round 6, review 5038775165)
- **Where:** `ConnectionList.vue:573`
- **Severity:** P2
- **Summary:** Displayed track rows are connected components of the SCOPED
  connections, so a narrow scope (selected/filtered/current location) shows
  one intact dataset-wide track as two fragments; both unanimously carry the
  same value and were badged `duplicate ID` though no split happened.
- **Status:** fixed — `findDuplicateTrackLabelValues` now takes the row's
  `colorKey` (the dataset-wide track identity from `trackAnalysis`) and
  reports a value only when it spans two DISTINCT dataset-wide tracks. The
  other half of the finding — a real split whose twin is outside the scope is
  missed — remains the documented scope limitation. Tests: *"does not badge
  scoped fragments of one dataset-wide track"*, *"does not report fragments
  of one dataset-wide track"* (utils).

### C11 — Lazy-mode failure survives into wholesale datasets (P2, round 6, review 5038775165)
- **Where:** `ConnectionList.vue:594`
- **Severity:** P2
- **Summary:** The component outlives dataset switches; after a lazy-mode
  fetch failure, opening a wholesale dataset re-hydrated a label path and hit
  the `!stubOnlyMode` early return without clearing `trackLabelFetchFailed` —
  a permanent warning that Retry (the same early return) could never clear.
- **Status:** fixed — the inactive/wholesale early return clears the flag:
  with the fetcher out of play, any recorded failure is obsolete. Test:
  *"clears a lazy-mode failure when wholesale mode takes over"*.

### C12 — Startup fetch superseded by the revision bump (P2, round 7, review 5038853319)
- **Where:** `ConnectionList.vue:717`
- **Severity:** P2
- **Summary:** With the tab active during a lazy dataset load,
  `fetchAnnotations` sets `stubOnlyMode` (a watch source since R2) before
  `Viewer.fetchAnnotationData` calls `fetchPropertyValues`, whose first
  operation bumps `propertyValuesRevision` — so the batch launched in that
  gap was superseded by the key change and the same members re-sent, every
  load.
- **Status:** fixed — `properties.fetchPropertyValues` records
  `propertyValuesDatasetId` in the same tick as the bump, and the fetcher
  gates on it matching the open dataset (the bump is a watch source, so the
  fetch fires the moment readiness lands). Tests: *"waits for the dataset's
  property refresh before fetching"*, *"records the dataset id alongside the
  revision bump"*.

### C3 — Fetch failures indistinguishable from confirmed missing values (P2)
- **Where:** `ConnectionList.vue:590` (lazy-mode fetch)
- **Severity:** P2
- **Summary:** On a failed batch request the cache stayed empty and
  `trackMemberValue` converted every absent entry to `null`, so all tracks
  showed the authoritative-looking `no ID` badge; nothing retried because no
  watcher input necessarily changes after a failure.
- **Status:** fixed — in lazy mode a member id absent from the fetch cache is
  now *unknown*, not missing: tracks with uncovered members get no resolution
  (default short-id title, no badge) until a successful response covers them;
  ids resolve to "confirmed missing" only from a successful response. A
  failed fetch sets an error flag rendered as a compact alert with a Retry
  button. Tests: *"does not confuse a failed fetch with confirmed missing
  values"*, *"retries after a failed fetch"*.
