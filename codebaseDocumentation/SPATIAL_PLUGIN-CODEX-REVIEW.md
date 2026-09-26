# PR #1347 — Codex review fixes

## Review of `4793d690` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Quality threshold is not exact in every render mode | fixed — the panel says so: coarser point levels only split at Q20 (exact at 0 and 20), and the heat map counts every quality; per-level quality data was not added |
| P2 Share-session restore can race the link's initialization | deferred — needs leaving the route inside the sub-second `loggedIn`; the worst case is a stale folder location or colour list until reload, not a wrong credential (the restored client is set synchronously) |
| P2 Region summaries survive dataset switches | fixed — results and the tag clear on a dataset change and an in-flight answer for another dataset is dropped; regression fails without the fix |
| P2 Falsy non-object `filters` default to `{}` on the aggregate endpoint | declined — `{}` is itself a valid request with the same cost, so a malformed falsy value grants nothing a caller could not already ask for |

## Review of `756f68b6` (2026-09-26)

| Finding | Status |
|---|---|
| P1 Anonymous region-summary computation | deferred — same class as the anonymous differential-expression jobs the user asked to leave unchanged (2026-09-06); the centroid pass is cached per raster version |
| P2 Malformed `regionTag` beside `regionIds` → 500 | fixed — `regionTag` validated whenever present (400); regression in `testRegionSummaryValidation` fails without the fix |
| P2 Region polygons counted as cells in neighborhoods | deferred — a handful of region polygons among ~700K cells barely moves counts or enrichment, and every candidate cell predicate (the `cell` tag, table membership) would exclude real cells on non-Xenium datasets; revisit if regions become numerous |
| P2 Region results labelled with edited genes | fixed — columns use the genes the request was sent with (the button is disabled while loading, so no guard is needed); regression fails without the fix |
| P2 Session not restored after leaving a shared view | fixed — `leaveShareLink` restores the replaced client on route unmount (raw-client comparison: Vuex hands back reactive proxies), including after link-to-link hops |

## Final local review (2026-09-06)

| Finding | Status |
|---|---|
| P1 Virtual values bypass file access after a source item moves | fixed — provider rechecks current parent-item affiliation before every table/cache read |
| P2 Abandoned share-route bootstrap still commits identity | fixed — route cancellation reaches the store's identity commit guard |
| P2 Old job polls overwrite a reopened dialog's new run | fixed — shared lifecycle guard invalidates submissions, polls and timers in all four sibling dialogs |

Anonymous jobs remain deferred at the user's request. Commit and push are explicitly authorized for this round.

### Final-round pattern sweep and verification

- Warm-cache provider reads now refuse a source moved out of the authorized
  dataset. Four parameterized regressions failed with 200 instead of 403 before
  the fix; all cover restoration when the item moves back.
- Both the real share-login action and the route have cancellation regressions;
  both failed before the fix. Token replacement uses the same watcher cleanup.
- Sixteen real-component lifecycle cases cover all four job dialogs. Thirteen
  failed before the fix; the existing differential-expression implementation
  already handled three. The shared guard also protects dependent property/info
  refreshes and clears stale result state on dataset changes.
- Focused share tests: 12 passed. Existing job-dialog suites plus lifecycle
  regressions: 34 passed.
- Full final frontend: **4,062 tests passed** across 235 files, no unhandled
  errors. Type checking, zero-warning lint and production build pass (existing
  bundle-size warnings). A parameterized-test typing issue was corrected, then
  the lifecycle suite was rerun: all 16 passed.
- Full final Spatial backend: **249 tests passed**, six existing zip/UMAP warnings.
  Annotation backend source is unchanged from the preceding **609-test** full
  pass. All changed Python files pass flake8; diff and skill parity checks pass.
- Fresh live frontend: the synthetic dataset loads, recompute opens/closes/reopens
  without stale busy state, and an invalid share link shows the expected error
  without losing access to the private viewer. Exact delayed-response races are
  covered by the deterministic action/component tests, not this smoke check.
