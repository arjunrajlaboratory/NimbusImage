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
        datasetView = DatasetViewModel().load(
            requireObjectId(body.get("datasetViewId"), "datasetViewId"),
            user=user, level=AccessType.READ, exc=True,
        )
        # Sharing is the dataset owner's call: ADMIN on the folder, like
        # set_public.
        dataset = Folder().load(
            datasetView["datasetId"], user=user, level=AccessType.ADMIN,
            exc=True,
        )
        configuration = CollectionModel().load(
            datasetView["configurationId"], user=user,
            level=AccessType.READ, exc=True,
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

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("List a dataset's live share links (without tokens)")
        .param("datasetId", "The dataset (folder) id", required=True)
        .errorResponse("Read access denied.", 403)
    )
    def find(self, datasetId):
        datasetId = requireObjectId(datasetId, "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
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
               "the token is not a share link's (an ordinary login).")
        .errorResponse("Not a share link.", 404)
    )
    def me(self, params):
        document = self._model.forLinkUser(self.getCurrentUser()["_id"])
        if document is None or self._model.isExpired(document):
            raise RestException("This token is not a live share link.", 404)
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
