import json

import pytest

from pytest_girder.assertions import assertStatusOk

from upenncontrast_annotation.server.models.property import (
    AnnotationProperty,
)

from girder.constants import AccessType


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyEndpoints:
    """REST API endpoint tests for annotation properties."""

    def _createProperty(self, admin):
        prop = {
            "name": "test-prop",
            "image": "test-image:latest",
            "shape": "point",
            "tags": {
                "tags": ["tag1"],
                "exclusive": False,
            },
            "workerInterface": {},
        }
        model = AnnotationProperty()
        model.setUserAccess(
            prop, user=admin,
            level=AccessType.ADMIN, save=False
        )
        return model.save(prop)

    def testUpdateIgnoresUnknownFields(self, admin, server):
        """PUT /annotation_property/:id drops unknown fields."""
        prop = self._createProperty(admin)
        update_body = {
            "name": "updated-prop",
            "_malicious": "should be dropped",
            "accessLevel": 99,
            "unknownField": True,
        }
        resp = server.request(
            path="/annotation_property/%s" % prop["_id"],
            method="PUT",
            user=admin,
            body=json.dumps(update_body),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded = AnnotationProperty().load(
            prop["_id"], user=admin
        )
        assert loaded["name"] == "updated-prop"
        assert "_malicious" not in loaded
        assert "accessLevel" not in loaded
        assert "unknownField" not in loaded
