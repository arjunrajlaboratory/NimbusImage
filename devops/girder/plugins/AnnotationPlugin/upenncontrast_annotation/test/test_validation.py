"""Unit tests for the shared API-boundary validation helpers.

These exercise the helpers directly (no HTTP layer): the point is that a
malformed caller value becomes a RestException(400) rather than an uncaught
TypeError/AttributeError that would surface as a 500 on a public endpoint.
"""

import pytest

from girder.exceptions import RestException

from upenncontrast_annotation.server.helpers import validation


class TestRequireObjectId:
    def testAcceptsValidHexString(self):
        oid = validation.requireObjectId(
            "0123456789abcdef01234567", "datasetId"
        )
        assert str(oid) == "0123456789abcdef01234567"

    def testMissingValueIsRejected(self):
        with pytest.raises(RestException):
            validation.requireObjectId(None, "datasetId")

    def testMalformedStringIsRejected(self):
        with pytest.raises(RestException):
            validation.requireObjectId("not-a-valid-object-id", "datasetId")

    def testNonStringIsRejectedAsBadRequest(self):
        """A JSON number/bool reaches ObjectId() as a non-str, which raises
        TypeError (not InvalidId). It must still be a clean 400, not a 500."""
        for badValue in (123, True, 1.5):
            with pytest.raises(RestException):
                validation.requireObjectId(badValue, "datasetId")
