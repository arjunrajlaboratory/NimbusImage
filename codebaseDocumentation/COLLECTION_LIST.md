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
| Sort | Restricted to `COLLECTION_SORTABLE_FIELDS`; default `updated` descending |
| Indexes | `updated` and `(folderId, updated)`, so the default sort doesn't blocking-sort full documents |

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
resolve in batches of 500.

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

**2. A non-scoped global `td span` rule centers every table cell.**
`AnnotationBrowser/AnnotationList.vue` ships an un-scoped
`td span { display: block; text-align: center; margin: auto; }`, which leaks into every
table in the app. In this table it centered Name, Description, Folder, Modified and
Created under their left-aligned headers. The contained fix is the `cell-text` class
plus a scoped override; **the global rule is still there and will ambush the next new
table.** Scoping or deleting it is a worthwhile follow-up with app-wide visual blast
radius, so it was deliberately left out of this feature.

---

## Design note: search across pages

Server-side search would be ~5 lines (a regex on `lowerName`), but a substring match
can't use an index, so every keystroke becomes a full scan — and it would make the
common case (a few hundred collections) *slower* than an instant client-side filter.
So: one fetch of up to 10,000, everything client-side, and above that a warning plus a
"Load 10,000 more" that appends. That gives paging without stacking a second level of
pagination on top of the table's own.

### Untested: the >10,000 path

**The `hasMore` / "Load 10,000 more" flow has never been exercised against real data.**
No available dataset comes close to 10,000 collections (the dev database has 44), so
the frontend append-and-continue path — the alert appearing, the button fetching at
`offset = collections.length`, results appending without duplicates, `hasMore` clearing
on the last page — has only ever been covered by unit tests with mocked responses
(*"loadMore appends the next page at the current offset"*).

The **backend** half of it is verified against a live server, by shrinking the page
size rather than growing the data: `limit=43` → `hasMore: true`, `limit=44` → `false`,
`limit=10&offset=40` → 4 rows. Anyone touching the paging path should do the same —
drive `COLLECTION_PAGE_SIZE` down to a handful in a scratch build and page through 44
real collections — rather than trusting the mocked tests alone.

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
- [ ] **Every text cell carries an alignment class.** A new column added without `cell-text` renders centered again, because of the global `td span` rule. — *"gives every text cell a class that defeats the global td-span centering"*
- [ ] **The Folder column exists only in the all-folders scope.** — *"tableHeaders includes the Folder column only in the 'all' scope"*

### Cost

- [ ] **Chips resolve per visible page, not per collection.** Two batch requests per page regardless of row count; a page already visited is not refetched. — *"resolves every collection with two batch requests"*, *"onCurrentItemsChange resolves chips for the visible rows only once"*
- [ ] **Folder-name resolution is chunked and only for unseen ids.** — *"resolveFolderNames chunks large id sets across requests"*, *"resolveFolderNames batch-resolves unseen folders only"*
- [ ] **The folder scope skips folder-name resolution entirely.** — *"resolveFolderNames does nothing in the folder scope"*

### Error handling

- [ ] **A failed chip lookup propagates and is retryable.** `collectionsToDatasetChips` must NOT swallow: resolving with the seeded empty chips renders as "No datasets", indistinguishable from a collection that genuinely has none. The caller logs and *releases* the ids, otherwise one failed burst pins those rows on "Loading..." for the component's lifetime. — *"propagates a failed view lookup instead of reporting empty chips"*, *"retries chip resolution for a page whose previous attempt failed"*
- [ ] **Loading, empty and resolved are three distinct states.** `undefined` chips = not resolved yet; `[]` = resolved with none. — *"shows the loading state while chips have not been resolved"*, *"shows 'No datasets' once resolved to an empty chip list"*
- [ ] **A null `description` never reaches a string method.** The listing projects with `document.get(field)`, so it can be JSON null. — *"filteredCollections tolerates a null description"*
- [ ] **A stale response cannot overwrite a newer listing.** `fetchGeneration` guards every await. — *"fetchCollections handles error and sets empty collections"*

### Selection and scope

- [ ] **Changing scope clears the dialog's selection.** Scope redefines which collections are listed, so a selection made under the old scope no longer matches what the user sees. — *"clears selectedIds when the scope changes"*
- [ ] **Scope is persisted and restored.** — *"persists the scope choice and refetches when it changes"*, *"restores the persisted scope on mount"*

### Backend paging and access

- [ ] **`limit=-1` cannot bypass the cap.** `min(limit or MAX, MAX)` preserves `-1`, and `limit + 1` then becomes `0` — Girder's *unlimited* sentinel. `0` and `MAX+1` both behave correctly, so a spot-check passes while the bypass ships. — *`testNegativeOneLimitCannotBypassTheCap`*, *`testDegeneratePagingParamsNeverReachMongo`*
- [ ] **Both listing endpoints share the clamp and the sort allowlist.** `by_folders` returns whole documents including `meta`, so it needs them more than `/list` does. — *`testFindByFoldersClampsLimit`*, *`testFindByFoldersRestrictsSortToReturnedFields`*, *`testListClampsLimitToMaximum`*, *`testSortIsRestrictedToReturnedFields`*
- [ ] **The clamp test can actually fail.** With 3 collections and a 10,000 ceiling, "unlimited" and "capped" are indistinguishable — shrink `MAX_COLLECTION_LIST_LIMIT` via `monkeypatch` instead. — *`testFindByFoldersClampsLimit`*
- [ ] **Malformed input is 400, never 500.** Bad folderId, non-list `folderIds`, numeric entries, a JSON-array body. — *`testMalformedFolderIdIsA400`*, *`testFindByFoldersRejectsMalformedBodies`*
- [ ] **The listing never ships `meta`.** — *`testListOmitsMetadata`*
- [ ] **Access filtering survives the field projection.** — *`testListExcludesCollectionsTheUserCannotRead`*
- [ ] **`GET /upenn_collection` still demands a folderId.** — *`testFindStillRequiresFolderId`*

### Test-harness rules this feature proved

- [ ] **Never assert an order that depends on wall-clock timing.** MongoDB stores datetimes at *millisecond* resolution, so creating one collection and touching another routinely lands both in the same millisecond; the sort then ties and returns an arbitrary order. Write the timestamps explicitly. — *`testListSortsByUpdatedDescendingByDefault`*
- [ ] **Scope a listing assertion to its own folder.** An exact-list assertion against an unfiltered cross-folder listing is at the mercy of every other test file. — *`testListSortsByUpdatedDescendingByDefault`*
- [ ] **Run the backend file after `test_annotations.py`, not just alone.** That ordering is what exposed the tie. `tox -- upenncontrast_annotation/test/test_annotations.py upenncontrast_annotation/test/test_collection_list.py`
- [ ] **Source-scan guards are legitimate where the cascade is untestable.** jsdom does not apply SFC styles, so no runtime assertion can observe a CSS override; assert against the template source instead (the precedent is `src/vuetifyDeprecations.test.ts`).
- [ ] **`import.meta.url` is not a `file://` URL in the jsdom environment.** Resolve from `process.cwd()` in tests that read source files.
