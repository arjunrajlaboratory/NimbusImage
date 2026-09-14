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


# JSON has no integer size limit, so a caller can send an int too large to
# convert to float. float(bigint) and math.isfinite(bigint) both raise
# OverflowError — which is neither TypeError nor ValueError — so unguarded
# checks turn it into a 500 on endpoints whose whole point is clean 400s.
HUGE_INT = 10 ** 1000


class TestIsFiniteNumber:
    def testAcceptsIntAndFloat(self):
        for value in (0, -3, 2.5):
            assert validation.isFiniteNumber(value) is True

    def testRejectsNonNumbersBoolsAndNonFinite(self):
        for value in (None, "1", True, float("nan"), float("inf")):
            assert validation.isFiniteNumber(value) is False

    def testHugeIntIsNonFiniteNotAnError(self):
        assert validation.isFiniteNumber(HUGE_INT) is False


class TestRequireFloat:
    def testParsesNumericStrings(self):
        assert validation.requireFloat("2.5", "pointRadius") == 2.5

    def testHugeIntIsABadRequestNotA500(self):
        with pytest.raises(RestException):
            validation.requireFloat(HUGE_INT, "pointRadius")


class TestOptionalBoolean:
    def testMissingKeyReturnsDefault(self):
        assert validation.optionalBoolean({}, "dryRun", False) is False
        assert validation.optionalBoolean({}, "createView", True) is True

    def testPresentBooleanIsReturned(self):
        assert validation.optionalBoolean(
            {"dryRun": True}, "dryRun", False
        ) is True

    def testTruthyNonBooleansAreRejected(self):
        """JSON strings/numbers must not be truthy-coerced: "false" and 1
        would both silently read as True."""
        for badValue in ("false", "true", 1, 0, None, [], {}):
            with pytest.raises(RestException):
                validation.optionalBoolean(
                    {"dryRun": badValue}, "dryRun", False
                )


class TestGateVertexValidation:
    def testHugeIntVertexIsABadRequestNotA500(self):
        """Gate vertices reach the finite check on PUBLIC analysis
        endpoints, so a huge-int coordinate must 400, not OverflowError."""
        gate = {
            "categoryKeyVersion": validation.ANALYSIS_CATEGORY_KEY_VERSION,
            "vertices": [{"x": HUGE_INT, "y": 0}],
            "xCategories": None,
            "yCategories": None,
        }
        axis = {"type": "property", "path": ["p"]}
        with pytest.raises(RestException):
            validation._validateGateObject(gate, axis, axis)
