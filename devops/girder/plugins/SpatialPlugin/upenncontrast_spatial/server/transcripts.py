"""Reading a dataset's `transcripts.zarr.zip` — the 10x per-molecule store,
kept exactly as shipped because it already is a level-of-detail pyramid
(plan §4, SPATIAL_PLUGIN.md "Phase 3").

    grids/{level}/{gx},{gy}   a tile of 250 * 2**level microns starting at
                              (gx, gy) * that size; sorted by gene in two runs
                              (high quality first, then low), with
                              gene_offset[g] = [lowStart, lowEnd,
                              highStart, highEnd]
    level 0                   location(x, y, z) um, quality_score, id (the
                              transcript's own id; the file carries no cell
                              reference, so molecule -> cell is geometric)
    levels 1..                location, gene_identity, cluster_count
    density/gene              CSR over (gene, row) of a 10 um grid: a heat
                              map per gene

`gene_identity` indexes the root attribute `gene_names`, which mixes genes
and control codewords; only genes are offered for display.

Coordinates leave this module in IMAGE PIXELS: microns / pixelSize, then
through the registration's optional 3x3 transform (an image on another grid,
such as H&E).
"""

import io
import re
import threading
from collections import OrderedDict

import numpy as np
import zarr
from girder.models.file import File
from PIL import Image

MAX_OPEN_TRANSCRIPT_STORES = 4
# Across the maximum number of open stores, cached density grids may retain at
# most this many bytes. Each store gets an equal share, which makes the bound
# deterministic without coupling the stores' individual locks.
MAX_DENSITY_CACHE_BYTES = 512 * 1024 * 1024
# Points per response: 8 genes over a screen's worth of level-0 tiles can
# reach millions; the client budgets before asking, this is the hard stop.
MAX_POINTS_PER_RESPONSE = 2_000_000
MAX_TILES_PER_REQUEST = 256
MAX_GENES_PER_REQUEST = 8
# Xenium's own quality boundary between the two runs of a tile.
HIGH_QUALITY_QV = 20.0

CONTROL_PATTERN = re.compile(
    r"^(Deprecated|Unassigned|NegControl|BLANK|Blank|Intergenic)", re.I
)
TILE_KEY_PATTERN = re.compile(r"^(\d+),(\d+)$")


def parseTransform(value):
    """A 3x3 row-major affine (list of 9 or 3 lists of 3) or None."""
    if value is None:
        return None
    rows = value
    if isinstance(value, list) and len(value) == 9:
        rows = [value[0:3], value[3:6], value[6:9]]
    try:
        matrix = np.asarray(rows, dtype=np.float64)
    except (TypeError, ValueError):
        raise ValueError("transform must be a 3x3 matrix of numbers")
    if matrix.shape != (3, 3) or not np.all(np.isfinite(matrix)):
        raise ValueError("transform must be a 3x3 matrix of finite numbers")
    return matrix


