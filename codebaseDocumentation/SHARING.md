# Dataset Sharing System

This document describes the technical implementation of dataset sharing in NimbusImage.

## Overview

The sharing system allows dataset owners to:
- Grant read or write access to specific users
- Make datasets publicly accessible (read-only)
- View and manage who has access to their datasets
- Revoke access from users

Users who have been shared with (READ or WRITE) can:
- View the sharing status (public/private, list of users with access)
- See this info in DatasetInfo/ConfigurationInfo pages and in the Share dialog (read-only mode)

## Permission Model

NimbusImage uses Girder's built-in access control system with three permission levels:

| Level | Value | Description |
|-------|-------|-------------|
| READ | 0 | View dataset, annotations, and configurations |
| WRITE | 1 | Edit annotations and configurations |
| ADMIN | 2 | Full control including sharing permissions |

**Key behaviors:**
- Users automatically receive ADMIN access when they create a dataset
- Users with WRITE or ADMIN access can add, change and remove users, but never above their own
  level: a WRITE collaborator can share Read or Write, and cannot grant Admin or change/remove
  anyone above Write (the owner). Toggling public, choosing collections and share links stay
  ADMIN-only
- Any user with READ access can view the access list (who has access and at what level)
- Owners (ADMIN) can't be changed or removed by anyone below ADMIN (`requireCanSetUserAccess`).
  The dialog also locks owner rows for everyone. Another ADMIN can change a co-owner through the
  API.
- A dataset or project always keeps **at least one user at ADMIN** (`last_admin_guard`). Who holds
  it doesn't matter: the creator can give another user ADMIN and then step down, and a co-owner
  can remove the creator. What is refused (400, nothing written) is removing or demoting the
  *last* ADMIN, whether they remove themselves or another ADMIN does. Site admins can override
  (recovery path). Both share endpoints check it before writing anything, `project/:id/share`
  on the project's own ACL as well as every dataset it reaches, and a folder-save listener backs
  up Girder's raw `PUT folder/{id}/access`. Only user entries count: a group ADMIN grant doesn't,
  because group membership is managed elsewhere and a group can be emptied. See the regression
  checklist below for the tests.
  - Handing a dataset over is API-only for now (`ds.sharing` or `dataset_view/share`): both
    Share dialogs lock every Admin row. Give the new owner ADMIN on the dataset *and* its views
    and configurations (a `dataset_view/share` at ADMIN does all three) before stepping down;
    only the folder is guarded, so a new owner who is ADMIN on the folder alone leaves the
    views and configurations with no ADMIN when the old owner leaves.
  - Known gaps:
    - Any user entry at ADMIN counts, whether or not the account still exists. Girder doesn't
      remove a deleted user's ACL entries, and the raw `PUT folder/{id}/access` accepts any
      id, including a typo or a share-link principal.
    - Two co-owners removing each other at the same moment through project shares (bulk
      writes, no save event) can both pass the check.
    - A recursive raw `PUT folder/{id}/access?recurse=true` saves the parent and earlier
      subfolders before a refused dataset subfolder, so it isn't all-or-nothing. The plugin's
      share endpoints are.

The folder-save listener (`server/helpers/last_admin_guard.py`) rejects a save of a `contrastDataset` folder that leaves no user at ADMIN, comparing against the stored folder: a dataset that already had none (damaged before the guard, or by a site admin) stays editable instead of being frozen. That exception covers only folders that were already datasets: marking a folder `contrastDataset` with no user at ADMIN is refused, or clearing the subtype, removing the last ADMIN and re-importing would get around the guard. This guard plugs a gap in core Girder's `setAccessList`, which otherwise accepts any ACL including one that locks the owner out — see `BUG_OWNER_CAN_REMOVE_SELF_FROM_DATASET.md`.

## Architecture

### Resources Affected by Sharing

When sharing a dataset, permissions are set on multiple Girder resources:

1. **Dataset Folder** - The main folder containing the dataset
2. **DatasetViews** - User-specific view configurations linking datasets to configurations
3. **Configurations (Collections)** - Tool definitions, layer settings, scales

All three resource types must have matching permissions for proper access.

### Property documents never carry the ACL

Annotation properties (`annotation_property`) carry a Girder `access` ACL of their own, but it does not decide who reads them: `GET /annotation_property` and `GET /annotation_property/:id` admit anyone with READ on a configuration whose `meta.propertyIds` lists the property, including anonymous viewers of a public dataset. So no response may include that ACL, which names every user the property was shared with.

