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
class TestUncomputedCounts:
    """POST /upenn_annotation/uncomputed_counts.

    For each property, the count of annotations that match the property's
    compute criteria (shape + tag rule, mirroring the client
    canComputeAnnotationProperty) but have no computed value for it. The
    server returns only counts, never values.
    """

    def _makeDataset(self, admin, name="uncomputed_ds"):
        return utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )

    def _addAnnotation(
        self, folder, shape="point", tags=None, value=None,
        propertyId="propA",
    ):
        annotation = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation["shape"] = shape
        annotation["tags"] = [] if tags is None else tags
        created = Annotation().create(annotation)
        if value is not None:
            AnnotationPropertyValues().appendValues(
                {propertyId: value}, created["_id"], folder["_id"]
            )
        return created

    def _uncomputed(self, server, user, datasetId, properties):
        return server.request(
            path="/upenn_annotation/uncomputed_counts",
            method="POST",
            user=user,
            body=json.dumps(
                {"datasetId": datasetId, "properties": properties}
            ),
            type="application/json",
        )

    @staticmethod
    def _prop(propertyId, shape="point", tags=None, exclusive=False):
        return {
            "id": propertyId,
            "shape": shape,
            "tags": {"tags": [] if tags is None else tags,
                     "exclusive": exclusive},
        }

    def testBasicCount(self, admin, server):
        folder = self._makeDataset(admin)
        # 5 point annotations; first 2 have a propA value computed.
        for i in range(5):
            self._addAnnotation(
                folder, value=(i if i < 2 else None)
            )
        resp = self._uncomputed(
            server, admin, str(folder["_id"]), [self._prop("propA")]
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 3}

    def testAllComputed(self, admin, server):
        folder = self._makeDataset(admin)
        for i in range(3):
            self._addAnnotation(folder, value=i)
        resp = self._uncomputed(
            server, admin, str(folder["_id"]), [self._prop("propA")]
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 0}

    def testEmptyDataset(self, admin, server):
        folder = self._makeDataset(admin)
        resp = self._uncomputed(
            server, admin, str(folder["_id"]), [self._prop("propA")]
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 0}

    def testShapeFilter(self, admin, server):
        folder = self._makeDataset(admin)
        for _ in range(3):
            self._addAnnotation(folder, shape="point")
        for _ in range(2):
            self._addAnnotation(folder, shape="polygon")
        resp = self._uncomputed(
            server,
            admin,
            str(folder["_id"]),
            [self._prop("propPoint", shape="point"),
             self._prop("propPoly", shape="polygon")],
        )
        assertStatusOk(resp)
        assert resp.json == {"propPoint": 3, "propPoly": 2}

    def testInclusiveTagsMatchSupersets(self, admin, server):
        folder = self._makeDataset(admin)
        self._addAnnotation(folder, tags=["nucleus"])
        self._addAnnotation(folder, tags=["nucleus", "big"])
        self._addAnnotation(folder, tags=["cell"])
        # Inclusive ["nucleus"] matches annotations whose tags include nucleus.
        resp = self._uncomputed(
            server,
            admin,
            str(folder["_id"]),
            [self._prop("propN", tags=["nucleus"], exclusive=False)],
        )
        assertStatusOk(resp)
        assert resp.json == {"propN": 2}

    def testExclusiveTagsMatchExactSet(self, admin, server):
        folder = self._makeDataset(admin)
        self._addAnnotation(folder, tags=["nucleus"])
        self._addAnnotation(folder, tags=["nucleus", "big"])
        self._addAnnotation(folder, tags=["cell"])
        # Exclusive ["nucleus"] matches only the annotation tagged exactly so.
        resp = self._uncomputed(
            server,
            admin,
            str(folder["_id"]),
            [self._prop("propN", tags=["nucleus"], exclusive=True)],
        )
        assertStatusOk(resp)
        assert resp.json == {"propN": 1}

    def testEmptyInclusiveTagsMatchAllOfShape(self, admin, server):
        folder = self._makeDataset(admin)
        self._addAnnotation(folder, tags=["nucleus"])
        self._addAnnotation(folder, tags=[])
        self._addAnnotation(folder, tags=["cell", "small"])
        resp = self._uncomputed(
            server, admin, str(folder["_id"]), [self._prop("propA")]
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 3}

    def testEmptyExclusiveTagsMatchOnlyUntagged(self, admin, server):
        folder = self._makeDataset(admin)
        self._addAnnotation(folder, tags=["nucleus"])
        self._addAnnotation(folder, tags=[])
        self._addAnnotation(folder, tags=[])
        resp = self._uncomputed(
            server,
            admin,
            str(folder["_id"]),
            [self._prop("propA", tags=[], exclusive=True)],
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 2}

    def testValueForOtherPropertyDoesNotCount(self, admin, server):
        folder = self._makeDataset(admin)
        # Both annotations have a value but only for propB; propA is still
        # uncomputed for both.
        self._addAnnotation(folder, value=1, propertyId="propB")
        self._addAnnotation(folder, value=2, propertyId="propB")
        resp = self._uncomputed(
            server,
            admin,
            str(folder["_id"]),
            [self._prop("propA"), self._prop("propB")],
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 2, "propB": 0}

    def testExcludesOtherDatasets(self, admin, server):
        folderA = self._makeDataset(admin, name="ds_a")
        folderB = self._makeDataset(admin, name="ds_b")
        for _ in range(2):
            self._addAnnotation(folderA)
        for _ in range(5):
            self._addAnnotation(folderB)
        resp = self._uncomputed(
            server, admin, str(folderA["_id"]), [self._prop("propA")]
        )
        assertStatusOk(resp)
        assert resp.json == {"propA": 2}

    def testNoPropertiesReturnsEmpty(self, admin, server):
        folder = self._makeDataset(admin)
        self._addAnnotation(folder)
        resp = self._uncomputed(server, admin, str(folder["_id"]), [])
        assertStatusOk(resp)
        assert resp.json == {}

    def testInvalidDatasetReturnsError(self, admin, server):
        resp = self._uncomputed(
            server,
            admin,
            "012345678901234567890123",
            [self._prop("propA")],
        )
        assertStatus(resp, 400)
