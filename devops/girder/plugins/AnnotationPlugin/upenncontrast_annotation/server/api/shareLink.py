import datetime

import cherrypy
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute, describeRoute
from girder.api.rest import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder

from ..helpers.validation import requireInt, requireObjectBody, requireObjectId
from ..models.collection import Collection as CollectionModel
from ..models.datasetView import DatasetView as DatasetViewModel
from ..models.shareLink import MAX_LABEL_LENGTH, ShareLink as ShareLinkModel

MAX_DAYS = 3650


def _cookieDays(token):
    """The cookie lives as long as the token does."""
    expires = token["expires"]
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    remaining = expires - datetime.datetime.now(datetime.timezone.utc)
    return max(remaining.total_seconds() / 86400, 1 / 24)


class ShareLink(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "share_link"
        self._model = ShareLinkModel()
        self.route("POST", (), self.create)
        self.route("GET", (), self.find)
        self.route("GET", ("me",), self.me)
        self.route("DELETE", (":id",), self.revoke)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Create a share-view link for a dataset view")
        .notes("Needs ADMIN on the dataset. Body: {datasetViewId, days? "
               "(omit or 0 for no expiry, at most %d), label?}. The token "
               "is returned once; the client builds #/shared/<token>."
               % MAX_DAYS)
        .param("body", "JSON, see notes", paramType="body")
        .errorResponse()
        .errorResponse("Admin access denied.", 403)
    )
    def create(self, params):
        user = self.getCurrentUser()
        body = requireObjectBody(self.getBodyJson())
        # The same levels the named-share endpoint demands: a link grants
        # READ on the view and its configuration, so the creator must be
        # allowed to share them (WRITE), and sharing the dataset is the
        # owner's call (ADMIN on the folder, like set_public).
        datasetView = DatasetViewModel().load(
            requireObjectId(body.get("datasetViewId"), "datasetViewId"),
            user=user, level=AccessType.WRITE, exc=True,
        )
        dataset = Folder().load(
            datasetView["datasetId"], user=user, level=AccessType.ADMIN,
            exc=True,
        )
        configuration = CollectionModel().load(
            datasetView["configurationId"], user=user,
            level=AccessType.WRITE, exc=True,
        )
        days = requireInt(body.get("days", 0), "days")
        if not 0 <= days <= MAX_DAYS:
            raise RestException(
                "days must be between 0 and %d" % MAX_DAYS, code=400
            )
        label = body.get("label", "")
        if not isinstance(label, str) or len(label) > MAX_LABEL_LENGTH:
            raise RestException(
                "label must be at most %d characters" % MAX_LABEL_LENGTH,
                code=400,
            )
        document, token = self._model.create(
            datasetView, configuration, dataset, user, days, label.strip()
        )
        return {**self._model.serialize(document), "token": token}

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description("List a dataset's live share links (without tokens)")
        .notes("Needs WRITE on the dataset: who shared it and until when is "
               "the sharers' business, not every reader's.")
        .param("datasetId", "The dataset (folder) id", required=True)
        .errorResponse("Write access denied.", 403)
    )
    def find(self, datasetId):
        datasetId = requireObjectId(datasetId, "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.WRITE,
            exc=True,
        )
        return [
            self._model.serialize(document)
            for document in self._model.forDataset(datasetId)
        ]

    @access.user(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("The link the request's token belongs to")
        .notes("For the shared viewer: which dataset view to open. 404 when "
               "the token is not a share link's (an ordinary login). Also "
               "sets the girderToken cookie to the link token when the "
               "browser has none, so <img>-loaded tiles authenticate.")
        .errorResponse("Not a share link.", 404)
    )
    def me(self, params):
        user, token = self.getCurrentUser(returnToken=True)
        document = self._model.forLinkUser(user["_id"])
        if document is None or self._model.isExpired(document):
            raise RestException("This token is not a live share link.", 404)
        # Image, annotation-raster and density tiles load through <img>
        # requests, which Girder authenticates from the HttpOnly girderToken
        # cookie alone. Set it to the link token — but never over a cookie
        # the browser already has, which is some user's own login.
        if "girderToken" not in cherrypy.request.cookie:
            self.sendAuthTokenCookie(
                user, token=token, days=_cookieDays(token)
            )
        return self._model.serialize(document)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Revoke a share link")
        .param("id", "The link id", paramType="path")
        .errorResponse("Admin access denied.", 403)
        .errorResponse("Unknown link.", 404)
    )
    def revoke(self, id, params):
        document = self._model.load(requireObjectId(id, "id"))
        if document is None:
            raise RestException("Unknown share link.", code=404)
        Folder().load(
            document["datasetId"], user=self.getCurrentUser(),
            level=AccessType.ADMIN, exc=True,
        )
        if not document.get("revoked"):
            document = self._model.revoke(document)
        return self._model.serialize(document)
