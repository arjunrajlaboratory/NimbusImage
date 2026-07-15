from bson.objectid import ObjectId
from bson.errors import InvalidId

from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder

from ..helpers.dataImport import importAnnotationData
from ..helpers.proxiedModel import recordable, memoizeBodyJson


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
        .errorResponse("Missing datasetId.", 400)
        .errorResponse("Write access was denied for the dataset.", 403)
    )
    @memoizeBodyJson
    @recordable("Import annotation data", getDatasetIdFromImportBody)
    def importData(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        if not isinstance(body, dict):
            raise RestException(
                "Request body must be a JSON object.", code=400
            )

        datasetIdString = body.get("datasetId")
        if not datasetIdString:
            raise RestException("Missing datasetId", code=400)
        # ObjectId() raises InvalidId for a malformed string and TypeError
        # for a non-string (e.g. a JSON number/bool); both are bad input.
        try:
            datasetId = ObjectId(datasetIdString)
        except (InvalidId, TypeError) as exc:
            raise RestException("Invalid datasetId", code=400) from exc

        annotations = body.get("annotations", [])
        connections = body.get("connections", [])
        propertyValues = body.get("propertyValues", {})
        propertyIdMap = body.get("propertyIdMap", {})
        # (field name, value, expected type, type label) per optional field.
        for name, value, expectedType, typeLabel in (
            ("annotations", annotations, list, "array"),
            ("connections", connections, list, "array"),
            ("propertyValues", propertyValues, dict, "object"),
            ("propertyIdMap", propertyIdMap, dict, "object"),
        ):
            if not isinstance(value, expectedType):
                raise RestException(
                    "%s must be a JSON %s." % (name, typeLabel), code=400
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
