import json
import threading

import pytest
from bson.objectid import ObjectId
from pytest_girder.assertions import assertStatus

from girder.exceptions import ValidationException
from pymongo.errors import BulkWriteError

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def _makeAnnotations(admin, count, name="save_many_dataset"):
    folder = utilities.createFolder(
        admin, name, upenn_utilities.datasetMetadata
    )
    annotations = Annotation().createMultiple([
        upenn_utilities.getSampleAnnotation(folder["_id"])
        for _ in range(count)
    ])
    return folder, annotations


def _runConcurrently(targets):
    """Start every target at the same moment and collect what they raise."""
    barrier = threading.Barrier(len(targets))
    errors = []

    def run(target):
        barrier.wait()
        try:
            target()
        except Exception as e:  # re-raised via the errors list
            errors.append(e)

    threads = [threading.Thread(target=run, args=(t,)) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return errors


def _bulkWriteError():
    return BulkWriteError({
        "writeErrors": [{
            "index": 0,
            "code": 11000,
            "errmsg": "E11000 duplicate key error",
        }],
        "nInserted": 0,
    })


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestSaveManyErrors:
    """Issue #1357: the error handler concatenated a dict onto a str."""

    def testBulkWriteErrorBecomesValidationException(
        self, admin, monkeypatch
    ):
        folder, _ = _makeAnnotations(admin, 1)
        collection = Annotation().collection

        def fail(*args, **kwargs):
            raise _bulkWriteError()

        # Whichever bulk primitive saveMany uses must surface the database
        # error as a ValidationException, not a TypeError from formatting.
        monkeypatch.setattr(type(collection), "insert_many", fail)
        monkeypatch.setattr(type(collection), "bulk_write", fail)
        with pytest.raises(ValidationException) as excinfo:
            Annotation().createMultiple([
                upenn_utilities.getSampleAnnotation(folder["_id"])
            ])
        assert "E11000" in str(excinfo.value)
        assert isinstance(excinfo.value.__cause__, BulkWriteError)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValueWrites:
    """Issue #1356: concurrent property-value writes must not race."""

    def _values(self, annotations):
        docs = list(AnnotationPropertyValues().find({
            "annotationId": {"$in": [a["_id"] for a in annotations]}
        }))
        byAnnotation = {}
        for doc in docs:
            byAnnotation.setdefault(doc["annotationId"], []).append(doc)
        return byAnnotation

    def _entries(self, folder, annotations, propertyId, value):
        return [
            {
                "annotationId": annotation["_id"],
                "datasetId": folder["_id"],
                "values": {propertyId: value},
            }
            for annotation in annotations
        ]

    def testDifferentPropertiesMergeIntoOneDocument(self, admin):
        folder, annotations = _makeAnnotations(admin, 3)
        model = AnnotationPropertyValues()
        model.appendMultipleValues(
            self._entries(folder, annotations, "propA", 1))
        model.appendMultipleValues(
            self._entries(folder, annotations, "propB", {"sub": 2}))

        byAnnotation = self._values(annotations)
        for annotation in annotations:
            docs = byAnnotation[annotation["_id"]]
            assert len(docs) == 1
            assert docs[0]["values"] == {"propA": 1, "propB": {"sub": 2}}
            assert docs[0]["datasetId"] == folder["_id"]

    def testRewritingAPropertyReplacesItsValue(self, admin):
        # Recomputing a property must store the new value; the batched merge
        # used to let the stored value win over the one being written.
        folder, annotations = _makeAnnotations(admin, 2)
        model = AnnotationPropertyValues()
        model.appendMultipleValues(
            self._entries(folder, annotations, "propA", {"a": 1, "b": 1}))
        model.appendMultipleValues(
            self._entries(folder, annotations, "propA", {"a": 2}))

        for docs in self._values(annotations).values():
            assert [doc["values"] for doc in docs] == [{"propA": {"a": 2}}]

    def testAppendValuesMergesWithExistingDocument(self, admin):
        folder, annotations = _makeAnnotations(admin, 1)
        model = AnnotationPropertyValues()
        model.appendValues({"propA": 1}, annotations[0]["_id"], folder["_id"])
        model.appendValues({"propB": 2}, annotations[0]["_id"], folder["_id"])

        docs = self._values(annotations)[annotations[0]["_id"]]
        assert [doc["values"] for doc in docs] == [{"propA": 1, "propB": 2}]

    def testReturnsTheStoredDocuments(self, admin):
        folder, annotations = _makeAnnotations(admin, 2)
        model = AnnotationPropertyValues()
        model.appendMultipleValues(
            self._entries(folder, annotations, "propA", 1))
        saved = model.appendMultipleValues(
            self._entries(folder, annotations, "propB", 2))

        assert len(saved) == 2
        for doc in saved:
            assert "_id" in doc
            assert doc["values"] == {"propA": 1, "propB": 2}

    def _concurrentWriters(self, folder, annotations, workers):
        model = AnnotationPropertyValues()
        return [
            (lambda propertyId=propertyId: model.appendMultipleValues(
                self._entries(folder, annotations, propertyId, 1)))
            for propertyId in ["prop%d" % i for i in range(workers)]
        ]

    def testConcurrentWritersOnExistingDocuments(self, admin):
        # The prod failure: sibling property workers write the same
        # annotations at once, after an earlier property already created
        # their documents. Delete-then-insert raced into E11000 and dropped
        # values.
        folder, annotations = _makeAnnotations(admin, 300)
        workers = 4
        for iteration in range(5):
            model = AnnotationPropertyValues()
            model.appendMultipleValues(
                self._entries(folder, annotations, "seed", iteration))
            errors = _runConcurrently(
                self._concurrentWriters(folder, annotations, workers))
            assert errors == []

            byAnnotation = self._values(annotations)
            expected = {"prop%d" % i: 1 for i in range(workers)}
            expected["seed"] = iteration
            for annotation in annotations:
                docs = byAnnotation[annotation["_id"]]
                assert len(docs) == 1
                assert docs[0]["values"] == expected

    def testConcurrentWritersOnFreshAnnotations(self, admin):
        # First writes to annotations with no document yet must still end up
        # as ONE document per annotation holding every writer's values.
        workers = 4
        for iteration in range(5):
            folder, annotations = _makeAnnotations(
                admin, 300, "fresh%d" % iteration)
            errors = _runConcurrently(
                self._concurrentWriters(folder, annotations, workers))
            assert errors == []

            byAnnotation = self._values(annotations)
            expected = {"prop%d" % i: 1 for i in range(workers)}
            for annotation in annotations:
                docs = byAnnotation[annotation["_id"]]
                assert len(docs) == 1
                assert docs[0]["values"] == expected


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestConcurrentDocumentReplacement:
    """saveMany replacing existing documents must never lose them."""

    def testConcurrentReplacementsKeepEveryDocument(self, admin):
        folder, annotations = _makeAnnotations(admin, 300)
        ids = [annotation["_id"] for annotation in annotations]

        def replaceAll(tag):
            def run():
                docs = list(Annotation().find({"_id": {"$in": ids}}))
                for doc in docs:
                    doc["tags"] = [tag]
                Annotation().saveMany(docs)
            return run

        for iteration in range(5):
            errors = _runConcurrently(
                [replaceAll("w%d" % i) for i in range(4)])
            assert errors == []
            stored = list(Annotation().find({"_id": {"$in": ids}}))
            assert len(stored) == len(ids)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValueDatasetBinding:
    """Writes are authorized per datasetId, so each annotation must belong
    to the dataset its entry names (Codex P1 on PR #1358)."""

    def _victim(self, admin):
        # Admin's private dataset holding an annotation with a stored value.
        folder = utilities.createPrivateFolder(
            admin, "victim", upenn_utilities.datasetMetadata
        )
        annotation = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        AnnotationPropertyValues().appendValues(
            {"propA": 1}, annotation["_id"], folder["_id"]
        )
        return folder, annotation

    def _storedValues(self, annotation):
        return [
            doc["values"] for doc in AnnotationPropertyValues().find(
                {"annotationId": annotation["_id"]})
        ]

    def testMultipleRejectsAnnotationFromAnotherDataset(
        self, admin, user, server
    ):
        _, annotation = self._victim(admin)
        own = utilities.createFolder(
            user, "own", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/annotation_property_values/multiple",
            method="POST",
            user=user,
            body=json.dumps([{
                "annotationId": str(annotation["_id"]),
                "datasetId": str(own["_id"]),
                "values": {"propA": 666},
            }]),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert "does not belong to dataset" in resp.json["message"]
        assert self._storedValues(annotation) == [{"propA": 1}]

    def testSingleRejectsAnnotationFromAnotherDataset(
        self, admin, user, server
    ):
        _, annotation = self._victim(admin)
        own = utilities.createFolder(
            user, "own", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/annotation_property_values",
            method="POST",
            user=user,
            body=json.dumps({"propA": 666}),
            type="application/json",
            params={
                "annotationId": str(annotation["_id"]),
                "datasetId": str(own["_id"]),
            },
        )
        assertStatus(resp, 400)
        assert "does not belong to dataset" in resp.json["message"]
        assert self._storedValues(annotation) == [{"propA": 1}]

    def _postMultiple(self, server, user, entries):
        return server.request(
            path="/annotation_property_values/multiple",
            method="POST",
            user=user,
            body=json.dumps([
                {**entry, "annotationId": str(entry["annotationId"]),
                 "datasetId": str(entry["datasetId"])}
                for entry in entries
            ]),
            type="application/json",
        )

    def testRejectsNonexistentAnnotation(self, admin, server):
        folder, _ = _makeAnnotations(admin, 1)
        resp = self._postMultiple(server, admin, [{
            "annotationId": ObjectId(),
            "datasetId": folder["_id"],
            "values": {"propA": 1},
        }])
        assertStatus(resp, 400)
        assert "does not belong to dataset" in resp.json["message"]

    def testRejectsEntryMissingAnId(self, admin, server):
        folder, annotations = _makeAnnotations(admin, 1)
        for entry in (
            {"annotationId": str(annotations[0]["_id"]),
             "values": {"propA": 1}},
            {"datasetId": str(folder["_id"]), "values": {"propA": 1}},
        ):
            resp = server.request(
                path="/annotation_property_values/multiple",
                method="POST",
                user=admin,
                body=json.dumps([entry]),
                type="application/json",
            )
            assertStatus(resp, 400)
        assert self._storedValues(annotations[0]) == []

    def testRejectsMalformedMultipleBody(self, admin, server):
        # The dataset check runs before the model's schema validation, so
        # the endpoint must reject non-object entries itself.
        for body in (["not an entry"], {"annotationId": "x"}, [5]):
            resp = server.request(
                path="/annotation_property_values/multiple",
                method="POST",
                user=admin,
                body=json.dumps(body),
                type="application/json",
            )
            assertStatus(resp, 400)

    def testRejectedBatchWritesNothing(self, admin, server):
        folder, annotations = _makeAnnotations(admin, 2)
        other, _ = self._victim(admin)
        resp = self._postMultiple(server, admin, [
            {"annotationId": annotations[0]["_id"],
             "datasetId": folder["_id"], "values": {"propB": 2}},
            {"annotationId": annotations[1]["_id"],
             "datasetId": other["_id"], "values": {"propB": 2}},
        ])
        assertStatus(resp, 400)
        assert self._storedValues(annotations[0]) == []
