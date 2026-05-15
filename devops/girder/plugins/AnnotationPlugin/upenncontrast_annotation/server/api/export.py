"""
Export API for downloading annotation data as JSON or CSV.

This endpoint exports annotations, connections, properties, and property
values for a dataset.
"""

import orjson
import re
from dataclasses import dataclass

from bson.objectid import ObjectId

from girder.api import access
from girder.api.describe import autoDescribeRoute, Description
from girder.api.rest import Resource, setResponseHeader, setContentDisposition
from girder.constants import AccessType, TokenScope
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
# Property columns are added dynamically and quoted if they contain commas.
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

# Must stay in sync with UNSAFE_CSV_COLUMN_CHARS in
# src/components/AnnotationBrowser/AnnotationCSVDialog.vue so that the
# client-side preview matches the server-generated CSV exactly.
CSV_UNSAFE_COLUMN_CHARS = re.compile(r"[^A-Za-z0-9_]+")


def sanitizeCsvColumnName(name):
    """Return an R-friendly CSV column name.

    Column names are limited to ASCII letters, numbers, and underscores.
    Runs of spaces, slashes, commas, and other punctuation are collapsed
    to one underscore.
    """
    sanitized = CSV_UNSAFE_COLUMN_CHARS.sub("_", name).strip("_")
    return sanitized or "_"


