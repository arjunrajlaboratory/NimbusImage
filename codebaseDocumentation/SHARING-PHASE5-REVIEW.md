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
| 6 | Low | link users | They exist in the user collection (`share-<hex>`, `public: False`) and could appear in admin user lists; they hold no storage and cannot log in. | by-design for now — a marker field (`shareLink`) allows filtering later. |
| 9 | High | `server/models/shareLink.py` | Live: the first link opened to "no longer valid" — the client bootstraps with `GET user/me`, which needs `USER_INFO_READ`, and the token only had `DATA_READ`. | fixed — tokens carry `DATA_READ` + `USER_INFO_READ` (still no write scope); pinned by the `user/me` assertion in *"testBearerReadsOnlyTheSharedDataset"*. |
| 10 | High | `src/store/index.ts` `createGirderRestClient` handlers | Live: opening a dead link in one tab signed the owner out of every tab — the client's `userFetched` (anonymous `user/me`) and 401 handlers wipe the stored login, and the shared route had just put a foreign token on the same client. | fixed — `openShareLink` enters a shared session during which `clearStoredToken` is a no-op; the design note "in memory only" is now enforced, not assumed. |
| 11 | Low | shared viewer | The link user has no storage quota, so "Failed to fetch user storage quota" is logged once, and the jobs WebSocket retries; both are cosmetic for a read-only bearer. | deferred — silence them behind `isSharedSession` when the embed chrome is refined. |
| 12 | Medium | `api/shareLink.py` `create` | Branch review: the creator needed only READ on the dataset view and configuration (ADMIN on the folder), so a folder admin could hand out READ on a configuration they may not share; the named-share endpoint demands WRITE on both. | fixed — WRITE on the view and configuration; pinned in *"testCreateNeedsAdminAndValidInput"*. |
| 13 | High | `api/shareLink.py` `me`, `src/store/index.ts` | Independent review: `<img>`-loaded tile routes (image tiles, annotation raster, density) authenticate from the HttpOnly `girderToken` cookie alone, and the client only set the header — a recipient with no session of their own would see annotations over a blank canvas. The live check passed only because it ran in the owner's browser (own cookie). | fixed — `share_link/me` sets the cookie to the link token when the browser has none (never over an existing login), for the token's lifetime; pinned in *"testBearerReadsOnlyTheSharedDataset"*. |
| 14 | Medium | `SHARING.md`, `ShareDataset.vue` | Independent review: a link is also a download capability (`folder/{id}/download`, `/export`) — nothing in Girder's scope model separates viewing from downloading. | documented in SHARING.md and the dialog caption (by-design: no such scope exists). |
| 15 | Low | `models/shareLink.py` | Independent review: `createUser` honours the registration policy — with "approve", every link e-mails the admins and creates a pending user. | fixed — the link user is saved `status: enabled`; folders noted in SHARING.md. |
| 16 | Low | `src/store/index.ts` `openShareLink` | Independent review: the shared-session flag was raised before the token was validated (a dead link left the tab in shared mode) and exposed through a Vuex getter over a non-reactive variable. | fixed — the flag is reset and the token cleared when the attempt fails; the unused getter is removed. |
| 17 | Low | `ShareDataset.vue` | Independent review: the link silently opened the first checked collection and the table did not say which. | fixed — Create needs exactly one selected collection; a Collection column names it. |
| 18 | By-design | `api/shareLink.py` `find` | Independent review: listing a dataset's links needs only READ. | kept — readers already see the access list; tokens are never listed. Stated in SHARING.md. |
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
  signed the owner out of the neighbouring tab.
- After the branch review (finding 13): `share_link/me` without a cookie answers
  `Set-Cookie: girderToken=<link token>; HttpOnly; Path=/` expiring with the token; a density
  tile and an image tile fetched with only that cookie are 200; `me` with an existing
  cookie sets none.
