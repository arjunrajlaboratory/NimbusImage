"""Differential expression between two groups of cells, as a local job.

For every feature: mean, fraction expressing and n in A and B, log2 fold
change of the means (with a pseudocount), and Welch's t statistic with its
two-sided p-value. One vectorized pass per feature over the CSC slice, so
4,600 features over 700K cells is tens of seconds — a job, with the ranked
table stored on the job document under `spatialResult`.

The optional Wilcoxon method uses Mann-Whitney U over each feature's dense
count distributions and reports its signed z statistic for consistent ranking.
"""

import math

import numpy as np
from bson.objectid import ObjectId
from girder.models.file import File
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job
from scipy import stats

from upenncontrast_annotation.server.models.annotation import Annotation

from .store import openStore

MAX_RESULT_FEATURES = 500
DEFAULT_RESULT_FEATURES = 50
# Added to both means before the ratio so an all-zero group gives a finite
# fold change; counts are integers, so 1e-2 is well below any real mean.
PSEUDOCOUNT = 1e-2
# Progress is written every this many features (jobs SSE + Mongo writes).
PROGRESS_EVERY = 250


def welch(sumA, sumSqA, nA, sumB, sumSqB, nB):
    """(t, p, meanA, meanB) for Welch's unequal-variance t-test from sums;
    t is 0 and p is 1 when both variances are 0."""
    meanA, meanB = sumA / nA, sumB / nB
    varA = max((sumSqA - nA * meanA ** 2) / (nA - 1), 0.0) if nA > 1 else 0.0
    varB = max((sumSqB - nB * meanB ** 2) / (nB - 1), 0.0) if nB > 1 else 0.0
    se2 = varA / nA + varB / nB
    if se2 <= 0:
        return 0.0, 1.0, meanA, meanB
    t = (meanA - meanB) / math.sqrt(se2)
    dof = se2 * se2 / (
        (varA / nA) ** 2 / max(nA - 1, 1) + (varB / nB) ** 2 / max(nB - 1, 1)
    )
    p = float(2 * stats.t.sf(abs(t), dof)) if dof > 0 else 1.0
    return float(t), p, meanA, meanB


METHODS = ("welch", "wilcoxon")


def wilcoxon(valuesA, valuesB, nA, nB):
    """(U-derived z, p) for the Mann-Whitney U test on the dense values of
    both groups (zeros for cells without the gene); z is signed like a
    t-statistic so the ranking by |statistic| works the same way."""
    denseA = np.zeros(nA, dtype=np.float64)
    denseA[:len(valuesA)] = valuesA
    denseB = np.zeros(nB, dtype=np.float64)
    denseB[:len(valuesB)] = valuesB
    if not denseA.any() and not denseB.any():
        return 0.0, 1.0
    result = stats.mannwhitneyu(denseA, denseB, alternative="two-sided")
    meanU = nA * nB / 2.0
    z = float(result.statistic - meanU)
    scale = math.sqrt(nA * nB * (nA + nB + 1) / 12.0)
    return (z / scale if scale else 0.0), float(result.pvalue)


def differential(store, rowsA, rowsB, maxFeatures, onProgress=None,
                 method="welch"):
    """Ranked table for group A (row indices) vs group B (row indices, or
    None for every other row). `method` is "welch" (t-test on means) or
    "wilcoxon" (Mann-Whitney U on the count distributions)."""
    if method not in METHODS:
        raise ValueError("method must be one of %s" % ", ".join(METHODS))
    maskA = np.zeros(store.nObs, dtype=bool)
    maskA[rowsA] = True
    if rowsB is None:
        maskB = ~maskA
    else:
        maskB = np.zeros(store.nObs, dtype=bool)
        maskB[rowsB] = True
        maskB &= ~maskA  # a cell cannot sit on both sides
    nA, nB = int(maskA.sum()), int(maskB.sum())
    if nA < 2 or nB < 2:
        raise ValueError(
            "differential expression needs at least two cells on each side "
            "(A has %d, B has %d)" % (nA, nB)
        )
    table = []
    for index, symbol in enumerate(store.featureSymbols):
        rows, values = store.column(symbol)
        values = values.astype(np.float64)
        inA, inB = maskA[rows], maskB[rows]
        valuesA, valuesB = values[inA], values[inB]
        t, p, meanA, meanB = welch(
            float(valuesA.sum()), float((valuesA * valuesA).sum()), nA,
            float(valuesB.sum()), float((valuesB * valuesB).sum()), nB,
        )
        if method == "wilcoxon":
            t, p = wilcoxon(valuesA, valuesB, nA, nB)
        table.append({
            "symbol": symbol,
            "meanA": meanA,
            "meanB": meanB,
            "fractionA": int(np.count_nonzero(valuesA)) / nA,
            "fractionB": int(np.count_nonzero(valuesB)) / nB,
            "log2FoldChange": math.log2(
                (meanA + PSEUDOCOUNT) / (meanB + PSEUDOCOUNT)
            ),
            "t": t,
            "pValue": p,
        })
        if onProgress is not None and (index + 1) % PROGRESS_EVERY == 0:
            onProgress(index + 1, store.nVar)
    table.sort(key=lambda row: -abs(row["t"]))
    return {
        "nA": nA,
        "nB": nB,
        "featuresTested": store.nVar,
        "method": method,
        "features": table[:maxFeatures],
    }


def rowsForFilters(store, datasetId, filters):
    """Row indices of the annotations matching an already-validated filter
    object (gates and virtual filters resolved by the endpoint)."""
    ids = Annotation().listIds(datasetId, filters)
    rows = store.rowsForAnnotationIds(ids)
    return rows[rows >= 0]


def run(job):
    """Local-job entry point. kwargs: datasetId, fileId, filtersA, filtersB
    (or None), maxFeatures. The endpoint validated the filters and checked
    access; the rows are resolved here so the job document stays small."""
    jobModel = Job()
    kwargs = job["kwargs"]
    jobModel.updateJob(
        job, status=JobStatus.RUNNING,
        log="Comparing expression between two groups...\n",
    )
    try:
        store = openStore(File().load(ObjectId(kwargs["fileId"]), force=True))
        datasetId = ObjectId(kwargs["datasetId"])

        def onProgress(current, total):
            jobModel.updateJob(
                job, progressCurrent=current, progressTotal=total,
                progressMessage="%d / %d features" % (current, total),
            )

        result = differential(
            store,
            rowsForFilters(store, datasetId, kwargs["filtersA"]),
            (
                None if kwargs.get("filtersB") is None
                else rowsForFilters(store, datasetId, kwargs["filtersB"])
            ),
            kwargs["maxFeatures"],
            onProgress,
            method=kwargs.get("method", "welch"),
        )
    except Exception as exc:
        # The job boundary: any failure must land in the job's status/log,
        # then propagate for Girder's own handling.
        jobModel.updateJob(
            job, status=JobStatus.ERROR,
            log="Differential expression failed: %s\n" % exc,
        )
        raise
    jobModel.updateJob(
        job, status=JobStatus.SUCCESS,
        log="Ranked %d features.\n" % result["featuresTested"],
        otherFields={"spatialResult": result},
    )
