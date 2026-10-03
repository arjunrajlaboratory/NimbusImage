"""Write a feature panel from the store into an annotation property.

Every row still belonging to the dataset gets a DENSE sub-value per feature
(``values[propertyId][symbol] = count``, zeros included) so the UI can tell
"zero" from "not computed"; cells without a row in the table lose the
written sub-keys once the write succeeds, so re-materializing from a smaller
table leaves no stale values. Runs inline for small stores and as a Girder
local job (``run(job)``) above ``MATERIALIZE_INLINE_MAX_ROWS``.

Merging uses atomic update pipelines in the property-values model, preserving
unrelated properties and sub-values even when spatial jobs run concurrently.
"""

import numpy as np
from bson.objectid import ObjectId
from girder.models.file import File
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from .provider import requireFileInDataset
from .store import numberFromNumpy, openStore

# Rows per write batch: 20K documents is well under Mongo's 16 MB command
# limit for a 64-feature panel and keeps each bulk update bounded.
CHUNK_ROWS = 20_000
# Above this many rows the endpoint schedules a job instead of blocking the
# request (709K rows x 5 features measured ~60 s through the REST API).
MATERIALIZE_INLINE_MAX_ROWS = 50_000


def scoreColumn(store, symbols, method):
    """(rows, values) of a gene-set score per cell: the mean (or sum) of the
    given features' counts, sparse like a column (zero rows omitted)."""
    dense = np.zeros(store.nObs, dtype=np.float64)
    for symbol in symbols:
        rows, values = store.column(symbol)
        dense[rows] += values
    if method == "mean":
        dense /= len(symbols)
    nonzero = np.flatnonzero(dense)
    return nonzero, dense[nonzero]


def writeValues(store, datasetId, propertyId, columns, onProgress=None):
    """Write `columns` ({subKey: (rows, values)}, e.g. from store.column or
    scoreColumn) for live dataset rows as sub-values of the property.
    Returns the number of live dataset rows written."""
    symbols = list(columns)

    def subValuesFor(start, stop):
        subValues = [dict.fromkeys(symbols, 0) for _ in range(stop - start)]
        for symbol, (rows, values) in columns.items():
            # CSC row indices are ascending, so the chunk is one slice.
            low, high = np.searchsorted(rows, [start, stop])
            for row, value in zip(rows[low:high], values[low:high]):
                subValues[int(row) - start][symbol] = numberFromNumpy(value)
        return subValues

    return writeCellValues(
        datasetId, propertyId, store.annotationIds, subValuesFor, onProgress,
        retireSubKeys=symbols,
    )


def writeCellValues(datasetId, propertyId, annotationIds, subValuesFor,
                    onProgress=None, retireSubKeys=None):
    """Chunked writer shared by materialize, score and the neighborhood
    job: `subValuesFor(start, stop)` returns one {subKey: number} dict per
    cell of the chunk, merged into the cells' property-value documents.
    Returns the number of live dataset cells written. Progress reports rows
    examined, including moved/deleted cells that must not receive writes.

    With `retireSubKeys`, once every chunk is written those sub-keys are
    unset on this dataset's other value documents: the cells a previous
    (larger) table wrote and this one has no row for would otherwise keep
    its values. A failed write leaves the previous values in place."""
    valuesModel = AnnotationPropertyValues()
    propertyKey = str(propertyId)
    total = len(annotationIds)
    written = 0
    writtenRows = np.zeros(total, dtype=bool)
    for start in range(0, total, CHUNK_ROWS):
        stop = min(start + CHUNK_ROWS, total)
        chunkIds = [ObjectId(str(value))
                    for value in annotationIds[start:stop]]
        # A stored table can contain deleted, moved, or foreign IDs. Check
        # membership before global annotation-keyed writes, never trusting
        # the uploaded table's claimed dataset. One lookup per write batch.
        liveIds = {document['_id'] for document in Annotation().find({
            'datasetId': datasetId, '_id': {'$in': chunkIds},
        }, fields=['_id'])}
        if liveIds:
            live = [annotationId in liveIds for annotationId in chunkIds]
            entries = [
                (annotationId, subValues)
                for annotationId, subValues, isLive in zip(
                    chunkIds, subValuesFor(start, stop), live)
                if isLive
            ]
            valuesModel.setSubValuesMany(datasetId, propertyKey, entries)
            writtenRows[start:stop] = live
            written += len(entries)
        if onProgress is not None:
            onProgress(stop, total)
    if retireSubKeys:
        _retireUnwritten(
            datasetId, propertyKey, retireSubKeys,
            np.asarray([str(annotationIds[row]) for row in
                        np.flatnonzero(writtenRows)], dtype="S24"),
        )
    return written


