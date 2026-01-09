"""
Export API for downloading annotation data as JSON.

This endpoint provides a memory-efficient way to export annotations,
connections, properties, and property values for a dataset.
"""

from bson.objectid import ObjectId

from girder.api import access
from girder.api.describe import autoDescribeRoute, Description
from girder.api.rest import Resource, setResponseHeader, setContentDisposition
from girder.constants import AccessType
from girder.models.folder import Folder

from ..models.annotation import Annotation as AnnotationModel
from ..models.connections import AnnotationConnection as ConnectionModel
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel
)
from ..models.property import AnnotationProperty as PropertyModel
from ..models.collection import Collection as CollectionModel
from ..models.datasetView import DatasetView as DatasetViewModel
from ..helpers.serialization import jsonGenerator


class Export(Resource):
    """REST API resource for exporting annotation data."""

    def __init__(self):
        super().__init__()
        self.resourceName = "export"

        self.exportBufferLength = 1000

        self._annotationModel = AnnotationModel()
        self._connectionModel = ConnectionModel()
        self._propertyValuesModel = PropertyValuesModel()
        self._propertyModel = PropertyModel()
        self._collectionModel = CollectionModel()
        self._datasetViewModel = DatasetViewModel()

        self.route("GET", ("json",), self.exportJson)

    @access.public
    @autoDescribeRoute(
        Description("Export dataset annotations and related data as JSON")
        .param("datasetId", "The dataset ID", required=True)
        .param(
            "configurationId",
            "Configuration ID to get properties from. If not provided, "
            "properties will be aggregated from all configurations "
            "for the dataset.",
            required=False
        )
        .param(
            "includeAnnotations",
            "Include annotations in export",
            dataType="boolean",
            default=True,
            required=False
        )
        .param(
            "includeConnections",
            "Include annotation connections in export",
            dataType="boolean",
            default=True,
            required=False
        )
        .param(
            "includeProperties",
            "Include property definitions in export",
            dataType="boolean",
            default=True,
            required=False
        )
        .param(
            "includePropertyValues",
            "Include property values in export",
            dataType="boolean",
            default=True,
            required=False
        )
        .param(
            "filename",
            "Filename for the downloaded file",
            default="export.json",
            required=False
        )
        .errorResponse("Dataset not found or access denied", 404)
    )
    def exportJson(
        self,
        datasetId,
        configurationId=None,
        includeAnnotations=True,
        includeConnections=True,
        includeProperties=True,
        includePropertyValues=True,
        filename="export.json"
    ):
        """
        Export annotation data for a dataset as JSON.

        Returns a streaming JSON response with the following structure:
        {
            "annotations": [...],
            "annotationConnections": [...],
            "annotationProperties": [...],
            "annotationPropertyValues": {"annotationId": {"propertyId": value}}
        }
        """
        # Permission check - will raise RestException if access denied
        datasetObjectId = ObjectId(datasetId)
        Folder().load(
            datasetObjectId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True
        )

        configObjectId = ObjectId(configurationId) if configurationId else None

        # Ensure filename ends with .json
        safe_filename = (
            filename if filename.endswith('.json') else filename + '.json'
        )

        setResponseHeader("Content-Type", "application/json")
        setContentDisposition(safe_filename, disposition='attachment')

        return self._generateExportJson(
            datasetObjectId,
            configObjectId,
            includeAnnotations,
            includeConnections,
            includeProperties,
            includePropertyValues
        )

    def _generateExportJson(
        self,
        datasetId,
        configurationId,
        includeAnnotations,
        includeConnections,
        includeProperties,
        includePropertyValues
    ):
        """
        Generator function that yields JSON chunks.

        This is returned as a callable to match Girder's streaming pattern.
        """
        def generate():
            exportObject = {}

            # First construct the JSON object

            # Annotations
            if includeAnnotations:
                exportObject["annotations"] = self._annotationModel.find(
                    {"datasetId": datasetId}
                ).hint([("datasetId", 1), ("_id", 1)])

            # Connections
            if includeConnections:
                exportObject["annotationConnections"] = \
                    self._connectionModel.find(
                    {"datasetId": datasetId}
                ).hint([("datasetId", 1), ("_id", 1)])

            # Properties
            if includeProperties:
                propertyIds = set()

                if configurationId:
                    # Get specific configuration
                    config = self._collectionModel.load(
                        configurationId, force=True)
                    if config and 'meta' in config \
                            and 'propertyIds' in config['meta']:
                        for pid in config['meta']['propertyIds']:
                            propertyIds.add(ObjectId(pid))
                else:
                    # Find all configurations via DatasetViews
                    # Dataset -> DatasetViews -> Configurations
                    datasetViews = list(
                        self._datasetViewModel.collection.find({
                            'datasetId': datasetId
                        }))
                    configIds = {dv['configurationId'] for dv in datasetViews}

                    for configId in configIds:
                        config = self._collectionModel.load(
                            configId, force=True)
                        if (config and 'meta' in config
                                and 'propertyIds' in config['meta']):
                            for pid in config['meta']['propertyIds']:
                                propertyIds.add(ObjectId(pid))

                exportObject["annotationProperties"] = \
                    self._propertyModel.find(
                    {"_id": {"$in": list(propertyIds)}}
                ) if propertyIds else []

            if includePropertyValues:
                exportObject["annotationPropertyValues"] = \
                    self._propertyValuesModel.collection.aggregate([
                        {
                            "$project": {
                                "_id": 0,
                                "k": {"$toString": "$annotationId"},
                                "v": "$values"
                            }
                        },
                        {
                            "$group": {
                                "_id": None,
                                "pairs": {
                                    "$push": {
                                        "k": "$k",
                                        "v": "$v"
                                    }
                                }
                            }
                        },
                        {
                            "$project": {
                                "_id": 0,
                                "result": {
                                    "$arrayToObject": "$pairs"
                                }
                            }
                        },
                        {
                            "$replaceRoot": {
                                "newRoot": "$result"
                            }
                        }
                    ])

            generator = jsonGenerator(exportObject)
            buffer = b""
            while True:
                try:
                    buffer += next(generator)
                    if len(buffer) > self.exportBufferLength:
                        yield buffer
                        buffer = b""
                except StopIteration:
                    break
            yield buffer

        return generate
