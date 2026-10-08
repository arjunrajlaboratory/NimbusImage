# PR #1347 — Codex review fixes

## Reviews of `447cf225` … `725d2e7a` (2026-09-27/28) — final rounds before human review

| Finding | Status |
|---|---|
| P2 Share links survive their dataset's deletion | fixed (44e63efa) — a `model.folder.remove` hook revokes them |
| P2 Declined: stage materialize/score/neighborhood chunks atomically | declined — only a mid-job Mongo write failure; the job reports it and a rerun fixes it |
| P1 H&E adopts morphology's pixel size | fixed (9dff80e1) — `pixelSize / sqrt(\|det A\|)` through the transcript transform |
| P2 Gene picker keeps another dataset's genes | fixed (9dff80e1) |
| P1 Provider values materialize per-row dicts | declined — memory scales only on 64-gene full exports; a provider-contract redesign, not a wrong answer |
| P2 GeoJSON export open to share-link bearers | fixed (33cfb27a) — joins the download denylist; CSV and GeoJSON now tested |
| P1 ROI polygons counted as cells (neighborhood, regions, recompute) | fixed (33cfb27a) — `recompute.cellQuery` excludes the reserved `region` tag everywhere cells are selected |
| P2 Owner shown logged out after a directly opened share URL | fixed (33cfb27a) |
| P1 Vertex-mean vs area-weighted centroids | declined — segmentations are near-convex and evenly sampled; the frontend's `simpleCentroid` uses the same convention |
| P1 Anonymous differential jobs | deferred — the earlier decision; rate limiting at the proxy (AWSDeploy#120) |
| P2 Sparse-index validation of malformed stores; SharedView mid-load token change | declined — corrupt uploads and a sub-second navigation window |
| (live test) Pre-XOA-4 transcript tiles refused | fixed (59f04382) — the audit's exact `gene_offset` shape check rejected the lymph node's padded tables; only a shorter table is refused now |
| P2 Two-corner rectangles dropped from GeoJSON export | fixed (a0a292f8) |
| P3 `virtual_path` docstring says CSV needs materialize | fixed (a0a292f8) |
| P1 Server-atomic multi-batch GeoJSON import | declined — only a lost response mid-import; needs a server import session |
| P2 Share-link creation rollback | declined — only a mid-create DB failure; the orphaned token is never returned to anyone |
| P2 Singular transcript transforms accepted | declined — registrations come from the ingest scripts' real alignments |
| P2/P1 Stale table rows in unfiltered aggregate, differential B, virtual and stored summaries (fourth round of this family) | fixed at the source (ba37f908) — `store.liveRowMask` is the one "every cell" population; a bulk move carries value documents. Supersedes the earlier declines below |
| P2 SVD components exceed a one-feature table in recompute embeddings | declined — real tables have hundreds to thousands of features (405 / 4,624) |
| P2 Share login commits after its bootstrap awaits | declined — the same mid-load navigation race family, sub-second window |
| P2 Anisotropic transform and the scalar adopted scale | declined — 10x H&E alignments are similarity transforms (kidney: equal diagonals, derived 0.2740 vs the image's 0.2738 µm) |


## Reviews of `1b8c82c9` and `283828c5` (2026-09-27)

| Finding | Status |
|---|---|
| P2 Full rebuild refused when the active table was moved | fixed — only a dirty run pre-checks the active table; a full rebuild skips an unusable one (logged). The audit's job test is updated to that rule; regression fails without the fix |
| P2 Histogram bucket bounds of Infinity become null | fixed — non-finite values are left out of the buckets (a consequence of the previous round's `jsonSafe`); regression fails without the fix |
| P2 Dotted / `$` feature symbols listed but unusable in paths | fixed — refused at registration (`requirePathSafeSymbols`); existing registrations keep opening; regression fails without the fix |
| P2 Virtual summaries count table rows for deleted cells | declined then; **fixed later at the source (ba37f908, `liveRowMask`)** |
| P2 Transcript overlay: old request commits during the debounce | declined — a sub-second window, self-corrects when the replacement request lands |
| P2 Measurement refresh commits after a dataset switch | declined — needs the dataset switched inside the refresh's own awaits |
| P2 Shared raster-filter key evicted by another user's cap | declined — needs two users on the identical filter and one at 50 live registrations; a reload re-registers |

## Live test of the audit fixes (2026-09-27)

Backend (API, kidney/scratch test datasets) — all pass: batch unknown gene 400; summary
with a stored Infinity (count includes it, max/mean null); dirty recompute refuses changed
minQv and changed transcript pixel size, accepts once restored; materialize retires stale
sub-values (358 → 5 cells after a 5-cell table); materialize `.` symbol 400; neighborhood
retires per property; NaN / duplicate-symbol tables refused at registration with the
registration unchanged. Browser (ovary): materialize bumps the value revision; a recompute
whose dialog closed mid-job still switches the table (versions 0 → 2); the comparison
table clears when the method changes and labels Wilcoxon `z`; the selection summary warns
under a region filter; the live-column hint now says columns export to CSV.

Found and fixed during the live test:
- **A property a server job creates stayed invisible until reload** (materialize / score /
  neighborhood register it in the configuration server-side; the client never re-read
  it) — `adoptServerRegisteredProperty` adds the id locally before the property list
  reloads; dialog tests assert it, verified live ("LiveTest2 genes" appears immediately).
- **Writing a property value of `1e999` stored Infinity but answered 500** (Girder echoes
  the document through `allow_nan=False`), and so would GET values and the histogram —
  those endpoints now send non-finite numbers as null (`serialization.jsonSafe`); HTTP
  regression, verified live.
- **The hidden-layer warning** named the rule even when no layer was hidden — now only
  when one is.

## Pre-emptive audit (2026-09-27)

Three read-only auditors swept the branch for the shapes the Codex rounds kept finding
(validate before mutating, 500 on malformed input, identity uniqueness, twin paths,
merge vs replace, derived data mixing settings, non-finite JSON, miscounts), then fixers
applied the reachable ones, each with a regression test that fails without it.

| Area | Fixed |
|---|---|
| AnnotationPlugin | CSV export fills live gene (virtual) columns instead of a 400; histograms/dots honour gene filters (were an empty population); `batch` unknown gene is a 400; summary maps non-finite statistics to null (Infinity stays a value, as decided); summary validates paths before resolving filters; an omitted `upstreamGates` is `[]`, not a 500 |
| SpatialPlugin | dirty recompute also compares the transcript registration (file, pixel size, transform); materialize/score retire stale sub-keys on cells absent from the table; neighborhood types retired per property; materialize refuses `.`/`$` symbols; registration catches IndexError/TypeError; structural length checks at open; duplicate grid keys refused; non-finite X refused at registration; `log2FoldChange` null for non-positive means; jobs check file affiliation |
| Frontend | values refresh after Materialize/Score/Neighborhood; a job keeps polling after its dialog closes and still refreshes (a dataset change stops it); differential result cleared when inputs change; selection summary warns when region/hidden-layer filters are not applied server-side; revoking another link keeps a just-created URL |

Declined: a registered file's contents replaced in place (Girder `PUT file/contents`),
and the CSV preview labelling gene columns "Spatial table / X" while the file writes
"spatial / X" (cosmetic; needs a provider display name).

Suites: AnnotationPlugin 866 (full, including test_dataset_multi_source.py), SpatialPlugin
305 (full), frontend 4,214; live: histogram with a gene filter plots 38,731 = list/ids.

## Review of `96326b6d` (2026-09-27)

| Finding | Status |
|---|---|
| P2 A store whose schema fails replaces a working transcript registration | fixed — the schema is built inside the guarded open, before the registry changes; a malformed store is a 400 and the previous registration stays; regression fails without the fix |
| P2 Duplicate transcript gene names accepted | fixed — twin of the table-symbol check, over the biological genes; the lymph node and three tiny stores still open; regression fails without the fix |
| P2 Density tiles cached across a re-registration | fixed — the tile URL carries the registration (item, pixel size, transform); unit test |

## Review of `943b8e22` (2026-09-27)

| Finding | Status |
|---|---|
| P1 Dirty recompute with a different `minQv` (or tags) mixes settings | fixed — recomputed versions now record `minQv`/`tags` in their provenance, and a dirty run whose settings differ from the active table's is a 400 asking for scope `all` (an imported table has no settings to compare); regression fails without the fix |
| P2 Share-link creation vs a dialog reopened for another dataset | declined — needs the dialog closed and reopened on another dataset inside one create request; the third share-dialog race in a row, and the rounds are now finding progressively rarer interleavings of the same shape |

## Review of `1a316091` (2026-09-27)

| Finding | Status |
|---|---|
| P2 Selection-summary CSV mixes a new summary with old expression rows | fixed — Download CSV is disabled while the expression table recomputes (`canDownload`); unit test |
| P2 Overlapping share-link list refreshes | fixed — only the latest list request for the current dataset commits; a revoke and closing the dialog retire in-flight lists; regression fails without the guard |

## Review of `28a50f0a` (2026-09-27)

| Finding | Status |
|---|---|
| P1 Clearing the neighborhood property before writing loses it on failure and drops unrelated sub-keys | fixed — the previous round's up-front delete is gone; after every new value is written, only the types the previous run on this property wrote and this run lacks are unset. Regression covers a failed run (old values kept), an unrelated sub-key (kept) and a retired type (dropped); fails on the delete-first version |
| P2 Dirty recompute reports carried cells' molecules as unassigned | fixed — `assigned` counts every molecule inside a cell; only the rebuilt-row keys are narrowed to dirty cells; test fails without the fix |
| P2 Duplicate feature symbols accepted | fixed — registration refuses a repeated `var` symbol; verified the lymph node and the three 10x tiny tables still open; regression fails without the fix |

## Review of `38e88878` (2026-09-26)

| Finding | Status |
|---|---|
| P1 Retired neighborhood type fractions linger after a rerun | fixed — a run clears its property for the dataset before writing (`writeCellValues` merges sub-keys); the rerun-with-a-type-excluded regression fails without the fix |
| P2 Duplicate `obs.annotation_id` rows accepted | fixed — registration refuses a repeated id; regression fails without the fix |
| P2 Transcript overlay reused across a replaced map | fixed — overlays are keyed by map identity, and teardown deletes only layers the map still holds (an exited map already dropped them); unit test. An unroll round-trip live did not replace map 0 here, and the overlay kept updating |
| P2 Table card refresh not retired when the table goes away | fixed — the no-table branch claims the refresh token; regression fails without the fix |

## Review of `980059cb` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Only a strided sample of `obs.annotation_id` is validated | fixed — the whole column is checked, vectorized (0.09 s for 700K ids), so a bad row is a registration 400, not a failed job; regression fails without the fix |
| P2 A missing live gene aborts the post-activation refreshes | fixed — registration, versions and staleness are re-read even when the gene-value refresh rejects; the first failure is still shown; regression fails without the fix |

## Review of `62f5c81a` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Recompute drops cell-free tiles' molecules from `unassigned` | fixed — a tile no cell reaches still counts its quality-passing molecules as considered; unit test fails without the fix |
| P2 Differential groups editable while a comparison runs | fixed — group B, its tags and the method lock while running (group A comes from the viewer's filters behind the modal); regression fails without the fix |
| P1 Anonymous differential-expression jobs | deferred — repeat of the 2026-09-06 decision to leave anonymous jobs unchanged |
| P2 Share bootstrap vs session restore | declined — repeat of the 4793d690 round's reasoning |

## Review of `a643cc49` (2026-09-26)

| Finding | Status |
|---|---|
| P1 Welch reports t 0 / p 1 for two constant groups with different means | fixed — perfect separation is t ±inf, p 0 (as scipy); it ranks first and serializes as `t: null` (JSON has no infinity; the dialog shows –); unit test |
| P2 Activating a version moved out of the dataset breaks the registry | fixed — the version's file is loaded and affiliation-checked before the registry changes; regression fails without the fix |
| P2 Materialize job reports the table size as cells written | fixed — the dialog reads the job's published `spatialResult.written`; regression fails without the fix |

## Review of `038f25e4` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Dirty recompute opens the active table without the affiliation check | fixed — the recompute preflight uses the shared `_openStore` (a sweep found no other request-time opener); regression fails without the fix |
| P2 Pixel-size adoption is not rolled back on a failed write | declined — the blank is only filled in memory for that session; the next load re-adopts it from the registry |
| P2 Selection-based region summary vs a changing selection | declined — the dialog is modal, so the viewer selection cannot change while a request runs |

## Review of `b00adb36` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Overlapping spatial-info refreshes | fixed — `refreshInfo` claims a sequence token first; only the latest commits info, error or loading; regression fails without the fix |
| P2 Direct store openers skip the dataset-affiliation check | fixed — `provider.requireFileInDataset` now guards the provider and both API openers (table, transcripts); regression with a caller who reads both folders fails without the fix |
| P2 Virtual columns densify the whole column per page | declined — the CSC column read is unavoidable either way; the dense fill is a ~ms allocation next to it |

## Review of `a7c48839` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Wilcoxon statistic labelled `t` | fixed — header and CSV say `z` for Wilcoxon results (`t` for Welch); regression fails without the fix |
| P2 Region inputs editable while a summary runs | fixed — source and tag lock while loading (the genes were already captured per request); regression fails without the fix |
| P2 Falsy non-object `filters` in the shared list prologue | declined — same reasoning as the aggregate endpoint: `{}` is a valid request with the same cost |
| P2 Unfiltered aggregate reads the table, not live annotations | declined then; **fixed later at the source (ba37f908): the live mask is cached, 2.2 s cold / 0.01 s warm at 709K** |
| P2 Overview filter keys expire after seven days | declined — needs a viewer left open over a week with unchanged filters; a reload or any filter change re-registers |

## Review of `e1b483dd` (2026-09-26)

| Finding | Status |
|---|---|
| P2 Geometry hash raises before annotation validation (500) | fixed — malformed coordinates skip the hash so the schema validator rejects them; four parameterized cases fail without the fix |
| P2 Density layer above annotation outlines | not a bug — GeoJS `zIndex()` without `allowDuplicate` moves the equal-z annotation layer up; verified live (density 10, annotations 11) |
| P2 Selection summary survives a dataset switch while open | declined — the dialog is modal and refetches on every open; switching datasets underneath an open modal is not a reachable UI path |
| P2 Table-version activation across a dataset switch | declined — needs a dataset switch inside the activation request; the next dataset load refreshes the table state |

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
  *(Superseded by the merge of master's #1358: an append now `$set`s each property it
  carries, so a recompute replaces the stored value; `setSubValuesMany` still merges
  nested keys.)*
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
