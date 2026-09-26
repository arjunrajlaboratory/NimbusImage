"""A registry reference cannot outlive the source item's dataset ACL."""
import pytest

from girder.constants import AccessType
from girder.models.folder import Folder
from girder.models.item import Item
from pytest_girder.assertions import assertStatus

from .test_spatial import TestSpatial as SpatialFixture, request
from .test_phase2 import postJson
from .test_transcripts import TestTranscripts as TranscriptsFixture


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestProviderAccess:
    @pytest.mark.parametrize(
        "consumer", ["list", "summary", "filter", "batch"],
    )
    def testMovedSourceRefusesVirtualReads(
        self, admin, user, server, tmp_path, fsAssetstore, consumer,
    ):
        fixture = SpatialFixture()
        folder, annotations, item = fixture._setup(admin, tmp_path)
        Folder().setPublic(folder, False, save=True)
        Folder().setUserAccess(folder, user, AccessType.READ, save=True)
        fixture._register(server, admin, folder, item)
        path = ["spatial", "CD3E"]
        body = {"datasetId": str(folder["_id"]), "filters": {}}
        if consumer == "filter":
            endpoint = "/upenn_annotation/list/ids"
            body["filters"] = {"propertyFilters": [
                {"path": path, "mode": "range", "min": 1},
            ]}
        elif consumer == "batch":
            endpoint = "/annotation_property_values/batch"
            body.update(annotationIds=[str(a["_id"]) for a in annotations],
                        propertyPaths=[path])
        else:
            endpoint = "/upenn_annotation/" + consumer
            body["propertyPaths"] = [path]
        # Warm the provider's store cache before the move.
        assertStatus(postJson(server, user, endpoint, body), 200)
        private = Folder().findOne({
            "parentId": admin["_id"], "name": "Private",
        })
        Item().move(item, private)
        assertStatus(request(
            server, user, "GET", "/spatial/%s" % folder["_id"],
        ), 403)
        assertStatus(postJson(server, user, endpoint, body), 403)
        # Moving back restores valid affiliation without re-registering.
        Item().move(item, folder)
        assertStatus(postJson(server, user, endpoint, body), 200)

    def testMovedSourcesRefuseDirectOpenersEvenWithReadOnBoth(
        self, admin, server, tmp_path, fsAssetstore,
    ):
        # The admin reads both folders, so the ACL alone would not stop a
        # moved table or transcript store being answered as this dataset's.
        fixture = TranscriptsFixture()
        folder, _, table, transcripts = fixture._setupTranscripts(
            admin, tmp_path
        )
        fixture._register(server, admin, folder, table)
        fixture._registerTranscripts(server, admin, folder, transcripts)
        features = "/spatial/%s/features" % folder["_id"]
        genes = "/spatial/%s/transcripts/genes" % folder["_id"]
        for path in (features, genes):
            assertStatus(request(server, admin, "GET", path), 200)
        elsewhere = Folder().findOne({
            "parentId": admin["_id"], "name": "Private",
        })
        Item().move(table, elsewhere)
        Item().move(transcripts, elsewhere)
        for path in (features, genes):
            assertStatus(request(server, admin, "GET", path), 403)
        Item().move(table, folder)
        Item().move(transcripts, folder)
        for path in (features, genes):
            assertStatus(request(server, admin, "GET", path), 200)
