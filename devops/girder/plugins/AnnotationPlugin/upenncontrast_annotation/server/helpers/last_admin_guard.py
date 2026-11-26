"""Keep at least one user at ADMIN on every dataset and project.

Girder's core `setAccessList` (behind `PUT /folder/{id}/access`) and
`setUserAccess` accept any access list, including one with no ADMIN left.
After that, only a site admin can share, publish or delete the resource
again; see `codebaseDocumentation/BUG_OWNER_CAN_REMOVE_SELF_FROM_DATASET.md`.

The rule: no change may leave a `contrastDataset` folder or a project with
no *user* at ADMIN. It doesn't matter who holds ADMIN. The creator can give
it to someone else and then step down, and a co-owner can remove the
creator, as long as another user still has it.

- Only user entries count. A group ADMIN grant doesn't keep a resource
  administrable: membership is managed elsewhere (members leave, the group
  can be emptied or deleted), and the plugin shares only with users.
- Site admins are exempt (recovery path), and so is code running outside a
  request (jobs, scripts).
- A resource that already has no user at ADMIN (damaged before this guard
  existed, or by a site admin) isn't frozen: changes that take ADMIN from
  nobody still go through. Becoming a dataset with no ADMIN is refused,
  though, or clearing a folder's subtype, removing the last ADMIN and
  re-marking it would get around the guard.

There are two enforcement points:

- `require_keeps_an_admin` runs before any write on the plugin's share
  paths: dataset_view/share and project/:id/share, including project
  propagation. Each goes through `access_helpers.requireCanSetUserAccess`.
  These paths write several documents, and propagation uses bulk updates
  that fire no save event, so a listener alone would leave partial writes
  or never run.
- A `model.folder.save` listener covers everything else that saves a
  dataset folder: Girder's raw folder endpoints and model-layer code.
  Projects need no listener, because project/:id/share is the only path
  that changes a project's ACL.
"""
from bson import ObjectId

from girder import events
from girder.api import rest
from girder.constants import AccessType
from girder.exceptions import ValidationException
from girder.models.folder import Folder


CONTRAST_DATASET_SUBTYPE = "contrastDataset"
EVENT_LISTENER_NAME = "upenn.folder.keep_an_admin"


def _is_contrast_dataset(doc):
    meta = doc.get("meta") or {}
    return meta.get("subtype") == CONTRAST_DATASET_SUBTYPE


def _admin_user_ids(doc):
    """Ids of the users with an ADMIN entry in doc's ACL (groups ignored)."""
    users = (doc.get("access") or {}).get("users") or []
    return {
        ObjectId(entry["id"]) for entry in users
        if entry.get("level", AccessType.NONE) >= AccessType.ADMIN
    }


def _guarded_kind(model, doc):
    """'Dataset' or 'Project' if the rule applies to doc, else None."""
    if model.name == "folder":
        return "Dataset" if _is_contrast_dataset(doc) else None
    if model.name == "upenn_project":
        return "Project"
    return None


def _refusal(kind, doc):
    # Named, since a project share can be refused by any dataset it reaches.
    return ValidationException(
        '%s "%s" must keep at least one user with ADMIN access. '
        "Give another user ADMIN first." % (kind, doc.get("name", "")),
        field="access")


def _caller_is_site_admin_or_internal():
    """Site admins can override (recovery path). Outside a REST request
    (workers, scripts) there is no caller, and internal code isn't blocked.
    """
    current = rest.getCurrentUser()
    return current is None or bool(current.get("admin"))


def require_keeps_an_admin(model, doc, target_user, level):
    """Before anything is written, refuse a change that would leave a
    dataset or project with no user at ADMIN.

    :param model: The AccessControlledModel doc belongs to.
    :param doc: The document whose ACL is about to change.
    :param target_user: The user whose access is changing.
    :param level: The new level, or None to remove access.
    :raises ValidationException: If target_user is doc's last ADMIN and
        would lose it.
    """
    kind = _guarded_kind(model, doc)
    if kind is None:
        return
    if level is not None and level >= AccessType.ADMIN:
        return
    admins = _admin_user_ids(doc)
    if target_user["_id"] not in admins or len(admins) > 1:
        # Not an ADMIN (nothing to lose, including on a damaged resource
        # with none), or another user keeps it.
        return
    if _caller_is_site_admin_or_internal():
        return
    raise _refusal(kind, doc)


def _keep_an_admin_on_dataset_save(event):
    """model.folder.save listener: a dataset folder must keep a user at
    ADMIN.

    The stored folder is compared, so only a save that takes away the last
    ADMIN, or makes a folder a dataset without one, is refused. A dataset
    that already had none (a damaged one) can still be renamed, shared or
    published.
    """
    doc = event.info
    if not isinstance(doc, dict) or "_id" not in doc:
        # A new folder: createFolder grants its creator ADMIN.
        return
    if not _is_contrast_dataset(doc) or _admin_user_ids(doc):
        return
    stored = Folder().findOne(
        {"_id": doc["_id"]}, fields=["access", "meta"])
    if stored is None or (
            _is_contrast_dataset(stored) and not _admin_user_ids(stored)):
        # Already a dataset with no ADMIN: this save didn't remove it.
        return
    if _caller_is_site_admin_or_internal():
        return
    raise _refusal("Dataset", doc)


def register():
    """Idempotently install the dataset folder save listener."""
    events.unbind("model.folder.save", EVENT_LISTENER_NAME)
    events.bind(
        "model.folder.save",
        EVENT_LISTENER_NAME,
        _keep_an_admin_on_dataset_save,
    )
