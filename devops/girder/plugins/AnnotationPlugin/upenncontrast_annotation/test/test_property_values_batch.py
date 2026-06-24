import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.helpers import validation
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

    def testConsistentDocShapeWithAndWithoutPaths(self, admin, server):
        # The returned docs must carry the same minimal field set
        # (annotationId + values) whether or not propertyPaths is given, so a
        # consumer can key on them uniformly. datasetId must not leak either.
        folder, ids = self._makeDatasetWithValues(
            admin, [{"propA": 1, "propB": 2}]
        )
        full = self._batch(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "annotationIds": ids},
        )
        projected = self._batch(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "annotationIds": ids,
                "propertyPaths": [["propA"]],
            },
        )
        assertStatusOk(full)
        assertStatusOk(projected)
        fullKeys = set(full.json[0].keys())
        projectedKeys = set(projected.json[0].keys())
        assert "annotationId" in fullKeys and "values" in fullKeys
        assert fullKeys == projectedKeys
        assert "datasetId" not in fullKeys
        assert "datasetId" not in projectedKeys

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

    def testMalformedDatasetIdReturns400(self, admin, server):
        resp = self._batch(
            server,
            admin,
            {"datasetId": "not-an-object-id", "annotationIds": []},
        )
        assertStatus(resp, 400)

    def testPropertyPathsNotAListReturns400(self, admin, server):
        folder, ids = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "annotationIds": ids,
                "propertyPaths": "propA",
            },
        )
        assertStatus(resp, 400)

    def testPropertyPathElementNotAListReturns400(self, admin, server):
        folder, ids = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "annotationIds": ids,
                "propertyPaths": ["propA"],
            },
        )
        assertStatus(resp, 400)

    def testPropertyPathNonStringComponentReturns400(self, admin, server):
        # [["propA", 5]] -> ".".join raises TypeError -> 500 w/o validation.
        folder, ids = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "annotationIds": ids,
                "propertyPaths": [["propA", 5]],
            },
        )
        assertStatus(resp, 400)

    def testPropertyPathInjectionComponentReturns400(self, admin, server):
        # A component with "." or "$" would build a wrong/injected projection
        # key ("values.a.b" / a Mongo operator) -- reject it.
        folder, ids = self._makeDatasetWithValues(admin, [{"propA": 1}])
        for bad in [["a.b"], ["$where"]]:
            resp = self._batch(
                server,
                admin,
                {
                    "datasetId": str(folder["_id"]),
                    "annotationIds": ids,
                    "propertyPaths": [bad],
                },
            )
            assertStatus(resp, 400)

    def testAnnotationIdsCountCapRejectsOversized(self, admin, server,
                                                  monkeypatch):
        # A degenerate id list is rejected (a sanity ceiling; the cap is read
        # at call time so we can shrink it for the test).
        monkeypatch.setattr(validation, "MAX_ANNOTATION_IDS", 2)
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        ids = ["012345678901234567890123"] * 3
        resp = self._batch(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "annotationIds": ids},
        )
        assertStatus(resp, 400)

    def testEmptyPropertyPathsListIsAllowed(self, admin, server):
        # An empty list means "no projection" -> full values, same as omitting.
        folder, ids = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._batch(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "annotationIds": ids,
                "propertyPaths": [],
            },
        )
        assertStatusOk(resp)
        assert resp.json[0]["values"] == {"propA": 1}
