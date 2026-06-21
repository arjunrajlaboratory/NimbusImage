import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValuesBatch:
    """POST /annotation_property_values/batch — values for a set of ids."""

    def _makeDatasetWithValues(self, admin, valuesById, name="test_dataset"):
        folder = utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )
        ids = []
        for values in valuesById:
            annotation = Annotation().create(
                upenn_utilities.getSampleAnnotation(folder["_id"])
            )
            AnnotationPropertyValues().appendValues(
                values, annotation["_id"], folder["_id"]
            )
            ids.append(str(annotation["_id"]))
        return folder, ids

    def _batch(self, server, user, body):
        return server.request(
            path="/annotation_property_values/batch",
            method="POST",
            user=user,
            body=json.dumps(body),
            type="application/json",
        )

    def testReturnsValuesForRequestedIds(self, admin, server):
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": 10}, {"propA": 20}, {"propA": 30}],
        )
        resp = self._batch(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "annotationIds": ids[:2]},
        )
        assertStatusOk(resp)
        byId = {d["annotationId"]: d["values"] for d in resp.json}
        assert byId == {ids[0]: {"propA": 10}, ids[1]: {"propA": 20}}

    def testProjectsRequestedPaths(self, admin, server):
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": {"sub0": 5}, "propB": 3}],
        )
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "annotationIds": ids,
                "propertyPaths": [["propA"]],
            },
        )
        assertStatusOk(resp)
        assert len(resp.json) == 1
        values = resp.json[0]["values"]
        assert values == {"propA": {"sub0": 5}}
        assert "propB" not in values

    def testEmptyIdsReturnsEmpty(self, admin, server):
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._batch(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "annotationIds": []},
        )
        assertStatusOk(resp)
        assert resp.json == []

    def testExcludesOtherDatasets(self, admin, server):
        folderA, idsA = self._makeDatasetWithValues(
            admin, [{"propA": 1}], name="dataset_a"
        )
        folderB, idsB = self._makeDatasetWithValues(
            admin, [{"propA": 2}], name="dataset_b"
        )
        # Request dataset A but pass an id that belongs to dataset B.
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": str(folderA["_id"]),
                "annotationIds": idsA + idsB,
            },
        )
        assertStatusOk(resp)
        returned = {d["annotationId"] for d in resp.json}
        assert returned == set(idsA)
        assert idsB[0] not in returned

    def testInvalidDatasetReturnsError(self, admin, server):
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": "012345678901234567890123",
                "annotationIds": [],
            },
        )
        assertStatus(resp, 400)
