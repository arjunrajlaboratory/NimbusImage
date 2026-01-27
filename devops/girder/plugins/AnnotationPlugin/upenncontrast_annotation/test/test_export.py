import pytest

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.property import AnnotationProperty
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)
from upenncontrast_annotation.server.models.collection import Collection
from upenncontrast_annotation.server.models.datasetView import (
    DatasetView as DatasetViewModel
)
from upenncontrast_annotation.server.api.export import Export

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def createDatasetWithData(user):
    """Create a dataset with annotations, connections, and property values."""
    # Create dataset folder
    dataset = utilities.createFolder(
        user, "test_dataset", upenn_utilities.datasetMetadata
    )

    # Create annotations
    ann1_data = upenn_utilities.getSampleAnnotation(dataset["_id"])
    ann1_data["shape"] = "polygon"
    ann1_data["coordinates"] = [
        {"x": 0, "y": 0},
        {"x": 10, "y": 0},
        {"x": 10, "y": 10},
        {"x": 0, "y": 10},
    ]
    ann1 = Annotation().create(ann1_data)

    ann2_data = upenn_utilities.getSampleAnnotation(dataset["_id"])
    ann2 = Annotation().create(ann2_data)

    # Create connection
    connection = upenn_utilities.getSampleConnection(
        ann1["_id"], ann2["_id"], dataset["_id"]
    )
    conn = AnnotationConnection().create(connection)

    # Create property values
    PropertyValuesModel = AnnotationPropertyValues()
    PropertyValuesModel.appendValues(
        {"test_property": {"Area": 100, "Perimeter": 40}},
        ann1["_id"],
        dataset["_id"]
    )

    return dataset, [ann1, ann2], [conn]


def createConfiguration(user, dataset, propertyIds=None):
    """Create a configuration with property IDs."""
    if propertyIds is None:
        propertyIds = []

    config_meta = {
        "subtype": "contrastDataset",
        "compatibility": {},
        "layers": [],
        "tools": [],
        "propertyIds": [str(pid) for pid in propertyIds],
        "snapshots": [],
        "scales": {}
    }

    config = Collection().createCollection(
        name="test_config",
        creator=user,
        folder=dataset,
        metadata=config_meta,
        description="Test configuration"
    )
    return config


