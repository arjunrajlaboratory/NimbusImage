import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def annotationExportDict(oldId, idKey="_id"):
    """Build a raw annotation dict as it would appear in an export file.

    oldId is an arbitrary string standing in for the annotation's id in
    the source dataset; it does not need to be a real ObjectId since
    the import endpoint only uses it as an opaque remapping key.
    """
    return {
        idKey: oldId,
        "name": "Imported annotation %s" % oldId,
        "coordinates": [{"x": 1, "y": 2, "z": 0}],
        "tags": ["imported"],
        "channel": 0,
        "location": {"XY": 0, "Z": 0, "Time": 0},
        "shape": "point",
    }


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDataImportEndpoint:
    """REST API tests for POST /annotation_import."""

    def _makeDataset(self, user, name="import_ds"):
        return utilities.createFolder(
            user, name, upenn_utilities.datasetMetadata
        )

    def _annotationsByName(self, datasetId):
        return {
            ann["name"]: ann
            for ann in Annotation().find({"datasetId": datasetId})
        }

    def testImportAnnotationsAndConnectionsWithUnderscoreId(
        self, admin, server
    ):
        """Server-export shape: old ids are keyed under "_id"."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [
                annotationExportDict("old-ann-1"),
                annotationExportDict("old-ann-2"),
            ],
            "connections": [{
                "label": "imported connection",
                "tags": [],
                "parentId": "old-ann-1",
                "childId": "old-ann-2",
            }],
        }

        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json == {
            "annotationCount": 2,
            "connectionCount": 1,
            "propertyValueCount": 0,
        }

        annByName = self._annotationsByName(dataset["_id"])
        assert len(annByName) == 2
        parentAnn = annByName["Imported annotation old-ann-1"]
        childAnn = annByName["Imported annotation old-ann-2"]

        connectionDocs = list(
            AnnotationConnection().find({"datasetId": dataset["_id"]})
        )
        assert len(connectionDocs) == 1
        assert connectionDocs[0]["parentId"] == parentAnn["_id"]
        assert connectionDocs[0]["childId"] == childAnn["_id"]
        assert connectionDocs[0]["label"] == "imported connection"

    def testImportAnnotationsAndConnectionsWithLegacyIdKey(
        self, admin, server
    ):
        """Legacy frontend export shape: old ids are keyed under "id"."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [
                annotationExportDict("old-ann-1", idKey="id"),
                annotationExportDict("old-ann-2", idKey="id"),
            ],
            "connections": [{
                "tags": [],
                "parentId": "old-ann-1",
                "childId": "old-ann-2",
            }],
        }

        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json["annotationCount"] == 2
        assert resp.json["connectionCount"] == 1

        annByName = self._annotationsByName(dataset["_id"])
        parentAnn = annByName["Imported annotation old-ann-1"]
        childAnn = annByName["Imported annotation old-ann-2"]

        connectionDocs = list(
            AnnotationConnection().find({"datasetId": dataset["_id"]})
        )
        assert len(connectionDocs) == 1
        assert connectionDocs[0]["parentId"] == parentAnn["_id"]
        assert connectionDocs[0]["childId"] == childAnn["_id"]

    def testImportAnnotationWithNullName(self, admin, server):
        """Exports carry "name": null for unnamed annotations; null
        fields must be dropped since the schema only allows a string
        when the field is present."""
        dataset = self._makeDataset(admin)
        annotation = annotationExportDict("old-ann-1")
        annotation["name"] = None
        annotation["color"] = None
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [annotation],
        }

        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json["annotationCount"] == 1

        docs = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert len(docs) == 1
        assert "name" not in docs[0]
        assert "color" not in docs[0]

    def testImportPropertyValuesRemapping(self, admin, server):
        """propertyIdMap remaps property ids; unmapped ids are skipped."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [
                annotationExportDict("old-ann-1"),
                annotationExportDict("old-ann-2"),
            ],
            "propertyValues": {
                "old-ann-1": {
                    "old-prop-mapped": {"Area": 10},
                    "old-prop-unmapped": {"Area": 99},
                },
                # Entirely unmapped: should be dropped, not just have
                # empty values.
                "old-ann-2": {
                    "old-prop-unmapped": {"Area": 5},
                },
            },
            "propertyIdMap": {
                "old-prop-mapped": "new-prop-mapped",
            },
        }

        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json["propertyValueCount"] == 1

        annByName = self._annotationsByName(dataset["_id"])
        ann1 = annByName["Imported annotation old-ann-1"]

        propValueDocs = list(
            AnnotationPropertyValues().find({"datasetId": dataset["_id"]})
        )
        assert len(propValueDocs) == 1
        doc = propValueDocs[0]
        assert doc["annotationId"] == ann1["_id"]
        assert doc["values"] == {"new-prop-mapped": {"Area": 10}}

    def testImportConnectionUnknownAnnotationRollsBack(self, admin, server):
        """An unresolvable connection reference fails and rolls back."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [annotationExportDict("old-ann-1")],
            "connections": [{
                "tags": [],
                "parentId": "old-ann-1",
                "childId": "old-ann-missing",
            }],
        }

        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

        remaining = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert remaining == []

    def testImportDeniedWithoutWriteAccess(self, admin, user, server):
        """A user without WRITE access to the dataset gets a 403."""
        dataset = utilities.createPrivateFolder(
            admin, "private_import_ds", upenn_utilities.datasetMetadata
        )
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [annotationExportDict("old-ann-1")],
        }

        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=user,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 403)

        remaining = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert remaining == []

    # --- Malformed-input handling: bad input must yield 400, not 500 ----

    def testImportNonObjectBodyReturns400(self, admin, server):
        """A JSON body that isn't an object (e.g. an array) -> 400."""
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(["not", "an", "object"]),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testImportMalformedDatasetIdReturns400(self, admin, server):
        """A datasetId that isn't a valid ObjectId -> 400, not 500."""
        body = {
            "datasetId": "not-a-valid-object-id",
            "annotations": [annotationExportDict("old-ann-1")],
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testImportAnnotationsNotListReturns400(self, admin, server):
        """A non-list "annotations" field -> 400."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": {"not": "a list"},
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testImportConnectionsNotListReturns400(self, admin, server):
        """A non-list "connections" field -> 400."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [],
            "connections": {"not": "a list"},
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testImportPropertyValuesNotDictReturns400(self, admin, server):
        """A non-dict "propertyValues" field -> 400."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [],
            "propertyValues": ["not", "a dict"],
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testImportPropertyIdMapNotDictReturns400(self, admin, server):
        """A non-dict "propertyIdMap" field -> 400 and nothing created."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [annotationExportDict("old-ann-1")],
            "propertyValues": {"old-ann-1": {"old-prop": {"Area": 1}}},
            "propertyIdMap": ["not", "a dict"],
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

        remaining = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert remaining == []

    def testImportNonStringDatasetIdReturns400(self, admin, server):
        """A non-string datasetId (e.g. a number) -> 400, not 500.

        ObjectId(123) raises TypeError, not InvalidId, so catching only
        InvalidId would leave an uncaught 500.
        """
        body = {"datasetId": 123, "annotations": []}
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testImportAnnotationEntryNotObjectReturns400(self, admin, server):
        """A non-object entry inside the annotations list -> 400."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [123],
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

        remaining = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert remaining == []

    def testImportConnectionEntryNotObjectReturns400(self, admin, server):
        """A non-object entry inside the connections list -> 400 and
        rolls back the annotations created before it."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [annotationExportDict("old-ann-1")],
            "connections": [123],
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

        remaining = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert remaining == []

    def testImportPropertyValueEntryNotObjectReturns400(self, admin, server):
        """propertyValues is an object but a nested entry isn't -> 400."""
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [annotationExportDict("old-ann-1")],
            "propertyValues": {"old-ann-1": 5},
            "propertyIdMap": {},
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatus(resp, 400)

        remaining = list(Annotation().find({"datasetId": dataset["_id"]}))
        assert remaining == []

    def testImportedDataIsRecordedAndUndoable(self, admin, server):
        """A completed import must be captured by @recordable so it can be
        undone. The helper writes via AnnotationModel()/ConnectionModel()/
        PropertyValuesModel(), which are Girder model *singletons* (the
        _ModelSingleton metaclass), so they are the same recording
        instances that received proxiedModel.startRecording — the writes
        are recorded and undo reverts them.
        """
        dataset = self._makeDataset(admin)
        body = {
            "datasetId": str(dataset["_id"]),
            "annotations": [
                annotationExportDict("old-ann-1"),
                annotationExportDict("old-ann-2"),
            ],
            "connections": [{
                "tags": [],
                "parentId": "old-ann-1",
                "childId": "old-ann-2",
            }],
            "propertyValues": {"old-ann-1": {"p1": {"Area": 1}}},
            "propertyIdMap": {"p1": "p1"},
        }
        resp = server.request(
            path="/annotation_import",
            method="POST",
            user=admin,
            body=json.dumps(body),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json == {
            "annotationCount": 2,
            "connectionCount": 1,
            "propertyValueCount": 1,
        }

        # Sanity: the documents exist after import.
        assert len(list(
            Annotation().find({"datasetId": dataset["_id"]}))) == 2
        assert len(list(
            AnnotationConnection().find({"datasetId": dataset["_id"]}))) == 1
        assert len(list(
            AnnotationPropertyValues().find(
                {"datasetId": dataset["_id"]}))) == 1

        # Undo the import: if the helper's writes were recorded, undo
        # reverts every created document.
        undo = server.request(
            path="/history/undo",
            method="PUT",
            user=admin,
            params={"datasetId": str(dataset["_id"])},
        )
        assertStatusOk(undo)

        assert list(Annotation().find({"datasetId": dataset["_id"]})) == []
        assert list(
            AnnotationConnection().find({"datasetId": dataset["_id"]})) == []
        assert list(
            AnnotationPropertyValues().find(
                {"datasetId": dataset["_id"]})) == []
