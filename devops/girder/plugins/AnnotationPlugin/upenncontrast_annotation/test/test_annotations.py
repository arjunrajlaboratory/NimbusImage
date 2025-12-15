import pytest

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models import annotation

from girder.models.folder import Folder

from girder.exceptions import ValidationException

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnnotation:
    def testAnnotationSchema(self):
        schema = annotation.AnnotationSchema
        assert schema.annotationSchema is not None
        assert schema.coordSchema is not None
        assert schema.coordsSchema is not None
        assert schema.tagsSchema is not None
        assert schema.locationSchema is not None
        assert schema.shapeSchema is not None

    def testAnnotationCreate(self, admin):
        folder = utilities.createFolder(
            admin, "sample", upenn_utilities.datasetMetadata
        )
        newAnnotation = upenn_utilities.getSampleAnnotation(folder["_id"])

        result = Annotation().create(newAnnotation)
        assert "_id" in result
        annotId = result["_id"]
        result = Annotation().load(annotId, user=admin)
        assert result is not None
        assert result["name"] == newAnnotation["name"]

    def testLoad(self, admin):
        with pytest.raises(Exception, match="Invalid ObjectId"):
            Annotation().load("nosuchid", user=admin)
        assert (
            Annotation().load("012345678901234567890123", user=admin) is None
        )

        folder = utilities.createFolder(
            admin, "sample", upenn_utilities.datasetMetadata
        )
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation = Annotation().create(sample)

        loaded = Annotation().load(annotation["_id"], user=admin)
        assert (
            loaded["_id"] == annotation["_id"]
            and loaded["name"] == sample["name"]
        )

    def testRemove(self, user):
        folder = utilities.createFolder(
            user, "sample", upenn_utilities.datasetMetadata
        )
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation = Annotation().create(sample)

        assert Annotation().load(annotation["_id"], force=True) is not None
        result = Annotation().remove(annotation)
        assert result.deleted_count == 1
        assert Annotation().load(annotation["_id"], force=True) is None

    def testOnDatasetRemove(self, user):
        folder = utilities.createFolder(
            user, "sample", upenn_utilities.datasetMetadata
        )
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation = Annotation().create(sample)

        Folder().remove(folder)
        result = Annotation().load(annotation["_id"], user=user)
        assert result is None

    def testValidate(self, admin):
        sample = upenn_utilities.getSampleAnnotation(
            "012345678901234567890123"
        )
        with pytest.raises(
            ValidationException, match="Annotation dataset ID is invalid"
        ):
            Annotation().validate(sample)
        empty = {}
        with pytest.raises(ValidationException):
            Annotation().validate(empty)

        folder = utilities.createFolder(admin, "sample2", {})
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        with pytest.raises(
            ValidationException,
            match="Annotation dataset ID is invalid",
        ):
            Annotation().validate(sample)
