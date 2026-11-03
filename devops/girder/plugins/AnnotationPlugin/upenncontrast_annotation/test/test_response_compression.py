"""API responses are zstd-compressed by Girder when the client accepts zstd
(server/helpers/compression.py)."""
import io
import json

import pytest

from girder.models.upload import Upload
from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.helpers.compression import (
    _zstdCompress,
    zstd,
)
from upenncontrast_annotation.server.models.annotation import Annotation

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities
from .test_export import createDatasetWithData
from .test_raster import requestTile

# Several raw Mongo batches, so the streamed list arrives in many chunks.
ANNOTATION_COUNT = 2500

# What current Chrome and Firefox send over HTTPS.
BROWSER_ACCEPT_ENCODING = "gzip, deflate, br, zstd"


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
    def testStreamedListIsCompressed(self, admin, server, dataset):
        _, plain = _listAnnotations(server, admin, dataset["_id"])
        resp, body = _listAnnotations(
            server, admin, dataset["_id"], BROWSER_ACCEPT_ENCODING
        )

        assert resp.headers["Content-Encoding"] == "zstd"
        assert "Accept-Encoding" in resp.headers["Vary"]
        assert len(body) < len(plain) / 3
        assert zstd.decompress(body) == plain
        assert len(json.loads(plain)) == ANNOTATION_COUNT

    def testNoAcceptEncodingIsUncompressed(self, admin, server, dataset):
        resp, body = _listAnnotations(server, admin, dataset["_id"])

        assert "Content-Encoding" not in resp.headers
        assert len(json.loads(body)) == ANNOTATION_COUNT

    # No gzip fallback, and never CherryPy's 406 for an unmet encoding.
    @pytest.mark.parametrize(
        "acceptEncoding",
        ["gzip, deflate, br", "br", "identity", "gzip, zstd;q=0"],
    )
    def testZstdNotAcceptedIsUncompressed(
        self, admin, server, dataset, acceptEncoding
    ):
        resp, body = _listAnnotations(
            server, admin, dataset["_id"], acceptEncoding
        )

        assert "Content-Encoding" not in resp.headers
        assert "Accept-Encoding" in resp.headers["Vary"]
        assert len(json.loads(body)) == ANNOTATION_COUNT

    def testMalformedAcceptEncodingIsUncompressedNot400(
        self, admin, server, dataset
    ):
        # CherryPy raises a 400 for a bad q-value, after the handler ran.
        resp, body = _listAnnotations(
            server, admin, dataset["_id"], "gzip;q=x, zstd"
        )

        assert "Content-Encoding" not in resp.headers
        assert len(json.loads(body)) == ANNOTATION_COUNT

    def testBufferedJsonIsCompressed(self, server):
        def version(headers):
            resp = server.request(
                path="/system/version",
                additionalHeaders=headers,
                isJson=False,
            )
            assertStatusOk(resp)
            return resp, b"".join(resp.body)

        _, plain = version([])
        resp, body = version([("Accept-Encoding", "ZSTD")])

        assert resp.headers["Content-Encoding"] == "zstd"
        assert int(resp.headers["Content-Length"]) == len(body)
        assert zstd.decompress(body) == plain

    def testJsonFileDownload(self, admin, server, fsAssetstore):
        # The download streams with the uncompressed Content-Length preset.
        folder = utilities.createFolder(
            admin, "compressed_file", upenn_utilities.datasetMetadata
        )
        data = json.dumps([{"value": i} for i in range(2000)]).encode()
        upload = Upload().uploadFromFile(
            io.BytesIO(data), len(data), "values.json", "folder", folder,
            user=admin, mimeType="application/json",
        )

        def download(headers):
            resp = server.request(
                path=f"/file/{upload['_id']}/download",
                user=admin,
                additionalHeaders=[
                    ("Accept-Encoding", BROWSER_ACCEPT_ENCODING), *headers
                ],
                isJson=False,
            )
            return resp, b"".join(resp.body)

        resp, body = download([])
        assertStatusOk(resp)
        assert resp.headers["Content-Encoding"] == "zstd"
        assert "Content-Length" not in resp.headers
        assert zstd.decompress(body) == data

        resp, body = download([("Range", "bytes=0-9")])
        assertStatus(resp, 206)
        assert "Content-Encoding" not in resp.headers
        assert body == data[:10]

    def testCsvExportIsCompressed(self, admin, server):
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
        resp, body = export([("Accept-Encoding", BROWSER_ACCEPT_ENCODING)])

        assert resp.headers["Content-Encoding"] == "zstd"
        assert zstd.decompress(body) == plain
        assert len(plain.decode().splitlines()) == 3

    def testPngTileIsNotCompressed(self, admin, server):
        folder = utilities.createFolder(
            admin, "compressed_tile", upenn_utilities.datasetMetadata
        )
        resp = requestTile(
            server,
            folder,
            user=admin,
            additionalHeaders=[("Accept-Encoding", BROWSER_ACCEPT_ENCODING)],
        )

        assertStatusOk(resp)
        assert resp.headers["Content-Type"].startswith("image/png")
        assert "Content-Encoding" not in resp.headers


def testClosingCompressedBodyClosesEndpointBody():
    # Streaming endpoints stop prefetch threads and close cursors when
    # their generator is closed; CherryPy only closes the wrapper.
    closed = []

    def endpointBody():
        try:
            for _ in range(10):
                yield b"[]" * 1000
        finally:
            closed.append(True)

    # Something else still holds the endpoint's generator, as CherryPy's
    # encode tool does, so dropping it alone wouldn't finalize it.
    body = endpointBody()
    compressed = _zstdCompress(body, 2)
    next(compressed)
    compressed.close()

    assert closed == [True]
