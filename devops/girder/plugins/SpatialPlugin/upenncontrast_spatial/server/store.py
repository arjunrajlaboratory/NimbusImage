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

# Non-zero entries read per slice when walking every feature. Neighboring
# columns share compressed chunks (613K values each for the lymph node), so
# a per-column read decompresses each chunk many times over; one slice per
# block of columns reads each chunk once. 8M entries is 64 MB of indices and
# values.
COLUMN_BLOCK_VALUES = 8_000_000
# Values per slice of the registration-time finite check over X/data: 4M
# float64 is 32 MB (plus the boolean mask).
FINITE_CHECK_CHUNK_VALUES = 4_000_000


def _allObjectIds(values):
    """Every value is a 24-character lowercase hex ObjectId string.

    Checks the whole column, vectorized (a strided sample let a bad row
    through registration and fail a later job instead of the upload): a
    value longer than 24 characters survives the U25 cast with its excess,
    and a non-string (None, a number) fails as its text."""
    if not all(isinstance(value, str) for value in values):
        return False
    text = np.asarray(values, dtype="U25")
    if text.size == 0:
        return True
    return bool(
        (np.char.str_len(text) == 24).all()
        and (np.char.strip(text, "0123456789abcdef") == "").all()
    )


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
        # Cheap shape checks (no data scan): a short indptr would make the
        # last columns' reads index past it, a long one misalign them all.
        if len(self._cscIndptr) != self.nVar + 1:
            raise ValueError(
                "X/indptr has %d entries, expected nVar + 1 = %d"
                % (len(self._cscIndptr), self.nVar + 1)
            )
        self._cscIndices = matrix["indices"]
        self._cscData = matrix["data"]

        self._csr = None
        if "layers/X_csr" in self.root:
            self._csr = _requireGroup(self.root, "layers/X_csr", "csr_matrix")
            self._csrIndptr = np.asarray(self._csr["indptr"][:])
            if len(self._csrIndptr) != self.nObs + 1:
                raise ValueError(
                    "layers/X_csr/indptr has %d entries, expected nObs + 1 "
                    "= %d" % (len(self._csrIndptr), self.nObs + 1)
                )

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
        # Symbols are the API's feature identity: a repeated one would make
        # column(symbol) pick an arbitrary duplicate.
        if len(self.featureIndex) != len(self.featureSymbols):
            seen = set()
            repeated = next(
                symbol for symbol in self.featureSymbols
                if symbol in seen or seen.add(symbol)
            )
            raise ValueError(
                "var feature symbols must be unique (%s appears more than "
                "once)" % repeated
            )
        self.featureTypes = (
            [str(t) for t in readStringColumn(var, "feature_type")]
            if "feature_type" in var else None
        )
        if self.featureTypes is not None and (
            len(self.featureTypes) != self.nVar
        ):
            raise ValueError(
                "var.feature_type has %d entries, X has %d features"
                % (len(self.featureTypes), self.nVar)
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
        if not _allObjectIds(annotationIds):
            raise ValueError(
                "obs.annotation_id must hold 24-character annotation ids"
            )
        self.annotationIds = np.asarray(annotationIds, dtype="U24")
        self.sortedOrder = np.argsort(self.annotationIds, kind="stable")
        self.sortedIds = self.annotationIds[self.sortedOrder]
        # The column is the row identity: a repeated id would join one row
        # but be aggregated and written twice.
        repeated = self.sortedIds[1:] == self.sortedIds[:-1]
        if repeated.any():
            raise ValueError(
                "obs.annotation_id must be unique (%s appears more than "
                "once)" % self.sortedIds[1:][repeated][0]
            )

    # ---- features -------------------------------------------------------

    def featureColumn(self, symbol):
        column = self.featureIndex.get(symbol)
        if column is None:
            raise ValueError("unknown feature %r" % symbol)
        return column

    def searchFeatures(self, query, limit):
        """Symbols matching `query` case-insensitively: shortest prefix
        matches first, so "CD3" offers CD3E before CD300A, then substring
        matches alphabetically. Same ranking as TranscriptStore.searchGenes —
        the two pickers search the same panel and must agree."""
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
            symbols = self.featureSymbols
            picked = (
                sorted(prefix, key=lambda i: (len(symbols[i]), symbols[i]))
                + sorted(inner, key=symbols.__getitem__)
            )[:limit]
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

    def iterColumns(self, maxValues=COLUMN_BLOCK_VALUES):
        """Yield (symbol, rows, values) for every feature in column order,
        like `column`, reading runs of consecutive columns with one slice of
        at most `maxValues` entries (a single larger column is read alone)."""
        indptr = self._cscIndptr
        first = 0
        while first < self.nVar:
            last = first + 1
            while (
                last < self.nVar
                and indptr[last + 1] - indptr[first] <= maxValues
            ):
                last += 1
            base, stop = int(indptr[first]), int(indptr[last])
            rows = np.asarray(self._cscIndices[base:stop])
            values = np.asarray(self._cscData[base:stop])
            for j in range(first, last):
                start, end = int(indptr[j]) - base, int(indptr[j + 1]) - base
                yield (
                    self.featureSymbols[j], rows[start:end],
                    values[start:end],
                )
            first = last

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

    def requirePathSafeSymbols(self):
        """Refuse feature symbols containing `.` or `$`. A symbol is the last
        segment of a `["spatial", symbol]` property path, and paths are
        validated and encoded with `.` as the separator, so such a symbol
        would be listed but unusable in filters, axes, color-by and columns.
        Registration runs it; tables already registered keep opening."""
        bad = [s for s in self.featureSymbols if "." in s or "$" in s]
        if bad:
            raise ValueError(
                "feature symbols cannot contain '.' or '$' (%d do, e.g. %s); "
                "rename them before registering"
                % (len(bad), ", ".join(bad[:3]))
            )

    def requireFiniteValues(self, chunkValues=FINITE_CHECK_CHUNK_VALUES):
        """Refuse X holding NaN or infinity: materialize would write them
        into property values, and every JSON response carrying one fails
        (Girder serializes with allow_nan=False). A full pass over X/data,
        so registration runs it rather than every open; memory stays at one
        chunk."""
        for start in range(0, self._cscData.shape[0], chunkValues):
            chunk = np.asarray(self._cscData[start:start + chunkValues])
            if not np.isfinite(chunk).all():
                raise ValueError(
                    "X holds non-finite values (NaN or infinity)"
                )


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


_liveLock = threading.Lock()
_liveMasks = OrderedDict()
MAX_LIVE_MASKS = 8


def liveRowMask(annotationModel, datasetId, store):
    """Boolean per table row: does it still join to a live annotation of
    this dataset? A table outlives edits — a deleted or moved cell keeps its
    row until the table is recomputed — so every read that means "all cells"
    goes through this, never through the raw rows. Cached per store and
    raster version (bumped by every annotation mutation, and rotated every
    120 s for writes seen by another process); ~1.5 s cold at 700K."""
    from upenncontrast_annotation.server.helpers.annotationRaster import (
        getRasterVersion,
    )

    key = (store.path, str(datasetId), getRasterVersion(datasetId))
    with _liveLock:
        mask = _liveMasks.get(key)
        if mask is not None:
            _liveMasks.move_to_end(key)
            return mask
    rows = store.rowsForAnnotationIds(
        annotationModel.listIds(ObjectId(str(datasetId)), {})
    )
    mask = np.zeros(store.nObs, dtype=bool)
    mask[rows[rows >= 0]] = True
    # Shared by every caller for this version: an in-place `&=` on it would
    # silently shrink the population for all later reads.
    mask.setflags(write=False)
    with _liveLock:
        _liveMasks[key] = mask
        while len(_liveMasks) > MAX_LIVE_MASKS:
            _liveMasks.popitem(last=False)
    return mask


def liveAnnotationCount(annotationModel, datasetId, store):
    """How many rows still join to an annotation of this dataset."""
    return int(np.count_nonzero(
        liveRowMask(annotationModel, datasetId, store)
    ))