def _retireUnwritten(datasetId, propertyKey, subKeys, writtenIds):
    """Unset `values.<property>.<subKey>` on the dataset's value documents
    that carry one of the sub-keys but whose annotation is not among
    `writtenIds`: one projected scan, then one bulk update per chunk."""
    valuesModel = AnnotationPropertyValues()
    paths = ["values.%s.%s" % (propertyKey, key) for key in subKeys]
    writtenIds = np.sort(writtenIds)
    stale = []
    batch = []

    def collect():
        ids = np.asarray([str(i) for i in batch], dtype="S24")
        found = np.zeros(len(ids), dtype=bool)
        if len(writtenIds):
            positions = np.clip(
                np.searchsorted(writtenIds, ids), 0, len(writtenIds) - 1
            )
            found = writtenIds[positions] == ids
        stale.extend(i for i, hit in zip(batch, found) if not hit)
        batch.clear()

    for document in valuesModel.find({
        "datasetId": datasetId,
        "$or": [{path: {"$exists": True}} for path in paths],
    }, fields=["annotationId"]):
        batch.append(document["annotationId"])
        if len(batch) >= CHUNK_ROWS:
            collect()
    if batch:
        collect()
    for start in range(0, len(stale), CHUNK_ROWS):
        valuesModel.update(
            {"datasetId": datasetId,
             "annotationId": {"$in": stale[start:start + CHUNK_ROWS]}},
            {"$unset": {path: "" for path in paths}},
        )


def columnsFor(store, kwargs):
    """The columns a materialize/score request writes: one per symbol, or
    one score column named kwargs["scoreName"] over the symbols."""
    symbols = kwargs["symbols"]
    if kwargs.get("scoreName"):
        return {
            kwargs["scoreName"]: scoreColumn(
                store, symbols, kwargs.get("scoreMethod", "mean")
            )
        }
    return {symbol: store.column(symbol) for symbol in symbols}


def run(job):
    """Girder local-job entry point. kwargs: datasetId, fileId, propertyId,
    symbols, and for a score scoreName + scoreMethod. Access was checked by
    the endpoint that scheduled the job, so the file is loaded without a
    user here."""
    jobModel = Job()
    kwargs = job["kwargs"]
    symbols = kwargs["symbols"]
    jobModel.updateJob(
        job, status=JobStatus.RUNNING,
        log="Materializing %d features...\n" % len(symbols),
    )
    try:
        datasetId = ObjectId(kwargs["datasetId"])
        # The item may have left the dataset since the endpoint checked it.
        fileDoc = File().load(kwargs["fileId"], force=True, exc=True)
        requireFileInDataset(fileDoc, datasetId)
        store = openStore(fileDoc)
        columns = columnsFor(store, kwargs)

        def onProgress(current, total):
            jobModel.updateJob(
                job, progressCurrent=current, progressTotal=total,
                progressMessage="%d / %d cells" % (current, total),
            )

        written = writeValues(
            store, datasetId, ObjectId(kwargs["propertyId"]), columns,
            onProgress,
        )
    except Exception as exc:
        jobModel.updateJob(
            job, status=JobStatus.ERROR,
            log="Materialize failed: %s\n" % exc,
        )
        raise
    jobModel.updateJob(
        job, status=JobStatus.SUCCESS,
        log="Wrote %d values for %d cells.\n" % (len(columns), written),
        otherFields={
            "spatialResult": {
                "propertyId": str(kwargs["propertyId"]),
                "written": written,
                "jobId": str(job["_id"]),
            }
        },
    )
