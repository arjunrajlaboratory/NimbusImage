from girder.constants import AccessType
from girder.exceptions import ValidationException
from ..helpers.proxiedModel import ProxiedAccessControlledModel

from ..helpers.fastjsonschema import customJsonSchemaCompile
import fastjsonschema


class DatasetViewSchema:
    contrastSchema = {
        "type": "object",
        "properties": {
            "mode": {"type": "string", "enum": ["percentile", "absolute"]},
            "blackPoint": {"type": "number"},
            "whitePoint": {"type": "number"},
        },
    }

    locationSchema = {
        "type": "object",
        "properties": {
            "xy": {
                "type": "number",
            },
            "z": {
                "type": "number",
            },
            "time": {
                "type": "number",
            },
        },
        "required": ["xy", "z", "time"],
        "additionalProperties": False,
    }

    datasetViewSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/datasetView",
        "type": "object",
        "properties": {
            "datasetId": {"type": "string"},
            "configurationId": {"type": "string"},
            "lastLocation": locationSchema,
            # Associate a contrast to a layer id
            "layerContrasts": {
                "type": "object",
                "additionalProperties": contrastSchema,
            },
        },
        "required": [
            "datasetId",
            "configurationId",
            "layerContrasts",
            "lastLocation",
        ],
    }


class DatasetView(ProxiedAccessControlledModel):

    def __init__(self):
        super().__init__()
        self.ensureIndices(["datasetId", "configurationId"])

    jsonValidate = staticmethod(
        customJsonSchemaCompile(DatasetViewSchema.datasetViewSchema)
    )

    def initialize(self):
        self.name = "dataset_view"

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            print("not validated cause objectId")
            raise ValidationException(exp)
        return document

    def create(self, creator, dataset_view):
        self.setUserAccess(
            dataset_view, user=creator, level=AccessType.ADMIN, save=False
        )
        return self.save(dataset_view)

    def delete(self, dataset_view):
        self.remove(dataset_view)

    def updateDatasetView(self, dataset_view, new_dataset_view):
        id = dataset_view["_id"]
        dataset_view.update(new_dataset_view)
        dataset_view["_id"] = id
        return self.save(dataset_view)
