# Collection List Feature Documentation

> **Status:** Implemented.
> **Issue:** [#1113 — Browsing collections only shows the current folder](https://github.com/arjunrajlaboratory/NimbusImage/issues/1113)
> **PR:** [#1278](https://github.com/arjunrajlaboratory/NimbusImage/pull/1278)

## Overview

Browsing collections used to show only the folder the file browser happened to be
parked in, and the backend had no way to list across folders: `GET /upenn_collection`
called `ObjectId(folderId)` with `folderId` omitted, which mints a *fresh* id and
therefore matched nothing. The browser's "retry without folderId" fallback could only
ever return an empty list.

This feature adds a cross-folder listing endpoint, a **"This folder" / "All
collections"** scope toggle, and turns the flat `v-list` into a sortable
`v-data-table`.

---

## Backend

### `GET /upenn_collection/list`

`folderId` is optional; omit it to list every collection the user can read. Entries
carry only `_id / name / description / folderId / creatorId / created / updated` —
never the `meta` document (layers, tools, snapshots), which is what made the existing
endpoint too heavy to use across folders.

| Concern | Behavior |
|---|---|
| Response | `{collections: [...], hasMore: bool}` |
| `hasMore` | Read one document past the limit rather than a second count query |
| Limit | Clamped to `[1, MAX_COLLECTION_LIST_LIMIT]` (10,000) |
| Sort | Restricted to `COLLECTION_SORTABLE_FIELDS`; default `updated` descending; `_id` appended as tie-breaker |
| Indexes | `(updated, _id)` and `(folderId, updated, _id)` for `/list`, plus `(folderId, lowerName, _id)` for `by_folders`' own default sort — every default sort must be index-covered |

**Offset paging requires a total order.** `withIdTieBreaker` appends `_id` to whatever sort the caller asked for. Without it, documents tied on `updated` — which is routine, since Mongo stores datetimes at millisecond resolution and a bulk import stamps many collections in the same millisecond — have no defined order, so a page-2 request can repeat a row from page 1 or skip one entirely with the data unchanged. The indexes carry `_id` for the same reason; an index whose prefix is `updated` still serves a plain `updated` sort, so no separate single-field index is needed.

**Appending a tie-breaker changes the sort key, so every endpoint's default sort needs a matching index.** `by_folders` defaults to `lowerName`, and adding `_id` to it turned `LIMIT <- FETCH <- IXSCAN` into `SORT <- FETCH <- IXSCAN` — a blocking sort over every matching document, correct output silently paid for. `(folderId, lowerName, _id)` restores the index scan. Caught in review, not by any test, which is why the plan is now pinned by `testDefaultSortsAreIndexCoveredNotBlocking`.

Verified on a live server: the default sort plans as `LIMIT <- FETCH <- IXSCAN` with **no blocking `SORT` stage**, examining 10 keys for a limit of 10, and paging 44 rows one at a time returns 44 distinct ids in the same order as a single request. Note that `ensureIndices` only ever *creates* — an already-deployed database keeps the superseded `updated_1` and `folderId_1_updated_-1` indexes until they are dropped by hand. They are harmless (a little write overhead), so seeing them alongside the new compounds is expected, not a failed migration.

**`findWithPermissions` + projection is safe.** It builds
`{'$and': [query, permissionClauses(user, level)]}` and hands that to `find()`, so
permission filtering happens *inside* the Mongo query. Projecting away `access` and
`public` does not weaken it — verified live: an anonymous caller sees exactly the
public collections and nothing else.

### Shared paging guards

`clampCollectionPaging` and `requireSortableFields` (`server/api/collection.py`) are
used by **both** `/list` and `/by_folders`. They exist as module-level functions, not
inline blocks, because the two endpoints drifted apart once already: `/list` got the
clamp and the sort allowlist while `by_folders` — which returns *whole* documents,
`meta` included, and is therefore the heavier of the two — kept an unbounded limit and
a free-form sort.

Both read `MAX_COLLECTION_LIST_LIMIT` at call time so tests can shrink the ceiling.

### `GET /upenn_collection` (unchanged route, new behavior)

Now returns **400** on a missing `folderId`, with a message pointing at
`/upenn_collection/list`, instead of silently returning nothing. Every remaining caller
in `src/` and `nimbusimage/` already passes one.

---

## Frontend

| Concern | Where |
|---|---|
| Listing API | `GirderAPI.listCollections` (`src/store/GirderAPI.ts`) |
| Table + scope toggle | `src/components/CollectionList.vue` |
| Chips cell | `src/components/CollectionDatasetChips.vue` |
| Chip resolution | `src/utils/collectionChips.ts` — two batch requests per page regardless of row count |
| Scope in the add-to-project dialog | `src/components/AddCollectionToProjectFilterDialog.vue` |
| Summary type | `ICollectionSummary` (`src/girder/index.ts`) — a collection *without* `meta` |

Search filters name, description and folder name across what's loaded. Dataset chips
resolve for the **visible page** rather than every collection up front; folder names
resolve in a **single** `resource/batch` request that projects only `name`.

That projection is why there is no chunking. `POST /resource/batch` takes an optional
`fields` list and trims every returned document to those keys plus `_id`; omit it and
callers get whole documents exactly as before. Resolving names without it meant either
shipping thousands of full folder documents in one response, or chunking into 500-id
requests — which traded the payload problem for up to 20 sequential round-trips, a
waterfall and a looped frontend API call this repo forbids.

### Two Vuetify traps this feature hit

**1. `update:currentItems` emits wrapped items; `click:row` emits raw ones.** Vuetify's
`v-data-table` hands `update:currentItems` its *internal* items, where the row lives
under `.raw` — `VDataTable.js` distinguishes `items: …map(i => i.raw)` from
`internalItems`, and `paginate.js` emits the wrapped array. `@click:row`, by contrast,
passes the raw row (`VDataTableRows.js`, `item: item.raw`). Reading `item._id` in the
`currentItems` handler yields `undefined` for every row, so **no chip ever resolved**
while row clicks worked fine. Both emits are typed `(value: any) => any`, so `tsc`
cannot catch it, and a unit test that calls the handler with raw rows passes while the
real table is broken.

**2. A non-scoped global `td span` rule used to center every table cell.**
`AnnotationBrowser/AnnotationList.vue` had an un-scoped
`td span { display: block; text-align: center; margin: auto; }` (and a matching
`tbody tr:hover`), which leaked into every table in the app. In this table it centered
Name, Description, Folder, Modified and Created under their left-aligned headers.
Vuetify 4 puts its utilities in a cascade layer and unlayered rules beat layered ones
outright, so no `text-left` / `ma-0` in the affected component could undo it.

**Both rules are now scoped to `.annotation-list-panel`, so the leak is gone.** This
table therefore carries *no* alignment workaround — the earlier `cell-text` class and
the chips component's compensating margins were removed once the root cause was fixed,
because an obsolete workaround enforced as an invariant constrains future columns for no
reason. `src/globalStyleLeaks.test.ts` guards the root cause instead: it fails if any
`.vue` file gains a top-level element selector in a non-scoped `<style>` block.

---

## Design note: search across pages

Server-side search would be ~5 lines (a regex on `lowerName`), but a substring match
can't use an index, so every keystroke becomes a full scan — and it would make the
common case (a few hundred collections) *slower* than an instant client-side filter.
So: one fetch of up to 10,000, everything client-side, and above that a warning plus a
"Load 10,000 more" that appends. That gives paging without stacking a second level of
pagination on top of the table's own.

### The add-to-project dialog pages too

It has its own `loadMore`, because it sends **no** `limit` and therefore gets the
server cap. The pre-`/list` implementation asked for `limit: 0` (Girder "unlimited")
and received every row, so switching to `/list` without a paging path silently made
collections past the cap unselectable — a regression, not just a missing feature.

Exercise it by shrinking `MAX_COLLECTION_LIST_LIMIT` on the **server** (the dialog
sends no limit, so the frontend constant has no effect here) and rebuilding girder.
With a cap of 5 the folder's 43 collections page `5 → 10 → … → 43`, 43 distinct, 0
duplicates, alert gone.

Two behaviours worth knowing when driving it:
- **Rapid repeat clicks load one page, not several.** The `loadingMore` guard
  suppresses clicks while a page is in flight — three clicks inside one batch
  produced exactly one page. That is correct, not a dropped click.
- **The button moves as rows append** (~43px per page here). Re-measure its position
  between clicks; four clicks at a stale position landed on a `DIV` and looked like a
  dead button.

### Verifying the >10,000 path without 10,000 collections

No available dataset comes close to 10,000 collections (the dev database has 44), so
**shrink the page size instead of growing the data.** Temporarily set
`COLLECTION_PAGE_SIZE = 5` in `CollectionList.vue`, reload, and page through — 44
collections become 9 pages, which exercises exactly the same code as the real ceiling.
Revert it afterwards.

Done that way, the whole flow checks out against the live server:

```
alert: "Showing the 5 most recently modified collections…"  +  "Load 5 more"
5 → 10 → 15 → 20 → 25 → 30 → 35 → 40 → 44
total=44  distinct=44  duplicates=0  hasMore=false  alert gone
order still strictly descending by `updated`
```

The zero duplicates across nine offset-paged requests is what confirms the `_id`
tie-breaker under real data, not just in the unit test. The backend half checks out the
same way: `limit=43` → `hasMore: true`, `limit=44` → `false`, `limit=10&offset=40` → 4
rows.

All nine pages were driven by **real mouse clicks** on the button, not by calling the
handler: 16 clicks landed on `SPAN.v-btn__content`, and the run ended at 44 loaded /
44 distinct / `hasMore: false` / alert gone. Every other interaction in this table was
real-clicked too — scope toggle, column-header sorting, the search field, row
navigation, and the data table's own footer pager.

Two traps cost real time getting there, both worth knowing before driving this UI:

- **A background-hidden window silently swallows clicks.** `document.visibilityState`
  reads `"hidden"` even while `document.hasFocus()` is `true`, and clicks produce *no*
  event at all — not even on a capture-phase `document` listener. That looks exactly
  like a dead button. Check `visibilityState` before concluding anything about a click.
- **Rescale to the CURRENT screenshot every time.** The click tool works in screenshot
  space. Reusing scale factors from an earlier screenshot after the window is resized
  maps the target somewhere else entirely — here the button's centre landed on the
  surrounding `v-alert` div, which registered a click on the wrong element and looked
  like the handler failing. Confirm with `elementFromPoint` *and* by logging the
  received `clientX/clientY`.

---

## Regression checklist

Every item below was a real defect found while reviewing this feature, and two of them
were **invisible to a green test suite**: the chips bug had a passing test that called
the handler with the wrong shape, and the flaky sort test passed alone and failed only
when another test file ran first. Each line names the invariant and the test that holds
it, so changing this code means re-checking the list rather than rediscovering it.

Run `pnpm test src/components/CollectionList.test.ts src/components/CollectionDatasetChips.test.ts src/components/AddCollectionToProjectFilterDialog.test.ts src/utils/collectionChips.test.ts`
and, from `devops/girder/plugins/AnnotationPlugin`, `tox -- upenncontrast_annotation/test/test_collection_list.py`.

### Table wiring

- [ ] **Per-page callbacks unwrap `.raw`.** `update:currentItems` emits Vuetify's internal wrapped items; `click:row` emits raw rows. Mixing them up silently yields `undefined` ids. — *"onCurrentItemsChange reads ids from the wrapped payload, never the wrapper"*, *"onRowClick navigates to the clicked collection"*
- [ ] **Tests drive handlers with the shape Vuetify really emits.** Use the `wrappedItem` helper for `currentItems`; passing raw rows makes the test pass while the table is broken. — *"onCurrentItemsChange resolves chips for the visible rows only once"*
- [ ] **No `.vue` file gains a top-level element selector in a non-scoped `<style>` block.** That is what centered every cell in this table; the fix was scoping the rule at its source rather than adding per-table workarounds, so there is no alignment class to keep in sync. — *`src/globalStyleLeaks.test.ts`*
- [ ] **The Folder column exists only in the all-folders scope.** — *"tableHeaders includes the Folder column only in the 'all' scope"*

### Cost

- [ ] **Chips resolve per visible page, not per collection.** Two batch requests per page regardless of row count; a page already visited is not refetched. — *"resolves every collection with two batch requests"*, *"onCurrentItemsChange resolves chips for the visible rows only once"*
- [ ] **Folder names resolve in ONE request, projecting only `name`, for unseen ids only.** Chunking the loop is not a fix for a looped API call — it just converts a payload problem into a waterfall. — *"resolveFolderNames resolves every folder in a single request"*, *"resolveFolderNames asks the backend for names only, not whole folders"*, *"resolveFolderNames batch-resolves unseen folders only"*
- [ ] **`resource/batch` without `fields` still returns whole documents.** Eight other callers depend on that. — *`testBatchReturnsWholeDocumentsByDefault`*
- [ ] **The folder scope skips folder-name resolution entirely.** — *"resolveFolderNames does nothing in the folder scope"*

### Error handling

- [ ] **A failed chip lookup propagates and is retryable.** `collectionsToDatasetChips` must NOT swallow: resolving with the seeded empty chips renders as "No datasets", indistinguishable from a collection that genuinely has none. The caller logs and *releases* the ids, otherwise one failed burst pins those rows on "Loading..." for the component's lifetime. — *"propagates a failed view lookup instead of reporting empty chips"*, *"retries chip resolution for a page whose previous attempt failed"*
- [ ] **Loading, empty and resolved are three distinct states.** `undefined` chips = not resolved yet; `[]` = resolved with none. — *"shows the loading state while chips have not been resolved"*, *"shows 'No datasets' once resolved to an empty chip list"*
- [ ] **A null `description` never reaches a string method.** The listing projects with `document.get(field)`, so it can be JSON null. — *"filteredCollections tolerates a null description"*
- [ ] **A stale response cannot overwrite a newer listing.** `fetchGeneration` guards every await. — *"fetchCollections handles error and sets empty collections"*
- [ ] **Paging cannot fire on a listing that is being replaced.** `fetchGeneration` alone does NOT cover this: a "Load more" click during a refetch captures the *already-bumped* generation, so its own stale-check passes and it appends outgoing-scope rows. `fetchCollections` clears `hasMore` on entry (the alert renders outside the `v-if="loading"` block, so it stays clickable otherwise), `loadMore` also guards on `loading`, and it pins `folderId` for the request instead of re-reading the mutable `loadedFolderId`. — *"does not append a previous-scope page when load-more races a refetch"*, *"loadMore is a no-op while a refetch is in flight"*, *"clears hasMore when a refetch starts so the alert cannot be clicked"*

### Selection and scope

- [ ] **Changing scope clears the dialog's selection.** Scope redefines which collections are listed, so a selection made under the old scope no longer matches what the user sees. — *"clears selectedIds when the scope changes"*
- [ ] **Scope is persisted and restored.** — *"persists the scope choice and refetches when it changes"*, *"restores the persisted scope on mount"*

### Backend paging and access

- [ ] **`limit=-1` cannot bypass the cap.** `min(limit or MAX, MAX)` preserves `-1`, and `limit + 1` then becomes `0` — Girder's *unlimited* sentinel. `0` and `MAX+1` both behave correctly, so a spot-check passes while the bypass ships. — *`testNegativeOneLimitCannotBypassTheCap`*, *`testDegeneratePagingParamsNeverReachMongo`*
- [ ] **Both listing endpoints share the clamp and the sort allowlist.** `by_folders` returns whole documents including `meta`, so it needs them more than `/list` does. — *`testFindByFoldersClampsLimit`*, *`testFindByFoldersRestrictsSortToReturnedFields`*, *`testListClampsLimitToMaximum`*, *`testSortIsRestrictedToReturnedFields`*
- [ ] **The clamp test can actually fail.** With 3 collections and a 10,000 ceiling, "unlimited" and "capped" are indistinguishable — shrink `MAX_COLLECTION_LIST_LIMIT` via `monkeypatch` instead. — *`testFindByFoldersClampsLimit`*
- [ ] **Malformed input is 400, never 500.** Bad folderId, non-list `folderIds`, numeric entries, a JSON-array body. — *`testMalformedFolderIdIsA400`*, *`testFindByFoldersRejectsMalformedBodies`*
- [ ] **The listing never ships `meta`.** — *`testListOmitsMetadata`*
- [ ] **Ties on the sort key do not make paging lossy.** `_id` is appended so the order is total, and the indexes carry it. — *`testListBreaksUpdatedTiesByIdSoPagingIsStable`*
- [ ] **`fields` on `resource/batch` is validated and cannot address a subpath.** It builds a projection from caller input; reject non-strings, empty keys, `.` and `$`. — *`testBatchRejectsMalformedFields`*
- [ ] **A projection does not weaken the access filter.** Permission criteria live inside the Mongo query, so excluding `access`/`public` from the *response* is safe — but they must still be *fetched*, because `model.filter()` reads them to compute the level. — *`testBatchProjectionStillEnforcesAccess`*
- [ ] **`resource/batch` filters every document through `model.filter(doc, user)`.** It hand-builds a map, so `@filtermodel` cannot apply and nothing else strips unexposed keys. Returning raw documents leaked folder `access` and, for the `user` type, `salt` — the bcrypt password hash — plus `email`. Filter **then** narrow to `fields`, never the reverse, or `fields: ["salt"]` becomes an exfiltration primitive. — *`testBatchNeverReturnsUnexposedFolderFields`*, *`testBatchNeverReturnsUnexposedUserFields`*
- [ ] **Nothing renders a user field that is only exposed at ADMIN.** `email` is ADMIN-level (your own account or a site admin), so another user's lookup legitimately has none; every display goes through `userDisplayName()`. — *`src/utils/userDisplay.test.ts`*, *"omits the email parenthetical when the owner's email is not visible"*
- [ ] **Access filtering survives the field projection.** — *`testListExcludesCollectionsTheUserCannotRead`*
- [ ] **`GET /upenn_collection` still demands a folderId.** — *`testFindStillRequiresFolderId`*

### Test-harness rules this feature proved

- [ ] **Never assert an order that depends on wall-clock timing.** MongoDB stores datetimes at *millisecond* resolution, so creating one collection and touching another routinely lands both in the same millisecond; the sort then ties and returns an arbitrary order. Write the timestamps explicitly. — *`testListSortsByUpdatedDescendingByDefault`*
- [ ] **Scope a listing assertion to its own folder.** An exact-list assertion against an unfiltered cross-folder listing is at the mercy of every other test file. — *`testListSortsByUpdatedDescendingByDefault`*
- [ ] **Run the backend file after `test_annotations.py`, not just alone.** That ordering is what exposed the tie. `tox -- upenncontrast_annotation/test/test_annotations.py upenncontrast_annotation/test/test_collection_list.py`
- [ ] **A race test must control resolution ORDER, or it proves nothing.** The first version of the load-more race test mocked both requests with one `mockResolvedValue` and passed *before* the fix: whichever response landed second won, and half the time that was the correct one. Use two hand-released deferred promises and release the refetch **first** — the bug only shows when paging resolves after the listing it no longer belongs to. — *"does not append a previous-scope page when load-more races a refetch"*
- [ ] **Source-scan guards are legitimate where the cascade is untestable.** jsdom does not apply SFC styles, so no runtime assertion can observe a CSS override; assert against the template source instead (the precedent is `src/vuetifyDeprecations.test.ts`).
- [ ] **`import.meta.url` is not a `file://` URL in the jsdom environment.** Resolve from `process.cwd()` in tests that read source files.
