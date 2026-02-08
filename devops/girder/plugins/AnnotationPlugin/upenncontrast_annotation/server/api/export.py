"""
Export API for downloading annotation data as JSON or CSV.

This endpoint exports annotations, connections, properties, and property
values for a dataset.
"""

import orjson
from dataclasses import dataclass

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


@dataclass
class CsvColumn:
    """Definition of a CSV column with its quoting behavior."""

    name: str
    is_quoted: bool


# Fixed columns for CSV export, defined at module level for visibility.
# Property columns are added dynamically and are never quoted.
CSV_FIXED_COLUMNS = [
    CsvColumn("Id", is_quoted=True),
    CsvColumn("Channel", is_quoted=False),
    CsvColumn("XY", is_quoted=False),
    CsvColumn("Z", is_quoted=False),
    CsvColumn("Time", is_quoted=False),
    CsvColumn("Tags", is_quoted=True),
    CsvColumn("Shape", is_quoted=True),
    CsvColumn("Name", is_quoted=True),
]


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
        self.route("POST", ("csv",), self.exportCsv)

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

    @access.public
    @autoDescribeRoute(
        Description("Export dataset annotations as CSV")
        .notes("""
            Uses POST to avoid URL length limits with large property/annotation
            lists. This is a read operation that returns a CSV file download.
        """)
        .jsonParam(
            "body",
            "Export parameters",
            paramType="body",
            required=True,
            schema={
                "type": "object",
                "properties": {
                    "datasetId": {
                        "type": "string",
                        "description": "The dataset ID (required)"
                    },
                    "propertyPaths": {
                        "type": "array",
                        "description": "Array of property paths to include",
                        "items": {
                            "type": "array",
                            "items": {"type": "string"}
                        }
                    },
                    "annotationIds": {
                        "type": "array",
                        "description": "Array of annotation IDs to filter",
                        "items": {"type": "string"}
                    },
                    "undefinedValue": {
                        "type": "string",
                        "description": "Value for undefined: '', 'NA', 'NaN'",
                        "default": ""
                    },
                    "filename": {
                        "type": "string",
                        "description": "Filename for download",
                        "default": "export.csv"
                    }
                },
                "required": ["datasetId"]
            }
        )
        .errorResponse("Dataset not found or access denied", 404)
    )
    def exportCsv(self, body):
        """
        Export annotation data for a dataset as CSV.

        CSV format matches the frontend export format exactly:
        - Fixed columns: Id, Channel, XY, Z, Time, Tags, Shape, Name
        - XY, Z, Time are 1-indexed (location + 1)
        - Quoted columns: Id, Tags, Shape, Name
        - Property columns: Named as "PropertyName / SubKey1 / SubKey2"
        """
        # Extract parameters from body
        datasetId = body.get("datasetId")
        propertyPaths = body.get("propertyPaths", [])
        annotationIds = body.get("annotationIds")
        undefinedValue = body.get("undefinedValue", "")
        filename = body.get("filename", "export.csv")

        # Permission check
        datasetObjectId = ObjectId(datasetId)
        Folder().load(
            datasetObjectId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True
        )

        # Property paths are already parsed from JSON body
        parsedPropertyPaths = propertyPaths or []

        parsedAnnotationIds = None
        if annotationIds:
            parsedAnnotationIds = set(annotationIds)

        # Ensure filename ends with .csv
        safe_filename = (
            filename if filename.endswith('.csv') else filename + '.csv'
        )

        setResponseHeader("Content-Type", "text/csv")
        setContentDisposition(safe_filename, disposition='attachment')

        # Build property name mapping
        propertyNameMap = self._buildPropertyNameMap(parsedPropertyPaths)

        # Generator for streaming CSV output
        def generate():
            # Build column definitions: fixed columns + property columns
            columns = CSV_FIXED_COLUMNS.copy()
            for path in parsedPropertyPaths:
                propertyName = self._getPropertyColumnName(
                    path, propertyNameMap)
                if propertyName:
                    columns.append(CsvColumn(propertyName, is_quoted=False))

            # Build header row
            headerRow = []
            for col in columns:
                if col.is_quoted:
                    headerRow.append(f'"{col.name}"')
                else:
                    headerRow.append(col.name)
            yield ','.join(headerRow) + '\n'

            # Load property values for all annotations in dataset
            propertyValues = self._getPropertyValues(datasetObjectId)

            # Build annotation query
            query = {"datasetId": datasetObjectId}
            if parsedAnnotationIds:
                query["_id"] = {
                    "$in": [ObjectId(aid) for aid in parsedAnnotationIds]
                }

            # Stream annotations
            cursor = self._annotationModel.find(query)

            for annotation in cursor:
                annId = str(annotation["_id"])

                # Build row values (order must match CSV_FIXED_COLUMNS)
                location = annotation.get("location", {})
                tags = annotation.get("tags", [])

                row = [
                    annId,
                    str(annotation.get("channel", 0)),
                    str(location.get("XY", 0) + 1),
                    str(location.get("Z", 0) + 1),
                    str(location.get("Time", 0) + 1),
                    ", ".join(tags),
                    annotation.get("shape", ""),
                    annotation.get("name", "") or "",
                ]

                # Add property values
                annPropertyValues = propertyValues.get(annId, {})
                for path in parsedPropertyPaths:
                    value = self._getValueFromPath(annPropertyValues, path)
                    if value is None or isinstance(value, dict):
                        row.append(undefinedValue)
                    else:
                        row.append(self._formatValue(value))

                # Format row with quoting based on column definitions
                formattedRow = []
                for col, value in zip(columns, row):
                    if col.is_quoted:
                        escapedValue = value.replace('"', '""')
                        formattedRow.append(f'"{escapedValue}"')
                    else:
                        formattedRow.append(value)

                yield ','.join(formattedRow) + '\n'

        return generate

    def _buildPropertyNameMap(self, propertyPaths):
        """
        Build a mapping of property IDs to their names.

        Args:
            propertyPaths: List of property paths, each path is
                           [propertyId, subKey1, ...]

        Returns:
            Dict mapping propertyId -> propertyName
        """
        if not propertyPaths:
            return {}

        # Collect unique property IDs
        propertyIds = set()
        for path in propertyPaths:
            if path and len(path) > 0:
                propertyIds.add(path[0])

        if not propertyIds:
            return {}

        # Fetch property documents
        properties = self._propertyModel.find({
            "_id": {"$in": [ObjectId(pid) for pid in propertyIds]}
        })

        return {str(prop["_id"]): prop["name"] for prop in properties}

    def _getPropertyColumnName(self, path, propertyNameMap):
        """
        Get the column name for a property path.

        Args:
            path: Property path [propertyId, subKey1, subKey2, ...]
            propertyNameMap: Dict mapping propertyId -> propertyName

        Returns:
            Column name like "PropertyName / SubKey1 / SubKey2"
        """
        if not path:
            return None

        propertyId = path[0]
        propertyName = propertyNameMap.get(propertyId)
        if not propertyName:
            return None

        subKeys = path[1:]
        if subKeys:
            return " / ".join([propertyName] + subKeys)
        return propertyName

    def _getValueFromPath(self, values, path):
        """
        Navigate nested dict using path array.

        This mirrors the frontend's getValueFromObjectAndPath function.

        Args:
            values: Nested dict of property values
            path: Property path [propertyId, subKey1, subKey2, ...]

        Returns:
            The value at the path, or None if not found
        """
        if not values or not path:
            return None

        current = values
        for key in path:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return None
        return current

    def _formatValue(self, value):
        """
        Format a value for CSV output.

        Handles number formatting to match frontend behavior:
        - Integers (or whole number floats) are shown without decimals
        - Other floats keep their decimal representation

        Args:
            value: The value to format

        Returns:
            String representation of the value
        """
        if isinstance(value, float):
            # Check if it's a whole number (like 534520.0)
            if value.is_integer():
                return str(int(value))
            return str(value)
        return str(value)
