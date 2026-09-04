"""Share-view links: a hidden link user with READ on one dataset view and a
DATA_READ token; bearers read that dataset and nothing else."""

import json

import pytest
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.models.folder import Folder
from girder.models.token import Token
from girder.models.user import User

from upenncontrast_annotation.server.models.shareLink import (
    ShareLink as ShareLinkModel,
)

from .test_sharing import createDatasetWithView


def privateDatasetWithView(creator):
    """createDatasetWithView puts the folder under the creator's Public
    folder; sharing tests need it private."""
    dataset, config, view = createDatasetWithView(creator)
    return Folder().setPublic(dataset, False, save=True), config, view


def request(server, method, path, user=None, token=None, body=None,
            params=None):
    kwargs = {"path": path, "method": method}
    if user is not None:
        kwargs["user"] = user
    if token is not None:
        kwargs["token"] = token
    if body is not None:
        kwargs.update(body=json.dumps(body), type="application/json")
    if params is not None:
        kwargs["params"] = params
    return server.request(**kwargs)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestShareLink:
    def _link(self, server, admin, view, **extra):
        resp = request(server, "POST", "/share_link", user=admin,
                       body={"datasetViewId": str(view["_id"]), **extra})
        assertStatusOk(resp)
        return resp.json

    def testBearerReadsOnlyTheSharedDataset(self, admin, server):
        dataset, config, view = privateDatasetWithView(admin)
        other, _, otherView = privateDatasetWithView(admin)
        link = self._link(server, admin, view, days=30, label="reviewers")
        assert link["expiresAt"] is not None and link["expired"] is False
        token = link["token"]
        assert len(token) == 64

        # The client bootstraps with user/me, which needs USER_INFO_READ.
        whoami = request(server, "GET", "/user/me", token=token)
        assertStatusOk(whoami)
        assert whoami.json["login"].startswith("share-")
        # The marker the client keys its bearer-session behavior on.
        assert whoami.json["shareLink"]["datasetId"] == str(dataset["_id"])
        me = request(server, "GET", "/share_link/me", token=token)
        assertStatusOk(me)
        assert me.json["datasetViewId"] == str(view["_id"])
        # Tile URLs carry the link token explicitly, so visiting a link never
        # overwrites an ambient login cookie or creates a persistent link-user
        # cookie in this browser profile.
        assert "girderToken" not in me.cookie
        assert User().findOne({"login": {"$regex": "^share-"}})["status"] == (
            "enabled"
        )
        # A browser that already has a cookie (a user's own login) keeps it.
        kept = server.request(
            path="/share_link/me", method="GET", token=token,
            cookie="girderToken=someoneelse",
        )
        assertStatusOk(kept)
        assert "girderToken" not in kept.cookie
        # The cookie alone authenticates a cookie route for the bearer.
        cookieOnly = server.request(
            path="/folder/%s" % dataset["_id"], method="GET",
            cookie="girderToken=%s" % token,
        )
        # /folder is not a cookie route, so this must be refused...
        assertStatus(cookieOnly, 401)
        # ...while the annotation raster route (cookie=True) accepts it.
        raster = server.request(
            path="/upenn_annotation/raster/0/0/0", method="GET",
            cookie="girderToken=%s" % token,
            params={"datasetId": str(dataset["_id"]), "selectors": "[]",
                    "sizeX": 256, "sizeY": 256, "maxLevel": 0},
        )
        assert raster.output_status.startswith(b"200") or (
            raster.output_status.startswith(b"400")
        ), raster.output_status
        assert me.json["label"] == "reviewers"
        assert "token" not in me.json

        # The shared dataset, view and configuration read; the other dataset
        # does not; writing is refused by the token's scope.
        assertStatusOk(request(
            server, "GET", "/folder/%s" % dataset["_id"], token=token
        ))
        assertStatusOk(request(
            server, "GET", "/dataset_view/%s" % view["_id"], token=token
        ))
        assertStatusOk(request(
            server, "GET", "/upenn_collection/%s" % config["_id"], token=token
        ))
        assertStatus(request(
            server, "GET", "/folder/%s" % other["_id"], token=token
        ), 403)
        assertStatus(request(
            server, "GET", "/dataset_view/%s" % otherView["_id"], token=token
        ), 403)
        assertStatus(request(
            server, "PUT", "/folder/%s" % dataset["_id"], token=token,
            params={"name": "renamed"},
        ), 401)
        # A share link cannot mint more links.
        assertStatus(request(
            server, "POST", "/share_link", token=token,
            body={"datasetViewId": str(view["_id"])},
        ), 401)
        # ...nor download the dataset's files, although its READ ACL would
        # otherwise allow it (Girder has no view-only scope).
        assertStatus(request(
            server, "GET", "/folder/%s/download" % dataset["_id"], token=token
        ), 403)
        assertStatus(request(
            server, "GET", "/export/json", token=token,
            params={"datasetId": str(dataset["_id"])},
        ), 403)
        # The owner still can.
        assertStatusOk(server.request(
            path="/folder/%s/download" % dataset["_id"], method="GET",
            user=admin, isJson=False,
        ))
        assertStatusOk(request(
            server, "GET", "/export/json", user=admin,
            params={"datasetId": str(dataset["_id"])},
        ))
        # Link users do not appear in user listings.
        listed = request(server, "GET", "/user", user=admin,
                         params={"text": "share-"})
        assertStatusOk(listed)
        assert not any(u["login"].startswith("share-") for u in listed.json)

    def testCreateNeedsAdminAndValidInput(self, admin, user, server):
        dataset, config, view = privateDatasetWithView(admin)
        assertStatus(request(
            server, "POST", "/share_link", user=user,
            body={"datasetViewId": str(view["_id"])},
        ), 403)
        # ADMIN on the folder but only READ on the configuration is not
        # enough: a link would hand out READ on a configuration the caller
        # may not share.
        from girder.models.folder import Folder as FolderModel
        from upenncontrast_annotation.server.models.collection import (
            Collection,
        )
        from upenncontrast_annotation.server.models.datasetView import (
            DatasetView,
        )
        FolderModel().setUserAccess(
            dataset, user, AccessType.ADMIN, save=True
        )
        DatasetView().setUserAccess(view, user, AccessType.WRITE, save=True)
        Collection().setUserAccess(config, user, AccessType.READ, save=True)
        assertStatus(request(
            server, "POST", "/share_link", user=user,
            body={"datasetViewId": str(view["_id"])},
        ), 403)
        Collection().setUserAccess(config, user, AccessType.WRITE, save=True)
        assertStatusOk(request(
            server, "POST", "/share_link", user=user,
            body={"datasetViewId": str(view["_id"])},
        ))
        for body in (
            {},
            {"datasetViewId": "nope"},
            {"datasetViewId": str(view["_id"]), "days": -1},
            {"datasetViewId": str(view["_id"]), "days": 99999},
            {"datasetViewId": str(view["_id"]), "days": "soon"},
            {"datasetViewId": str(view["_id"]), "label": "x" * 121},
        ):
            assertStatus(
                request(server, "POST", "/share_link", user=admin, body=body),
                400,
            )
        # No expiry: expiresAt is null but the token still has a lifetime.
        link = self._link(server, admin, view)
        assert link["expiresAt"] is None

    def testListAndRevoke(self, admin, user, server):
        dataset, config, view = privateDatasetWithView(admin)
        first = self._link(server, admin, view, label="a")
        second = self._link(server, admin, view, label="b")
        listed = request(
            server, "GET", "/share_link", user=admin,
            params={"datasetId": str(dataset["_id"])},
        )
        assertStatusOk(listed)
        assert [x["label"] for x in listed.json] == ["a", "b"]
        assert all("token" not in x for x in listed.json)
        # Listing needs WRITE on the dataset: a reader sees none of it.
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)
        assertStatus(request(
            server, "GET", "/share_link", user=user,
            params={"datasetId": str(dataset["_id"])},
        ), 403)

        # Revoking needs ADMIN; afterwards the token is dead and the link
        # user gone, and the link leaves the listing.
        assertStatus(request(
            server, "DELETE", "/share_link/%s" % first["_id"], user=user
        ), 403)
        assertStatusOk(request(
            server, "DELETE", "/share_link/%s" % first["_id"], user=admin
        ))
        assertStatus(request(
            server, "GET", "/share_link/me", token=first["token"]
        ), 401)
        assertStatus(request(
            server, "GET", "/folder/%s" % dataset["_id"], token=first["token"]
        ), 401)
        assert User().findOne({"login": {"$regex": "^share-"}}) is not None
        assert User().find({"login": {"$regex": "^share-"}}).count() == 1
        listed = request(
            server, "GET", "/share_link", user=admin,
            params={"datasetId": str(dataset["_id"])},
        )
        assert [x["label"] for x in listed.json] == ["b"]
        # Revoking twice is idempotent; an unknown id is a 404.
        assertStatusOk(request(
            server, "DELETE", "/share_link/%s" % first["_id"], user=admin
        ))
        assertStatus(request(
            server, "DELETE", "/share_link/%s" % ("0" * 24), user=admin
        ), 404)
        assert second["token"]

    def testOrdinaryLoginIsNotALink(self, admin, server):
        resp = request(server, "GET", "/share_link/me", user=admin)
        assertStatus(resp, 404)

    def testExpiredLinkIsRefused(self, admin, server):
        dataset, config, view = privateDatasetWithView(admin)
        link = self._link(server, admin, view, days=1)
        model = ShareLinkModel()
        document = model.load(link["_id"])
        import datetime
        document["expiresAt"] = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=1)
        )
        model.save(document, validate=False)
        assertStatus(request(
            server, "GET", "/share_link/me", token=link["token"]
        ), 404)
        assert model.serialize(document)["expired"] is True
        # The Girder token's own expiry is what Girder enforces on reads;
        # revoke drops it regardless.
        assert Token().load(link["token"], force=True, objectId=False)
