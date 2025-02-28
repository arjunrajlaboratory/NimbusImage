from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from ..models.workerPreviews import WorkerPreviewModel as PreviewModel
from girder.exceptions import RestException


class WorkerPreviews(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "worker_preview"
        self._previewModel = PreviewModel()

        self.route("GET", (), self.find)
        self.route("POST", (), self.update)
        self.route("DELETE", (), self.clearImagePreview)
        self.route("POST", ("request",), self.requestWorkerUpdate)

    @describeRoute(
        Description("Clear the preview for a worker").param(
            "image", "The docker image name for the worker."
        )
    )
    @access.user
    def clearImagePreview(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        return self._previewModel.delete(image)

    @describeRoute(
        Description("Update an existing preview")
        .param("image", "The docker image name for the worker.")
        .param(
            "body", "A JSON object describing the preview.", paramType="body"
        )
        .errorResponse("Write access was denied for the item.", 403)
        .errorResponse("Invalid JSON passed in request body.")
        .errorResponse("Validation Error: JSON doesn't follow schema.")
    )
    @access.user
    def update(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        return self._previewModel.updateWorkerPreview(
            self.getCurrentUser(), image, self.getBodyJson()
        )

    @access.user
    @describeRoute(
        Description("Get a preview for the given image").param(
            "image", "The docker image name for the worker."
        )
    )
    def find(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        return self._previewModel.getImagePreview(image) or {}

    @access.user
    @describeRoute(
        Description("Ask the worker to update its preview data")
        .param("datasetId", "The dataset Id", required=False)
        .param(
            "image", "The docker image name for the worker.", required=False
        )
        .param(
            "body",
            "A JSON object containing the worker parameters",
            paramType="body",
        )
    )
    def requestWorkerUpdate(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        datasetId = params.get("datasetId", None)
        if not datasetId:
            raise RestException(
                code=400, message="Missing datasetId parameter"
            )
        return self._previewModel.requestPreviewUpdate(
            image, datasetId, self.getBodyJson(), self.getCurrentUser()
        )
