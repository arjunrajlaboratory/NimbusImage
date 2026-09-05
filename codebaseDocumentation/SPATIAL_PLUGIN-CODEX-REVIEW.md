# PR #1347 — Codex review fixes

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
