"""The user's undo history in a dataset."""

from __future__ import annotations

from nimbusimage_mcp._common import (
    READ_ONLY,
    WRITES,
    clamp,
    client,
    instrumented,
)

MAX_HISTORY = 50


def entries(nc, dataset_id: str) -> list[dict]:
    return nc.girder.get("history", parameters={"datasetId": dataset_id})


def describe(entry: dict) -> dict:
    return {
        "action": entry.get("actionName"),
        "date": entry.get("actionDate"),
        "undone": bool(entry.get("isUndone")),
    }


@instrumented
def ni_history_list(dataset_id: str, limit: int = 10) -> dict:
    """The user's own recent changes to a dataset that undo can reverse,
    newest first: creating, editing (including tagging), or deleting
    annotations and connections, and imports. Worker runs and computed
    measurements are not recorded and cannot be undone. History keeps
    each user's last 10 actions, and recording a new action drops entries
    older than an hour. Use this before ni_history_undo to say what would
    be undone.
    """
    rows = entries(client(), dataset_id)
    limit = clamp(limit, 1, MAX_HISTORY)
    return {
        "total": len(rows),
        "entries": [describe(e) for e in rows[:limit]],
    }


@instrumented
def ni_history_undo(dataset_id: str) -> dict:
    """Undo the user's most recent change to a dataset that is not undone
    yet (see ni_history_list), as the app's undo button does. Undoes one
    action per call (e.g. one tagging call, or one bulk delete, even of
    many annotations). Tell the user what will be undone and confirm
    first.
    """
    nc = client()
    pending = [e for e in entries(nc, dataset_id) if not e.get("isUndone")]
    if not pending:
        raise ValueError("There is nothing to undo in this dataset.")
    nc.girder.put("history/undo", parameters={"datasetId": dataset_id})
    undone = describe(pending[0])
    del undone["undone"]
    return {"undone": undone, "remaining": len(pending) - 1}


TOOLS = [(ni_history_list, READ_ONLY), (ni_history_undo, WRITES)]
