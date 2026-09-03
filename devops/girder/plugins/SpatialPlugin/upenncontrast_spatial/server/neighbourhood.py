"""Neighbourhood composition, enrichment and region statistics (plan §15).

Cells are their polygon centroids, computed by Mongo (`$avg` over the
coordinates) so 700K cells cost seconds, not a coordinate download; a cell's
TYPE is its first tag that is not excluded (`cell` by default), the label
Phase 0 made canonical.
"""

import datetime
import math

import numpy as np
from bson.objectid import ObjectId
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job
from scipy.spatial import cKDTree
from skimage.measure import points_in_poly

from upenncontrast_annotation.server.models.annotation import Annotation

from .materialize import writeCellValues
from .models.registry import DatasetSpatial

DEFAULT_EXCLUDED_TAGS = ("cell",)
DEFAULT_PROPERTY_NAME = "Neighbourhood"
NEIGHBOUR_COUNT_KEY = "neighbours"
CELL_SHAPES = ("polygon", "rectangle")
MAX_REGIONS = 50
# Pseudocount in the enrichment log ratio, so an empty pair is finite.
ENRICHMENT_PSEUDOCOUNT = 1.0


def cellCentroids(datasetId, excludeTags=DEFAULT_EXCLUDED_TAGS,
                  excludeIds=()):
    """(annotation ids [n] str, centroids [n, 2] float64, types [n] object)
    of the dataset's polygon annotations; type None when no tag remains."""
    excluded = set(excludeTags)
    pipeline = [
        {"$match": {
            "datasetId": ObjectId(str(datasetId)),
            "shape": {"$in": list(CELL_SHAPES)},
        }},
        {"$project": {
            "x": {"$avg": "$coordinates.x"},
            "y": {"$avg": "$coordinates.y"},
            "tags": 1,
        }},
        {"$sort": {"_id": 1}},
    ]
    ids, xy, types = [], [], []
    skip = {str(i) for i in excludeIds}
    for document in Annotation().collection.aggregate(pipeline):
        annotationId = str(document["_id"])
        if annotationId in skip or document.get("x") is None:
            continue
        ids.append(annotationId)
        xy.append((float(document["x"]), float(document["y"])))
        cellType = None
        for tag in document.get("tags", []):
            if tag not in excluded:
                cellType = tag
                break
        types.append(cellType)
    return (
        np.array(ids, dtype=object),
        np.array(xy, dtype=np.float64).reshape(-1, 2),
        np.array(types, dtype=object),
    )


def typeIndex(types):
    """(sorted type names, per-cell index or -1 for untyped)."""
    names = sorted({t for t in types if t is not None})
    lookup = {name: i for i, name in enumerate(names)}
    codes = np.array([lookup.get(t, -1) for t in types], dtype=np.int64)
    return names, codes


def neighbourhood(centroids, codes, nTypes, radius):
    """Per-cell neighbour type counts [n, nTypes] and the pair matrix
    [nTypes, nTypes] (observed pairs with type i around type j, symmetric)
    for all pairs closer than `radius`."""
    n = len(centroids)
    counts = np.zeros((n, nTypes), dtype=np.int64)
    pairs = np.zeros((nTypes, nTypes), dtype=np.int64)
    if n < 2 or radius <= 0:
        return counts, pairs
    tree = cKDTree(centroids)
    close = tree.query_pairs(radius, output_type="ndarray")
    if len(close) == 0:
        return counts, pairs
    i, j = close[:, 0], close[:, 1]
    typedJ = codes[j] >= 0
    typedI = codes[i] >= 0
    # Each pair counts once in each direction: j is a neighbour of i and
    # i of j.
    np.add.at(counts, (i[typedJ], codes[j][typedJ]), 1)
    np.add.at(counts, (j[typedI], codes[i][typedI]), 1)
    both = typedI & typedJ
    np.add.at(pairs, (codes[i][both], codes[j][both]), 1)
    np.add.at(pairs, (codes[j][both], codes[i][both]), 1)
    return counts, pairs


def enrichment(pairs):
    """log2((observed + 1) / (expected + 1)) with expected_ij = row_i *
    col_j / total — what the pair counts would be if types were shuffled."""
    total = float(pairs.sum())
    if total == 0:
        return np.zeros_like(pairs, dtype=np.float64)
    rows = pairs.sum(axis=1, keepdims=True).astype(np.float64)
    cols = pairs.sum(axis=0, keepdims=True).astype(np.float64)
    expected = rows @ cols / total
    return np.log2(
        (pairs + ENRICHMENT_PSEUDOCOUNT) / (expected + ENRICHMENT_PSEUDOCOUNT)
    )


