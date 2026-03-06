from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.models.assetstore import Assetstore
from girder.models.folder import Folder
from girder.constants import AccessType
from import_tracker.utils import moveFolder


class UserAssetstore(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "user_assetstore"

        self._assetstoreModel: Assetstore = Assetstore()

        self.route("GET", (), self.find)
        self.route("PUT", (":id", "move"), self.moveFolder)

    @access.user
    @autoDescribeRoute(
        Description(("Get a list of available assetstores")).pagingParams(
            defaultSort="name"
        )
    )
    def find(self, limit, offset, sort):
        return self._assetstoreModel.list(
            offset=offset, limit=limit, sort=sort
        )

    @access.user
    @autoDescribeRoute(
        Description("Move folder contents to an assetstore.")
        .modelParam(
            "id", "Source folder ID", model=Folder, level=AccessType.WRITE
        )
        .modelParam(
            "assetstoreId",
            "Destination assetstore ID",
            model=Assetstore,
            paramType='query',
        )
        .param(
            "ignoreImported",
            "Ignore files that have been directly imported",
            dataType="boolean",
            default=True,
            required=True,
        )
        .param(
            "progress",
            "Whether to record progress on the move.",
            dataType="boolean",
            default=False,
            required=False,
        )
    )
    def moveFolder(self, folder, assetstore, ignoreImported, progress):
        user = self.getCurrentUser()
        return moveFolder(user, folder, assetstore, ignoreImported, progress)
