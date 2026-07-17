"""Preserve owner access on dataset folders.

Girder's core `Folder.setAccessList` (and the `PUT /folder/{id}/access`
endpoint that calls it) accept any access list, including one that
removes the caller. A non-admin folder owner can therefore lock
themselves out of their own dataset — see
`codebaseDocumentation/BUG_OWNER_CAN_REMOVE_SELF_FROM_DATASET.md`.

This module installs a `model.folder.save` listener that rejects any
save of a `contrastDataset` folder whose `access.users` does not include
the creator at ADMIN level. Site admins can bypass the check (recovery
path); ownership transfer is supported by updating `creatorId` in the
same save.
"""
from bson import ObjectId

from girder import events
from girder.api import rest
from girder.constants import AccessType
from girder.exceptions import ValidationException


CONTRAST_DATASET_SUBTYPE = "contrastDataset"
EVENT_LISTENER_NAME = "upenn.folder.preserve_creator_admin"


def _is_contrast_dataset(doc):
    meta = doc.get("meta") or {}
    return meta.get("subtype") == CONTRAST_DATASET_SUBTYPE


def _creator_has_admin(doc):
    creator_id = doc.get("creatorId")
    if creator_id is None:
        # No creator recorded — nothing to protect.
        return True
    creator_id = ObjectId(creator_id)
    access = doc.get("access") or {}
    for entry in access.get("users", []) or []:
        if (
            ObjectId(entry.get("id")) == creator_id
            and entry.get("level") == AccessType.ADMIN
        ):
            return True
    return False


def _ensure_creator_admin_access(event):
    """model.folder.save listener that enforces creator-stays-ADMIN."""
    doc = event.info
    if not isinstance(doc, dict):
        return
    if "_id" not in doc:
        # New folder; Girder grants the creator ADMIN before the first
        # save when `Folder.createFolder` is used. Skip — we don't want
        # to fight folder creation paths that haven't applied access
        # yet.
        return
    if not _is_contrast_dataset(doc):
        return
    if _creator_has_admin(doc):
        return

    # Site admins can override — recovery path. `rest.getCurrentUser`
    # returns None outside of a REST context (workers, scripts), in
    # which case we let the save through so internal Girder code is not
    # blocked.
    try:
        current = rest.getCurrentUser()
    except Exception:
        current = None
    if current is None or current.get("admin"):
        return

    raise ValidationException(
        "Dataset creator must retain ADMIN access on the folder. "
        "If you want to transfer ownership, add the new owner first "
        "and then have them remove your access.",
        field="access",
    )


def register():
    """Idempotently install the folder-access guard event listener."""
    events.unbind("model.folder.save", EVENT_LISTENER_NAME)
    events.bind(
        "model.folder.save",
        EVENT_LISTENER_NAME,
        _ensure_creator_admin_access,
    )
