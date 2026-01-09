"""
Export API for downloading annotation data as JSON.

This endpoint exports annotations, connections, properties, and property
values for a dataset.
"""

import orjson

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
from ..helpers.serialization import orJsonDefaults


class Export(Resource):
    """REST API resource for exporting annotation data."""

    def __init__(self):
        super().__init__()
        self.resourceName = "export"

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

        Returns a JSON response with the following structure:
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

        # Build export data
        data = {}

        if includeAnnotations:
            data["annotations"] = list(self._annotationModel.find(
                {"datasetId": datasetObjectId}
            ))

        if includeConnections:
            data["annotationConnections"] = list(self._connectionModel.find(
                {"datasetId": datasetObjectId}
            ))

        if includeProperties:
            data["annotationProperties"] = self._getProperties(
                datasetObjectId, configObjectId
            )

        if includePropertyValues:
            data["annotationPropertyValues"] = self._getPropertyValues(
                datasetObjectId
            )

        # Return as generator so Girder streams raw bytes
        def generate():
            yield orjson.dumps(data, default=orJsonDefaults)
        return generate

    def _getProperties(self, datasetId, configurationId):
        """
        Get property definitions as a list.

        If configurationId is provided, gets properties from that
        configuration. Otherwise, finds all configurations associated with
        the dataset via DatasetViews and aggregates their properties.
        """
        propertyIds = set()

        if configurationId:
            # Get specific configuration
            config = self._collectionModel.load(configurationId, force=True)
            if config and 'meta' in config and 'propertyIds' in config['meta']:
                for pid in config['meta']['propertyIds']:
                    propertyIds.add(ObjectId(pid))
        else:
            # Find all configurations via DatasetViews
            # Dataset -> DatasetViews -> Configurations
            datasetViews = list(self._datasetViewModel.collection.find({
                'datasetId': datasetId
            }))
            configIds = {dv['configurationId'] for dv in datasetViews}

            for configId in configIds:
                config = self._collectionModel.load(configId, force=True)
                if (config and 'meta' in config and
                        'propertyIds' in config['meta']):
                    for pid in config['meta']['propertyIds']:
                        propertyIds.add(ObjectId(pid))

        if propertyIds:
            return list(self._propertyModel.find(
                {"_id": {"$in": list(propertyIds)}}
            ))
        return []

    def _getPropertyValues(self, datasetId):
        """
        Get property values as a dict keyed by annotationId.

        The backend stores property values as individual documents:
        {"annotationId": "abc", "values": {"propId1": {"Area": 100}}}

        This method transforms them into the frontend format:
        {"abc": {"propId1": {"Area": 100}}}
        """
        result = {}
        cursor = self._propertyValuesModel.find({"datasetId": datasetId})

        for doc in cursor:
            annotationId = str(doc["annotationId"])
            values = doc.get("values", {})
            result[annotationId] = values

        return result