def _deduplicateColumnNames(names):
    """Suffix repeated names with _2, _3, ... in order of appearance.

    Sanitization can collapse distinct names to the same token (e.g.,
    "Mean Area (um^2)" and "Mean/Area/um/2" both -> "Mean_Area_um_2"),
    which would break R imports that rely on unique header names.
    """
    seen = {}
    result = []
    for name in names:
        count = seen.get(name, 0)
        result.append(name if count == 0 else f"{name}_{count + 1}")
        seen[name] = count + 1
    return result


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

    @access.public(scope=TokenScope.DATA_READ)
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
                datasetObjectId, configObjectId,
                self.getCurrentUser()
            )

        if includePropertyValues:
            data["annotationPropertyValues"] = self._getPropertyValues(
                datasetObjectId
            )

        # Return as generator so Girder streams raw bytes
        def generate():
            yield orjson.dumps(data, default=orJsonDefaults)
        return generate

    def _getProperties(self, datasetId, configurationId, user):
        """
        Get property definitions as a list.

        If configurationId is provided, gets properties from that
        configuration. Otherwise, finds all configurations associated
        with the dataset via DatasetViews and aggregates their
        properties.
        """
        propertyIds = set()

        if configurationId:
            config = self._collectionModel.load(
                configurationId,
                user=user,
                level=AccessType.READ,
                exc=True,
            )
            if 'meta' in config and 'propertyIds' in config['meta']:
                for pid in config['meta']['propertyIds']:
                    propertyIds.add(ObjectId(pid))
        else:
            datasetViews = list(
                self._datasetViewModel.collection.find({
                    'datasetId': datasetId
                })
            )
            configIds = {
                dv['configurationId'] for dv in datasetViews
            }

            for configId in configIds:
                config = self._collectionModel.load(
                    configId, user=user, level=AccessType.READ
                )
                if (config and 'meta' in config
                        and 'propertyIds' in config['meta']):
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
        cursor = self._propertyValuesModel.find(
            {"datasetId": datasetId}
        )

        for doc in cursor:
            annotationId = str(doc["annotationId"])
            values = doc.get("values", {})
            result[annotationId] = values

        return result

    @access.public(scope=TokenScope.DATA_READ)
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
                    "delimiter": {
                        "type": "string",
                        "description": "Delimiter: , or \\t",
                        "default": ","
                    },
                    "sanitizeColumnNames": {
                        "type": "boolean",
                        "description": (
                            "Replace spaces, slashes, commas, and other "
                            "non-alphanumeric column-name characters with "
                            "underscores"
                        ),
                        "default": False
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
        delimiter = body.get("delimiter", ",")
        sanitizeColumnNames = bool(body.get("sanitizeColumnNames", False))
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
            parsedAnnotationIds = [
                ObjectId(aid) for aid in annotationIds
            ]

        # Validate delimiter
        if delimiter not in (",", "\t"):
            delimiter = ","

        is_tsv = delimiter == "\t"
        expected_ext = ".tsv" if is_tsv else ".csv"
        content_type = (
            "text/tab-separated-values" if is_tsv else "text/csv"
        )

        # Ensure filename ends with correct extension
        safe_filename = (
            filename if filename.endswith(expected_ext)
            else filename + expected_ext
        )

        setResponseHeader("Content-Type", content_type)
        setContentDisposition(safe_filename, disposition='attachment')

        # Capture self for use inside the generate() closure.
        # In Python, nested functions (including generators) capture
        # variables from the enclosing scope, but `self` can be
        # rebound before the generator runs. Storing it in a local
        # variable ensures the generator references the correct
        # instance.
        exportSelf = self

        # Generator for streaming CSV output
        def generate():
            yield from exportSelf._generateCsvLines(
                datasetObjectId,
                parsedPropertyPaths,
                parsedAnnotationIds,
                undefinedValue,
                delimiter,
                sanitizeColumnNames,
            )

        return generate

    def _generateCsvLines(
        self,
        datasetObjectId,
        parsedPropertyPaths,
        parsedAnnotationIds=None,
        undefinedValue="",
        delimiter=",",
        sanitizeColumnNames=False,
    ):
        """Generate CSV lines for a dataset."""
        propertyNameMap = self._buildPropertyNameMap(parsedPropertyPaths)
        columns, includedPaths = self._buildCsvColumns(
            parsedPropertyPaths,
            propertyNameMap,
            sanitizeColumnNames,
        )

        # Build header row
        headerRow = []
        for col in columns:
            if col.is_quoted:
                headerRow.append(f'"{col.name}"')
            else:
                headerRow.append(col.name)
        yield delimiter.join(headerRow) + '\n'

        # Load all property values for the dataset
        propertyValues = self._getPropertyValues(datasetObjectId)

        # Query annotations. When filtering by IDs, chunk
        # the $in to stay under MongoDB's 16MB BSON limit.
        for annotation in self._iterAnnotations(
            datasetObjectId,
            parsedAnnotationIds,
        ):
            annId = str(annotation["_id"])
            location = annotation.get("location", {})
            tags = annotation.get("tags") or []

            row = [
                annId,
                str(annotation.get("channel", 0)),
                str(location.get("XY", 0) + 1),
                str(location.get("Z", 0) + 1),
                str(location.get("Time", 0) + 1),
                ", ".join(str(t) for t in tags),
                str(annotation.get("shape", "")),
                str(annotation.get("name", "") or ""),
            ]

            # Add property values
            annPropValues = propertyValues.get(annId, {})
            for path in includedPaths:
                value = self._getValueFromPath(annPropValues, path)
                if value is None:
                    row.append(undefinedValue)
                elif isinstance(value, dict):
                    row.append(str(value))
                else:
                    row.append(self._formatValue(value))

            # Format row with quoting
            formattedRow = []
            for col, value in zip(columns, row):
                if col.is_quoted:
                    escapedValue = str(value).replace('"', '""')
                    formattedRow.append(f'"{escapedValue}"')
                else:
                    formattedRow.append(str(value))

            yield delimiter.join(formattedRow) + '\n'

    def _buildCsvColumns(
        self,
        parsedPropertyPaths,
        propertyNameMap,
        sanitizeColumnNames=False,
    ):
        """Build CSV columns and matching property paths."""
        # Fixed-column is_quoted controls value quoting, not just header
        # quoting (Tags joins multiple tags with ", ", Name is freeform
        # user text), so preserve it regardless of sanitization.
        columns = [
            CsvColumn(
                sanitizeCsvColumnName(col.name)
                if sanitizeColumnNames else col.name,
                is_quoted=col.is_quoted,
            )
            for col in CSV_FIXED_COLUMNS
        ]
        includedPaths = []
        for path in parsedPropertyPaths:
            propertyName = self._getPropertyColumnName(
                path,
                propertyNameMap,
                sanitizeColumnNames=sanitizeColumnNames,
            )
            if propertyName:
                columns.append(CsvColumn(
                    propertyName,
                    is_quoted=',' in propertyName
                ))
                includedPaths.append(path)
        if sanitizeColumnNames:
            uniqueNames = _deduplicateColumnNames(
                [c.name for c in columns]
            )
            columns = [
                CsvColumn(name, is_quoted=c.is_quoted)
                for c, name in zip(columns, uniqueNames)
            ]
        return columns, includedPaths

    def _iterAnnotations(self, datasetId, annotationIds):
        """Iterate annotations, chunking $in queries to stay under limit."""
        if not annotationIds:
            for ann in self._annotationModel.find({"datasetId": datasetId}):
                yield ann
            return

        IN_CHUNK_SIZE = 500000
        for i in range(0, len(annotationIds), IN_CHUNK_SIZE):
            chunk = annotationIds[i:i + IN_CHUNK_SIZE]
            for ann in self._annotationModel.find({
                "datasetId": datasetId,
                "_id": {"$in": chunk},
            }):
                yield ann

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

    def _getPropertyColumnName(
        self,
        path,
        propertyNameMap,
        sanitizeColumnNames=False,
    ):
        """
        Get the column name for a property path.

        Args:
            path: Property path [propertyId, subKey1, subKey2, ...]
            propertyNameMap: Dict mapping propertyId -> propertyName
            sanitizeColumnNames: When True, replace non-alphanumeric
                characters with underscores (e.g., "Foo / Bar" ->
                "Foo_Bar").

        Returns:
            Column name like "PropertyName / SubKey1 / SubKey2", or the
            sanitized form when sanitizeColumnNames is True.
        """
        if not path:
            return None

        propertyId = path[0]
        propertyName = propertyNameMap.get(propertyId)
        if not propertyName:
            return None

        subKeys = path[1:]
        if subKeys:
            columnName = " / ".join([propertyName] + subKeys)
        else:
            columnName = propertyName

        if sanitizeColumnNames:
            return sanitizeCsvColumnName(columnName)
        return columnName

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
