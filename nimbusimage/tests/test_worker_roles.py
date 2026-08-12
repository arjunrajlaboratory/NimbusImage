"""Tests for worker role validation in the compute accessors.

Annotation and property workers submit through different endpoints with
different payload formats. Passing a property-worker image to
``ds.annotations.compute`` used to submit successfully and then crash
inside the worker (``AttributeError: 'list' object has no attribute
'get'``); the accessors now cross-check the image's role labels from
``GET /worker_interface/available`` and fail fast client-side.
"""

from unittest.mock import MagicMock

import pytest

from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.jobs import Job
from nimbusimage.models import Property
from nimbusimage.properties import PropertyAccessor


PROPERTY_IMAGE = "properties/blob_intensity_worker:latest"
ANNOTATION_IMAGE = "annotations/random_squares:latest"

# Role labels are Docker MARKER labels: presence defines the role and
# the value is commonly the empty string. Empty-string values are used
# throughout these tests on purpose — a truthiness or == "true" check
# would treat them as absent and let the mismatch through.
WORKERS = {
    PROPERTY_IMAGE: {
        "isUPennContrastWorker": "",
        "isPropertyWorker": "",
        "annotationShape": "polygon",
        "interfaceName": "Blob Intensity",
    },
    ANNOTATION_IMAGE: {
        "isUPennContrastWorker": "",
        "isAnnotationWorker": "",
        "annotationShape": "polygon",
        "interfaceName": "Random Squares",
    },
}


def make_property(image):
    return Property(
        id="prop_001",
        name="Blob Intensity",
        shape="polygon",
        image=image,
        tags={"exclusive": False, "tags": []},
        worker_interface={"Channel": 0},
    )


@pytest.fixture
def gc_with_workers(mock_gc):
    mock_gc.get.return_value = dict(WORKERS)
    mock_gc.post.return_value = [{"_id": "job_1", "status": 1}]
    return mock_gc


class TestAnnotationComputeRejectsPropertyWorker:
    def test_property_worker_raises_before_post(self, gc_with_workers):
        accessor = AnnotationAccessor(gc_with_workers, "ds_001")

        with pytest.raises(ValueError, match="property worker"):
            accessor.compute(image=PROPERTY_IMAGE, tags=["blobs"])
        # Must fail before any job is submitted.
        gc_with_workers.post.assert_not_called()

    def test_error_names_correct_accessor(self, gc_with_workers):
        accessor = AnnotationAccessor(gc_with_workers, "ds_001")

        with pytest.raises(
            ValueError, match=r"ds\.properties\.compute"
        ):
            accessor.compute(image=PROPERTY_IMAGE)

    def test_role_comes_from_labels_not_image_prefix(self, mock_gc):
        """A registry-qualified image whose path contains
        'annotations/' is still rejected when its labels say it is a
        property worker — the role must never be inferred from the
        image path prefix."""
        image = "ghcr.io/lab/annotations/blob_intensity:latest"
        mock_gc.get.return_value = {
            image: {"isPropertyWorker": ""},
        }
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        with pytest.raises(ValueError, match="property worker"):
            accessor.compute(image=image)

    def test_annotation_worker_passes(self, gc_with_workers):
        accessor = AnnotationAccessor(gc_with_workers, "ds_001")

        job = accessor.compute(image=ANNOTATION_IMAGE, tags=["squares"])
        assert isinstance(job, Job)
        gc_with_workers.get.assert_called_with(
            "/worker_interface/available"
        )


class TestPropertyComputeRejectsAnnotationWorker:
    def test_annotation_worker_raises_before_post(self, gc_with_workers):
        accessor = PropertyAccessor(gc_with_workers, "ds_001")

        with pytest.raises(ValueError, match="annotation worker"):
            accessor.compute(make_property(ANNOTATION_IMAGE))
        gc_with_workers.post.assert_not_called()

    def test_error_names_correct_accessor(self, gc_with_workers):
        accessor = PropertyAccessor(gc_with_workers, "ds_001")

        with pytest.raises(
            ValueError, match=r"ds\.annotations\.compute"
        ):
            accessor.compute(make_property(ANNOTATION_IMAGE))

    def test_property_worker_passes(self, gc_with_workers):
        accessor = PropertyAccessor(gc_with_workers, "ds_001")

        job = accessor.compute(make_property(PROPERTY_IMAGE))
        assert isinstance(job, Job)
        gc_with_workers.get.assert_called_with(
            "/worker_interface/available"
        )


class TestDualRoleWorker:
    """A worker may carry both role labels and is valid for either
    accessor."""

    @pytest.fixture
    def gc_dual(self, mock_gc):
        mock_gc.get.return_value = {
            "dual:latest": {
                "isAnnotationWorker": "",
                "isPropertyWorker": "",
            },
        }
        mock_gc.post.return_value = [{"_id": "job_1", "status": 1}]
        return mock_gc

    def test_allowed_via_annotations(self, gc_dual):
        job = AnnotationAccessor(gc_dual, "ds_001").compute(
            image="dual:latest"
        )
        assert isinstance(job, Job)

    def test_allowed_via_properties(self, gc_dual):
        job = PropertyAccessor(gc_dual, "ds_001").compute(
            make_property("dual:latest")
        )
        assert isinstance(job, Job)


class TestValidationIsBestEffort:
    """When the role cannot be determined, submission proceeds — the
    check only rejects a KNOWN mismatch."""

    def _submit_both(self, mock_gc):
        mock_gc.post.return_value = [{"_id": "job_1", "status": 1}]
        job_a = AnnotationAccessor(mock_gc, "ds_001").compute(
            image="unknown:latest"
        )
        job_p = PropertyAccessor(mock_gc, "ds_001").compute(
            make_property("unknown:latest")
        )
        assert isinstance(job_a, Job)
        assert isinstance(job_p, Job)

    def test_image_not_in_listing(self, mock_gc):
        mock_gc.get.return_value = dict(WORKERS)
        self._submit_both(mock_gc)

    def test_no_role_labels(self, mock_gc):
        mock_gc.get.return_value = {
            "unknown:latest": {"interfaceName": "Mystery"},
        }
        self._submit_both(mock_gc)

    def test_discovery_endpoint_http_error(self, mock_gc):
        from girder_client import HttpError

        mock_gc.get.side_effect = HttpError(
            status=403,
            text="forbidden",
            url="/worker_interface/available",
            method="GET",
        )
        self._submit_both(mock_gc)

    def test_non_dict_listing_response(self, mock_gc):
        mock_gc.get.return_value = None
        self._submit_both(mock_gc)

    def test_unconfigured_mock_listing(self, mock_gc):
        """A bare MagicMock listing (as in older tests that never
        configure gc.get) is not a dict and must not break compute."""
        mock_gc.get.return_value = MagicMock()
        self._submit_both(mock_gc)


class TestCheapChecksStillFailFirst:
    """Argument validation stays ahead of the role check, so bad
    arguments fail without an HTTP round-trip."""

    def test_connect_to_missing_tags_skips_discovery(self, mock_gc):
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        with pytest.raises(ValueError, match="tags"):
            accessor.compute(
                image=PROPERTY_IMAGE, connect_to={"channel": 0}
            )
        mock_gc.get.assert_not_called()

    def test_property_without_id_skips_discovery(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")
        prop = Property(
            id=None, name="Area", shape="polygon",
            image=ANNOTATION_IMAGE,
        )

        with pytest.raises(ValueError, match="saved to the server"):
            accessor.compute(prop)
        mock_gc.get.assert_not_called()
