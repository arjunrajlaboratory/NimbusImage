# Server-Side Annotation List — Code Review Notes (2026-06-18)

Holistic review of this session's work (Option A coordinate fixes + Option B server-side list), scoped to `git diff 9ff4f782..HEAD` on `feature/stub-annotations`. Each task was already two-stage-reviewed during implementation; this is the cross-cutting pass.

**Related docs:** `ANNOTATION-LIST-SERVER-SIDE-DESIGN.md` (spec + as-built notes), `ANNOTATION-LIST-SERVER-SIDE-PLAN.md` (task plan), `ANNOTATION-STUBS.md` (stub architecture / Option B status).

## Verdict
Quality is high: API/model layer separation intact (model raises `ValueError`, never `RestException`), no looped DB queries, no raw PyMongo (`.aggregate` only), access control correct (READ check + 403 test), tag/missing-sort/property-path semantics match the client and are tested, and the server-mode decoupling from `filterStore.filteredAnnotations` is well-guarded and proven by a throwing-getter test. The pass found **one High bug** (tag/color/name edits silently no-op in server mode) and a few Medium robustness gaps.

**Recommended to fix now:** #1 (High), #2 (Medium).
**Follow-ups (defer OK):** #3 (sequence token), #4 (row-component extraction), and the documented perf pass (spec §8).
**Cheap cleanups:** #5–#11.

> **Note:** `file:line` references are as of 2026-06-18 and will drift — search by symbol. Verify each root cause against current code before fixing (per memory: review notes are point-in-time).

---

## Findings

