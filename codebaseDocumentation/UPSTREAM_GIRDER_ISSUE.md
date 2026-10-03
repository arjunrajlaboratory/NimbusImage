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

In `AccessControlledModel.setAccessList`, after building `acList`, add a check:

```python
if user is not None and not user.get('admin') and not force:
    has_self_admin = any(
        entry['id'] == user['_id'] and entry['level'] == AccessType.ADMIN
        for entry in acList['users']
    )
    has_self_via_group = any(
        # any group that includes the user at ADMIN level
        ...  # group membership lookup
        for group in acList['groups']
    )
    if not (has_self_admin or has_self_via_group):
        raise ValidationException(
            'You cannot remove your own ADMIN access from this resource.'
            ' Have another ADMIN user remove your access instead.',
            field='access',
        )
```

This:

- Leaves site admins unrestricted (recovery path).
- Leaves the explicit `force=True` code path unrestricted (internal Girder code that intentionally bypasses access checks).
- Allows ownership transfer via the standard pattern: add new owner as ADMIN, have them remove the old owner.
- The group-membership check is the tricky part — if you don't want to walk groups, a strict "user must appear at ADMIN in `acList['users']`" rule is also defensible and simpler.

**Softer alternative**

If a strict rule is considered too breaking, a minimal fix that catches the worst footgun is to reject `acList['users'] == [] and acList['groups'] == []` outright (empty ACL ⇒ only site admins can access). This is rarely intentional and never recoverable by the owner.

**Real-world impact**

We're a downstream project (NimbusImage / `upenncontrast_annotation`) where folders represent scientific imaging datasets. A user lost ADMIN access to a dataset with ~50k annotations because a script set `access={users: [], groups: []}` while testing. The user had to ask a site admin to restore access. We've added a plugin-level guard for our `contrastDataset` folders, but the underlying issue affects every Girder deployment that exposes the access endpoint to non-site-admin users.

**Workaround for downstream**

```python
from girder import events
from girder.api import rest
from girder.constants import AccessType
from girder.exceptions import ValidationException

def _ensure_creator_admin(event):
    doc = event.info
    if not isinstance(doc, dict) or '_id' not in doc:
        return
    # ... filter to your resource type ...
    creator_id = doc.get('creatorId')
    if creator_id is None:
        return
    access = doc.get('access') or {}
    if not any(
        e.get('id') == creator_id and e.get('level') == AccessType.ADMIN
        for e in access.get('users', [])
    ):
        current = rest.getCurrentUser()
        if current is None or current.get('admin'):
            return
        raise ValidationException(
            'Creator must retain ADMIN access',
            field='access',
        )

events.bind('model.folder.save', 'my-plugin.creator-admin', _ensure_creator_admin)
```