- `AnnotationProperty.CLIENT_FIELDS` (`name`, `image`, `tags`, `shape`, `workerInterface`) plus `_id` are the only fields exposed. The get, list and create endpoints use `@filtermodel`; the JSON export and the Zenodo archive project to the same fields via `findClientFields`.
- Create and update store only `CLIENT_FIELDS`. A body's `access`, `public` or exported `_id` is dropped.
- Responses carry no `_accessLevel`. A level computed from the property's own ACL would be wrong (`-1` for a collaborator who reads it through a configuration), so `UngatedAclFilterMixin` filters by exposed fields alone.
- `worker_interface` and `worker_preview` responses are filtered the same way (`_id`, `image`, and `interface` or `preview`). There is one document per worker image, readable by any user, with an ACL naming whoever first created it. Their write paths need no allow-list because the model builds the document itself.

Tests: `test/test_property_fields.py`.

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Dataset Folder │────▶│   DatasetView   │────▶│  Configuration  │
│    (Girder)     │     │   (Plugin DB)   │     │   (Plugin DB)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                    All receive same permissions
```

## Backend API

### Endpoints

#### `GET /dataset_view/access/:datasetId`

Returns the current access list for a dataset.

**Required permission:** READ access to the dataset

**Response:**
```json
{
  "datasetId": "string",
  "public": true,
  "users": [
    {
      "id": "string",
      "login": "string",
      "name": "string",
      "email": "string",
      "level": 0
    }
  ],
  "groups": [],
  "currentUserLevel": 1,
  "configurations": [
    {
      "id": "string",
      "name": "string",
      "public": true,
      "currentUserLevel": 0
    }
  ],
  "writableViewIds": ["string"]
}
```

`currentUserLevel` is the caller's **effective** level (`getAccessLevel`, so groups and site admin
count). The same `formatAccessList` adds it to `/dataset_view/configuration_access/:id` and
`/project/:id/access`. Clients must use it for their own rights, not their row in `users`: that list
holds only direct entries, so access held through a group has no row. *"testAccessListReportsEffectiveCurrentUserLevel"*

Each configuration also carries the caller's level, and `writableViewIds` lists the dataset's views
the caller can write. `POST /dataset_view/share` needs WRITE on every view and configuration it is
sent, so the dialog sends only writable views, and treats a configuration as shareable only when
the caller can write it **and** at least one of its views (`isConfigShareable`). That one predicate
drives the default selection, the owner's checkbox enabling and the pruning after a self-change, so
a collection is never shown selected while its views are silently dropped
(*"never shows a collection selected that would not be shared"*). Without this, a WRITE collaborator with READ on one
collection had every share refused. *"testAccessListReportsWhatTheCallerCanShare"*,
*"selects writable collections and sends writable views"*

**Implementation notes:**
- Uses `Folder().getFullAccessList()` for user list (doesn't include emails)
- Requires separate bulk query to fetch user emails
- Bulk loads configurations to avoid N+1 queries
- Lists only configurations the caller can READ (`findWithPermissions`): another user may have opened the dataset with a private configuration of theirs

#### `GET /dataset_view/configuration_access/:configurationId`

Returns the current access list for a configuration and its associated datasets.

**Required permission:** READ access to the configuration

**Response:**
```json
{
  "configurationId": "string",
  "public": true,
  "users": [
    {
      "id": "string",
      "login": "string",
      "name": "string",
      "email": "string",
      "level": 0
    }
  ],
  "groups": [],
  "datasets": [
    {
      "id": "string",
      "name": "string",
      "public": true
    }
  ]
}
```

**Implementation notes:**
- Uses `Collection().getFullAccessList()` for user list (doesn't include emails)
- Requires separate bulk query to fetch user emails
- Bulk loads datasets to avoid N+1 queries
- Lists only datasets the caller can READ (`findWithPermissions`): other users may have opened their own private datasets with this configuration

#### `POST /dataset_view/share`

Grants, modifies, or revokes user access.

**Required permission:** WRITE on the dataset folder and on every listed DatasetView and its
configuration. All `datasetViewIds` must belong to one dataset (400 otherwise). On **each** of
those documents (`requireCanSetUserAccess`), the caller cannot grant a level above their own,
nor change or remove a user whose current entry is above their own; either is a 403 that changes
nothing. Before 2026-10-11 only WRITE was checked, so a collaborator could grant themselves
ADMIN or remove the owner. *"testWriteUserCanShareUpToWrite"*,
*"testWriteUserCannotExceedOwnLevel"*, *"testOwnLevelIsCheckedPerDocument"*,
*"testShareEndpointRejectsViewsOfSeveralDatasets"*

**Request body:**
```json
{
  "datasetViewIds": ["id1", "id2"],
  "userMailOrUsername": "user@example.com",
  "accessType": 0
}
```

**Access type values:**
- `0` - READ access
- `1` - WRITE access
- `2` - ADMIN (owner) access
- `-1` - Remove access entirely
- Anything else (including `100` SITE_ADMIN, fractions like `1.9`, booleans) is a 400 — *"testShareEndpointRejectsInvalidAccessType"*

**Behavior:**
- Sets permissions on all specified DatasetViews
- Also sets permissions on the parent Dataset folder
- Also sets permissions on associated Configurations
- `-1` is mapped to `None` (`parseShareAccessType` in `server/helpers/access_helpers.py`)
  before `setUserAccess`, which deletes the user's entry from each ACL. Girder removes an
  entry only for `None`; passing `-1` through would store an inert `level: -1` entry that
  grants nothing but kept the user in the sharing table (fixed 2026-10-11).
  `formatAccessList` drops negative entries, so leftovers from before the fix stay hidden.
  Tests: *"testShareEndpointRemoveDropsAclEntries"*, *"testAccessListHidesLegacyNegativeEntries"*,
  *"test_remove_drops_entries_everywhere"* (project), *"test_legacy_negative_entry_not_propagated"*.

**Limits (`server/helpers/aclLimits.py`):** sharing never hands out more than the
caller holds. WRITE is enough to share, but an explicit request (this endpoint,
`project/:id/share`) is refused if it would exceed the caller's level on any touched
document or change a user above it (its owner). Copying a project's ACL onto a resource
newly added to it caps each entry at the caller's level instead (`cappedCopyLevel`), so
adding a dataset never fails over someone else's grant. Project propagation reaches only
what the caller could share here (`limitToShareable`: datasets, their views and
collections the caller can edit). Before this, a WRITE collaborator could grant
themselves ADMIN (`accessType: 2` on their own login). Tests:
`test/test_share_escalation.py`; invariants are in `PROJECTS.md` "Regression checklist".

#### `POST /dataset_view/set_public`

Makes a dataset and all associated resources public or private.

**Required permission:** ADMIN access to the dataset

**Query parameters:**
- `datasetId` - The dataset folder ID
- `public` - Boolean, true to make public

**Affected resources:**
- Dataset folder
- The DatasetViews for the dataset that the caller administers
- The Configurations used by those DatasetViews that the caller administers

Other users can open a dataset they may read with their own configuration,
creating their own view. Owning the dataset does not let the caller publish or
unpublish those: setting `public` is an ADMIN operation on each document, and a
configuration can also serve another owner's public dataset, which unpublishing it
would break. They are left as they are in both directions; those not already in the
requested state are counted in the response's `datasetViewsSkipped` /
`configurationsSkipped` (beside `datasetViewsUpdated` / `configurationsUpdated`),
and the Share dialog says what stayed public or private. Views and configurations the
pre-ownership `set_public` published stay public until their owners (or a site
admin) change them. A site admin administers everything, so nothing is skipped for
them.

Who may share a dataset, and what project sharing and `project/:id/set_public`
may reach, are handled in PRs #1406 and #1410.

## Share links (share a view without making the dataset public)

A **share link** is a capability URL — `#/shared/<token>` (or `#/embed/<token>` for the
chrome-less viewer) — that opens one dataset view read-only for anyone who has it. It does
not make the dataset public and does not require the recipient to have an account.

