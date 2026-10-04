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
class TestPropertyDistinctValues:
    """GET /annotation_property_values/distinct — categorical filter values."""

    GENES = ["KIT", "KIT", "KIT", "TP53", "TP53", "MYC", "KITLG"]

    def _makeDataset(self, admin, values, name="distinct_ds"):
        folder = utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )
        for value in values:
            annotation = Annotation().create(
                upenn_utilities.getSampleAnnotation(folder["_id"])
            )
            AnnotationPropertyValues().appendValues(
                {"prop": value}, annotation["_id"], folder["_id"]
            )
        return folder

    def _distinct(self, server, user, folder, **params):
        return server.request(
            path="/annotation_property_values/distinct",
            method="GET",
            user=user,
            params={
                "datasetId": str(folder["_id"]),
                "propertyPath": "prop.gene",
                **params,
            },
        )

    def testCountsMostCommonFirstAndSkipsNumbers(self, admin, server):
        folder = self._makeDataset(
            admin,
            [{"gene": gene, "reads": 3} for gene in self.GENES]
            + [{"gene": 42}],
        )
        resp = self._distinct(server, admin, folder)
        assertStatusOk(resp)
        assert resp.json == {
            "values": [
                {"value": "KIT", "count": 3},
                {"value": "TP53", "count": 2},
                {"value": "KITLG", "count": 1},
                {"value": "MYC", "count": 1},
            ],
            "truncated": False,
        }

    def testSearchIsCaseInsensitiveAndLiteral(self, admin, server):
        folder = self._makeDataset(
            admin, [{"gene": gene} for gene in self.GENES + ["K.T"]]
        )
        resp = self._distinct(server, admin, folder, search="kit")
        assertStatusOk(resp)
        assert [e["value"] for e in resp.json["values"]] == ["KIT", "KITLG"]
        # "." is matched literally, not as a regex wildcard.
        resp = self._distinct(server, admin, folder, search="k.t")
        assert [e["value"] for e in resp.json["values"]] == ["K.T"]

    def testLimitReportsTruncation(self, admin, server):
        folder = self._makeDataset(
            admin, [{"gene": gene} for gene in self.GENES]
        )
        resp = self._distinct(server, admin, folder, limit=2)
        assertStatusOk(resp)
        assert [e["value"] for e in resp.json["values"]] == ["KIT", "TP53"]
        assert resp.json["truncated"] is True
        resp = self._distinct(server, admin, folder, limit=4)
        assert resp.json["truncated"] is False

    def testRejectsBadInput(self, admin, server):
        folder = self._makeDataset(admin, [{"gene": "KIT"}])
        assertStatus(
            self._distinct(server, admin, folder, propertyPath="prop.$x"), 400
        )
        assertStatus(
            self._distinct(server, admin, folder, limit="many"), 400
        )
        assertStatus(
            self._distinct(server, admin, folder, search="x" * 201), 400
        )

    def testDeniedWithoutAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "private_distinct", upenn_utilities.datasetMetadata
        )
        assertStatus(self._distinct(server, user, folder), 403)
