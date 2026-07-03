from bson.objectid import ObjectId

from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder

from ..helpers.dataImport import importAnnotationData
from ..helpers.proxiedModel import recordable, memoizeBodyJson


# Helper function to get dataset ID for the recordable endpoint


def getDatasetIdFromImportBody(self: "DataImport", *args, **kwargs):
    body = kwargs["memoizedBodyJson"]
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
        .errorResponse("Missing datasetId.", 400)
        .errorResponse("Write access was denied for the dataset.", 403)
    )
    @memoizeBodyJson
    @recordable("Import annotation data", getDatasetIdFromImportBody)
    def importData(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]

        datasetIdString = body.get("datasetId")
        if not datasetIdString:
            raise RestException("Missing datasetId", code=400)
        datasetId = ObjectId(datasetIdString)

        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )

        return importAnnotationData(
            datasetId,
            body.get("annotations", []),
            body.get("connections", []),
            body.get("propertyValues", {}),
            body.get("propertyIdMap", {}),
        )