- Rebuilt and recreated Girder. A live virtual filter on a disposable copied
  table returned 200 before moving the source item, 403 after moving it out of
  the dataset with the cache warm, and 200 after restoring it. Removed the
  disposable folder, copied item and registry; original data and ACLs unchanged.
  The private viewer also loaded successfully after the backend restart.

## Follow-up review of `ffc6383f` (5119300729)

| Finding | Status |
|---|---|
| P1 Anonymous differential-expression jobs | deferred — user explicitly requested leaving anonymous jobs unchanged (2026-09-06) |
| P2 Failed share bootstrap commits attempted identity | fixed — isolated validation before committing login state; obsolete attempts cannot win |
| P2 Duplicate-value migration retains obsolete dataset | fixed — indexed lookup resolves live annotation ownership during migration; orphan metadata retained |
| P2 Transcript gene results survive dataset switches | fixed — invalidate choices, query, loading and pending work on identity changes, including hidden panels/unmount |
| P2 Spatial registry permits duplicate/lost registrations | fixed — required unique index, legacy merge and revision-checked updates/deletes across all writers |

### Follow-up pattern and blast-radius checks

- **Session identity:** validated on a separate client without persistence handlers.
  The active credentials, Vuex user and dependent state are unchanged on failure.
  Tested signed-in/anonymous origins and overlapping attempts. Login is committed
  only after both user and share-link lookups succeed.
- **Migration ownership:** values still merge with older-leaf precedence, but the
  survivor now uses the annotation's live dataset. An indexed aggregation lookup
  avoids one database call per annotation; orphaned values retain their metadata.
  Destination-scoped hydration is tested without an additional computation.
- **Search identity:** the expression picker had the same pending-response shape.
  It now also invalidates requests when a dataset becomes null, cancels a queued
  old query, clears feature-type labels, and invalidates on unmount. Both pickers
  invalidate at query scheduling time rather than after the debounce delay.
- **Registry identity:** audited every writer, including activation, forgetting a
  version, neighborhood results and deleting either half. Revision checks protect
  updates and deletes; concurrent first inserts retry against the unique key.
  Legacy duplicates merge whole table/transcript bundles (latest wins), retaining
  alternative tables as versions. Removing the last store no longer discards an
  independently written neighborhood summary; removals return the removed file
  for cache invalidation. Index installation errors propagate rather than hiding
  a broken invariant behind Girder's best-effort helper.
- **Harnesses:** reactive dataset mocks and automatic component unmounting make
  stale-request tests meaningful. The full frontend run exposed older UserMenu
  tests leaking VImg timers; those mounts are now cleaned up. Registry constructor
  error tests patch the collection class, since initialization replaces its handle.
  Full-suite concurrency also exposed a checklist scan entering live Mongo data
  and file-manager mounts leaving delayed requests behind. The scan skips `db`
  before stat calls, and those components now unmount after each test.

### Follow-up verification

- Every reported P2 and the sibling expression picker had failing regressions
  before its fix. Focused auth/picker/property/registry suites pass.
- Final frontend: **4,044 tests passed** across 234 files, no unhandled errors;
  `pnpm tsc`, `pnpm lint:ci`, and `pnpm build` pass (existing size warnings).
- Final Spatial backend: **245 tests passed** via tox, with six existing
  zip/UMAP warnings. The earlier full run collected the old constructor-test
  mock before its correction; the clean full rerun includes that correction.
- Final Annotation backend: **609 tests passed** via tox, with 17 warnings.
  This full run includes the final ownership-migration code and regressions.
- Changed Python files pass flake8; skill mirrors are synchronized and parity
  checked. `git diff --check` passes. These fixes are included with the final round.
- Rebuilt and recreated Girder; confirmed the running image contains revision
  checks and the live-dataset migration lookup.