def compute(datasetId, radius, excludeTags, propertyId, onProgress):
    """Neighbourhood of every cell; writes the property values and returns
    the enrichment summary to store on the registry."""
    onProgress("centroids", 0, 1)
    ids, centroids, types = cellCentroids(datasetId, excludeTags)
    names, codes = typeIndex(types)
    onProgress("neighbours", 0, 1)
    counts, pairs = neighbourhood(centroids, codes, len(names), radius)
    totals = counts.sum(axis=1)

    def subValuesFor(start, stop):
        chunk = []
        for row in range(start, stop):
            total = int(totals[row])
            values = {NEIGHBOUR_COUNT_KEY: total}
            for column, name in enumerate(names):
                values[name] = (
                    float(counts[row, column]) / total if total else 0.0
                )
            chunk.append(values)
        return chunk

    written = writeCellValues(
        datasetId, propertyId, ids, subValuesFor,
        lambda current, total: onProgress("values", current, total),
    )
    return {
        "radius": radius,
        "excludeTags": list(excludeTags),
        "types": names,
        "counts": [int(v) for v in np.bincount(
            codes[codes >= 0], minlength=len(names)
        )],
        "pairs": pairs.tolist(),
        "matrix": [
            [None if math.isnan(v) else round(float(v), 4) for v in row]
            for row in enrichment(pairs)
        ],
        "cells": int(len(ids)),
        "typed": int((codes >= 0).sum()),
        "written": int(written),
        "propertyId": str(propertyId),
        "computed": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def run(job):
    """Local-job entry point. kwargs: datasetId, radius, excludeTags,
    propertyId."""
    jobModel = Job()
    kwargs = job["kwargs"]
    jobModel.updateJob(
        job, status=JobStatus.RUNNING,
        log="Computing neighbourhoods within %s px...\n" % kwargs["radius"],
    )
    try:
        def onProgress(stage, current, total):
            jobModel.updateJob(
                job, progressCurrent=current, progressTotal=total,
                progressMessage="%s %d / %d" % (stage, current, total),
            )

        datasetId = ObjectId(kwargs["datasetId"])
        result = compute(
            datasetId, float(kwargs["radius"]), tuple(kwargs["excludeTags"]),
            ObjectId(kwargs["propertyId"]), onProgress,
        )
        DatasetSpatial().setNeighbourhood(datasetId, result)
    except Exception as exc:
        jobModel.updateJob(
            job, status=JobStatus.ERROR,
            log="Neighbourhood failed: %s\n" % exc,
        )
        raise
    jobModel.updateJob(
        job, status=JobStatus.SUCCESS,
        log="Wrote neighbourhoods for %d cells (%d types).\n"
            % (result["written"], len(result["types"])),
        otherFields={"spatialResult": result},
    )


# ---- regions ----------------------------------------------------------------

def regionPolygons(datasetId, regionTag=None, regionIds=None):
    """Polygon annotations that are regions: those carrying `regionTag`, or
    the given ids. Returns [{id, name, tags, xy}]."""
    query = {
        "datasetId": ObjectId(str(datasetId)),
        "shape": {"$in": list(CELL_SHAPES)},
    }
    if regionIds is not None:
        query["_id"] = {"$in": [ObjectId(str(i)) for i in regionIds]}
    else:
        query["tags"] = regionTag
    regions = []
    for document in Annotation().find(
        query, fields=["coordinates", "tags", "name"], sort=[("_id", 1)],
        limit=MAX_REGIONS + 1,
    ):
        xy = np.array(
            [[p["x"], p["y"]] for p in document["coordinates"]],
            dtype=np.float64,
        )
        if len(xy) < 3:
            continue
        regions.append({
            "id": str(document["_id"]),
            "name": document.get("name") or str(document["_id"]),
            "tags": list(document.get("tags", [])),
            "xy": xy,
        })
    return regions


def cellsInRegion(region, centroids):
    """Boolean mask of the centroids inside the region polygon."""
    xy = region["xy"]
    inBox = (
        (centroids[:, 0] >= xy[:, 0].min())
        & (centroids[:, 0] <= xy[:, 0].max())
        & (centroids[:, 1] >= xy[:, 1].min())
        & (centroids[:, 1] <= xy[:, 1].max())
    )
    mask = np.zeros(len(centroids), dtype=bool)
    if inBox.any():
        mask[inBox] = points_in_poly(centroids[inBox], xy)
    return mask


def regionSummary(datasetId, regions, excludeTags, store=None, symbols=()):
    """Per region: cells, composition by type and (with a table) mean count
    and fraction expressing per symbol."""
    excludeIds = [region["id"] for region in regions]
    ids, centroids, types = cellCentroids(
        datasetId, excludeTags, excludeIds
    )
    rows = store.rowsForAnnotationIds(ids) if store is not None else None
    result = []
    for region in regions:
        mask = cellsInRegion(region, centroids)
        regionTypes = types[mask]
        composition = {}
        for cellType in regionTypes:
            key = cellType if cellType is not None else "(untyped)"
            composition[key] = composition.get(key, 0) + 1
        entry = {
            "id": region["id"], "name": region["name"],
            "tags": region["tags"], "cells": int(mask.sum()),
            "composition": [
                {"type": key, "count": count}
                for key, count in sorted(
                    composition.items(), key=lambda kv: (-kv[1], kv[0])
                )
            ],
            "expression": [],
        }
        if store is not None and symbols:
            regionRows = rows[mask]
            regionRows = regionRows[regionRows >= 0]
            aggregate = store.aggregate(list(symbols), regionRows)
            entry["expression"] = aggregate["features"]
            entry["rows"] = int(len(regionRows))
        result.append(entry)
    return result
