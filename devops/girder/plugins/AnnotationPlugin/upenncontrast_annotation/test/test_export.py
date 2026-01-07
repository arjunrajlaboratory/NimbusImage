import pytest
import json

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


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestExport:
    def testExportJsonBasic(self, admin):
        """Test basic export with all data types."""
        dataset, annotations, connections = createDatasetWithData(admin)

        # Create Export instance and call the method
        export = Export()

        # Get the generator function
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,  # no configurationId
            includeAnnotations=True,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=True
        )

        # Collect the output
        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

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
        dataset, annotations, connections = createDatasetWithData(admin)

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
        generator_func = export._generateExportJson(
            dataset["_id"],
            config["_id"],
            includeAnnotations=True,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=True
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should have the property from configuration
        assert len(result["annotationProperties"]) == 1
        assert str(result["annotationProperties"][0]["_id"]) == \
            str(prop["_id"])

    def testExportJsonExcludeAnnotations(self, admin):
        """Test export with annotations excluded."""
        dataset, annotations, connections = createDatasetWithData(admin)

        export = Export()
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,
            includeAnnotations=False,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=True
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should not have annotations key
        assert "annotations" not in result
        # But should have connections
        assert "annotationConnections" in result

    def testExportJsonExcludeConnections(self, admin):
        """Test export with connections excluded."""
        dataset, annotations, connections = createDatasetWithData(admin)

        export = Export()
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,
            includeAnnotations=True,
            includeConnections=False,
            includeProperties=True,
            includePropertyValues=True
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should have annotations but not connections
        assert "annotations" in result
        assert "annotationConnections" not in result

    def testExportJsonExcludePropertyValues(self, admin):
        """Test export with property values excluded."""
        dataset, annotations, connections = createDatasetWithData(admin)

        export = Export()
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,
            includeAnnotations=True,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=False
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should have annotations but not property values
        assert "annotations" in result
        assert "annotationPropertyValues" not in result

    def testExportJsonEmptyDataset(self, admin):
        """Test export with an empty dataset."""
        dataset = utilities.createFolder(
            admin, "empty_dataset", upenn_utilities.datasetMetadata
        )

        export = Export()
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,
            includeAnnotations=True,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=True
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should have empty arrays/objects
        assert result["annotations"] == []
        assert result["annotationConnections"] == []
        assert result["annotationProperties"] == []
        assert result["annotationPropertyValues"] == {}

    def testStreamCursorAsArray(self, admin):
        """Test the cursor streaming helper."""
        dataset, annotations, _ = createDatasetWithData(admin)

        export = Export()

        # Get annotations cursor
        cursor = Annotation().find({"datasetId": dataset["_id"]})

        # Stream as array
        result_bytes = b"".join(export._streamCursorAsArray(cursor))
        result = json.loads(result_bytes)

        assert len(result) == 2
        result_ids = {str(a["_id"]) for a in result}
        expected_ids = {str(ann["_id"]) for ann in annotations}
        assert result_ids == expected_ids

    def testExportJsonPropertiesViaDatasetView(self, admin):
        """Test that properties are found via DatasetViews when no
        configurationId is provided."""
        dataset, annotations, connections = createDatasetWithData(admin)

        # Create two properties
        property1_data = {
            "name": "Property One",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["polygon"]},
            "shape": "polygon",
            "workerInterface": {}
        }
        prop1 = AnnotationProperty().save(property1_data)

        property2_data = {
            "name": "Property Two",
            "image": "properties/test:latest",
            "tags": {"exclusive": False, "tags": ["point"]},
            "shape": "point",
            "workerInterface": {}
        }
        prop2 = AnnotationProperty().save(property2_data)

        # Create a configuration with these properties
        config = createConfiguration(
            admin, dataset, [prop1["_id"], prop2["_id"]]
        )

        # Create a DatasetView linking the dataset to the configuration
        # This is how the frontend links datasets to configurations
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
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,  # No configurationId - should look up via DatasetViews
            includeAnnotations=True,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=True
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should have found both properties via the DatasetView
        assert len(result["annotationProperties"]) == 2
        result_prop_ids = {
            str(p["_id"]) for p in result["annotationProperties"]
        }
        expected_prop_ids = {
            str(prop1["_id"]),
            str(prop2["_id"])
        }
        assert result_prop_ids == expected_prop_ids

    def testExportJsonPropertiesViaMultipleDatasetViews(self, admin):
        """Test that properties are aggregated from multiple DatasetViews."""
        dataset, annotations, connections = createDatasetWithData(admin)

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
            admin,
            dataset,
            [
                prop1["_id"],
                prop2["_id"]
            ]
        )
        config2 = createConfiguration(
            admin,
            dataset,
            [
                prop2["_id"],
                prop3["_id"]
            ]
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
        generator_func = export._generateExportJson(
            dataset["_id"],
            None,
            includeAnnotations=True,
            includeConnections=True,
            includeProperties=True,
            includePropertyValues=True
        )

        result_bytes = b"".join(generator_func())
        result = json.loads(result_bytes)

        # Should have all 3 unique properties (prop2 is in both configs,
        # but deduplicated)
        assert len(result["annotationProperties"]) == 3
        result_prop_ids = {
            str(p["_id"]) for p in result["annotationProperties"]
        }
        expected_prop_ids = {
            str(prop1["_id"]),
            str(prop2["_id"]),
            str(prop3["_id"])
        }
        assert result_prop_ids == expected_prop_ids
