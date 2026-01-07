"""
Export API for downloading annotation data as JSON.

This endpoint provides a memory-efficient way to export annotations,
connections, properties, and property values for a dataset.
"""

import orjson

from bson.objectid import ObjectId

from girder.api import access
from girder.api.describe import autoDescribeRoute, Description
from girder.api.rest import Resource, setResponseHeader
from girder.constants import AccessType
from girder.models.folder import Folder

from ..models.annotation import Annotation as AnnotationModel
from ..models.connections import AnnotationConnection as ConnectionModel
from ..models.propertyValues import AnnotationPropertyValues as PropertyValuesModel
from ..models.property import AnnotationProperty as PropertyModel
from ..models.collection import Collection as CollectionModel
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
        .errorResponse("Dataset not found or access denied", 404)
    )
    def exportJson(
        self,
        datasetId,
        configurationId=None,
        includeAnnotations=True,
        includeConnections=True,
        includeProperties=True,
        includePropertyValues=True
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

        setResponseHeader("Content-Type", "application/json")

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
            yield b'{'
            first_section = True

            # Annotations
            if includeAnnotations:
                if not first_section:
                    yield b','
                first_section = False
                yield b'"annotations":'
                yield from self._streamAnnotations(datasetId)

            # Connections
            if includeConnections:
                if not first_section:
                    yield b','
                first_section = False
                yield b'"annotationConnections":'
                yield from self._streamConnections(datasetId)

            # Properties
            if includeProperties:
                if not first_section:
                    yield b','
                first_section = False
                yield b'"annotationProperties":'
                yield from self._streamProperties(datasetId, configurationId)

            # Property Values
            if includePropertyValues:
                if not first_section:
                    yield b','
                first_section = False
                yield b'"annotationPropertyValues":'
                yield from self._streamPropertyValues(datasetId)

            yield b'}'

        return generate

    def _streamAnnotations(self, datasetId):
        """Stream annotations as a JSON array."""
        cursor = self._annotationModel.find(
            {"datasetId": datasetId}
        ).hint([("datasetId", 1), ("_id", 1)])
        yield from self._streamCursorAsArray(cursor)

    def _streamConnections(self, datasetId):
        """Stream connections as a JSON array."""
        cursor = self._connectionModel.find(
            {"datasetId": datasetId}
        ).hint([("datasetId", 1), ("_id", 1)])
        yield from self._streamCursorAsArray(cursor)

    def _streamProperties(self, datasetId, configurationId):
        """
        Stream property definitions as a JSON array.

        If configurationId is provided, gets properties from that
        configuration. Otherwise, aggregates properties from all
        configurations for the dataset.
        """
        propertyIds = set()

        if configurationId:
            # Get specific configuration
            config = self._collectionModel.load(configurationId, force=True)
            if config and 'meta' in config and 'propertyIds' in config['meta']:
                for pid in config['meta']['propertyIds']:
                    propertyIds.add(ObjectId(pid))
        else:
            # Aggregate from all configurations for this dataset
            configs = self._collectionModel.find({"folderId": datasetId})
            for config in configs:
                if 'meta' in config and 'propertyIds' in config['meta']:
                    for pid in config['meta']['propertyIds']:
                        propertyIds.add(ObjectId(pid))

        if propertyIds:
            cursor = self._propertyModel.find(
                {"_id": {"$in": list(propertyIds)}}
            )
            yield from self._streamCursorAsArray(cursor)
        else:
            yield b'[]'

    def _streamPropertyValues(self, datasetId):
        """
        Stream property values as a JSON object keyed by annotationId.

        The backend stores property values as individual documents:
        {"annotationId": "abc", "values": {"propId1": {"Area": 100}}}

        This method transforms them into the frontend format:
        {"abc": {"propId1": {"Area": 100}}}
        """
        cursor = self._propertyValuesModel.find(
            {"datasetId": datasetId}
        ).hint([("datasetId", 1), ("_id", 1)])

        yield b'{'
        first = True

        for doc in cursor:
            annotationId = str(doc["annotationId"])
            values = doc.get("values", {})

            if not first:
                yield b','
            first = False

            # Output: "annotationId": {...values...}
            yield orjson.dumps(annotationId)
            yield b':'
            yield orjson.dumps(values, default=orJsonDefaults)

        yield b'}'

    def _streamCursorAsArray(self, cursor, chunk_size=1000):
        """
        Generic helper to stream a MongoDB cursor as a JSON array.

        Yields chunks of JSON to avoid building the entire array in memory.
        """
        chunk = [b"["]
        first = True
        count = 0

        for doc in cursor:
            if not first:
                chunk.append(b",")
            chunk.append(orjson.dumps(doc, default=orJsonDefaults))
            first = False
            count += 1

            if count >= chunk_size:
                yield b"".join(chunk)
                chunk = []
                count = 0

        chunk.append(b"]")
        yield b"".join(chunk)
