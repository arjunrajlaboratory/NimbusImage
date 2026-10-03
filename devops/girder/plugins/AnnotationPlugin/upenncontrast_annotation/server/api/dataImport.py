from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from girder.constants import AccessType, TokenScope
from girder.models.folder import Folder

from ..helpers.dataImport import importAnnotationData
from ..helpers.proxiedModel import recordable, memoizeBodyJson
from ..helpers.validation import (
    requireObjectBody,
    requireList,
    requireObjectId,
)


# Helper function to get dataset ID for the recordable endpoint


def getDatasetIdFromImportBody(*args, **kwargs):
    body = kwargs["memoizedBodyJson"]
    # A non-object body is rejected with a 400 inside importData; return
    # None here so the recordable wrapper doesn't choke on body.get first.
    if not isinstance(body, dict):
        return None
    return body.get("datasetId")


class DataImport(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "annotation_import"

        self.route("POST", (), self.importData)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description(
            "Import annotations, connections, and property values "
            "previously exported from a dataset."
        )
        .notes("""
            Expects a body of the form:
            {
                "datasetId": "<required>",
                "annotations": [...],
                "connections": [...],
                "propertyValues": {
                    "oldAnnotationId": {"oldPropertyId": value}
                },
                "propertyIdMap": {"oldPropertyId": "newPropertyId"}
            }

            Annotations may carry their old id under "_id" (the shape
            produced by the export endpoint) or "id" (a legacy
            frontend export shape); either is accepted. Connections
            and property values reference annotations by their old
            id, which is remapped to the id of the newly created
            annotation. Property values are remapped through
            propertyIdMap; values for a property id missing from that
            map are silently skipped, since an export can legitimately
            include values for properties outside the exported
            property list.
        """)
        .param("body", "The annotation data to import", paramType="body")
        .errorResponse("Missing or malformed input (e.g. datasetId).", 400)
        .errorResponse("Write access was denied for the dataset.", 403)
    )
    @memoizeBodyJson
    @recordable("Import annotation data", getDatasetIdFromImportBody)
    def importData(self, params, *args, **kwargs):
        # Validate the request shape at the API boundary so malformed input
        # is a clean 400 rather than an uncaught 500 (shared validators in
        # helpers/validation.py).
        body = requireObjectBody(kwargs["memoizedBodyJson"])
        datasetId = requireObjectId(body.get("datasetId"), "datasetId")
        annotations = requireList(
            body.get("annotations", []), "annotations"
        )
        connections = requireList(
            body.get("connections", []), "connections"
        )
        propertyValues = requireObjectBody(
            body.get("propertyValues", {}), "propertyValues"
        )
        propertyIdMap = requireObjectBody(
            body.get("propertyIdMap", {}), "propertyIdMap"
        )

        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )

        return importAnnotationData(
            datasetId,
            annotations,
            connections,
            propertyValues,
            propertyIdMap,
        )
