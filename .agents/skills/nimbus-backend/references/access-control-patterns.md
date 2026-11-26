# Access Control Patterns (Detailed)

## Access Levels

Girder uses numeric access levels on individual documents (not site-wide):

| Value | Constant | Meaning |
|-------|----------|---------|
| -1 | `AccessType.NONE` | Wire value for "remove" in share requests; map to `None` before `setUserAccess` |
| 0 | `AccessType.READ` | View-only access |
| 1 | `AccessType.WRITE` | Edit access |
| 2 | `AccessType.ADMIN` | Owner — can manage access (share, set public, delete) |

**Important:** `AccessType.ADMIN` means **owner of that specific document**, not a site-wide admin. The creator of a project/dataset gets ADMIN on it. This is distinct from `@access.admin` (the endpoint decorator), which requires the user to be a site-wide Girder admin.

`-1` is the **wire value** the share endpoints accept for "remove access". It is **not** a level to hand to Girder. `setUserAccess` removes the entry only when `level is None` (from Girder's `_setAccess`: `if level is not None: ... $set/$push entry` / `else: $pull`). Anything else, `-1` included, is stored as `{id, level: -1}`. That entry grants nothing, because `_hasUserAccess` requires `level >= requested`. It also isn't a deny rule: group and public access still apply. Its only effect is that the user reappears in the sharing table with no level. (Commit `7e763d9c1` switched the wire value from `null` to `-1` and dropped the `None` mapping, which caused exactly that.)

```python
# Good - validate the wire value, map -1 to None at the API boundary
from ..helpers.access_helpers import parseShareAccessType
level = parseShareAccessType(body["accessType"])  # -1 -> None; 0/1/2 kept
Model().setUserAccess(doc, targetUser, level, save=True)

# Bad - stores a level -1 entry instead of removing the user
Model().setUserAccess(doc, targetUser, AccessType().validate(-1), save=True)
```

`parseShareAccessType` also restricts the level to -1/0/1/2 with a 400. `AccessType().validate` alone accepts `SITE_ADMIN` (100) and raises `ValueError`, which surfaces as a 500. A share endpoint must also stop a caller from reaching **above their own level**. With only a WRITE check, a collaborator can grant themselves ADMIN or remove the owner; the dataset share endpoint allowed this until 2026-10-11. Call `requireCanSetUserAccess(model, doc, user, target, level)` on **every** document whose ACL changes, before changing any of them. It refuses a grant above the caller's level and any change to a user whose current entry is above it. Checking one document isn't enough: WRITE on the folder says nothing about the configuration, which someone else may own. Requiring ADMIN outright also closes the hole, but then WRITE collaborators can't share at all.

Bulk `$pull`/`$push` helpers (`ProjectModel._bulkSetUserAccess`) must likewise push only `level >= AccessType.READ`. Code that copies one ACL onto another (`_bulkSetAllUsersAccess`) must skip negative entries so leftover ones don't spread. `formatAccessList` hides negative entries left over from before the fix.

**Testing removal:** assert `user['_id'] not in {u['id'] for u in doc['access']['users']}` after reloading the document with `force=True`. "User can no longer read" passes with the `-1` bug present. So does checking the GET access list, because `formatAccessList` filters negatives.

## Setting User Access

```python
# Grant access
Model().setUserAccess(doc, targetUser, AccessType.WRITE, save=True)

# Remove access (None, never -1)
Model().setUserAccess(doc, targetUser, None, save=True)
```

## Setting Public Access

```python
Model().setPublic(doc, public=True, save=True)
```

## Getting Access Lists

```python
# Get full access list with user details populated
accessList = Model().getFullAccessList(doc)
# Returns: {'users': [...], 'groups': [...]}
```

## Sharing Pattern (Multi-Resource Permissions)

When sharing a dataset, permissions must be set on multiple resources simultaneously:

```
Dataset Folder ──> DatasetView ──> Configuration
   All three receive the same permissions
```

Resources affected by sharing:
1. **Dataset Folder** - The main folder containing the dataset
2. **DatasetViews** - User-specific view configurations
3. **Configurations (Collections)** - Tool definitions, layer settings, scales

### Share Endpoint Pattern

```python
@access.user(scope=TokenScope.DATA_WRITE)
@autoDescribeRoute(
    Description("Share dataset views with a user")
    .jsonParam("body", "Share request", paramType="body",
               schema={
                   "datasetViewIds": ["id1", "id2"],
                   "userMailOrUsername": "user@example.com",
                   "accessType": 0  # 0=READ, 1=WRITE, 2=ADMIN, -1=remove (-> None)
               })
)
def share(self, body):
    # 1. Resolve user by email or username
    # 2. Load the dataset, views and configurations at WRITE
    # 3. requireCanSetUserAccess(model, doc, caller, target, level) on every
    #    document before writing any (403: above the caller's own level)
    # 4. setUserAccess with parseShareAccessType's level (None removes)
```

`AccessType().validate()` accepts 2, so a share endpoint that only checks
WRITE lets a collaborator grant **themselves** ADMIN (their own login as
the target). Any code that writes an ACL for someone else -- an endpoint,
or a propagation like project sharing -- applies the same rule: WRITE is
enough to share, never above the caller's own level. Explicit requests
refuse (`requireCanSetUserAccess`, 403, checked on every document before
any write); copying a whole ACL onto an added resource (a project's onto
a dataset) caps each entry instead (`helpers/aclLimits.cappedCopyLevel`),
since the caller's own ADMIN entry would otherwise ride along. Pass the
acting user down to the model rather than letting the model write
unconditionally; reach only what the caller could share directly
(`limitToShareable`).

Check every path that hands data *out* on a container's authority, not
only the ones that write ACLs: a Zenodo upload of a project exported every
dataset in it on project ADMIN alone, including datasets the caller could
not read. Publishing or exporting a container needs ADMIN on each thing in
it (`requireProjectContentsAccess`) -- including what the export finds
indirectly: the Zenodo job publishes the property definitions of the
configurations a project dataset's views use. Derive the checked set from
what the export reads, not from the container's own list, and hand the
export that set instead of letting it re-query.

But do not *refuse* because of something anyone can attach: dataset views
reference a dataset without any access check, so a stranger's view (public,
hence "readable") would block the owner's upload. Skip what the caller
does not own instead, and drop the data that depended on it (property
values without their definitions).

