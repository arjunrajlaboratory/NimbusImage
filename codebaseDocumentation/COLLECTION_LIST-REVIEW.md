# Review Findings: collection list and project-add dialog

Branch: `claude/collection-view-toggle-columns-885ekb` — final Codex review
after multiple implementation/review rounds. Feature: browse collections across
folders, choose visible columns, page through the server listing, and add
filtered collections to a project.

## Finding 1: multi-collection add can silently report partial success

- **Severity:** High — Data integrity
- **Location:** `src/components/AddCollectionToProjectFilterDialog.vue`,
  `src/store/projects.ts`, and `server/api/project.py`
- **Problem:** The dialog calls the single-collection endpoint in a loop, while
  the store action catches each failure and returns `null`. A mid-loop failure
  therefore leaves earlier collections added and still emits every selected ID
  as successful.
- **Fix:** Added `POST /project/:id/collections`, which validates every ID and
  WRITE permission before one project save and bulk permission propagation.
  The real Vuex action propagates errors with `rawError: true`, verifies the
  returned project, and the dialog emits only confirmed IDs while retaining
  selection on failure.
- **Status:** fixed; verified

## Finding 2: the add dialog mounts every loaded collection row

- **Severity:** Medium — Performance
- **Location:** `src/components/AddCollectionToProjectFilterDialog.vue`
- **Problem:** The dialog may load up to the server cap (10,000 collections)
  and renders the entire filtered array with `v-for`, causing excessive DOM
  construction and checkbox work.
- **Fix:** Added a 25-row client pager over the loaded/filtered set. Selection
  remains in the independent ID set, and filtering resets the pager to page 1.
- **Status:** fixed; verified

## Finding 3: `batchResources` converts authentication failures into data

- **Severity:** Medium — Error handling
- **Location:** `src/store/GirderAPI.ts` (`batchResources`)
- **Problem:** HTTP 401 is caught and converted to an empty response. New
  collection-chip and folder-name callers interpret that as successfully
  resolved missing data, cache fallback labels, and suppress retry/error paths.
- **Fix:** Removed the 401-to-empty-response catch. Callers now keep failed IDs
  retryable instead of caching fallback labels.
- **Status:** fixed; verified

## Finding 4: projected batch responses claim to be complete documents

- **Severity:** Medium — Type safety
- **Location:** `src/store/GirderAPI.ts` and `src/girder/index.ts`
- **Problem:** `batchResources({ fields: [...] })` promises full Girder
  folder/user/item types even though the backend intentionally returns only
  `_id` plus the requested fields.
- **Fix:** Added overloads for projected partial documents and unprojected
  filtered documents, without claiming the backend supplies the frontend-only
  `_modelType` discriminator.
- **Status:** fixed; verified

## Finding 5: backend index guidance omits deterministic paging keys

- **Severity:** Low — Durable guidance
- **Location:** `nimbus-backend/references/database-query-patterns.md`
- **Problem:** The index example still recommends plain `updated` and
  `(folderId, updated)` indexes, contradicting the branch lesson that offset
  paging needs `_id` as the final sort/index key.
- **Fix:** Updated the canonical guidance to use total-order compound indexes
  ending in `_id`, then synchronized the Codex mirror.
- **Status:** fixed; verified

## Finding 6: frontend skill still recommends sequential batch chunking

- **Severity:** Low — Durable guidance
- **Location:** `nimbus-frontend/SKILL.md`
- **Problem:** A late section recommends sequentially chunking
  `batchResources`, contradicting the earlier projection-based single-request
  rule and the repository ban on looped frontend API calls.
- **Fix:** Replaced sequential chunking guidance with one projected batch
  request and documented error/type behavior, then synchronized the mirror.
- **Status:** fixed; verified

## Finding 7: the collection-list cap test cannot detect a missing clamp

- **Severity:** Low — Test quality
- **Location:** `test/test_collection_list.py`
- **Problem:** The test creates one collection while asserting a production cap
  of 10,000, so capped and uncapped implementations produce the same result.
- **Fix:** The test now monkeypatches the cap to 2, creates 3 collections, and
  asserts both a 2-row response and `hasMore: true` for unlimited/oversize
  requests.
- **Status:** fixed; verified

## Verification

- Full frontend suite: 191 files, 3,165 tests passed.
- Backend project/collection regression set: 58 tests passed.
- Targeted batch-add endpoint tests: 9 tests passed.
- Full backend suite: 368 passed; its sole error was a transient MongoDB index
  build failure during fixture setup, and the exact errored test passed alone.
- `pnpm tsc`, `pnpm lint:ci`, backend flake8, `git diff --check`, and skill
  synchronization check passed.
- Rebuilt and restarted the Girder container successfully.
- Local REST/Mongo runtime check: a batch containing one inaccessible ID
  returned 403 with zero project references and no permission change; a valid
  two-collection batch returned 200, stored both references, and propagated
  public access to both collections. All isolated test resources were removed.
- Fresh live-browser pass confirmed 25-row dialog paging, selection retention
  across pages/search, page reset on filtering, and no console errors.
