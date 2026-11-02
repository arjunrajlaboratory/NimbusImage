"""The dataset-wide list endpoints stream their cursor.

`limit=0` asks for every document in a dataset. Built as one list and one
JSON string, property values grew Girder by ~1.6 GiB per 100K documents,
and the 709K-cell Xenium dataset OOM-killed the container. Streamed, Girder
holds only the current pymongo batch and one output chunk of about 500
documents. The Girder test server hands a streamed body back as
a generator of chunks and a serialized one as a single chunk, so more than
one chunk means the response was not materialized.
"""
import json

import pytest

from pytest_girder.assertions import assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

# streamJsonArray flushes about every 500 documents (1000 list entries,
# commas included), so a streamed response has several chunks.
DOCUMENT_COUNT = 2500


def _datasetWithAnnotations(admin, count):
    folder = utilities.createFolder(
        admin, "streamed", upenn_utilities.datasetMetadata
    )
    annotations = Annotation().createMultiple([
        upenn_utilities.getSampleAnnotation(folder["_id"])
        for _ in range(count)
    ])
    return folder, annotations


def _findAll(server, admin, path, datasetId):
    """The response body's chunks for every document in the dataset."""
    resp = server.request(
        path=path,
        method="GET",
        user=admin,
        params={"datasetId": str(datasetId), "limit": 0},
        isJson=False,
    )
    assertStatusOk(resp)
    return list(resp.body)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestListStreaming:
    def testPropertyValuesUnlimitedFindStreams(self, admin, server):
        folder, annotations = _datasetWithAnnotations(admin, DOCUMENT_COUNT)
        AnnotationPropertyValues().appendMultipleValues([
            {
                "datasetId": folder["_id"],
                "annotationId": annotation["_id"],
                "values": {"probe": {"index": index}},
            }
            for index, annotation in enumerate(annotations)
        ])

        chunks = _findAll(
            server, admin, "/annotation_property_values", folder["_id"]
        )

        assert len(chunks) > 1
        values = json.loads(b"".join(chunks))
        assert len(values) == DOCUMENT_COUNT
        assert {value["annotationId"] for value in values} == {
            str(annotation["_id"]) for annotation in annotations
        }
        assert values[0]["datasetId"] == str(folder["_id"])
        assert all(
            "index" in value["values"]["probe"] for value in values
        )

    def testConnectionsUnlimitedFindStreams(self, admin, server):
        folder, annotations = _datasetWithAnnotations(admin, 2)
        parent, child = annotations
        AnnotationConnection().createMultiple([
            upenn_utilities.getSampleConnection(
                parent["_id"], child["_id"], folder["_id"]
            )
            for _ in range(DOCUMENT_COUNT)
        ])

        chunks = _findAll(
            server, admin, "/annotation_connection", folder["_id"]
        )

        assert len(chunks) > 1
        connections = json.loads(b"".join(chunks))
        assert len(connections) == DOCUMENT_COUNT
        assert connections[0]["parentId"] == str(parent["_id"])
        assert connections[0]["childId"] == str(child["_id"])