### Finding 1 — Tag / Color / Name edits silently no-op in server mode  ·  Severity: High  ·  Reactivity/correctness
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue` — `handleTagSubmit`, `handleColorSubmit`, `updateAnnotationName` → `src/store/annotation.ts` `updateAnnotationsPerId` (~:1185).
**Problem:** Those handlers route through `updateAnnotationsPerId`, which does `const idx = this.annotationIdToIdx[id]; if (idx === undefined) continue;`. In stub-only/server mode `annotations[]` is empty so `annotationIdToIdx` is empty → **every id is skipped, the backend is never called.** "Tag Selected" / "Color Selected" / inline name edit silently do nothing on large datasets, with no error. The spec §2 lists tag/color bulk ops as in-scope. (This was earlier mis-deferred as mere "staleness" — it's actually a silent no-op, which is worse.) Contrast: `deleteAnnotations` was made stub-aware and `deleteSelected/Unselected` got server-mode branches; the tag/color/name path was not.
**Fix options:** (a) give the handlers server-mode branches that call the existing batch tag/color endpoints by id, then `annotationListServer.fetchPage()` to refresh; or (b) if the batch-by-id mutation isn't readily available, disable the Tag/Color actions + inline name field in server mode so the no-op isn't silent (and file a follow-up). Prefer (a). Verify the actual mutation path in `annotation.ts` first (`tagSelectedAnnotations`/`colorSelectedAnnotations`/`updateAnnotationName` → `updateAnnotationsPerId`), and check whether a stub-aware update already exists (mirror `deleteAnnotations`'s `if (this.stubOnlyMode)` branch).

### Finding 2 — Invalid ObjectId in `idConstraints` → uncaught 500 on a public endpoint  ·  Severity: Medium  ·  Error Handling
**Where:** `server/api/annotation.py` — `listAnnotationIds` (~:691, no try/except) and `listAnnotations` (`listCount` at ~:734 runs *before* the `except ValueError`); validator `_validateListInputs` (~:42-53).
**Problem:** `_validateListInputs` checks `idConstraints` entries are non-empty *strings* but not ObjectId-valid. The model then calls `ObjectId(i)` in `_buildListMatchStages`. A string like `"notanobjectid"` raises `bson.errors.InvalidId` (a `ValueError` subclass) → uncaught 500 in `/list/ids` (no try), and in `/list` it fires inside `listCount` before the `except ValueError` can catch it. Contradicts the validator's stated purpose ("avoid uncaught 500s on a public endpoint").
**Fix:** Convert/validate `idConstraints` ids to `ObjectId` at the API boundary (in or right after `_validateListInputs`) and raise `RestException(400)` on `InvalidId`. Same gap applies to `idSubstring` not being `isinstance(str)`-checked (see #7) — fold both in.
**Test:** add to `test/test_server_list.py` — malformed idConstraints (`[["notanobjectid"]]`) → 400 on both `/list` and `/list/ids`.

### Finding 3 — No stale-response guard (sequence token) in `fetchPage`  ·  Severity: Medium  ·  Reactivity/correctness
**Where:** `src/store/annotationListServer.ts` `fetchPage` (~:152-172).
**Problem:** `fetchPage` unconditionally `setPageResult(page)` after the await with no request token. Debounce reduces but doesn't eliminate overlap (immediate pagination racing a trailing debounced filter fetch; or a fast page-1 returning after a slow filtered request at 708K) — an older response can overwrite a newer one.
**Fix:** monotonic `requestSeq` captured before the await; only `setPageResult` if it's still the latest. (Documented-deferred; reasonable to defer but tracked here.)

### Finding 4 — ~113 lines of identical table markup duplicated  ·  Severity: Medium  ·  Code Duplication
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue` client table (~:196-308) vs server table (~:337-449).
**Problem:** The select-header, property-header, and item `<tr>` slots are byte-identical between `<v-data-table>` and `<v-data-table-server>`. Two table elements are unavoidable (Vuetify can't switch component type reactively), but the row content could be a small `AnnotationListRow.vue` child (props `item`, `selectedColumns`, `displayedPropertyPaths`; emits hover/click/select/tag). Prevents silent divergence on future edits. Defer OK.

### Finding 5 — `listCount` runs before sort-field validation  ·  Severity: Low  ·  Performance/Redundant
**Where:** `server/api/annotation.py:~734`; model `_sortStage` (~:347).
**Problem:** An invalid sort key pays a full count aggregation (seconds at 708K) before the `ValueError`→400.
**Fix:** validate the field-sort key (fixed `_SORTABLE_FIELDS` allowlist) at the API layer before counting, or move count after the page query.

### Finding 6 — Streaming `generateResult` duplicated 4× in `annotation.py`  ·  Severity: Low  ·  Code Duplication
**Where:** `server/api/annotation.py:~693, ~742` (+ pre-existing `~587`, `~653`).
**Fix:** extract `_streamJsonArray(items, prefix, suffix, default=None)`.

### Finding 7 — `idSubstring` user regex not type-checked/escaped  ·  Severity: Low  ·  Security/Access Control
**Where:** `server/models/annotation.py:~241` (the `$regexMatch`); validator `~:42`.
**Problem:** Passed verbatim as the `$regexMatch` regex over every matched `_id` on a public endpoint; not `isinstance(str)`-checked (non-string → 500) nor escaped. ReDoS impact is bounded by the 24-hex `_id` length, so Low — but add a string-type check (fold into #2) and consider escaping (it's a substring match, not a regex feature for users).

### Finding 8 — `index` column sorts by `_id`  ·  Severity: Low  ·  Naming/correctness nuance
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue` `mapSort` (~:611-613) + index cell (~:387).
**Problem:** "Sort by index" maps to `_id` order, which only matches the displayed index in default order.
**Fix:** add `"index"` to `serverUnsortableColumns` (position isn't meaningfully sortable server-side).

### Finding 9 — `LIST_ITEM_LIMIT=20000` client guard unreachable + stale comment  ·  Severity: Nit  ·  Unnecessary Variables
**Where:** `src/components/AnnotationBrowser/AnnotationList.vue:~687`, branch `~:311-321`, comment `~:683-686`.
**Problem:** Server mode activates at `maxVisible=10000`, so the client `tooManyToList` branch can never fire.
**Fix:** update the comment to "defensive net, superseded by `stubOnlyMode`" or remove the dead branch.

### Finding 10 — `propertyFilters` `values`/`min`/`max` not type-validated  ·  Severity: Nit  ·  Redundant Validation (missing)
**Where:** `server/api/annotation.py:~42`.
**Problem:** No injection risk (comparison operands, not operators); worst case an odd result. Noted for completeness; optional defense-in-depth.

### Finding 11 — `idSubstring` has two implementations  ·  Severity: Nit  ·  Pattern Consistency
**Where:** `AnnotationList.vue` client `includes` (~:672-681) vs server `setIdSubstring` (~:923-930).
Mutually exclusive at runtime (correct). Flagging only so substring semantics stay aligned across the boundary. Not a bug.

---

## Documented-deferred (not findings — your explicit calls)
- **Performance at 708K** (`/list` 3.6–25 s): centroid `$addFields` + property `$lookup` + `$sort` run over the full matched set before `$skip`/`$limit`; no per-property index (indexing is non-trivial — nested values, per-dataset prop ids). Spec §8 has the two-tier plan (reorder centroid/lookup after skip/limit for the common case; index/bidirectional later).
- **Server-side ROI filtering** (shows a notice), **infinite scroll** (page-numbers for now), other `propertyValues` consumers.

## Verification reference
- Backend: `cd devops/girder/plugins/AnnotationPlugin && tox` (or `tox -- upenncontrast_annotation/test/test_server_list.py -v`). flake8 runs in tox (79-char).
- Frontend: `pnpm exec vitest run <file>`, `pnpm tsc`, `pnpm exec eslint <files>`.
- **Backend changes need a girder image rebuild to hit the live API** — the plugin is baked into the image, so a plain `restart` won't load new code: `docker compose build girder && docker compose up -d girder` (~7s to come back).
- Real-data spot-check datasets (local): HCR `6a052e3704de280ec0a0309b` (26K, property id `6a33d0aa07139003543c4f2e`), Xenium `6a18de9586eb377626a51daf` (708K, property id `6a33f1d4cf32b89865b6affa`). Token: `curl -s -u admin:password http://localhost:8080/api/v1/user/authentication`. Mongo container: `nimbusimage-mongodb-1`.