### Public Access Pattern

Making resources public/private affects the entire chain:

```python
@access.user
@autoDescribeRoute(
    Description("Set dataset public/private")
    .modelParam('datasetId', 'The dataset folder ID', model=Folder,
                level=AccessType.ADMIN, destName='dataset')
    .param('public', 'Whether to make public', dataType='boolean',
           required=True)
)
def setDatasetPublic(self, dataset, public):
    # Set public on: dataset folder + all DatasetViews + all Configurations
    Folder().setPublic(dataset, public, save=True)
    for view in datasetViews:
        DatasetViewModel().setPublic(view, public, save=True)
    for config in configurations:
        Collection().setPublic(config, public, save=True)
```

### Access Check: Keep an Owner (last ADMIN)

A dataset (`contrastDataset` folder) or project must always keep at least one **user** at
ADMIN. Who holds it doesn't matter: the creator can hand ADMIN to someone else and step
down. Don't special-case `creatorId`. The rule lives in `server/helpers/last_admin_guard.py`:

- `require_keeps_an_admin(model, doc, targetUser, level)` runs inside
  `access_helpers.requireCanSetUserAccess`, so any share path that calls that helper on
  every touched document before writing gets it, and the request stays all-or-nothing.
  A new path that changes a dataset's or project's ACL must call `requireCanSetUserAccess`
  on the document itself, not only on what it propagates to. `project/:id/share` once
  checked only the contained resources, so an owner could leave an empty project with
  no ADMIN.
- A `model.folder.save` listener covers Girder's raw `PUT folder/{id}/access` and
  model-layer saves. Bulk `Model.update()` fires no save event, so the pre-write check
  is the only guard on those paths.
- Group ADMIN grants don't count (a group can be emptied). Site admins and code running
  outside a request are exempt. A resource that already has no ADMIN isn't frozen: the
  listener compares against the stored document.

## Reference

For full sharing implementation details, read: `codebaseDocumentation/SHARING.md`
