# Bug: Dataset owner can remove their own access via raw Girder ACL endpoint

**Discovered:** 2026-05-18 while exercising the NimbusImage API as a non-admin user (`arjunraj`).
**Fixed in plugin:** branch `fix/dataset-owner-cannot-remove-self` — see `server/helpers/folder_access_guard.py` and `test/test_folder_access_guard.py`.
**Upstream Girder report:** see `UPSTREAM_GIRDER_ISSUE.md` (filed separately).

## Summary

The documented sharing invariant — "The dataset owner (ADMIN) cannot be removed from the access list" (`SHARING.md` line 31) — is enforceable through the NimbusImage `dataset_view/share` endpoint, but **not** through the raw Girder `PUT /folder/{id}/access` endpoint. A non-admin owner can call the raw endpoint with an ACL that omits themselves, and Girder will silently accept it, leaving the owner with `_accessLevel: -1` on their own dataset folder.

## Reproduction

User: non-admin, `creatorId == <me>` on the folder. Folder has `meta.subtype == 'contrastDataset'`.

```python
import nimbusimage as ni, json
client = ni.connect()  # API key for non-admin user
gc = client._gc

DS = "<my-dataset-folder-id>"
acl = json.dumps({"users": [], "groups": []})
r = gc.put(f"folder/{DS}/access?access={acl}")
# r['_accessLevel'] == -1   <-- owner has lost access
```

Subsequent `GET folder/{DS}` still returns the folder (because `public: true` was retained), but `_accessLevel: -1` means none of the standard authenticated access paths recognize the user as having any ACL entry. WRITE operations on the folder via the standard model methods will fail with the user as caller.

`recurse` was not used, so descendant items/files retain whatever ACL they had.

## Why this matters

1. A user can accidentally lock themselves out of their own dataset and its 50k+ annotations.
2. The documented invariant in `codebaseDocumentation/SHARING.md` does not match runtime behavior.
3. The frontend sharing UI does not currently expose this path, but any client (CLI, Python API, automation script) using the raw Girder endpoint bypasses the safety.

## Root cause

The `dataset_view/share` endpoint (`server/api/datasetView.py` line 271) uses `Folder().setUserAccess(...)` which is **incremental** (one user at a time) — so it cannot remove the caller.

The raw Girder endpoint `PUT /folder/{id}/access` uses `setAccessList` semantics — full ACL replacement. The NimbusImage plugin does **not** override or guard this endpoint, so any owner with ADMIN on the folder can replace the ACL with one that omits themselves.

## Recommended fix

Add a guard at the plugin layer that intercepts ACL changes on `contrastDataset` folders and refuses to remove the creator. Options:

### Option A — Override the folder access endpoint (per-plugin route)

Register a route that takes precedence over Girder's default for `folder/{id}/access` when the folder's `meta.subtype == 'contrastDataset'`. Validate that the incoming ACL still grants ADMIN to `folder.creatorId` before delegating to the model.

Pro: Single point of enforcement.
Con: Route override is sometimes fragile in Girder; needs care with method/path matching.

### Option B — Model-layer hook on Folder save

Wire a `model.folder.save` event listener that, on save of a `contrastDataset` folder, ensures the creator retains ADMIN in the `access.users` list. If missing, re-add it (or raise `ValidationException`).

Pro: Catches every code path that saves the folder, not just one endpoint.
Con: Event listener has to be careful not to interfere with intentional ownership transfer flows (if any exist).

### Option C — API-layer helper used by all share/access paths

Centralize "set folder access" in a helper in `server/helpers/` that always re-asserts the creator's ADMIN entry. Refuse to register the raw endpoint at all — but this isn't really possible since Girder ships it built-in.

**Preferred:** Option B (model event hook), because the bug is about an invariant on the document itself, not a particular endpoint. Existing patterns: see `server/models/datasetView.py` for an example of plugin-level model hooks.

## Test to add

`devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_sharing.py` (new or existing):

```python
def test_owner_cannot_remove_self_via_raw_folder_access(user, dataset_folder):
    # user is the creator/owner of dataset_folder (subtype=contrastDataset)
    body = {"access": json.dumps({"users": [], "groups": []})}
    resp = server.request(
        path=f"/folder/{dataset_folder['_id']}/access",
        method="PUT", user=user, params=body,
    )
    # Expect either:
    #  (a) 400/403 refusing the change, OR
    #  (b) 200 with creator still present in access.users at ADMIN level
    refetched = Folder().load(dataset_folder['_id'], force=True)
    assert any(
        a['id'] == user['_id'] and a['level'] == AccessType.ADMIN
        for a in refetched['access']['users']
    ), "owner must retain ADMIN on contrastDataset folder"
```

## Related

- `codebaseDocumentation/SHARING.md` — the doc whose invariant is violated
- `server/api/datasetView.py` — the safe (incremental) sharing path
- `server/helpers/access_helpers.py` — likely home for a centralized guard helper

## Manual recovery for the broken folder

(Recorded for the case at hand: folder `69f74239a30941949682bfa9` "HCR_ANNOTATION" needs creator ADMIN restored.)

As a site admin in the Girder UI: open the folder → Access Control → add `arjunraj` as ADMIN → save (no recursion needed; the bad PUT did not recurse). Or via API as a site admin:

```bash
ADMIN_TOKEN=...
curl -s -X PUT -H "Girder-Token: $ADMIN_TOKEN" \
  "http://localhost:8080/api/v1/folder/69f74239a30941949682bfa9/access" \
  --data-urlencode 'access={"users":[{"id":"69f49c2faaba948c2d7b97fd","level":2}],"groups":[]}' \
  --data 'public=true'
```
