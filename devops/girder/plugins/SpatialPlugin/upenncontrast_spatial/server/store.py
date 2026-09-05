"""Reading a dataset's ``spatial.zarr.zip`` store.

The store is written by ``anndata`` (zarr v2, AnnData encodings) and read
here with plain ``zarr``: the counts matrix as CSC (``X``, one contiguous
slice per feature) and CSR (``layers/X_csr``, one slice per cell), the
``obs`` table with ``annotation_id`` joining each row to a NimbusImage cell
annotation, and the ``var`` table naming the features.

Rows are joined to annotations without touching the annotation documents:
``obs.annotation_id`` is the only key. Annotation → row is a ``searchsorted``
over a sorted copy of that column, built once per open store and kept in a
small LRU keyed by the Girder file id (SPATIAL_PLUGIN.md, "Row identity").
"""

import re
import threading
from collections import OrderedDict

import numpy as np
import zarr
from bson.objectid import ObjectId
from girder.models.file import File

SCHEMA_VERSION = 1

# Open stores kept per process. Opening a zip store is cheap; sorting 700K
# annotation ids and indexing 4,600 feature symbols is not, so a handful of
# datasets stay open.
MAX_OPEN_STORES = 8

OBJECT_ID_PATTERN = re.compile(r"^[0-9a-f]{24}$")


def readStringColumn(group, name):
    """One string column of an AnnData ``obs``/``var`` group as an object
    array, whatever encoding anndata chose for it: a plain ``string-array``,
    a ``nullable-string-array`` group (``values`` + ``mask``), or a
    ``categorical`` group (``codes`` + ``categories``). Missing entries are
    None."""
    if name not in group:
        raise ValueError("store has no column %r" % name)
    node = group[name]
    if isinstance(node, zarr.Group):
        encoding = node.attrs.get("encoding-type")
        if encoding == "categorical":
            codes = np.asarray(node["codes"][:])
            categories = np.asarray(node["categories"][:], dtype=object)
            values = np.empty(len(codes), dtype=object)
            valid = codes >= 0
            values[valid] = categories[codes[valid]]
            values[~valid] = None
            return values
        if encoding == "nullable-string-array":
            values = np.asarray(node["values"][:], dtype=object)
            values[np.asarray(node["mask"][:], dtype=bool)] = None
            return values
        raise ValueError(
            "unsupported encoding %r for column %r" % (encoding, name)
        )
    return np.asarray(node[:], dtype=object)


def _requireGroup(root, path, encoding=None):
    if path not in root:
        raise ValueError("store is missing %r" % path)
    node = root[path]
    if encoding is not None and node.attrs.get("encoding-type") != encoding:
        raise ValueError(
            "%r must be a %s (encoding-type is %r)"
            % (path, encoding, node.attrs.get("encoding-type"))
        )
    return node


