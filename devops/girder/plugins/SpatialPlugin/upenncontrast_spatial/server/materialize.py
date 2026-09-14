"""Write a feature panel from the store into an annotation property.

Every row still belonging to the dataset gets a DENSE sub-value per feature
(``values[propertyId][symbol] = count``, zeros included) so the UI can tell
"zero" from "not computed". Runs inline for small stores and as a Girder
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
        datasetId, propertyId, store.annotationIds, subValuesFor, onProgress
    )


def writeCellValues(datasetId, propertyId, annotationIds, subValuesFor,
                    onProgress=None):
    """Chunked writer shared by materialize, score and the neighborhood
    job: `subValuesFor(start, stop)` returns one {subKey: number} dict per
    cell of the chunk, merged into the cells' property-value documents.
    Returns the number of live dataset cells written. Progress reports rows
    examined, including moved/deleted cells that must not receive writes."""
    valuesModel = AnnotationPropertyValues()
    propertyKey = str(propertyId)
    total = len(annotationIds)
    written = 0
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
            entries = [
                (annotationId, subValues)
                for annotationId, subValues in zip(
                    chunkIds, subValuesFor(start, stop))
                if annotationId in liveIds
            ]
            valuesModel.setSubValuesMany(datasetId, propertyKey, entries)
            written += len(entries)
        if onProgress is not None:
            onProgress(stop, total)
    return written


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
        store = openStore(File().load(kwargs["fileId"], force=True))
        columns = columnsFor(store, kwargs)

        def onProgress(current, total):
            jobModel.updateJob(
                job, progressCurrent=current, progressTotal=total,
                progressMessage="%d / %d cells" % (current, total),
            )

        written = writeValues(
            store, ObjectId(kwargs["datasetId"]),
            ObjectId(kwargs["propertyId"]), columns, onProgress,
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
