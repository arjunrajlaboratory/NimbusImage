"""HistoryAccessor — undo/redo operations."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client


class HistoryAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def list(self) -> list[dict]:
        """List history entries for this dataset."""
        return self._gc.get(
            f"/history?datasetId={self._dataset_id}"
        )

    def undo(self) -> None:
        """Undo the last action."""
        self._gc.put(
            f"/history/undo?datasetId={self._dataset_id}"
        )

    def redo(self) -> None:
        """Redo the last undone action."""
        self._gc.put(
            f"/history/redo?datasetId={self._dataset_id}"
        )