**How the bearer is bounded.** A Girder token's scope is global (a `DATA_READ` token for
the owner would read everything the owner can), so each link creates a hidden Girder user
`share-<hex>` (random password, `shareLink` marker), grants it READ on the dataset folder,
the dataset view and its configuration through the same `setUserAccess` calls the named
sharing uses, and mints a Girder token for *that* user scoped to `DATA_READ` plus
`USER_INFO_READ` (the client's `user/me` bootstrap; nothing else). The bearer sees
exactly this dataset (ACL) and cannot write (scope: write endpoints answer 401). Girder has no
view-only scope — `DATA_READ` would also open `folder/{id}/download`, `item/{id}/download`,
`file/{id}/download`, `resource/download` and the plugin's `/export` routes — so
`server/helpers/shareLinkGuards.py` binds `rest.<method>.<route>.before` on those routes and
refuses a link user (403) before the handler runs. The guard is decorated `@access.public`:
Girder demands a site admin for any `before` handler without an access level, which
had silently made every download and export admin-only. The same module drops link users from
`GET user` listings. The shared access-list formatter also excludes link principals
from dataset, configuration, and project named-user tables without changing their ACLs.
Manage those principals through the Share links list instead. Tiles, annotations,
properties and the spatial routes stay open: a link
shows a view, it does not hand out the files. Revoking
deletes the user — Girder's `cleanupDeletedEntity` drops its ACL entries — and its tokens.
Deleting the dataset revokes all of its links (a `model.folder.remove` hook), since the
revoke endpoint can no longer load the folder afterwards.
The link user is `public: False` but does exist in the user collection; it never receives
storage and cannot be signed into (nobody knows its password).

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/share_link` `{datasetViewId, days? (0 = never, ≤ 3650), label?}` | ADMIN on the dataset, WRITE on the view and its configuration (as named sharing) | Create; the response carries `token` **once** |
| `GET` | `/api/v1/share_link?datasetId=` | WRITE on the dataset | Live links (no tokens) |
| `GET` | `/api/v1/share_link/me` | the bearer | Which view the request's token opens; 404 for an ordinary login or an expired link. Does not mutate browser cookies. |
| `DELETE` | `/api/v1/share_link/{id}` | ADMIN on the dataset | Revoke (idempotent) |

Model: `server/models/shareLink.py` (`share_link` collection: `datasetId, datasetViewId,
configurationId, linkUserId, tokenId, label, createdBy, created, expiresAt, revoked`).
Expiry is enforced by Girder on the token and reported by `/me`; datetimes are compared as
aware UTC (Girder's token expiry is aware, Mongo's round trip may be naive). The link user
is saved `status: enabled` so a registration policy of "approve" does not e-mail the admins
for every link; it still gets Girder's default Public/Private folders (empty, no quota).
A recipient who is signed in to this Girder on the same browser keeps their own cookie.
Shared-view image, annotation-raster, and transcript-density tile URLs explicitly carry the
in-memory link bearer as a `token` query parameter, so Girder authorizes those image requests
as the link user instead of the ambient login.

**Client.** `src/store/ShareLinkAPI.ts`; `store.openShareLink({token, signal})` validates the token
on an isolated REST client **in memory only**, fetching the link user and asking `/me`
before committing either credentials or Vuex identity. Failed or superseded attempts
leave the current session and user-dependent state untouched. The route aborts its
signal on token changes or unmount; the store checks cancellation before committing
identity, so an abandoned bootstrap cannot log in after navigation. A signed-in user's
persisted login survives a visit, and leaving the shared route in the same tab
(`store.leaveShareLink`, from `SharedView`'s unmount) restores the session the link
replaced — also after hopping between links — unless a login or logout replaced the
link's session meanwhile. The tile URL builders add that bearer only when the fetched user has the `shareLink`
marker. `src/views/SharedView.vue` renders the viewer on the original token-bearing
route, so refresh revalidates the bearer without changing the owner's stored login.
The normal login bootstrap is skipped on shared routes to avoid racing the bearer.
App.vue recognizes `/embed/<token>` to hide the toolbar and palettes (`embedMode`).
Route defaults and later palette-open requests respect embed mode; the Time Lapse
palette is hidden without changing the underlying viewer mode. The Share dialog's
**Share links** section (admins) lists, creates (label, 7/30/90 days/never) and revokes
links; the URL is shown once with its embed variant.

Tests: `test/test_share_link.py` (bearer reads only the shared dataset and cannot write or
mint links; create needs ADMIN and valid input; list/revoke; deleting the dataset revokes its links; ordinary login is not a link;
expired links refused), `ShareLinkAPI.test.ts`, `SharedView.test.ts`,
`ShareDataset.test.ts`.

### Share-link regression checklist

- The API classes send the link's bearer, not the boot client's token (the stored login,
  or none for a recipient): `girderRestProxy` resolves the live `girderRest` —
  `index.test.ts` (`commits only the latest validated link and does not persist its
  bearer`, which asserts `main.api.client.token`). Verified live: a share view's
  `api.client` `user/me` is the `share-…` user, the view's `_accessLevel` is 0 and
  `canEditDatasetView` is false.
- Leaving the shared route cancels pending authentication before identity commits —
  `SharedView.test.ts` (`cancels pending authentication when leaving the shared route`),
  `index.test.ts` (`does not commit a share bootstrap after its route is cancelled`).
- Failed link validation cannot commit attempted identity or reset user state;
  only the latest successful bootstrap commits, without persisting its bearer —
  `index.test.ts` (`does not commit an attempted identity when link validation fails`,
  `commits only the latest validated link and does not persist its bearer`).

- Hide link principals from dataset/configuration access lists while their bearer stays
  readable — `test_share_link.py::testLinkUsersStayOutOfAccessLists`.

- Keep the bearer URL on initial open and reload/remount without replacing the owner's
  persisted login — `SharedView.test.ts` (`acts as the link's bearer and opens its dataset view`).
- Leaving the shared route restores the replaced session, from before the first of
  several links — `index.test.ts` (`restores the replaced session when the shared
  route is left`), `SharedView.test.ts` (`gives back the viewer's own session when the
  route is left`).
- Recognize the embed route without redirecting away from its credential —
  `SharedView.test.ts` (`marks the embed route so the chrome is dropped`).
- Keep palettes closed through route initialization and late viewer requests, and
  restore normal controls when leaving embed — `App.test.ts`
  (`keeps palettes closed after entering an embedded viewer`, both route and query variants).
- Display expired/invalid link errors without opening an unrelated viewer —
  `SharedView.test.ts` (`explains a dead link instead of navigating`).
- Preserve saved virtual gene columns and gates when a shared configuration is hydrated —
  `annotationBrowserConfig.test.ts` (`preserves virtual columns, filters, labels and gates on reload`).

## Frontend Implementation

### Component: `ShareDataset.vue`

Location: `src/components/ShareDataset.vue`

**Props:**
- `dataset` - The dataset object to share
- `value` - v-model for dialog visibility

**Key features:**
- Real-time updates (no "Save" button - each action immediately syncs)
- Individual loading states per user row
- Confirmation dialog before removing access
- ADMIN users protected from removal (lock icon)
- Rights come from the access response's `currentUserLevel`, not the caller's row (*"takes management rights from the server's effective level"*). Changing your own entry re-reads it without resetting the collection selection. Any failed load, including the 403 after removing your last access, fails closed (*"removing your last access fails closed on the 403"*).
- Only the latest access load commits: full loads and refreshes (`fetchAccessInfo(id, refresh)`) share one request counter with `resetState`, and a refresh that supersedes an in-flight full load (a reopen) finishes it as a full load (*"an older refresh cannot overwrite a newer load"*, *"a self-change during a reopen's load still fills the dialog"*). The refresh that follows every settled sharing change is also what re-reads the caller's own level after they change their own entry; a failed refresh (the 403 after removing your last access) fails closed without an error banner (*"removing your last access fails closed on the 403"*).
- Share targets are named users only. `findShareTarget` treats share-link principals as unknown on both share endpoints (*"testShareEndpointRejectsShareLinkPrincipals"*).
- With nothing shareable (`canShareAny`), the add form becomes a note and the row controls are hidden (*"with nothing shareable, a WRITE user gets a note, not controls"*).
- **WRITE collaborators** (`canManageUsers`) get the add-user form, plus level dropdowns and remove buttons on rows at or below their own level (`canEditUser`). Rows above it show a lock. Public toggle, collection checkboxes and share links stay ADMIN-only (`isResourceAdmin`). A refused share shows the server's reason.
- **Read-only mode** for READ users: the dialog hides all edit controls (add user form, remove buttons, access level dropdowns, public toggle, collection checkboxes) and shows access levels as plain text. The dialog title changes from "Share Dataset:" to "Sharing:".

### State Management

```typescript
// Access list data
isPublic: boolean
users: IDatasetAccessUser[]
configurations: IDatasetAccessConfiguration[]
selectedConfigIds: string[]

// Loading states
publicLoading: boolean
userLoading: string | null  // ID of user being modified
addUserLoading: boolean
```

### API Methods

Located in `src/store/GirderAPI.ts`:

```typescript
// Fetch current access list
async getDatasetAccess(datasetId: string): Promise<IDatasetAccessList>

// Share with a user (or revoke with accessType: -1)
async shareDatasetView(
  datasetViews: IDatasetView[],
  userMailOrUsername: string,
  accessType: number
): Promise<true | string>

// Toggle public access
async setDatasetPublic(datasetId: string, isPublic: boolean): Promise<object>
```

### TypeScript Interfaces

Located in `src/store/model.ts`:

```typescript
interface IDatasetAccessUser {
  id: string;
  login: string;
  name: string;
  email: string;
  level: 0 | 1 | 2;
}

interface IDatasetAccessConfiguration {
  id: string;
  name: string;
  public: boolean;
  currentUserLevel: number; // caller's effective level on this configuration
}

interface IDatasetAccessList {
  datasetId: string;
  public: boolean;
  users: IDatasetAccessUser[];
  groups: unknown[];
  configurations: IDatasetAccessConfiguration[];
  currentUserLevel: number; // caller's effective level on the dataset
  writableViewIds: string[]; // views the caller can write (and so share)
}
```

## UI Layout

### Admin View (resource owner)

```
+-----------------------------------------------+
| Share Dataset: [Dataset Name]                 |
+-----------------------------------------------+
| Select collections to share along with dataset|
| [x] Collection A                              |
| [x] Collection B                              |
+-----------------------------------------------+
| [x] Make Public (read-only access for all)    |
+-----------------------------------------------+
| Current Access:                               |
| | User          | Access    | Remove        | |
| | user@email    | [Read v]  | [X]           | |
| | jane.doe      | [Write v] | [X]           | |
| | owner         | Admin     | [lock icon]   | |
+-----------------------------------------------+
| Add User:                                     |
| [email/username    ] [Read v] [+ Add]        |
+-----------------------------------------------+
|                                      [Done]   |
+-----------------------------------------------+
```

### Read-Only View (READ-level shared users)

```
+-----------------------------------------------+
| Sharing: [Dataset Name]                       |
+-----------------------------------------------+
| [Private] or [Public]                         |
+-----------------------------------------------+
| Current Access:                               |
| | User          | Access                    | |
| | user@email    | Read                      | |
| | jane.doe      | Write                     | |
| | owner         | Admin (Owner)             | |
+-----------------------------------------------+
|                                      [Done]   |
+-----------------------------------------------+
```

No collection checkboxes, public toggle, access level dropdowns, remove buttons, or add user form are shown.

## Error Handling

| Error | User Message |
|-------|--------------|
| Invalid email/username | "Unknown user. Please check the username or email." |
| Network error | "Failed to [action]" |
| No collections selected | "Please select at least one collection" |

## Future Considerations

1. **Per-configuration public status**: The backend supports different public status per configuration, but the UI doesn't expose this since most datasets have a single configuration.

2. **Group support**: Girder supports group-based permissions, but the UI currently only handles individual users.

## File Locations

| File | Purpose |
|------|---------|
| `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/datasetView.py` | Backend API endpoints |
| `src/components/ShareDataset.vue` | Frontend share dialog (admin: full edit, write: users up to Write, read: read-only) |
| `src/components/SharingStatusDisplay.vue` | Inline sharing status card (public/private chip, user list) |
| `src/components/SharingStatusIcon.vue` | Small sharing icon for list items |
| `src/views/dataset/DatasetInfo.vue` | Dataset info page (embeds SharingStatusDisplay) |
| `src/views/configuration/ConfigurationInfo.vue` | Configuration info page (embeds SharingStatusDisplay) |
| `src/store/GirderAPI.ts` | API client methods |
| `src/store/model.ts` | TypeScript interfaces |

## Regression checklist

Each line below was a real defect in sharing, found in review of PR #1403 or by
Codex, and names the test that holds it. Changing sharing, publishing, the
share-link guard or dataset-view writes means re-checking this list.

Run `pnpm test src/components/ShareDataset.test.ts` and, from
`devops/girder/plugins/AnnotationPlugin`, `tox -- upenncontrast_annotation/test/test_sharing.py upenncontrast_annotation/test/test_share_link.py upenncontrast_annotation/test/test_export.py`.

### Share-link guard

- [ ] **The download/export guard refuses link users only.** Its `rest.*.before` listener needs an access level, or Girder makes every guarded route site-admin-only. Test with a non-admin owner, not the `admin` fixture. — *"testNonAdminOwnerCanStillDownload"*
- [ ] **Anonymous viewers of a public dataset can still download and export it.** The admin lockout broke this too (`requireAdmin(None)`). — *"testAnonymousUsersCanDownloadAndExportAPublicDataset"*
- [ ] **Link users are refused by the guard itself.** Assert the guard's message on every route, not just a 403, which also passed while every non-admin was refused. — *"testBearerReadsOnlyTheSharedDataset"*

### Publishing (`dataset_view/set_public`)

- [ ] **Publishing and making private both change only the caller's own views and configurations.** Unpublishing another owner's configuration would break any public dataset of theirs that uses it. — *"testChangesOnlyOwnViewsAndConfigurations"*, *"togglePublic explains what making private left public"*
- [ ] **A site admin skips nothing.** — *"testSiteAdminStillChangesEverything"*
- [ ] **Skipped counts ignore deleted configurations** (a view can outlive its configuration). — *"testDeletedConfigurationIsNotCountedAsSkipped"*
- [ ] **ACL saves accept older views holding null `scales`/`lastViewed`.** `setPublic`/`setUserAccess` validate the stored document as is. — *"testAclSavesAcceptOlderNullFields"*
- [ ] **The Share dialog says what publishing skipped, and only for the dataset and publish it describes.** — *"togglePublic explains views and collections owned by others"*, *"togglePublic shows no notice when nothing was skipped"*, *"resetState clears all fields"*
- [ ] **A publish in flight survives a dialog reset.** The server keeps writing after the dialog closes, so reopening keeps the checkbox disabled until it settles (no opposite request can interleave), and the late result updates the checkbox but not the reopened dialog's notice. Pending publishes are tracked per dataset and shared by every dialog instance (`utils/pendingPublishes.ts`: one dialog is mounted per file-browser row), since the reused dialog can move to another dataset and back. — *"togglePublic keeps a publish in flight across a dialog reset"*, *"togglePublic tracks a pending publish per dataset"*, *"togglePublic shows a dataset's notice after another dataset's publish"*, *"shares a pending publish across dialog instances"*
- [ ] **Every async handler in the Share dialog writes back only while the dialog still shows the session and dataset it started in.** The root cause behind most findings above: one dialog instance is reused across datasets and across close/reopen, so a late response landed in whatever it showed by then. Handlers capture `claimDialog()` before awaiting; every reset (closing the dialog or moving it to another dataset) starts a new session. Every ownership check compares against a counter that only increases; the dataset id alone recurs (A → B → A). — *"sharing and link responses that land after a reset leave the dialog alone"*, *"a request from before A -> B -> A does not write into the new A session"*, *"a failed load for the next dataset leaves no previous dataset state"*, *"another dialog takes the publish result its overlapping load skipped"*
- [ ] **Sharing changes are server operations: their guards outlive the dialog, and every open dialog resyncs when one settles.** Add user, change/remove a user's access, create and revoke link keep running after the dialog closes, so their in-progress state lives in `utils/pendingMutations.ts` (shared by every instance, keyed by what they change; an Add can name any user, so it excludes every user change). When one settles, every open dialog showing the dataset refreshes quietly (selection and notice kept), so none keeps rows read mid-change. The other lifetime -- what the dialog shows -- stays per session (claimDialog). — *"a sharing change in flight blocks an overlapping one after a reopen"*, *"a change settling refreshes a dialog that loaded while it ran"*, *"an Add and a change to any user's access exclude each other"*, *"one removal finishing leaves another removal's confirmation alone"*, *"a revoke does not drop a create's refreshed link list"*, *"addUser calls shareDatasetView and refreshes access"*
- [ ] **The dialog shows only the current dataset's access state.** Moving the open dialog to another dataset reloads it; a load for a dataset no longer shown, or one that overlapped a publish (it read the flag mid-write), does not overwrite the checkbox. — *"reloads access info when the open dialog moves to another dataset"*, *"ignores an access load for a dataset no longer shown"*, *"an access load overlapping a publish leaves the checkbox to the publish"*
- [ ] **Skipped counts only resources left in the wrong state.** Another user's view or configuration that is already public needed nothing; counting it made the dialog claim it "stayed private". — *"testAlreadyPublicResourcesAreNotCountedAsSkipped"*

### Named-user sharing (`dataset_view/share`, `project/:id/share`)

- [ ] **Removing a user deletes their ACL entries.** `-1` is the wire value only; Girder removes an entry only for `None` (`parseShareAccessType`), so a stored `level: -1` reappeared in the dialog. — *"testShareEndpointRemoveDropsAclEntries"*, *"test_remove_drops_entries_everywhere"*, *"testAccessListHidesLegacyNegativeEntries"*
- [ ] **WRITE can share, but never above the caller's own level, checked on every touched document.** No grant above it, no change to a user above it (the owner). — *"testWriteUserCanShareUpToWrite"*, *"testWriteUserCannotExceedOwnLevel"*, *"testOwnLevelIsCheckedPerDocument"*
- [ ] **Only ints -1/0/1/2 are levels** (no SITE_ADMIN, fractions or booleans). — *"testShareEndpointRejectsInvalidAccessType"*, *"test_invalid_access_type_is_400"*
- [ ] **Share-link principals are not share targets.** — *"testShareEndpointRejectsShareLinkPrincipals"*, *"test_share_link_principal_is_not_a_target"*
- [ ] **The dialog takes the caller's rights from the server's effective level and shares only writable views of shareable collections.** — *"takes management rights from the server's effective level"*, *"selects writable collections and sends writable views"*, *"never shows a collection selected that would not be shared"*, *"removing your last access fails closed on the 403"*

### Last ADMIN (`last_admin_guard`)

Run `tox -- upenncontrast_annotation/test/test_last_admin_guard.py`.

- [ ] **The last user at ADMIN can't remove or demote themselves, on a dataset or a project, and a refused request writes nothing** (views and configurations, and the project's own ACL, included). — *"testLastAdminCannotRemoveThemselvesViaDatasetShare"*, *"testLastAdminCannotDemoteThemselvesViaDatasetShare"*, *"testNewSoleAdminCannotRemoveThemselves"*, *"testLastDatasetAdminCannotLeaveViaProjectShare"*, *"testRefusedProjectShareLeavesTheProjectUnchanged"*
- [ ] **`project/:id/share` checks the project's own ACL, not only what it propagates to.** Before this, an owner could leave a project holding none of their datasets and get a 403 on it. — *"testLastAdminCannotLeaveAnEmptyProject"*, *"testLastAdminCannotDemoteThemselvesOnAProject"*
- [ ] **Ownership can move.** The creator isn't special: they can hand ADMIN over and step down, and a co-owner can remove them. — *"testCreatorCanTransferOwnershipThenStepDown"*, *"testCoOwnerCanRemoveTheCreator"*, *"testCreatorCanHandOverViaRestEndpoint"*, *"testProjectOwnerCanHandOverThenLeave"*
- [ ] **Girder's raw folder endpoints are guarded by the save listener**, at the model layer too. — *"testSoleAdminCannotEmptyAccessViaRestEndpoint"*, *"testSoleAdminCannotDemoteSelfViaRestEndpoint"*, *"testModelLayerAlsoGuarded"*
- [ ] **Only user entries count; a group ADMIN grant doesn't.** — *"testGroupAdminDoesNotCountAsAnAdmin"*
- [ ] **Site admins can override (recovery path).** — *"testSiteAdminCanOverride"*, *"testSiteAdminCanRemoveTheLastAdminViaDatasetShare"*, *"testSiteAdminCanRemoveTheLastProjectAdmin"*
- [ ] **A dataset that already has no ADMIN isn't frozen, but a folder can't become a dataset without one.** The listener compares against the stored folder. — *"testDamagedDatasetStaysShareable"*, *"testFolderCannotBecomeADatasetWithoutAnAdmin"*
- [ ] **Plain Girder folders are untouched.** — *"testNonContrastFolderUnaffected"*

### Dataset-view writes

- [ ] **Create and update keep only the view's own fields.** A body's `access`/`public` must never reach the ACL (WRITE → ADMIN escalation). — *"testWriteUserCannotRewriteTheAcl"*, *"testCreateIgnoresAclFields"*
- [ ] **Create needs both ids and READ on the dataset and configuration**, and a non-object body is a 400. — *"testCreateValidatesAndChecksBothIds"*, *"testNonObjectBodyIsRejected"*

### Export

- [ ] **`export/json` without `configurationId` skips configurations the caller cannot read** instead of failing; publishing now leaves other users' configurations private. — *"testReaderExportsAroundAnotherUsersPrivateConfiguration"*