- Live browser: switched from the original synthetic fixture to a disposable
  second fixture with distinct `ROUND2_` gene names. The mounted panel showed only
  the new gene choices; selecting `ROUND2_CD3E` rendered two molecules. Returned
  to the original fixture (with the panel hidden), and after the backend restart
  a fresh load again offered only its original three genes.
- Live invalid-link check displayed the expected error while the profile remained
  `arjunraj`; returning to the normal private viewer and reloading retained login.
  The more specific user-lookup-success/link-lookup-failure case is covered by the
  real Vuex action regressions, not by a credential-bearing browser URL.
- Live expression picker: `CD3` narrows to `CD3E`, correctly labeled as a gene;
  closed without adding a column or starting a computation.
- Live concurrent first-time registration on a separate disposable child retained
  both table and transcripts in exactly one record; the unique index was verified
  in Mongo. Unregistering the table retained transcripts.
- Both disposable datasets and their copied/uploaded items were removed. The
  first fixture's orphaned view/registry records were also explicitly removed.
  No original scientific dataset, annotation, property or access policy changed.

The earlier temporary share-link live check was subsequently approved and passed:
the synthetic fixture's bearer could read, named access lists hid the link principal,
and revocation invalidated the bearer. No test link remains active.

## Previous round

Review of `b25725ba`, review ID `5118897415`.

| # | Priority | Location | Finding / generalized pattern | Status |
|---|---|---|---|---|
| 1 | P1 | `TranscriptOverlay.vue` | Density mode ignores transformed-registration capabilities | fixed — auto and forced density use the point pyramid; disabled heat-map control explains the limitation |
| 2 | P2 | `models/propertyValues.py` | Dataset-scoped uniqueness conflicts with annotation-only joins after moves | fixed — restore global annotationId uniqueness and both upsert keys; upgrade the old nonunique index and coalesce cross-dataset duplicates |
| 3 | P2 | `TranscriptOverlay.vue` | Empty tile plans are valid empty results, not requests | fixed — empty views clear points, density, and readout; no empty initial or 413-retry requests |
| 4 | P2 | `App.vue` | Failed discovery hides the control needed to recover | fixed — controls remain reachable while loading or failed, explicit retry, cached-error retry and stale-request guards |
| 5 | P2 | `helpers/shareLinkGuards.py` | Hidden principals leak through sibling access-list surfaces | fixed — shared formatter excludes link users without changing ACLs |

## Verification and pattern sweeps

All five original findings had failing regressions before their fixes.

- **Capabilities:** checked auto, explicit density, the mode toggle, and schema refresh.
  Added two sibling fixes: refreshed schemas re-evaluate the renderer, and a formerly
  selected density mode displays Points on a transformed registration.
  `TranscriptOverlay.test.ts`: `uses points for transformed registrations`,
  `rechecks rendering capabilities when the schema is refreshed`;
  `TranscriptsPanel.test.ts`: `disables heat maps for transformed registrations and explains why`.
- **Identity:** checked ordinary single/bulk append, spatial nested writes, validation,
  annotation-driven and property-driven joins, and legacy migration. Both writers now
  use the same immutable annotation key as readers; datasetId remains mutable metadata.
  Existing append precedence (stored values win) and nested merge semantics remain.
  The final ownership sweep also found that global-key upserts require checking
  annotation membership, not just access to the supplied dataset. Both REST writers
  now validate all annotation/dataset pairs with one query before any write; a
  mixed valid/foreign batch is rejected before its valid prefix is saved.
  `test_property_value_atomic.py`: `testMoveThenComputeKeepsOneValueDocument` (both writers),
  `testStartupCoalescesCrossDatasetDuplicates`; existing startup/atomic tests retained.
  `testCannotRehomeForeignValuesThroughWritableDataset` failed before the ownership
  guard for both single and bulk writes.
  The spatial materialize/score/neighborhood writer also batch-checks membership,
  skipping table IDs for moved, deleted, or foreign annotations. Its written count
  reports actual live cells, while progress reports examined rows. The regression
  `testCellValueWriterSkipsMovedAndDeletedAnnotations` passes with the fix and
  fails at `written == 1` with the legacy writer (three rows were written).
