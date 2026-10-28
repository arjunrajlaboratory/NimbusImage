# Upstream Girder issue draft

To file at https://github.com/girder/girder/issues (or as a PR).

The text below is the proposed issue body. Review and edit before posting — particularly the "suggested fix" section, which proposes a change in semantics that the Girder maintainers may want to debate.

---

**Title:** Non–site-admin folder owner can remove their own ADMIN access via `PUT /folder/{id}/access`, locking themselves out

**Affected:** at least Girder 5.x (verified against the `girder` package currently shipping with `large_image==1.34.2a166`). The relevant code paths look the same in current `master`.

**Summary**

`AccessControlledModel.setAccessList` (in `girder/models/model_base.py`) replaces the entire access list with whatever is passed in, validating only the per-entry shape (`id`, `level`). It does not verify that the caller remains in the resulting ACL. The `PUT /folder/{id}/access` endpoint (`girder/api/v1/folder.py:updateFolderAccess`) wires the request body directly into this method.

Consequence: a non–site-admin user who has ADMIN access on a folder (typically because they created it) can call `PUT /folder/{id}/access` with an access list that omits themselves, and the request succeeds. After the call:

- `Folder().load(folderId, user=originalOwner)` returns the folder with `_accessLevel: -1`.
- If the folder is not `public`, only site admins can recover access.
- If the folder is `public`, READ still works for everyone but WRITE is gone for the original owner.

This is hard to discover via the UI but easy to hit from a script or notebook that's manipulating ACLs programmatically.

**Reproduction**

```bash
# Authenticate as a non-admin user (any user with ADMIN on the folder works)
TOKEN=$(curl -s -u user:password http://localhost:8080/api/v1/user/authentication \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["authToken"]["token"])')

# Create a folder (caller is auto-granted ADMIN)
FOLDER_ID=$(curl -s -X POST -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/folder?parentType=user&parentId=<myUserId>&name=test" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["_id"])')

# Remove yourself from access
curl -s -X PUT -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/folder/$FOLDER_ID/access" \
  --data-urlencode 'access={"users":[],"groups":[]}'

# Re-fetch — _accessLevel is -1
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/folder/$FOLDER_ID"
```

The response from the PUT is `200 OK` and includes `"_accessLevel": -1` in the returned document.

**Why the existing layers don't catch this**

- `Folder.setAccessList` (`girder/models/folder.py:831`) only adds `recurse`/`setPublic` logic, then delegates to `AccessControlledModel.setAccessList`.
- `AccessControlledModel.setAccessList` (`girder/models/model_base.py:1114`) validates per-entry shape, then assigns `doc['access']` and saves.
- The `updateFolderAccess` route requires the caller to currently hold ADMIN on the folder, but does not check the post-state.

**Suggested fix**

The thing to prevent is a resource left with **no user at ADMIN**. It doesn't matter who holds ADMIN: an owner handing a folder to someone else and then stepping down is legitimate. In `AccessControlledModel.setAccessList`, after building `acList`, add a check:

```python
if user is not None and not user.get('admin') and not force:
    if not any(entry['level'] >= AccessType.ADMIN
               for entry in acList['users']):
        raise ValidationException(
            'A resource must keep at least one user with ADMIN access.'
            ' Give another user ADMIN first.',
            field='access',
        )
```

`setUserAccess` would need the same check, since removing or demoting the last ADMIN one entry at a time has the same effect.

This:

- Leaves site admins unrestricted (recovery path).
- Leaves the explicit `force=True` code path unrestricted (internal Girder code that intentionally bypasses access checks).
- Allows ownership transfer: give the new owner ADMIN, then either of you can remove the old owner.
- Counts users only. Group ADMIN grants could count too, but a group can be emptied or deleted independently of the resource, so a group-only ACL can still end up with nobody able to administer it.

**Softer alternative**

If a strict rule is considered too breaking, a minimal fix that catches the worst footgun is to reject `acList['users'] == [] and acList['groups'] == []` outright (empty ACL ⇒ only site admins can access). This is rarely intentional and never recoverable by the owner.

**Real-world impact**

We're a downstream project (NimbusImage / `upenncontrast_annotation`) where folders represent scientific imaging datasets. A user lost ADMIN access to a dataset with ~50k annotations because a script set `access={users: [], groups: []}` while testing. The user had to ask a site admin to restore access. We've added a plugin-level guard for our `contrastDataset` folders, but the underlying issue affects every Girder deployment that exposes the access endpoint to non-site-admin users.

**Workaround for downstream**

A `model.folder.save` listener that compares against the stored document, so a folder that already had no ADMIN isn't frozen (NimbusImage's version, which also covers its own share endpoints, is `server/helpers/last_admin_guard.py`):

```python
from girder import events
from girder.api import rest
from girder.constants import AccessType
from girder.exceptions import ValidationException
from girder.models.folder import Folder


def _has_admin_user(doc):
    return any(entry.get('level', -1) >= AccessType.ADMIN
               for entry in (doc.get('access') or {}).get('users', []))


def _keep_an_admin(event):
    doc = event.info
    if not isinstance(doc, dict) or '_id' not in doc:
        return
    # ... filter to your resource type ...
    if _has_admin_user(doc):
        return
    stored = Folder().findOne({'_id': doc['_id']}, fields=['access'])
    if stored is None or not _has_admin_user(stored):
        return  # already had no ADMIN; this save didn't remove it
    current = rest.getCurrentUser()
    if current is None or current.get('admin'):
        return
    raise ValidationException(
        'A folder must keep at least one user with ADMIN access.',
        field='access',
    )


events.bind('model.folder.save', 'my-plugin.keep-an-admin', _keep_an_admin)
```
