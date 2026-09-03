"""Rebuild the expression table from the current cell polygons and the
transcript store (plan §13, SPATIAL_PLUGIN.md "Phase 4").

Every level-0 transcript tile is independent: the polygons intersecting it
are rasterized largest-first into an int32 label image at the image's pixel
size (so a smaller polygon inside a larger one wins), each molecule of a
gene above the quality threshold looks up its label, and the (cell, gene)
pairs are summed into a CSR matrix. The result is written as a new
`spatial.zarr.zip` in the layout `store.py` reads, uploaded into the dataset
folder and registered as the active table; the previous table becomes a
version.

`scope == "dirty"` reassigns only the tiles touched by added, changed or
removed cells (see `staleness`) and carries the rows of every other cell
over from the active table by annotation id.
"""

import datetime
import os
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

import numcodecs
import numpy as np
import scipy.sparse as sp
import zarr
from bson.objectid import ObjectId
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.upload import Upload
from girder.models.user import User
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job
from skimage.draw import polygon as rasterPolygon

from upenncontrast_annotation.server.helpers.annotationRaster import (
    getRasterVersion,
)
from upenncontrast_annotation.server.models.annotation import Annotation

from .models.registry import DatasetSpatial
from .store import (
    SCHEMA_VERSION,
    invalidateStore,
    openStore,
    readStringColumn,
    registryEntry,
)
from .transcripts import openTranscriptStore, parseTransform

SCOPES = ("all", "dirty")
DEFAULT_LABEL = "Recomputed"
CELL_SHAPES = ("polygon", "rectangle")
# Cells with more vertices than this are simplified by stride before
# rasterization; the raster is at image resolution, so nothing is lost.
MAX_VERTICES = 4096
EMBEDDING_COMPONENTS = 50
EMBEDDING_CLUSTERS = 10
MAX_STALENESS_IDS = 10_000


@dataclass
class Cell:
    annotationId: str
    xy: np.ndarray            # (n, 2) image pixels
    tags: list
    bbox: tuple               # minX, minY, maxX, maxY in image pixels
    area: float
    geometryHash: str


def geometryHash(coordinates):
    """A fingerprint of a polygon's vertices, so an edited cell can be told
    from an unedited one without timestamps: vertex count and the sums of
    x, y and x*y, rounded to a hundredth of a pixel. Chosen so Mongo can
    compute the same value with $size/$sum (see `polygonFingerprints`), which
    keeps staleness from downloading 700K coordinate arrays; a moved vertex
    changes at least one sum."""
    xs = [float(point["x"]) for point in coordinates]
    ys = [float(point["y"]) for point in coordinates]
    return fingerprint(
        len(xs), sum(xs), sum(ys), sum(x * y for x, y in zip(xs, ys))
    )


def fingerprint(count, sumX, sumY, sumXY):
    return "%d:%.2f:%.2f:%.2f" % (count, sumX, sumY, sumXY)


def isFingerprint(value):
    return isinstance(value, str) and value.count(":") == 3


def polygonFingerprints(datasetId):
    """{annotation id: fingerprint} for every polygon of the dataset, from
    one aggregation — no coordinates leave Mongo."""
    pipeline = [
        {"$match": {
            "datasetId": ObjectId(str(datasetId)),
            "shape": {"$in": list(CELL_SHAPES)},
        }},
        {"$project": {
            "n": {"$size": "$coordinates"},
            "sx": {"$sum": "$coordinates.x"},
            "sy": {"$sum": "$coordinates.y"},
            "sxy": {"$sum": {"$map": {
                "input": "$coordinates", "as": "p",
                "in": {"$multiply": ["$$p.x", "$$p.y"]},
            }}},
        }},
    ]
    return {
        str(doc["_id"]): fingerprint(
            int(doc["n"]), float(doc["sx"]), float(doc["sy"]),
            float(doc["sxy"]),
        )
        for doc in Annotation().collection.aggregate(pipeline)
    }


