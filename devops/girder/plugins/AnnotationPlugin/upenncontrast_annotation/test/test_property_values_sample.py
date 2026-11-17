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
class TestPropertyValuesSample:
    """POST /annotation_property_values/sample: value documents covering
    each requested property, from which lazy mode discovers columns."""

    def _makeDataset(self, user, name="test_dataset"):
        return utilities.createFolder(
            user, name, upenn_utilities.datasetMetadata
        )

    def _addValues(self, folder, valuesList):
        """One annotation per entry, created (and so _id-ordered) in list
        order, with those values."""
        for values in valuesList:
            annotation = Annotation().create(
                upenn_utilities.getSampleAnnotation(folder["_id"])
            )
            AnnotationPropertyValues().appendValues(
                values, annotation["_id"], folder["_id"]
            )

    def _sample(self, server, user, body):
        return server.request(
            path="/annotation_property_values/sample",
            method="POST",
            user=user,
            body=json.dumps(body),
            type="application/json",
        )

    @staticmethod
    def _subKeys(documents):
        """{propertyId: set of sub-keys} across the returned documents."""
        keys = {}
        for document in documents:
            for propertyId, value in document["values"].items():
                keys.setdefault(propertyId, set()).update(value)
        return keys

    def testFindsPropertyOnlyOnNewerAnnotations(self, admin, server):
        """Issue #1463: a property computed only on newer annotations is
        found even when older annotations carrying another property fill
        any oldest-first sample."""
        folder = self._makeDataset(admin)
        older = [{"nucleus": {"Area": 1, "Perimeter": 2}}] * 6
        newer = [{"perfTest": {"MeanIntensity": 3}}] * 2
        self._addValues(folder, older + newer)
        # The pre-fix discovery: the oldest documents only. With 6 older
        # annotations a sample of 6 holds no perfTest value.
        resp = server.request(
            path="/annotation_property_values", method="GET", user=admin,
            params={"datasetId": str(folder["_id"]), "limit": 6,
                    "sort": "_id"},
        )
        assertStatusOk(resp)
        assert all("perfTest" not in doc["values"] for doc in resp.json)

        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]),
            "propertyIds": ["nucleus", "perfTest"],
        })
        assertStatusOk(resp)
        assert self._subKeys(resp.json) == {
            "nucleus": {"Area", "Perimeter"},
            "perfTest": {"MeanIntensity"},
        }

    def testIncludesSubKeysOnlyOnTheNewestDocument(self, admin, server):
        """A later compute that added an output is seen: the newest document
        is returned along with the oldest."""
        folder = self._makeDataset(admin)
        self._addValues(folder, [
            {"blob": {"Area": 1}},
            {"blob": {"Area": 1}},
            {"blob": {"Area": 1, "Circularity": 0.5}},
        ])
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]), "propertyIds": ["blob"],
        })
        assertStatusOk(resp)
        assert self._subKeys(resp.json) == {"blob": {"Area", "Circularity"}}

    def testReturnsOnlyRequestedProperties(self, admin, server):
        folder = self._makeDataset(admin)
        self._addValues(folder, [
            {"wanted": {"a": 1}, "other": {"b": 2}},
        ])
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]), "propertyIds": ["wanted"],
        })
        assertStatusOk(resp)
        assert resp.json
        for document in resp.json:
            assert set(document["values"]) == {"wanted"}
            assert "_id" not in document
            assert document["annotationId"]

    def testPropertyWithoutValuesIsOmitted(self, admin, server):
        """A never-computed property returns nothing for itself and does not
        hide the properties that have values."""
        folder = self._makeDataset(admin)
        self._addValues(folder, [{"computed": {"x": 1}}])
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]),
            "propertyIds": ["neverComputed", "computed"],
        })
        assertStatusOk(resp)
        assert self._subKeys(resp.json) == {"computed": {"x"}}

    def testEmptyPropertyListReturnsNothing(self, admin, server):
        folder = self._makeDataset(admin)
        self._addValues(folder, [{"computed": {"x": 1}}])
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]), "propertyIds": [],
        })
        assertStatusOk(resp)
        assert resp.json == []

    def testScopedToTheDataset(self, admin, server):
        """Values for the same property id in another dataset are not
        returned."""
        folder = self._makeDataset(admin)
        otherFolder = self._makeDataset(admin, name="other_dataset")
        self._addValues(otherFolder, [{"shared": {"elsewhere": 1}}])
        self._addValues(folder, [{"shared": {"here": 1}}])
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]), "propertyIds": ["shared"],
        })
        assertStatusOk(resp)
        assert self._subKeys(resp.json) == {"shared": {"here"}}

    def testWalkResumesInsteadOfRescanning(self, admin):
        """Each pass returns one document per hit and resumes after it: with
        every property on the first document, one document each way."""
        folder = self._makeDataset(admin)
        self._addValues(folder, [{"a": {"x": 1}, "b": {"y": 2}}] * 4)
        documents = AnnotationPropertyValues().samplesCoveringProperties(
            folder["_id"], ["a", "b"]
        )
        assert len(documents) == 2

    def testRequiresReadAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "private_dataset", upenn_utilities.datasetMetadata
        )
        self._addValues(folder, [{"secret": {"x": 1}}])
        resp = self._sample(server, user, {
            "datasetId": str(folder["_id"]), "propertyIds": ["secret"],
        })
        assertStatus(resp, 403)

    @pytest.mark.parametrize("propertyIds,message", [
        ("abc", "propertyIds must be a list"),
        (None, "propertyIds must be a list"),
        ([123], "each property id must be a non-empty string"),
        ([""], "each property id must be a non-empty string"),
        (["a.b"], "each property id must be a non-empty string"),
        (["$where"], "each property id must be a non-empty string"),
    ])
    def testRejectsMalformedPropertyIds(
        self, admin, server, propertyIds, message
    ):
        folder = self._makeDataset(admin)
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]), "propertyIds": propertyIds,
        })
        assertStatus(resp, 400)
        assert message in resp.json["message"]

    def testRejectsTooManyPropertyIds(self, admin, server, monkeypatch):
        monkeypatch.setattr(validation, "MAX_SAMPLED_PROPERTIES", 2)
        folder = self._makeDataset(admin)
        resp = self._sample(server, admin, {
            "datasetId": str(folder["_id"]),
            "propertyIds": ["a", "b", "c"],
        })
        assertStatus(resp, 400)
        assert "propertyIds exceeds the maximum of 2" in resp.json["message"]

    def testRejectsNonObjectBody(self, admin, server):
        resp = self._sample(server, admin, ["not", "an", "object"])
        assertStatus(resp, 400)
        assert "must be a JSON object" in resp.json["message"]
