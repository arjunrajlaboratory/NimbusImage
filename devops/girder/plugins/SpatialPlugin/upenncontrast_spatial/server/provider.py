"""The `spatial` value provider: `["spatial", "<symbol>"]` as a virtual
property path (annotation plugin `helpers/valueProviders.py`).

Registered at plugin load. A dataset without a registered store answers as
if no annotation had a value; an unknown symbol raises ValueError, which the
consuming endpoints turn into a 400.
"""

import numpy as np
from bson.objectid import ObjectId
from girder.exceptions import AccessException
from girder.models.file import File
from girder.models.item import Item

from .models.registry import DatasetSpatial
from .store import numberFromNumpy, openStore

PREFIX = "spatial"


def storeForDataset(datasetId):
    """The open store for a dataset, or None when none is registered. Access
    to the dataset was checked by the caller. Verify the file still inherits
    that dataset's ACL, including on cache hits: moving an item must not let
    a stale registry reference read another folder through force=True.
    This affiliation check also works outside an HTTP request context."""
    datasetId = ObjectId(str(datasetId))
    entry = DatasetSpatial().forDataset(datasetId)
    if entry is None or 'fileId' not in entry:
        return None
    # Force loads only establish affiliation; no data is opened until checked.
    fileDoc = File().load(entry["fileId"], force=True, exc=True)
    requireFileInDataset(fileDoc, datasetId)
    return openStore(fileDoc)


def requireFileInDataset(fileDoc, datasetId):
    """Refuse a registered file whose item was moved out of the dataset: the
    registry still names it, but it no longer describes (or inherits the ACL
    of) that dataset. Every opener of a registered store checks this."""
    item = Item().load(fileDoc["itemId"], force=True, exc=True)
    if item["folderId"] != ObjectId(str(datasetId)):
        raise AccessException(
            "The spatial source is no longer in this dataset.")


def symbolOf(path):
    if len(path) != 2:
        raise ValueError(
            "a spatial path is [\"%s\", <feature symbol>]" % PREFIX
        )
    return path[1]


class SpatialValueProvider:
    def denseColumn(self, store, symbol):
        rows, values = store.column(symbol)
        dense = np.zeros(store.nObs, dtype=np.float64)
        dense[rows] = values
        return dense

    def values(self, datasetId, path):
        store = storeForDataset(datasetId)
        if store is None:
            return {}
        dense = self.denseColumn(store, symbolOf(path))
        integral = bool(np.all(dense == np.floor(dense)))
        cast = int if integral else float
        return {
            str(annotationId): cast(value)
            for annotationId, value in zip(store.annotationIds, dense)
        }

    def valuesForIds(self, datasetId, path, annotationIds):
        store = storeForDataset(datasetId)
        if store is None:
            return [None] * len(annotationIds)
        dense = self.denseColumn(store, symbolOf(path))
        rows = store.rowsForAnnotationIds(annotationIds)
        return [
            numberFromNumpy(dense[row]) if row >= 0 else None
            for row in rows
        ]

    def matchingIds(self, datasetId, path, propertyFilter):
        store = storeForDataset(datasetId)
        if store is None:
            return []
        dense = self.denseColumn(store, symbolOf(path))
        if propertyFilter.get("mode") == "values":
            mask = np.isin(dense, [
                float(v) for v in propertyFilter.get("values") or []
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            ])
        else:
            mask = np.ones(store.nObs, dtype=bool)
            if propertyFilter.get("min") is not None:
                mask &= dense >= propertyFilter["min"]
            if propertyFilter.get("max") is not None:
                mask &= dense <= propertyFilter["max"]
        return store.annotationIds[mask].tolist()