def _polygonArea(xy):
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * abs(
        float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
    )


def _rectangleCorners(xy):
    if len(xy) == 2:
        (x0, y0), (x1, y1) = xy
        return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], np.float64)
    return xy


def cellPolygons(datasetId, tags=None):
    """The dataset's cell polygons as `Cell`s, in a stable order. `tags`
    (optional) restricts to annotations carrying all of them."""
    query = {"datasetId": ObjectId(str(datasetId)),
             "shape": {"$in": list(CELL_SHAPES)}}
    if tags:
        query["tags"] = {"$all": list(tags)}
    cells = []
    for document in Annotation().find(
        query, fields=["coordinates", "tags", "shape"], sort=[("_id", 1)],
    ):
        coordinates = document["coordinates"]
        xy = np.array(
            [[p["x"], p["y"]] for p in coordinates], dtype=np.float64
        )
        if document["shape"] == "rectangle":
            xy = _rectangleCorners(xy)
        if len(xy) < 3:
            continue
        if len(xy) > MAX_VERTICES:
            xy = xy[:: int(np.ceil(len(xy) / MAX_VERTICES))]
        cells.append(Cell(
            annotationId=str(document["_id"]),
            xy=xy,
            tags=list(document.get("tags", [])),
            bbox=(float(xy[:, 0].min()), float(xy[:, 1].min()),
                  float(xy[:, 0].max()), float(xy[:, 1].max())),
            area=_polygonArea(xy),
            geometryHash=geometryHash(coordinates),
        ))
    return cells


# ---- staleness --------------------------------------------------------------

_stalenessLock = threading.Lock()
_stalenessCache = OrderedDict()
MAX_STALENESS_CACHE = 32


def staleness(datasetId, store, fileId, cells=None):
    """Added / changed / removed cells of the dataset relative to `store`,
    cached on the dataset's annotation raster version (which bumps on every
    annotation save or delete)."""
    key = (str(datasetId), str(fileId), getRasterVersion(datasetId))
    # A caller-supplied cell list (the job's tag-filtered polygons) is not
    # the endpoint's whole-dataset answer: neither reads nor writes the cache.
    if cells is None:
        with _stalenessLock:
            cached = _stalenessCache.get(key)
            if cached is not None:
                return cached
    hashes = None
    obs = store.root["obs"]
    if "geometry_hash" in obs:
        hashes = dict(zip(
            store.annotationIds.tolist(),
            (str(h) for h in readStringColumn(obs, "geometry_hash")),
        ))
        # Tables written before the fingerprint format (sha1 digests) cannot
        # be compared; treat them as hash-less rather than "all changed".
        if hashes and not any(
            isFingerprint(value) for value in list(hashes.values())[:10]
        ):
            hashes = None
    if cells is not None:
        live = [(cell.annotationId, cell.geometryHash) for cell in cells]
    elif hashes is not None:
        # Fingerprints straight from Mongo: seconds, not a coordinate
        # download (the old sha1 of every vertex cost a minute at 700K).
        live = list(polygonFingerprints(datasetId).items())
    else:
        # Without hashes only membership matters: skip the coordinates,
        # which are most of the bytes of 700K polygons.
        live = [(str(doc["_id"]), None) for doc in Annotation().find(
            {"datasetId": ObjectId(str(datasetId)),
             "shape": {"$in": list(CELL_SHAPES)}},
            fields=["_id"],
        )]
    known = set(store.annotationIds.tolist())
    added, changed = [], []
    liveIds = set()
    for annotationId, geometryHash in live:
        liveIds.add(annotationId)
        if annotationId not in known:
            added.append(annotationId)
        elif hashes is not None and hashes.get(annotationId) != geometryHash:
            changed.append(annotationId)
    removed = sorted(known - liveIds)
    result = {
        "added": added, "changed": changed, "removed": removed,
        "hasGeometryHashes": hashes is not None,
        "cells": len(live), "rows": int(store.nObs),
    }
    if cells is None:
        with _stalenessLock:
            _stalenessCache[key] = result
            while len(_stalenessCache) > MAX_STALENESS_CACHE:
                _stalenessCache.popitem(last=False)
    return result


