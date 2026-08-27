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
  `ensureVisiblePropertyValues` in the properties store.

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
