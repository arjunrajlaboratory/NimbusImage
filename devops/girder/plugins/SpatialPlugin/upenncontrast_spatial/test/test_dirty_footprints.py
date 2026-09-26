from pathlib import Path

import numpy as np
from bson import ObjectId

from upenncontrast_spatial.server import recompute as r
from upenncontrast_spatial.server.store import SpatialStore
from upenncontrast_spatial.server.transcripts import TranscriptStore
from .test_transcripts import buildTranscriptsZip, PIXEL_SIZE


def cell(identifier, bounds):
    x0, y0, x1, y1 = bounds
    xy = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) / PIXEL_SIZE
    return r.Cell(identifier, xy, ['cell'], (
        xy[:, 0].min(), xy[:, 1].min(), xy[:, 0].max(), xy[:, 1].max(),
    ), r._polygonArea(xy), r.geometryHash([
        dict(x=x, y=y) for x, y in xy
    ]))


def testDirtyRecomputeIncludesPreviousFootprint(tmp_path, monkeypatch):
    buildTranscriptsZip(str(tmp_path / 'transcripts.zip'))
    transcripts = TranscriptStore(
        str(tmp_path / 'transcripts.zip'), PIXEL_SIZE,
    )
    original = [cell(str(ObjectId()), (0, 0, 60, 40)),
                cell(str(ObjectId()), (5, 15, 15, 25))]
    monkeypatch.setattr(r, 'getRasterVersion', lambda *_: 0)
    paths = []

    def rebuild(cells, active=None, scope='all'):
        path, *_ = r.recompute(
            'review', transcripts, active, scope, 20, None, False,
            lambda *args: None, cells=cells, activeFileId='review-file',
        )
        paths.append(path)
        return SpatialStore(path)

    try:
        active = rebuild(original)
        moved = [original[0], cell(original[1].annotationId,
                                   (295, 5, 305, 15))]
        dirty = rebuild(moved, active, 'dirty')
        full = rebuild(moved, active)
        assert dirty.row(0) == full.row(0) == {'CD3E': 1}
        # Removing the inner cell also frees its previously occupied tile.
        deleted = rebuild(original[:1], active, 'dirty')
        assert deleted.row(0) == {'CD3E': 1}
        # Legacy tables without previous footprints must rebuild every tile.
        monkeypatch.setattr(active, 'root', {'obs': active.root['obs']})
        legacy = rebuild(moved, active, 'dirty')
        assert legacy.row(0) == full.row(0)
    finally:
        for path in paths:
            Path(path).unlink()