def summarizeStaleness(result):
    return {
        key: value for key, value in result.items()
        if key not in ("added", "changed", "removed")
    } | {
        "added": len(result["added"]),
        "changed": len(result["changed"]),
        "removed": len(result["removed"]),
        "addedIds": result["added"][:MAX_STALENESS_IDS],
        "changedIds": result["changed"][:MAX_STALENESS_IDS],
        "removedIds": result["removed"][:MAX_STALENESS_IDS],
        "upToDate": not (
            result["added"] or result["changed"] or result["removed"]
        ),
    }


# ---- assignment -------------------------------------------------------------

def tilePixelBounds(transcripts, key):
    """(left, top, right, bottom) in image pixels of a level-0 tile."""
    gx, gy = (int(v) for v in key.split(","))
    size = transcripts.tileMicrons(0) / transcripts.pixelSize
    return gx * size, gy * size, (gx + 1) * size, (gy + 1) * size


def tilesForBoxes(transcripts, boxes):
    """Level-0 tile keys (that exist) intersecting any of the pixel boxes."""
    size = transcripts.tileMicrons(0) / transcripts.pixelSize
    wanted = set()
    for minX, minY, maxX, maxY in boxes:
        for gx in range(int(minX // size), int(maxX // size) + 1):
            for gy in range(int(minY // size), int(maxY // size) + 1):
                wanted.add("%d,%d" % (gx, gy))
    return [key for key in transcripts.tileKeys[0] if key in wanted]


def labelImage(cells, cellIndices, bounds):
    """int32 label image of the tile: 0 = no cell, else cell index + 1.
    Largest polygon first, so the smallest containing polygon wins."""
    left, top, right, bottom = bounds
    height = int(np.ceil(bottom - top)) + 1
    width = int(np.ceil(right - left)) + 1
    labels = np.zeros((height, width), dtype=np.int32)
    order = sorted(cellIndices, key=lambda i: -cells[i].area)
    for index in order:
        xy = cells[index].xy
        rows, cols = rasterPolygon(
            xy[:, 1] - top, xy[:, 0] - left, shape=labels.shape
        )
        labels[rows, cols] = index + 1
    return labels


def assignTile(transcripts, key, cells, cellIndices, minQv, geneToVar):
    """(matrix keys, counts, assigned, considered) for one tile: keys are
    `cell * nVar + var` of the molecules that landed in a cell."""
    tile = transcripts.tile(0, key)
    if tile is None or not cellIndices:
        return None, None, 0, 0
    bounds = tilePixelBounds(transcripts, key)
    labels = labelImage(cells, cellIndices, bounds)
    location = np.asarray(tile["location"][:, :2], dtype=np.float64)
    gene = np.asarray(tile["gene_identity"][:, 0], dtype=np.int64)
    quality = np.asarray(tile["quality_score"][:, 0], dtype=np.float32)
    var = geneToVar[gene]
    keep = (quality >= minQv) & (var >= 0)
    px = location[keep] / transcripts.pixelSize
    var = var[keep]
    col = np.floor(px[:, 0] - bounds[0]).astype(np.int64)
    row = np.floor(px[:, 1] - bounds[1]).astype(np.int64)
    inside = (
        (row >= 0) & (row < labels.shape[0])
        & (col >= 0) & (col < labels.shape[1])
    )
    label = np.zeros(len(row), dtype=np.int32)
    label[inside] = labels[row[inside], col[inside]]
    assigned = label > 0
    nVar = len(_varSymbols(transcripts))
    keys = (label[assigned].astype(np.int64) - 1) * nVar + var[assigned]
    uniqueKeys, counts = np.unique(keys, return_counts=True)
    return uniqueKeys, counts, int(assigned.sum()), int(keep.sum())


_varCache = {}


def _varSymbols(transcripts):
    """Gene symbols in var order (cached per store path): the transcript
    store's genes with control codewords dropped."""
    cacheKey = transcripts.path
    symbols = _varCache.get(cacheKey)
    if symbols is None:
        symbols = [
            name for name, isGene
            in zip(transcripts.geneNames, transcripts.isGene) if isGene
        ]
        _varCache[cacheKey] = symbols
    return symbols


def geneToVarMap(transcripts):
    """gene_identity index -> var column (-1 for control codewords)."""
    mapping = np.full(len(transcripts.geneNames), -1, dtype=np.int64)
    column = 0
    for index, isGene in enumerate(transcripts.isGene):
        if isGene:
            mapping[index] = column
            column += 1
    return mapping


def buildMatrix(keysList, countsList, nCells, nVar):
    if keysList:
        keys = np.concatenate(keysList)
        counts = np.concatenate(countsList).astype(np.float32)
    else:
        keys = np.zeros(0, dtype=np.int64)
        counts = np.zeros(0, dtype=np.float32)
    rows = keys // nVar
    cols = keys % nVar
    # coo -> csr sums duplicates, which is exactly the per-tile merge.
    return sp.coo_matrix((counts, (rows, cols)), shape=(nCells, nVar)).tocsr()


def carriedRows(activeStore, symbols, cellIds):
    """Rows of `cellIds` from the active table, columns aligned to
    `symbols` (a cell without a row is a zero row), as one CSR built with
    fancy row indexing — a per-row loop over 700K cells would be minutes."""
    rows = activeStore.rowsForAnnotationIds(cellIds)
    csr = sp.csc_matrix(
        (activeStore.root["X/data"][:], activeStore.root["X/indices"][:],
         activeStore.root["X/indptr"][:]),
        shape=(activeStore.nObs, activeStore.nVar),
    ).tocsr().astype(np.float32)
    columnOf = {symbol: i for i, symbol in enumerate(symbols)}
    source = [i for i, s in enumerate(activeStore.featureSymbols)
              if s in columnOf]
    target = [columnOf[activeStore.featureSymbols[i]] for i in source]
    aligned = sp.csr_matrix(
        (activeStore.nObs, len(symbols)), dtype=np.float32
    )
    if source:
        selector = sp.csr_matrix(
            (np.ones(len(source), np.float32), (source, target)),
            shape=(activeStore.nVar, len(symbols)),
        )
        aligned = (csr @ selector).tocsr()
    # One extra all-zero row stands in for cells the table does not have.
    withZero = sp.vstack([
        aligned, sp.csr_matrix((1, len(symbols)), dtype=np.float32)
    ]).tocsr()
    picked = np.where(rows >= 0, rows, activeStore.nObs)
    return withZero[picked].tocsr()


# ---- embeddings -------------------------------------------------------------

def embeddings(counts, onProgress=None):
    """normalize -> log1p -> PCA -> UMAP -> k-means. Returns (umap (n, 2)
    float32, cluster labels int32)."""
    from sklearn.cluster import KMeans
    from sklearn.decomposition import TruncatedSVD
    import umap

    total = np.asarray(counts.sum(axis=1)).ravel()
    total[total == 0] = 1
    normalized = sp.diags(100.0 / total) @ counts
    normalized.data = np.log1p(normalized.data)
    components = min(EMBEDDING_COMPONENTS, max(2, min(counts.shape) - 1))
    pcs = TruncatedSVD(n_components=components, random_state=0).fit_transform(
        normalized
    )
    if onProgress:
        onProgress("umap")
    projection = umap.UMAP(random_state=0).fit_transform(pcs)
    if onProgress:
        onProgress("clusters")
    k = min(EMBEDDING_CLUSTERS, max(1, counts.shape[0]))
    labels = KMeans(n_clusters=k, n_init=4, random_state=0).fit_predict(pcs)
    return projection.astype(np.float32), labels.astype(np.int32)


# ---- writing ----------------------------------------------------------------

def _stringArray(group, name, values):
    group.create_dataset(
        name, data=np.array([str(v) for v in values], dtype=object),
        dtype=object, object_codec=numcodecs.VLenUTF8(),
    )
    group[name].attrs.update({
        "encoding-type": "string-array", "encoding-version": "0.2.0",
    })


def _categorical(group, name, values):
    categories = sorted({v for v in values if v is not None})
    index = {c: i for i, c in enumerate(categories)}
    codes = np.array(
        [index.get(v, -1) for v in values], dtype=np.int32
    )
    sub = group.create_group(name)
    sub.attrs.update({
        "encoding-type": "categorical", "encoding-version": "0.2.0",
        "ordered": False,
    })
    sub.create_dataset("codes", data=codes)
    _stringArray(sub, "categories", categories)


def _sparse(root, path, matrix, encoding):
    group = root.create_group(path)
    group.attrs.update({
        "encoding-type": encoding, "encoding-version": "0.1.0",
        "shape": [int(matrix.shape[0]), int(matrix.shape[1])],
    })
    group.create_dataset("data", data=matrix.data.astype(np.float32))
    group.create_dataset("indices", data=matrix.indices.astype(np.int32))
    group.create_dataset("indptr", data=matrix.indptr.astype(np.int64))


def writeStore(path, counts, cells, symbols, cellTypes, provenance,
               projection=None, clusters=None):
    """A spatial.zarr.zip in the AnnData layout `store.py` reads."""
    zipStore = zarr.ZipStore(path, mode="w")
    root = zarr.group(store=zipStore)
    root.attrs.update({
        "encoding-type": "anndata", "encoding-version": "0.1.0",
    })
    csr = counts.tocsr()
    _sparse(root, "X", csr.tocsc(), "csc_matrix")
    root.create_group("layers")
    _sparse(root, "layers/X_csr", csr, "csr_matrix")
    obs = root.create_group("obs")
    columns = ["annotation_id", "cell_index", "geometry_hash", "area",
               "transcript_count"]
    obs.attrs.update({"_index": "_index", "column-order": columns})
    _stringArray(obs, "_index", [str(i) for i in range(len(cells))])
    _stringArray(obs, "annotation_id", [c.annotationId for c in cells])
    obs.create_dataset(
        "cell_index", data=np.arange(len(cells), dtype=np.int64)
    )
    _stringArray(obs, "geometry_hash", [c.geometryHash for c in cells])
    obs.create_dataset(
        "area", data=np.array([c.area for c in cells], dtype=np.float32)
    )
    obs.create_dataset(
        "transcript_count",
        data=np.asarray(csr.sum(axis=1)).ravel().astype(np.int32),
    )
    if cellTypes is not None:
        _categorical(obs, "cell_type", cellTypes)
        columns.append("cell_type")
    if clusters is not None:
        obs.create_dataset("kmeans", data=clusters)
        columns.append("kmeans")
    obs.attrs["column-order"] = columns
    var = root.create_group("var")
    var.attrs.update({"_index": "_index", "column-order": ["feature_type"]})
    _stringArray(var, "_index", symbols)
    _stringArray(var, "feature_type", ["gene"] * len(symbols))
    if projection is not None:
        obsm = root.create_group("obsm")
        obsm.create_dataset("X_umap", data=projection)
    uns = root.create_group("uns")
    uns.attrs["nimbus"] = provenance
    zipStore.close()


# ---- the job ----------------------------------------------------------------

def cellTypeOf(cell, categories):
    """The cell's tag among the previous table's cell-type categories."""
    for tag in cell.tags:
        if tag in categories:
            return tag
    return None


def recompute(datasetId, transcripts, activeStore, scope, minQv, tags,
              withEmbeddings, onProgress, cells=None, activeFileId=None):
    """The whole rebuild, without Girder job bookkeeping. Returns
    (path, cells, symbols, stats)."""
    started = time.time()
    if transcripts.transform is not None:
        raise ValueError(
            "recompute needs the transcripts on this image's pixel grid "
            "(no transform)"
        )
    if cells is None:
        cells = cellPolygons(datasetId, tags)
    symbols = _varSymbols(transcripts)
    geneToVar = geneToVarMap(transcripts)
    nVar = len(symbols)
    onProgress("polygons", 0, 1)

    carried = None
    dirtyIndices = set(range(len(cells)))
    if scope == "dirty":
        if activeStore is None:
            raise ValueError("dirty scope needs an active table")
        stale = staleness(datasetId, activeStore, activeFileId, cells)
        dirtyIds = set(stale["added"]) | set(stale["changed"])
        dirtyIndices = {
            i for i, cell in enumerate(cells) if cell.annotationId in dirtyIds
        }
        boxes = [cells[i].bbox for i in dirtyIndices]
        # A removed cell has no polygon left to locate its molecules; they
        # stay unassigned unless a neighbour grew over them, in which case
        # that neighbour is itself "changed" and its tile is redone.
        # Every cell overlapping a dirty tile is re-assigned (its molecules
        # may have moved to a neighbour), and a re-assigned cell needs every
        # tile IT touches, so the tile set and the touched set grow together
        # until stable — a cell straddling into a quiet tile would otherwise
        # lose the molecules on the far side.
        touched = set(dirtyIndices)
        tileKeys = []
        while True:
            tileKeys = tilesForBoxes(
                transcripts, [cells[i].bbox for i in touched]
            )
            before = len(touched)
            for key in tileKeys:
                bounds = tilePixelBounds(transcripts, key)
                for i, cell in enumerate(cells):
                    if _boxesIntersect(cell.bbox, bounds):
                        touched.add(i)
            if len(touched) == before:
                break
        dirtyIndices = touched
        carriedIndex = [
            i for i in range(len(cells)) if i not in dirtyIndices
        ]
        carried = carriedRows(
            activeStore, symbols, [cells[i].annotationId for i in carriedIndex]
        )
    else:
        tileKeys = list(transcripts.tileKeys[0])

    # Per-tile candidate cells from bboxes.
    boxes = np.array([cell.bbox for cell in cells], dtype=np.float64) \
        if cells else np.zeros((0, 4))
    keysList, countsList = [], []
    assigned = considered = 0
    for number, key in enumerate(tileKeys):
        left, top, right, bottom = tilePixelBounds(transcripts, key)
        if len(cells):
            hits = np.nonzero(
                (boxes[:, 0] <= right) & (boxes[:, 2] >= left)
                & (boxes[:, 1] <= bottom) & (boxes[:, 3] >= top)
            )[0]
            candidates = [int(i) for i in hits if int(i) in dirtyIndices]
        else:
            candidates = []
        keys, counts, tileAssigned, tileConsidered = assignTile(
            transcripts, key, cells, candidates, minQv, geneToVar
        )
        if keys is not None and len(keys):
            keysList.append(keys)
            countsList.append(counts)
        assigned += tileAssigned
        considered += tileConsidered
        onProgress("tiles", number + 1, len(tileKeys))

    counts = buildMatrix(keysList, countsList, len(cells), nVar)
    if carried is not None and carriedIndex:
        # Dirty cells have zero carried rows and carried cells have zero
        # recomputed rows, so the two matrices simply add.
        placement = sp.csr_matrix(
            (np.ones(len(carriedIndex), np.float32),
             (carriedIndex, np.arange(len(carriedIndex)))),
            shape=(len(cells), len(carriedIndex)),
        )
        counts = (counts + placement @ carried).tocsr()

    categories = None
    if activeStore is not None and "cell_type" in activeStore.root["obs"]:
        categories = set(
            str(v) for v in readStringColumn(
                activeStore.root["obs"], "cell_type"
            ) if v is not None
        )
    cellTypes = (
        [cellTypeOf(cell, categories) for cell in cells]
        if categories else None
    )
    projection = clusters = None
    if withEmbeddings and len(cells) > 2:
        onProgress("embeddings", 0, 1)
        projection, clusters = embeddings(
            counts, lambda stage: onProgress(stage, 0, 1)
        )

    provenance = {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": str(datasetId),
        "source": "upenncontrast_spatial.recompute",
        "scope": scope,
        "minQv": minQv,
        "tags": list(tags or []),
        "tiles": len(tileKeys),
        "assigned": assigned,
        "considered": considered,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    fd, path = tempfile.mkstemp(suffix=".zarr.zip", prefix="spatial-")
    os.close(fd)
    os.remove(path)
    writeStore(path, counts, cells, symbols, cellTypes, provenance,
               projection, clusters)
    stats = {
        "nObs": len(cells), "nVar": nVar, "tilesProcessed": len(tileKeys),
        "assigned": assigned, "considered": considered,
        "unassigned": considered - assigned,
        "seconds": round(time.time() - started, 1),
    }
    return path, cells, symbols, stats


def _boxesIntersect(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def run(job):
    """Girder local-job entry point. kwargs: datasetId, userId,
    transcriptsFileId, pixelSize, transform, activeFileId (or None), label,
    scope, minQv, tags, recomputeEmbeddings. Access was checked by the
    endpoint that scheduled the job."""
    jobModel = Job()
    kwargs = job["kwargs"]
    jobModel.updateJob(
        job, status=JobStatus.RUNNING,
        log="Recomputing counts (%s)...\n" % kwargs["scope"],
    )
    try:
        datasetId = ObjectId(kwargs["datasetId"])
        transcripts = openTranscriptStore(
            File().load(kwargs["transcriptsFileId"], force=True),
            kwargs["pixelSize"], parseTransform(kwargs.get("transform")),
        )
        activeStore = None
        if kwargs.get("activeFileId"):
            activeStore = openStore(
                File().load(kwargs["activeFileId"], force=True)
            )

        def onProgress(stage, current, total):
            jobModel.updateJob(
                job, progressCurrent=current, progressTotal=total,
                progressMessage="%s %d / %d" % (stage, current, total),
            )

        path, cells, symbols, stats = recompute(
            datasetId, transcripts, activeStore, kwargs["scope"],
            float(kwargs["minQv"]), kwargs.get("tags"),
            bool(kwargs.get("recomputeEmbeddings")), onProgress,
            activeFileId=kwargs.get("activeFileId"),
        )
        try:
            user = User().load(kwargs["userId"], force=True)
            folder = Folder().load(datasetId, force=True)
            with open(path, "rb") as fh:
                fileDoc = Upload().uploadFromFile(
                    fh, os.path.getsize(path), "spatial.zarr.zip",
                    parentType="folder", parent=folder, user=user,
                    mimeType="application/zip",
                )
        finally:
            os.remove(path)
        from girder.models.item import Item
        item = Item().load(fileDoc["itemId"], force=True)
        invalidateStore(fileDoc["_id"])
        store = openStore(fileDoc)
        entry = registryEntry(datasetId, item, fileDoc, store)
        DatasetSpatial().registerVersion(
            entry, kwargs.get("label") or DEFAULT_LABEL,
            stats.copy(),
        )
        result = {"itemId": str(item["_id"]), **stats}
    except Exception as exc:  # job boundary: recorded, then re-raised
        jobModel.updateJob(
            job, status=JobStatus.ERROR,
            log="Recompute failed: %s\n" % exc,
        )
        raise
    jobModel.updateJob(
        job, status=JobStatus.SUCCESS,
        log="Wrote %d cells x %d genes (%d molecules assigned).\n"
            % (stats["nObs"], stats["nVar"], stats["assigned"]),
        otherFields={"spatialResult": result},
    )