- **Empty work:** checked initial plans, the density sibling, outside-image views,
  and coarser 413 retries. One shared clearing path resets status and stale readout.
  `TranscriptOverlay.test.ts`: `clears a previously populated viewport when its tile plan is empty`
  (auto and density), `does not request an empty coarser tile set after a 413`.
- **Recovery:** checked initial failure, retained-schema failure, dataset switches,
  and overlapping retries. Old requests cannot overwrite current results/errors or
  clear the newer loading flag. `App.test.ts`: `keeps the Transcripts control reachable
  after schema failure and during retry`; `TranscriptsPanel.test.ts`: `offers an explicit retry
  after schema failure`; `transcripts.test.ts`: cached-error and older-request regressions.
- **Hidden principals:** checked all `formatAccessList` callers: dataset, configuration,
  and project. The existing bulk email query now filters link principals, and only
  those ordinary users appear in the formatted response. No extra per-user queries.
  `test_share_link.py`: `testLinkUsersStayOutOfAccessLists` checks both link-bearing
  resources and verifies the bearer remains usable. Named-sharing and revocation tests retained.

## Automated verification

- Frontend: **4,037 tests passed** across 234 files; `pnpm tsc` and
  `pnpm lint:ci` passed. `pnpm build` passed with non-fatal bundle-size warnings.
- Spatial backend: initial tox run **222 passed**; final source rerun after the
  membership guard **231 passed** (the new shared-class regression also runs in
  the inheriting test suites).
- Annotation backend: full tox run **606 passed**. This run started before the
  final ownership additions; those are covered by the focused final-source reruns
  below and the rebuilt live API checks.
- Final ownership/property/access/sharing regressions: **79 passed**; spatial
  writer/materialization focus: **7 passed**. Changed Python files pass flake8.
  The final atomic suite also passed all **8 tests**, including the private-dataset
  ownership fixture.
- Skill mirrors synchronized and parity checked; `git diff --check` passed.

## Live verification (synthetic dataset only)

Dataset `6a9b48ac52ade68cca53700c` (Astra review live regression); no scientific
datasets or pre-existing annotations were modified in this review round.

- Fresh-load identity-transform fixture: Heat map disabled with its explanation;
  CD3E reports two molecules in Auto mode, with no new browser errors.
- Rebuilt Girder with `docker compose build girder` and recreated the service.
  The live database now has unique `annotationId_1` (the prior compound index
  remains compatible).
- REST move/recompute smoke test on two disposable child datasets: the value
  document keeps its ID, adopts the destination dataset, retains the old value,
  and adds the new value without a duplicate. Removed the scratch annotation
  and both scratch folders after the check. Repeated on the final rebuilt backend:
  single and bulk mismatched annotation/dataset writes both return 400, and the
  subsequent legitimate move/recompute still succeeds. All scratch data removed.
- On the rebuilt server, translating the synthetic transcripts outside the image
  produces “Nothing to show in this view” without new browser errors.
- A deliberately unreadable transform causes initial discovery to fail. The
  Transcripts control remains available with Retry; restoring the registration
  and clicking Retry recovers all controls **without reloading**.
- Restored the fixture's original null transform. The injected lookup failure
  was intentional; earlier browser errors during the service restart are not
  treated as clean-run results.
- Final fresh-browser check on the rebuilt backend: CD3E shows two points,
  switching to Heat map reports density rendering, and fresh logs contain only
  the Vite connection messages (no new errors).
- Live creation of a temporary share link was **blocked by approval policy**
  because it grants read access. No new link was created. The isolated Girder
  regression covers both formatted access responses and continued bearer access;
  a new-link browser smoke check remains unperformed. Read-only live dataset and
  configuration access responses both retain the two ordinary named users;
  the synthetic fixture has zero active share links.
