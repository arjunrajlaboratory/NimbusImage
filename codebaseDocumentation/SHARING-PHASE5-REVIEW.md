# Sharing, Phase 5 (share links) — review tracker

Branch `xenium-phase0`, self-review of the share-link diff (the independent reviewer agent
is unavailable: API spend limit). Status: `fixed` / `by-design` / `deferred — reason`.

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| 1 | High (design) | `server/models/shareLink.py` | A `DATA_READ` token minted for the *owner* would let the bearer read every dataset the owner can — a token scope is global. | by-design avoided — the bearer is a hidden per-link user with READ on exactly this dataset view; pinned by *"testBearerReadsOnlyTheSharedDataset"* (other dataset 403, write 401, cannot mint links). |
| 2 | Medium | `server/models/shareLink.py` `validate` | Girder token ids are the 64-char token strings, not ObjectIds; the first validator rejected every link. | fixed — `tokenId` validated as a string. |
| 3 | Medium | `server/models/shareLink.py` `isExpired` | Girder's token `expires` is tz-aware while Mongo returns naive datetimes → `TypeError` on the first create. | fixed — all comparisons in aware UTC (`_aware`). |
| 4 | Low | `test/test_share_link.py` | The sharing test helper creates datasets under the creator's *Public* folder, so a 403 assertion for another user passed as 200. | fixed — the tests make the folder private first. |
| 5 | Low | `api/shareLink.py` `revoke`, tests | `Model.load(..., force=True)` is an access-controlled-model signature; `share_link` is a plain model. | fixed. |
| 6 | Low | link users | They exist in the user collection and appeared in user listings. | fixed — `shareLinkGuards` drops them from `GET user` results. |
| 9 | High | `server/models/shareLink.py` | Live: the first link opened to "no longer valid" — the client bootstraps with `GET user/me`, which needs `USER_INFO_READ`, and the token only had `DATA_READ`. | fixed — tokens carry `DATA_READ` + `USER_INFO_READ` (still no write scope); pinned by the `user/me` assertion in *"testBearerReadsOnlyTheSharedDataset"*. |
| 10 | High | `src/store/index.ts` `createGirderRestClient` handlers | Live: opening a dead link in one tab signed the owner out of every tab — the client's `userFetched` (anonymous `user/me`) and 401 handlers wipe the stored login, and the shared route had just put a foreign token on the same client. | fixed — `openShareLink` enters a shared session during which `clearStoredToken` is a no-op; the design note "in memory only" is now enforced, not assumed. |
| 11 | Low | shared viewer | The link user has no storage quota (logged error) and its token cannot open the jobs WebSocket (retries). | fixed — `loggedIn` skips both for a user carrying the `shareLink` marker. |
| 12 | Medium | `api/shareLink.py` `create` | Branch review: the creator needed only READ on the dataset view and configuration (ADMIN on the folder), so a folder admin could hand out READ on a configuration they may not share; the named-share endpoint demands WRITE on both. | fixed — WRITE on the view and configuration; pinned in *"testCreateNeedsAdminAndValidInput"*. |
| 13 | High | `api/shareLink.py` `me`, tile URL builders | Independent review: `<img>`-loaded tile routes need an explicit shared-view credential. The first fix set a link cookie only when no ambient login existed, which still made signed-in recipients render with the wrong identity. | superseded — `/me` sets no cookie; image, annotation-raster, and density URLs carry the in-memory link bearer, pinned by their API/component tests and *"testBearerReadsOnlyTheSharedDataset"*. |
| 14 | Medium | `SHARING.md`, `ShareDataset.vue`, `helpers/shareLinkGuards.py` | Independent review: a link was also a download capability (`folder/{id}/download`, `/export`). | fixed — route `before` hooks refuse link users on every download/export route (403); pinned in *"testBearerReadsOnlyTheSharedDataset"*. |
| 15 | Low | `models/shareLink.py` | Independent review: `createUser` honors the registration policy — with "approve", every link e-mails the admins and creates a pending user. | fixed — the link user is saved `status: enabled`; folders noted in SHARING.md. |
| 16 | Low | `src/store/index.ts` `openShareLink` | Independent review: the shared-session flag was raised before the token was validated (a dead link left the tab in shared mode) and exposed through a Vuex getter over a non-reactive variable. | fixed — the flag is reset and the token cleared when the attempt fails; the unused getter is removed. |
| 17 | Low | `ShareDataset.vue` | Independent review: the link silently opened the first checked collection and the table did not say which. | fixed — Create needs exactly one selected collection; a Collection column names it. |
| 18 | Low | `api/shareLink.py` `find` | Independent review: listing a dataset's links needed only READ. | fixed — WRITE on the dataset. |
| 19 | Medium | `helpers/shareLinkGuards.py` | Round 2 (own pass): Girder strips fields it does not know from `user/me`, so the `shareLink` marker the client keys its bearer-session behavior on never reached it — the quota/websocket skip was dead code. | fixed — `User().exposeFields(READ, {"shareLink"})` at plugin load; asserted in *"testBearerReadsOnlyTheSharedDataset"*. |
| 20 | Low | `src/store/index.ts` `openShareLink` | Round 2: on a dead link the client token was cleared instead of restored, so a signed-in owner's in-memory session was gone and a later 401 could wipe the stored login once shared mode ended. | fixed — the previous token is restored and the user re-fetched while still in shared mode. |
| 7 | Deferred | plan §14.3 | Fork by reference. | deferred — policy questions on quota and cross-folder tile sources (plan §14.3). |
| 8 | Deferred | plan §14.2 | Import-from-DOI. | deferred — the record already carries `spatial.zarr.zip` and `transcripts.zarr.zip`; the round trip is a download manager plus the existing register calls. |

## Live verification (2026-09-03)

- `POST share_link` for the morphology view (7 days): the bearer reads `user/me`,
  `share_link/me`, the folder, dataset view, configuration, annotation stubs, connections,
  user colors, tiles, histograms and the spatial/transcript routes (all 200); the H&E dataset
  is 403; `PUT folder` and `POST upenn_annotation` are 401 (no write scope).
- `#/shared/<token>` in a fresh tab opens the morphology view as `share-<hex>` with image,
  annotations, saved filter and the Transcripts button; `#/embed/<token>` the same without
  the toolbar. Revoking the link (`DELETE share_link/{id}`) kills the token immediately.
- Finding 10 was found this way: the very first attempt (token without `USER_INFO_READ`)
  signed the owner out of the neighboring tab.
- Historical first fix for finding 13 used a link cookie. The later review replaced it:
  `/me` now sets no cookie and shared-view tile URLs carry the link bearer explicitly,
  preventing an unrelated signed-in cookie from choosing the rendering identity.
- After the "fix everything" round: as the bearer, `folder/{id}/download` and `export/json`
  are 403 while `item/{id}/tiles` stays 200; `GET user?text=share-` as the owner lists no
  link users; listing links with the bearer's token is 401 (WRITE required).