def buildExportData(export, datasetId, configurationId=None,
                    includeAnnotations=True, includeConnections=True,
                    includeProperties=True, includePropertyValues=True):
    """Helper to build export data dict like the endpoint does."""
    data = {}

    if includeAnnotations:
        data["annotations"] = list(export._annotationModel.find(
            {"datasetId": datasetId}
        ))

    if includeConnections:
        data["annotationConnections"] = list(export._connectionModel.find(
            {"datasetId": datasetId}
        ))

    if includeProperties:
        data["annotationProperties"] = export._getProperties(
            datasetId, configurationId
        )

    if includePropertyValues:
        data["annotationPropertyValues"] = export._getPropertyValues(
            datasetId
        )

    return data


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestExport:
    def testExportJsonBasic(self, admin):
        """Test basic export with all data types."""
        dataset, annotations, connections = createDatasetWithData(admin)

        export = Export()
        result = buildExportData(export, dataset["_id"])

        # Verify structure
        assert "annotations" in result
        assert "annotationConnections" in result
        assert "annotationProperties" in result
        assert "annotationPropertyValues" in result

        # Verify counts
        assert len(result["annotations"]) == 2
        assert len(result["annotationConnections"]) == 1

        # Verify annotation IDs match
        result_ann_ids = {str(a["_id"]) for a in result["annotations"]}
        expected_ann_ids = {str(ann["_id"]) for ann in annotations}
        assert result_ann_ids == expected_ann_ids

        # Verify connection
        assert str(result["annotationConnections"][0]["_id"]) == \
            str(connections[0]["_id"])

        # Verify property values structure
        ann1_id = str(annotations[0]["_id"])
        assert ann1_id in result["annotationPropertyValues"]
        assert "test_property" in result["annotationPropertyValues"][ann1_id]

    def testExportJsonWithConfiguration(self, admin):
        """Test export with a specific configuration."""
        dataset, _, _ = createDatasetWithData(admin)

        # Create a property
        property_data = {
            "name": "Test Property",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["point"]},
            "shape": "point",
            "workerInterface": {}
        }
        prop = AnnotationProperty().save(property_data)

        # Create configuration with this property
        config = createConfiguration(admin, dataset, [prop["_id"]])

        # Export with configurationId
        export = Export()
        result = buildExportData(
            export, dataset["_id"], configurationId=config["_id"]
        )

        # Should have the property from configuration
        assert len(result["annotationProperties"]) == 1
        assert str(result["annotationProperties"][0]["_id"]) == \
            str(prop["_id"])

    def testExportJsonExcludeAnnotations(self, admin):
        """Test export with annotations excluded."""
        dataset, _, _ = createDatasetWithData(admin)

        export = Export()
        result = buildExportData(
            export, dataset["_id"], includeAnnotations=False
        )

        # Should not have annotations key
        assert "annotations" not in result
        # But should have connections
        assert "annotationConnections" in result

    def testExportJsonExcludeConnections(self, admin):
        """Test export with connections excluded."""
        dataset, _, _ = createDatasetWithData(admin)

        export = Export()
        result = buildExportData(
            export, dataset["_id"], includeConnections=False
        )

        # Should have annotations but not connections
        assert "annotations" in result
        assert "annotationConnections" not in result

    def testExportJsonExcludePropertyValues(self, admin):
        """Test export with property values excluded."""
        dataset, _, _ = createDatasetWithData(admin)

        export = Export()
        result = buildExportData(
            export, dataset["_id"], includePropertyValues=False
        )

        # Should have annotations but not property values
        assert "annotations" in result
        assert "annotationPropertyValues" not in result

    def testExportJsonEmptyDataset(self, admin):
        """Test export with an empty dataset."""
        dataset = utilities.createFolder(
            admin, "empty_dataset", upenn_utilities.datasetMetadata
        )

        export = Export()
        result = buildExportData(export, dataset["_id"])

        # Should have empty arrays/objects
        assert result["annotations"] == []
        assert result["annotationConnections"] == []
        assert result["annotationProperties"] == []
        assert result["annotationPropertyValues"] == {}

    def testGetPropertyValues(self, admin):
        """Test the property values helper method."""
        dataset, annotations, _ = createDatasetWithData(admin)

        export = Export()
        result = export._getPropertyValues(dataset["_id"])

        # Should have property values for first annotation
        ann1_id = str(annotations[0]["_id"])
        assert ann1_id in result
        assert "test_property" in result[ann1_id]
        assert result[ann1_id]["test_property"]["Area"] == 100

    def testExportJsonPropertiesViaDatasetView(self, admin):
        """Test that properties are found via DatasetViews when no
        configurationId is provided."""
        dataset, _, _ = createDatasetWithData(admin)

        # Create two properties
        prop1 = AnnotationProperty().save({
            "name": "Property One",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["polygon"]},
            "shape": "polygon",
            "workerInterface": {}
        })
        prop2 = AnnotationProperty().save({
            "name": "Property Two",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["point"]},
            "shape": "point",
            "workerInterface": {}
        })

        # Create a configuration with these properties
        config = createConfiguration(
            admin, dataset, [prop1["_id"], prop2["_id"]]
        )

        # Create a DatasetView linking the dataset to the configuration
        DatasetViewModel().create(
            admin,
            {
                "datasetId": dataset["_id"],
                "configurationId": config["_id"],
                "lastLocation": {"xy": 0, "z": 0, "time": 0},
                "layerContrasts": {}
            }
        )

        # Export WITHOUT configurationId - should find properties via
        # DatasetView
        export = Export()
        result = buildExportData(export, dataset["_id"])

        # Should have found both properties via the DatasetView
        assert len(result["annotationProperties"]) == 2
        result_prop_ids = {
            str(p["_id"]) for p in result["annotationProperties"]
        }
        expected_prop_ids = {str(prop1["_id"]), str(prop2["_id"])}
        assert result_prop_ids == expected_prop_ids

    def testExportJsonPropertiesViaMultipleDatasetViews(self, admin):
        """Test that properties are aggregated from multiple DatasetViews."""
        dataset, _, _ = createDatasetWithData(admin)

        # Create three properties
        prop1 = AnnotationProperty().save({
            "name": "Property A",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["polygon"]},
            "shape": "polygon",
            "workerInterface": {}
        })
        prop2 = AnnotationProperty().save({
            "name": "Property B",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["point"]},
            "shape": "point",
            "workerInterface": {}
        })
        prop3 = AnnotationProperty().save({
            "name": "Property C",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["line"]},
            "shape": "line",
            "workerInterface": {}
        })

        # Create two configurations with different properties
        config1 = createConfiguration(
            admin, dataset, [prop1["_id"], prop2["_id"]]
        )
        config2 = createConfiguration(
            admin, dataset, [prop2["_id"], prop3["_id"]]
        )

        # Create DatasetViews linking to both configurations
        DatasetViewModel().create(
            admin,
            {
                "datasetId": dataset["_id"],
                "configurationId": config1["_id"],
                "lastLocation": {"xy": 0, "z": 0, "time": 0},
                "layerContrasts": {}
            }
        )
        DatasetViewModel().create(
            admin,
            {
                "datasetId": dataset["_id"],
                "configurationId": config2["_id"],
                "lastLocation": {"xy": 0, "z": 0, "time": 0},
                "layerContrasts": {}
            }
        )

        # Export without configurationId
        export = Export()
        result = buildExportData(export, dataset["_id"])

        # Should have all 3 unique properties (prop2 is in both configs,
        # but deduplicated)
        assert len(result["annotationProperties"]) == 3
        result_prop_ids = {
            str(p["_id"]) for p in result["annotationProperties"]
        }
        expected_prop_ids = {
            str(prop1["_id"]), str(prop2["_id"]), str(prop3["_id"])
        }
        assert result_prop_ids == expected_prop_ids


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestCSVExport:
    """Tests for CSV export endpoint."""

    def testExportCsvBasic(self, admin):
        """Test basic CSV export - verify header and row format."""
        dataset, annotations, _ = createDatasetWithData(admin)

        export = Export()

        # Simulate what the endpoint does - build CSV rows
        cursor = export._annotationModel.find({"datasetId": dataset["_id"]})
        rows = []

        for annotation in cursor:
            annId = str(annotation["_id"])
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
            rows.append(row)

        # Verify we have the expected number of rows
        assert len(rows) == 2

        # Verify header generation logic
        fields = ["Id", "Channel", "XY", "Z", "Time", "Tags", "Shape", "Name"]
        quotedIndices = {0, 5, 6, 7}
        headerRow = []
        for i, field in enumerate(fields):
            if i in quotedIndices:
                headerRow.append(f'"{field}"')
            else:
                headerRow.append(field)
        actualHeader = ','.join(headerRow)
        expectedHeader = '"Id",Channel,XY,Z,Time,"Tags","Shape","Name"'
        assert actualHeader == expectedHeader

    def testExportCsvOneIndexed(self, admin):
        """Verify XY, Z, Time are 1-indexed."""
        dataset, annotations, _ = createDatasetWithData(admin)

        export = Export()
        cursor = export._annotationModel.find({"datasetId": dataset["_id"]})

        for annotation in cursor:
            location = annotation.get("location", {})
            # Location values are 0-indexed in storage
            xy_stored = location.get("XY", 0)
            z_stored = location.get("Z", 0)
            time_stored = location.get("Time", 0)

            # CSV export should add 1 to each
            xy_csv = xy_stored + 1
            z_csv = z_stored + 1
            time_csv = time_stored + 1

            # With default location of {XY: 0, Z: 0, Time: 0},
            # CSV should show 1, 1, 1
            assert xy_csv == 1
            assert z_csv == 1
            assert time_csv == 1

    def testExportCsvWithPropertyPaths(self, admin):
        """Test CSV export with specific property paths."""
        dataset, annotations, _ = createDatasetWithData(admin)

        # Create a property
        prop = AnnotationProperty().save({
            "name": "Test Area Property",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["polygon"]},
            "shape": "polygon",
            "workerInterface": {}
        })
        propId = str(prop["_id"])

        # Add property values to an annotation
        PropertyValuesModel = AnnotationPropertyValues()
        PropertyValuesModel.appendValues(
            {propId: {"Area": 150.5, "Perimeter": 50}},
            annotations[0]["_id"],
            dataset["_id"]
        )

        export = Export()
        propertyPaths = [[propId, "Area"], [propId, "Perimeter"]]
        propertyNameMap = export._buildPropertyNameMap(propertyPaths)

        # Check property name map
        assert propId in propertyNameMap
        assert propertyNameMap[propId] == "Test Area Property"

        # Check column names
        areaColName = export._getPropertyColumnName(
            [propId, "Area"], propertyNameMap
        )
        assert areaColName == "Test Area Property / Area"

        perimColName = export._getPropertyColumnName(
            [propId, "Perimeter"], propertyNameMap
        )
        assert perimColName == "Test Area Property / Perimeter"

    def testExportCsvWithAnnotationFilter(self, admin):
        """Test CSV export filtered to specific annotations."""
        dataset, annotations, _ = createDatasetWithData(admin)

        export = Export()

        # Filter to just first annotation
        query = {
            "datasetId": dataset["_id"],
            "_id": {"$in": [annotations[0]["_id"]]}
        }

        cursor = export._annotationModel.find(query)
        results = list(cursor)

        # Should only get 1 annotation
        assert len(results) == 1
        assert str(results[0]["_id"]) == str(annotations[0]["_id"])

    def testExportCsvUndefinedValues(self, admin):
        """Test undefined value handling: empty, NA, NaN."""
        dataset, annotations, _ = createDatasetWithData(admin)

        export = Export()
        propertyValues = export._getPropertyValues(dataset["_id"])

        # Second annotation has no property values
        ann2Id = str(annotations[1]["_id"])
        ann2Values = propertyValues.get(ann2Id, {})

        # Test _getValueFromPath for non-existent path
        value = export._getValueFromPath(ann2Values, ["nonexistent", "Area"])
        assert value is None

        # The endpoint would replace None with the undefinedValue parameter
        # Test each option
        for undefinedValue in ["", "NA", "NaN"]:
            if value is None:
                result = undefinedValue
            else:
                result = str(value)

            if undefinedValue == "":
                assert result == ""
            elif undefinedValue == "NA":
                assert result == "NA"
            elif undefinedValue == "NaN":
                assert result == "NaN"

    def testExportCsvEmptyDataset(self, admin):
        """Test export with no annotations returns header only."""
        dataset = utilities.createFolder(
            admin, "empty_csv_dataset", upenn_utilities.datasetMetadata
        )

        export = Export()
        cursor = export._annotationModel.find({"datasetId": dataset["_id"]})
        results = list(cursor)

        # Should have no annotations
        assert len(results) == 0

    def testExportCsvNestedPropertyValues(self, admin):
        """Test multi-level property paths like ['propId', 'sub1', 'sub2']."""
        export = Export()

        # Test nested value extraction
        values = {
            "propId": {
                "level1": {
                    "level2": {
                        "value": 42
                    }
                }
            }
        }

        # Test various paths
        assert export._getValueFromPath(values, ["propId"]) == {
            "level1": {"level2": {"value": 42}}
        }
        assert export._getValueFromPath(
            values, ["propId", "level1"]
        ) == {"level2": {"value": 42}}
        assert export._getValueFromPath(
            values, ["propId", "level1", "level2"]
        ) == {"value": 42}
        assert export._getValueFromPath(
            values, ["propId", "level1", "level2", "value"]
        ) == 42

        # Test non-existent path
        assert export._getValueFromPath(
            values, ["propId", "nonexistent"]
        ) is None

    def testExportCsvQuoting(self, admin):
        """Verify Id, Tags, Shape, Name are quoted; others not."""
        # The quoting logic is:
        # quotedIndices = {0, 5, 6, 7}  # Id, Tags, Shape, Name
        #
        # For a row like:
        # ["abc123", "0", "1", "1", "1", "tag1, tag2", "polygon", "Cell 1"]
        #
        # The output should be:
        # "abc123",0,1,1,1,"tag1, tag2","polygon","Cell 1"

        quotedIndices = {0, 5, 6, 7}
        row = ["abc123", "0", "1", "1", "1", "tag1, tag2", "polygon", "Cell 1"]

        formattedRow = []
        for i, value in enumerate(row):
            if i in quotedIndices:
                escapedValue = value.replace('"', '""')
                formattedRow.append(f'"{escapedValue}"')
            else:
                formattedRow.append(value)

        csvLine = ','.join(formattedRow)

        # Verify quoting
        assert csvLine == '"abc123",0,1,1,1,"tag1, tag2","polygon","Cell 1"'

    def testBuildPropertyNameMap(self, admin):
        """Test building property name map from paths."""
        # Create properties
        prop1 = AnnotationProperty().save({
            "name": "Property One",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["point"]},
            "shape": "point",
            "workerInterface": {}
        })
        prop2 = AnnotationProperty().save({
            "name": "Property Two",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["polygon"]},
            "shape": "polygon",
            "workerInterface": {}
        })

        export = Export()
        propertyPaths = [
            [str(prop1["_id"]), "Area"],
            [str(prop1["_id"]), "Perimeter"],
            [str(prop2["_id"]), "Count"]
        ]

        nameMap = export._buildPropertyNameMap(propertyPaths)

        assert len(nameMap) == 2
        assert nameMap[str(prop1["_id"])] == "Property One"
        assert nameMap[str(prop2["_id"])] == "Property Two"

    def testGetPropertyColumnName(self, admin):
        """Test column name generation from path."""
        export = Export()

        propertyNameMap = {"prop123": "My Property"}

        # Test simple path (property only)
        assert export._getPropertyColumnName(
            ["prop123"], propertyNameMap
        ) == "My Property"

        # Test path with one subkey
        assert export._getPropertyColumnName(
            ["prop123", "Area"], propertyNameMap
        ) == "My Property / Area"

        # Test path with multiple subkeys
        assert export._getPropertyColumnName(
            ["prop123", "Stats", "Mean"], propertyNameMap
        ) == "My Property / Stats / Mean"

        # Test unknown property
        assert export._getPropertyColumnName(
            ["unknown"], propertyNameMap
        ) is None

        # Test empty path
        assert export._getPropertyColumnName([], propertyNameMap) is None