class TranscriptStore:
    def __init__(self, path, pixelSize, transform=None):
        self.path = path
        self.pixelSize = float(pixelSize)
        if not self.pixelSize > 0:
            raise ValueError("pixelSize must be positive")
        self.transform = transform
        self.root = zarr.open_group(zarr.ZipStore(path, mode="r"), mode="r")
        attrs = dict(self.root.attrs)
        if "gene_names" not in attrs or "grids" not in self.root:
            raise ValueError(
                "not a Xenium transcripts store (gene_names/grids missing)"
            )
        self.geneNames = [str(name) for name in attrs["gene_names"]]
        self.geneIndex = {name: i for i, name in enumerate(self.geneNames)}
        self.isGene = np.array(
            [CONTROL_PATTERN.match(name) is None for name in self.geneNames]
        )
        grids = self.root["grids"]
        gridAttrs = dict(grids.attrs)
        self.levels = int(gridAttrs["number_levels"])
        self.gridSizeMicrons = float(gridAttrs["grid_size"][0])
        self.tileKeys = [
            [str(key) for key in keys] for keys in gridAttrs["grid_keys"]
        ]
        self.tileCounts = [
            [int(count) for count in counts]
            for counts in gridAttrs["grid_number_objects"]
        ]
        self.totalPoints = sum(self.tileCounts[0]) if self.tileCounts else 0
        self._density = None
        self._densityCache = OrderedDict()
        self._densityCacheBytes = 0
        self._lock = threading.Lock()

    # ---- schema -----------------------------------------------------------

    def tileMicrons(self, level):
        return self.gridSizeMicrons * (2 ** level)

    def schema(self):
        return {
            "levels": self.levels,
            "gridSizeMicrons": self.gridSizeMicrons,
            "pixelSize": self.pixelSize,
            "transform": (
                None if self.transform is None else self.transform.tolist()
            ),
            "genes": int(self.isGene.sum()),
            "totalPoints": self.totalPoints,
            "tiles": [
                {
                    "level": level,
                    "tileMicrons": self.tileMicrons(level),
                    "tilePixels": self.tileMicrons(level) / self.pixelSize,
                    "keys": self.tileKeys[level],
                    "counts": self.tileCounts[level],
                }
                for level in range(self.levels)
            ],
        }

    def searchGenes(self, query, limit):
        needle = (query or "").strip().lower()
        candidates = [
            name for name, isGene in zip(self.geneNames, self.isGene) if isGene
        ]
        if needle:
            # Shortest prefix matches first, so "cd3" offers CD3E and CD3G
            # before CD300A; substring matches after all of them.
            prefix = sorted(
                (n for n in candidates if n.lower().startswith(needle)),
                key=lambda n: (len(n), n),
            )
            inner = sorted(
                n for n in candidates
                if needle in n.lower() and not n.lower().startswith(needle)
            )
            candidates = prefix + inner
        return candidates[:limit]

    def geneIndices(self, symbols):
        indices = []
        for symbol in symbols:
            index = self.geneIndex.get(symbol)
            if index is None:
                raise ValueError("unknown gene %r" % symbol)
            indices.append(index)
        return indices

    # ---- points -------------------------------------------------------------

    def tile(self, level, key):
        if not 0 <= level < self.levels:
            raise ValueError("level must be in [0, %d)" % self.levels)
        if not TILE_KEY_PATTERN.match(key):
            raise ValueError("tile keys look like 'gx,gy'")
        grid = self.root["grids"][str(level)]
        if key not in grid:
            return None
        return grid[key]

    def tilePoints(self, level, key, geneIndices, minQv):
        """Points of the given genes in one tile: (xy_um[n,2], slot[n] uint8,
        quality[n] or None). Empty arrays for a tile the pyramid does not
        have (no molecules there)."""
        tile = self.tile(level, key)
        if tile is None:
            return self._emptyPoints(level)
        offsets = tile["gene_offset"][:]
        ranges = []
        for slot, geneIndex in enumerate(geneIndices):
            lowStart, lowEnd, highStart, highEnd = (
                int(v) for v in offsets[geneIndex]
            )
            if highEnd > highStart:
                ranges.append((highStart, highEnd, slot))
            if minQv < HIGH_QUALITY_QV and lowEnd > lowStart:
                ranges.append((lowStart, lowEnd, slot))
        if not ranges:
            return self._emptyPoints(level)
        location = tile["location"]
        hasQuality = "quality_score" in tile
        quality = tile["quality_score"] if hasQuality else None
        xys, slots, qvs = [], [], []
        for start, end, slot in ranges:
            xy = np.asarray(location[start:end, :2], dtype=np.float32)
            if hasQuality:
                qv = np.asarray(quality[start:end, 0], dtype=np.float32)
                if minQv > 0:
                    keep = qv >= minQv
                    xy, qv = xy[keep], qv[keep]
                qvs.append(qv)
            xys.append(xy)
            slots.append(np.full(len(xy), slot, dtype=np.uint8))
        return (
            np.concatenate(xys) if xys else np.zeros((0, 2), np.float32),
            np.concatenate(slots) if slots else np.zeros(0, np.uint8),
            np.concatenate(qvs) if qvs else None,
        )

    def _emptyPoints(self, level):
        return (
            np.zeros((0, 2), np.float32), np.zeros(0, np.uint8),
            np.zeros(0, np.float32) if level == 0 else None,
        )

    def toPixels(self, xyMicrons):
        xy = np.asarray(xyMicrons, dtype=np.float64) / self.pixelSize
        if self.transform is None:
            return xy.astype(np.float32)
        homogeneous = np.column_stack([xy, np.ones(len(xy))])
        return (self.transform @ homogeneous.T).T[:, :2].astype(np.float32)

    # ---- density ------------------------------------------------------------

    def _densityGroup(self):
        if "density" not in self.root or "gene" not in self.root["density"]:
            raise ValueError("store has no density/gene grid")
        return self.root["density"]["gene"]

    def densityGrid(self, geneIndices):
        """(rows x cols counts of the given genes summed, bin size in microns,
        alpha reference count) from the 10 um CSR; cached per gene set."""
        key = tuple(sorted(geneIndices))
        with self._lock:
            cached = self._densityCache.get(key)
            if cached is not None:
                self._densityCache.move_to_end(key)
                return cached
        group = self._densityGroup()
        attrs = dict(group.attrs)
        rows, cols = int(attrs["rows"]), int(attrs["cols"])
        binMicrons = float(
            attrs["grid_size"][0] if isinstance(attrs["grid_size"], list)
            else str(attrs["grid_size"]).strip("[]").split(",")[0]
        )
        indptr = group["indptr"]
        indices, data = group["indices"], group["data"]
        # Density tiles are visualization data; float32 halves the retained
        # grid cost while preserving more precision than the rendered alpha.
        grid = np.zeros((rows, cols), dtype=np.float32)
        for geneIndex in key:
            pointers = np.asarray(
                indptr[geneIndex * rows:(geneIndex + 1) * rows + 1]
            )
            start, end = int(pointers[0]), int(pointers[-1])
            if end <= start:
                continue
            rowIds = np.repeat(np.arange(rows), np.diff(pointers))
            np.add.at(
                grid, (rowIds, np.asarray(indices[start:end])),
                np.asarray(data[start:end], dtype=np.float32),
            )
        # Alpha reference: the 99.5th percentile of the occupied bins, not
        # the maximum — a single hot bin would otherwise flatten the rest.
        occupied = grid[grid > 0]
        reference = (
            float(np.percentile(occupied, 99.5)) if occupied.size else 0.0
        )
        result = (grid, binMicrons, reference)
        with self._lock:
            previous = self._densityCache.pop(key, None)
            if previous is not None:
                self._densityCacheBytes -= previous[0].nbytes
            self._densityCache[key] = result
            self._densityCacheBytes += grid.nbytes
            budget = MAX_DENSITY_CACHE_BYTES // MAX_OPEN_TRANSCRIPT_STORES
            while self._densityCache and self._densityCacheBytes > budget:
                _, evicted = self._densityCache.popitem(last=False)
                self._densityCacheBytes -= evicted[0].nbytes
        return result

    def densityTile(self, geneIndices, color, sizeX, sizeY, tileSize,
                    maxLevel, level, x, y):
        """PNG bytes of one tile of the density heat map, on the same tile
        pyramid the annotation overview uses (scale = 2 ** (level - maxLevel);
        tile (x, y) covers image pixels [x, x + 1) * tileSize / scale)."""
        if self.transform is not None:
            raise ValueError(
                "density tiles are only rendered for images on the "
                "transcripts' own pixel grid (no transform)"
            )
        grid, binMicrons, reference = self.densityGrid(geneIndices)
        scale = 2.0 ** (level - maxLevel)
        binPixels = binMicrons / self.pixelSize
        left = x * tileSize / scale
        top = y * tileSize / scale
        # Image pixel coordinate of each output pixel, then the bin it is in.
        px = left + (np.arange(tileSize) + 0.5) / scale
        py = top + (np.arange(tileSize) + 0.5) / scale
        colIdx = np.floor(px / binPixels).astype(np.int64)
        rowIdx = np.floor(py / binPixels).astype(np.int64)
        inside = (
            (px >= 0) & (px < sizeX) & (colIdx >= 0) & (colIdx < grid.shape[1])
        )
        insideY = (
            (py >= 0) & (py < sizeY) & (rowIdx >= 0) & (rowIdx < grid.shape[0])
        )
        values = np.zeros((tileSize, tileSize), dtype=np.float64)
        if inside.any() and insideY.any():
            sub = grid[np.ix_(rowIdx[insideY], colIdx[inside])]
            values[np.ix_(insideY, inside)] = sub
        # Square root of the count relative to the reference: a ubiquitous
        # gene still shows its gradient instead of a flat saturated sheet.
        alpha = np.zeros_like(values)
        if reference > 0:
            alpha = np.sqrt(np.clip(values / reference, 0, 1))
        rgba = np.zeros((tileSize, tileSize, 4), dtype=np.uint8)
        rgba[..., 0], rgba[..., 1], rgba[..., 2] = color
        rgba[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
        output = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(output, format="PNG")
        return output.getvalue()


def encodePoints(xyPixels, slots, quality):
    """The binary body of the points endpoint:
        uint32 n, uint8 hasQuality,
        float32[n*2] x,y (image pixels), uint8[n] gene slot,
        then when hasQuality (level 0): float32[n] quality.
    Little-endian throughout; the client decodes with typed arrays."""
    n = np.uint32(len(xyPixels))
    hasLevel0 = quality is not None
    parts = [
        n.astype("<u4").tobytes(),
        np.uint8(1 if hasLevel0 else 0).tobytes(),
        np.ascontiguousarray(xyPixels, dtype="<f4").tobytes(),
        np.ascontiguousarray(slots, dtype=np.uint8).tobytes(),
    ]
    if hasLevel0:
        parts.append(np.ascontiguousarray(quality, dtype="<f4").tobytes())
    return b"".join(parts)


_lock = threading.Lock()
_stores = OrderedDict()


def openTranscriptStore(fileDoc, pixelSize, transform):
    key = (str(fileDoc["_id"]), float(pixelSize),
           None if transform is None else tuple(np.asarray(transform).ravel()))
    with _lock:
        store = _stores.get(key)
        if store is not None:
            _stores.move_to_end(key)
            return store
    store = TranscriptStore(
        File().getLocalFilePath(fileDoc), pixelSize, transform
    )
    with _lock:
        _stores[key] = store
        while len(_stores) > MAX_OPEN_TRANSCRIPT_STORES:
            _stores.popitem(last=False)
    return store


def invalidateTranscriptStore(fileId):
    with _lock:
        for key in [k for k in _stores if k[0] == str(fileId)]:
            _stores.pop(key, None)