class SpatialStore:
    """An open store plus the indices the endpoints need."""

    def __init__(self, path):
        self.path = path
        self.root = zarr.open_group(zarr.ZipStore(path, mode="r"), mode="r")

        matrix = _requireGroup(self.root, "X", "csc_matrix")
        self.nObs, self.nVar = (int(n) for n in matrix.attrs["shape"])
        # indptr is nVar + 1 ints: small, and every column read needs it.
        self._cscIndptr = np.asarray(matrix["indptr"][:])
        self._cscIndices = matrix["indices"]
        self._cscData = matrix["data"]

        self._csr = None
        if "layers/X_csr" in self.root:
            self._csr = _requireGroup(self.root, "layers/X_csr", "csr_matrix")
            self._csrIndptr = np.asarray(self._csr["indptr"][:])

        var = _requireGroup(self.root, "var")
        symbols = readStringColumn(var, var.attrs.get("_index", "_index"))
        if len(symbols) != self.nVar:
            raise ValueError(
                "var has %d features, X has %d" % (len(symbols), self.nVar)
            )
        self.featureSymbols = [str(symbol) for symbol in symbols]
        self._lowerSymbols = np.array(
            [symbol.lower() for symbol in self.featureSymbols], dtype=object
        )
        self.featureIndex = {
            symbol: index for index, symbol in enumerate(self.featureSymbols)
        }
        self.featureTypes = (
            [str(t) for t in readStringColumn(var, "feature_type")]
            if "feature_type" in var else None
        )

        obs = _requireGroup(self.root, "obs")
        self.obsColumns = [
            name for name in obs.keys()
            if name != obs.attrs.get("_index", "_index")
        ]
        annotationIds = readStringColumn(obs, "annotation_id")
        if len(annotationIds) != self.nObs:
            raise ValueError(
                "obs.annotation_id has %d rows, X has %d"
                % (len(annotationIds), self.nObs)
            )
        if self.nObs and not all(
            isinstance(value, str) and OBJECT_ID_PATTERN.match(value)
            for value in annotationIds[:: max(1, self.nObs // 1000)]
        ):
            raise ValueError(
                "obs.annotation_id must hold 24-character annotation ids"
            )
        self.annotationIds = np.asarray(annotationIds, dtype="U24")
        self.sortedOrder = np.argsort(self.annotationIds, kind="stable")
        self.sortedIds = self.annotationIds[self.sortedOrder]

    # ---- features -------------------------------------------------------

    def featureColumn(self, symbol):
        column = self.featureIndex.get(symbol)
        if column is None:
            raise ValueError("unknown feature %r" % symbol)
        return column

    def searchFeatures(self, query, limit):
        """Symbols matching `query` case-insensitively, prefix matches first,
        each group alphabetical."""
        needle = (query or "").strip().lower()
        if not needle:
            picked = list(range(min(limit, self.nVar)))
        else:
            prefix = [
                index for index, symbol in enumerate(self._lowerSymbols)
                if symbol.startswith(needle)
            ]
            inner = [
                index for index, symbol in enumerate(self._lowerSymbols)
                if needle in symbol and not symbol.startswith(needle)
            ]
            key = self.featureSymbols.__getitem__
            picked = (sorted(prefix, key=key) + sorted(inner, key=key))[:limit]
        return [self.featureInfo(index) for index in picked]

    def featureInfo(self, index):
        return {
            "symbol": self.featureSymbols[index],
            "featureType": (
                self.featureTypes[index] if self.featureTypes else None
            ),
        }

    # ---- reads ----------------------------------------------------------

    def column(self, symbol):
        """(rows, values) of the non-zero entries of one feature; rows are
        ascending (CSC invariant), which the chunked writers rely on."""
        j = self.featureColumn(symbol)
        start, stop = int(self._cscIndptr[j]), int(self._cscIndptr[j + 1])
        return (
            np.asarray(self._cscIndices[start:stop]),
            np.asarray(self._cscData[start:stop]),
        )

    def row(self, rowIndex):
        """{symbol: value} of one cell's non-zero entries."""
        if self._csr is None:
            raise ValueError(
                "store has no cell-major layer (layers/X_csr); rebuild it "
                "with the import script to read single cells"
            )
        start = int(self._csrIndptr[rowIndex])
        stop = int(self._csrIndptr[rowIndex + 1])
        columns = np.asarray(self._csr["indices"][start:stop])
        values = np.asarray(self._csr["data"][start:stop])
        return {
            self.featureSymbols[int(column)]: numberFromNumpy(value)
            for column, value in zip(columns, values)
        }

    # ---- rows <-> annotations ------------------------------------------

    def rowsForAnnotationIds(self, annotationIds):
        """Row index per id, -1 where the id has no row."""
        ids = np.asarray(list(annotationIds), dtype="U24")
        if len(ids) == 0 or self.nObs == 0:
            return np.full(len(ids), -1, dtype=np.int64)
        positions = np.searchsorted(self.sortedIds, ids)
        positions = np.clip(positions, 0, len(self.sortedIds) - 1)
        found = self.sortedIds[positions] == ids
        return np.where(found, self.sortedOrder[positions], -1)

    def aggregate(self, symbols, rows=None):
        """Per-feature mean (zeros included) and fraction of cells with a
        non-zero count, over `rows` (None = every row)."""
        if rows is None:
            total = self.nObs
            selected = None
        else:
            total = int(len(rows))
            selected = np.zeros(self.nObs, dtype=bool)
            selected[rows] = True
        results = []
        for symbol in symbols:
            columnRows, values = self.column(symbol)
            if selected is not None:
                values = values[selected[columnRows]]
            expressing = int(np.count_nonzero(values))
            results.append({
                "symbol": symbol,
                "mean": float(values.sum()) / total if total else None,
                "fractionExpressing": expressing / total if total else None,
                "expressing": expressing,
            })
        return {"total": total, "features": results}


def numberFromNumpy(value):
    """A JSON-friendly number: integral floats (counts) come back as int."""
    number = float(value)
    return int(number) if number.is_integer() else number


_lock = threading.Lock()
_stores = OrderedDict()


def openStore(fileDoc):
    """The cached SpatialStore for a Girder file document."""
    key = str(fileDoc["_id"])
    with _lock:
        store = _stores.get(key)
        if store is not None:
            _stores.move_to_end(key)
            return store
    # Open outside the lock: validation can take a moment on a big store.
    store = SpatialStore(File().getLocalFilePath(fileDoc))
    with _lock:
        _stores[key] = store
        while len(_stores) > MAX_OPEN_STORES:
            _stores.popitem(last=False)
    return store


def invalidateStore(fileId):
    with _lock:
        _stores.pop(str(fileId), None)


def registryEntry(datasetId, item, fileDoc, store):
    """The document `DatasetSpatial` records for a validated store."""
    return {
        "datasetId": datasetId,
        "itemId": item["_id"],
        "fileId": fileDoc["_id"],
        "schemaVersion": SCHEMA_VERSION,
        "nObs": store.nObs,
        "nVar": store.nVar,
        "obsColumns": store.obsColumns,
    }


def liveAnnotationCount(annotationModel, datasetId, store):
    """How many rows still join to an annotation of this dataset."""
    living = annotationModel.listIds(ObjectId(str(datasetId)), {})
    return int(np.count_nonzero(store.rowsForAnnotationIds(living) >= 0))
