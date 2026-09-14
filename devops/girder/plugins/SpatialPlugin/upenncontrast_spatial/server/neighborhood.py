"""Neighborhood composition, enrichment and region statistics (plan §15).

Cells are their polygon centroids, computed by Mongo (`$avg` over the
coordinates) so 700K cells cost seconds, not a coordinate download; a cell's
TYPE is its first tag that is not excluded (`cell` by default), the label
Phase 0 made canonical.
"""

import datetime
import math
import threading
from collections import OrderedDict

import numpy as np
from bson.objectid import ObjectId
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job
from scipy.spatial import cKDTree
from skimage.measure import points_in_poly

from upenncontrast_annotation.server.helpers.annotationRaster import (
    getRasterVersion,
)
from upenncontrast_annotation.server.models.annotation import Annotation

from .materialize import writeCellValues
from .models.registry import DatasetSpatial
from .recompute import _rectangleCorners

DEFAULT_EXCLUDED_TAGS = ("cell",)
DEFAULT_PROPERTY_NAME = "Neighborhood"
NEIGHBOR_COUNT_KEY = "neighbors"
CELL_SHAPES = ("polygon", "rectangle")
MAX_REGIONS = 50
# A neighborhood result stays resident while values are written and the
# response matrix is serialized. Refuse allocations above 512 MiB rather than
# risking the whole Girder process; the usual 700K-cell / tens-of-types case is
# comfortably below this ceiling.
MAX_NEIGHBOR_RESULT_BYTES = 512 * 1024 * 1024
# `query_pairs` materializes two platform integers per pair plus temporary
# boolean/index arrays. Five million pairs keeps its working set bounded while
# still allowing dense local neighborhoods.
MAX_NEIGHBOR_PAIRS = 5_000_000
# Pseudocount in the enrichment log ratio, so an empty pair is finite.
ENRICHMENT_PSEUDOCOUNT = 1.0


_centroidLock = threading.Lock()
_centroidCache = OrderedDict()
# Each entry is ~100 MB for 700K cells; two datasets in flight is plenty.
MAX_CENTROID_CACHE = 2


def cellCentroids(datasetId, excludeTags=DEFAULT_EXCLUDED_TAGS,
                  excludeIds=()):
    """(annotation ids [n] str, centroids [n, 2] float64, types [n] object)
    of the dataset's polygon annotations; type None when no tag remains.
    Cached on the annotation raster version (bumped by every polygon edit),
    since the 700K-document pass is what a public region summary pays. The
    excluded ids (a region summary's own polygons) are dropped AFTER the
    cache so every selection does not store its own 100 MB copy."""
    key = (
        str(datasetId), tuple(sorted(excludeTags)),
        getRasterVersion(datasetId),
    )
    with _centroidLock:
        cached = _centroidCache.get(key)
        if cached is not None:
            _centroidCache.move_to_end(key)
    if cached is None:
        cached = _cellCentroids(datasetId, excludeTags)
        with _centroidLock:
            _centroidCache[key] = cached
            while len(_centroidCache) > MAX_CENTROID_CACHE:
                _centroidCache.popitem(last=False)
    if not excludeIds:
        return cached
    ids, centroids, types = cached
    keep = ~np.isin(ids, np.array([str(i) for i in excludeIds], object))
    return ids[keep], centroids[keep], types[keep]


def _cellCentroids(datasetId, excludeTags):
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
    for document in Annotation().collection.aggregate(pipeline):
        annotationId = str(document["_id"])
        if document.get("x") is None:
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


def neighborhood(centroids, codes, nTypes, radius):
    """Per-cell neighbor type counts [n, nTypes] and the pair matrix
    [nTypes, nTypes] (observed pairs with type i around type j, symmetric)
    for all pairs closer than `radius`."""
    n = len(centroids)
    resultBytes = np.dtype(np.int64).itemsize * (
        n * nTypes + nTypes * nTypes
    )
    if resultBytes > MAX_NEIGHBOR_RESULT_BYTES:
        raise ValueError(
            "neighborhood result arrays need %d bytes; limit is %d"
            % (resultBytes, MAX_NEIGHBOR_RESULT_BYTES)
        )
    counts = np.zeros((n, nTypes), dtype=np.int64)
    pairs = np.zeros((nTypes, nTypes), dtype=np.int64)
    if n < 2 or radius <= 0:
        return counts, pairs
    tree = cKDTree(centroids)
    # count_neighbors includes each pair in both directions and every point's
    # self-match. It obtains the size without retaining the pair array.
    pairCount = (int(tree.count_neighbors(tree, radius)) - n) // 2
    if pairCount > MAX_NEIGHBOR_PAIRS:
        raise ValueError(
            "radius produces %d neighbor pairs; limit is %d"
            % (pairCount, MAX_NEIGHBOR_PAIRS)
        )
    close = tree.query_pairs(radius, output_type="ndarray")
    if len(close) == 0:
        return counts, pairs
    i, j = close[:, 0], close[:, 1]
    typedJ = codes[j] >= 0
    typedI = codes[i] >= 0
    # Each pair counts once in each direction: j is a neighbor of i and
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
    """Neighborhood of every cell; writes the property values and returns
    the enrichment summary to store on the registry."""
    onProgress("centroids", 0, 1)
    ids, centroids, types = cellCentroids(datasetId, excludeTags)
    names, codes = typeIndex(types)
    onProgress("neighbors", 0, 1)
    counts, pairs = neighborhood(centroids, codes, len(names), radius)
    totals = counts.sum(axis=1)

    def subValuesFor(start, stop):
        chunk = []
        for row in range(start, stop):
            total = int(totals[row])
            values = {NEIGHBOR_COUNT_KEY: total}
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
        log="Computing neighborhoods within %s px...\n" % kwargs["radius"],
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
        DatasetSpatial().setNeighborhood(datasetId, result)
    except Exception as exc:  # job boundary: recorded, then re-raised
        jobModel.updateJob(
            job, status=JobStatus.ERROR,
            log="Neighborhood failed: %s\n" % exc,
        )
        raise
    jobModel.updateJob(
        job, status=JobStatus.SUCCESS,
        log="Wrote neighborhoods for %d cells (%d types).\n"
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
        query, fields=["coordinates", "tags", "name", "shape"],
        sort=[("_id", 1)],
        limit=MAX_REGIONS + 1,
    ):
        xy = np.array(
            [[p["x"], p["y"]] for p in document["coordinates"]],
            dtype=np.float64,
        )
        if document.get("shape") == "rectangle":
            xy = _rectangleCorners(xy)
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
