"""API responses are gzipped by Girder when the client accepts gzip
(server/helpers/compression.py)."""
import gzip
import json

import pytest

from pytest_girder.assertions import assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities
from .test_export import createDatasetWithData
from .test_raster import requestTile

# Several raw Mongo batches, so the streamed list arrives in many chunks.
ANNOTATION_COUNT = 2500


def _listAnnotations(server, admin, datasetId, acceptEncoding=None):
    headers = []
    if acceptEncoding is not None:
        headers.append(("Accept-Encoding", acceptEncoding))
    resp = server.request(
        path="/upenn_annotation",
        method="GET",
        user=admin,
        params={"datasetId": str(datasetId), "limit": 0},
        additionalHeaders=headers,
        isJson=False,
    )
    assertStatusOk(resp)
    return resp, b"".join(resp.body)


@pytest.fixture
def dataset(admin):
    folder = utilities.createFolder(
        admin, "compressed", upenn_utilities.datasetMetadata
    )
    Annotation().createMultiple([
        upenn_utilities.getSampleAnnotation(folder["_id"])
        for _ in range(ANNOTATION_COUNT)
    ])
    return folder


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestResponseCompression:
    def testStreamedListIsGzipped(self, admin, server, dataset):
        _, plain = _listAnnotations(server, admin, dataset["_id"])
        resp, body = _listAnnotations(
            server, admin, dataset["_id"], "gzip, deflate, br, zstd"
        )

        assert resp.headers["Content-Encoding"] == "gzip"
        assert "Accept-Encoding" in resp.headers["Vary"]
        assert len(body) < len(plain) / 3
        assert gzip.decompress(body) == plain
        assert len(json.loads(plain)) == ANNOTATION_COUNT

    def testNoAcceptEncodingIsUncompressed(self, admin, server, dataset):
        resp, body = _listAnnotations(server, admin, dataset["_id"])

        assert "Content-Encoding" not in resp.headers
        assert len(json.loads(body)) == ANNOTATION_COUNT

    @pytest.mark.parametrize("acceptEncoding", ["br", "gzip;q=0"])
    def testGzipNotAcceptedIsUncompressedNot406(
        self, admin, server, dataset, acceptEncoding
    ):
        # CherryPy's own gzip tool answers 406 to "br" alone.
        resp, body = _listAnnotations(
            server, admin, dataset["_id"], acceptEncoding
        )

        assert "Content-Encoding" not in resp.headers
        assert "Accept-Encoding" in resp.headers["Vary"]
        assert len(json.loads(body)) == ANNOTATION_COUNT

    def testCsvExportIsGzipped(self, admin, server):
        datasetFolder, _, _ = createDatasetWithData(admin)

        def export(headers):
            resp = server.request(
                path="/export/csv",
                method="POST",
                user=admin,
                body=json.dumps({
                    "datasetId": str(datasetFolder["_id"]),
                    "propertyPaths": [],
                }),
                type="application/json",
                additionalHeaders=headers,
                isJson=False,
            )
            assertStatusOk(resp)
            return resp, b"".join(resp.body)

        _, plain = export([])
        resp, body = export([("Accept-Encoding", "gzip")])

        assert resp.headers["Content-Encoding"] == "gzip"
        assert gzip.decompress(body) == plain
        assert len(plain.decode().splitlines()) == 3

    def testPngTileIsNotCompressed(self, admin, server):
        folder = utilities.createFolder(
            admin, "compressed_tile", upenn_utilities.datasetMetadata
        )
        resp = requestTile(
            server,
            folder,
            user=admin,
            additionalHeaders=[("Accept-Encoding", "gzip")],
        )

        assertStatusOk(resp)
        assert resp.headers["Content-Type"].startswith("image/png")
        assert "Content-Encoding" not in resp.headers
