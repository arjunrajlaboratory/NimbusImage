from ..helpers.proxiedModel import ProxiedModel
from girder.exceptions import ValidationException, RestException
from girder.constants import AccessType
from girder.models.model_base import AccessControlledModel
from ..helpers.tasks import runJobRequest

from ..helpers.fastjsonschema import customJsonSchemaCompile
import fastjsonschema


class PropertySchema:
    propertySchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/property",
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "image": {"type": "string"},
            "tags": {
                "type": "object",
                "properties": {
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "exclusive": {"type": "boolean"},
                },
            },
            "shape": {"type": "string", "enum": ["point", "line", "polygon"]},
            "workerInterface": {"type": "object"},
        },
    }


class AnnotationProperty(ProxiedModel, AccessControlledModel):
    # TODO: write lock
    # TODO: delete hooks: remove all computed values if the property is
    #   deleted ? (big operation)

    def __init__(self):
        super().__init__()
        self.ensureIndices(["name", "image"])
        self.schema = PropertySchema.propertySchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(PropertySchema.propertySchema)
    )

    def initialize(self):
        self.name = "annotation_property"

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            print("not validated cause objectId")
            raise ValidationException(exp)
        return document

    def create(self, creator, property):
        self.setUserAccess(
            property, user=creator, level=AccessType.ADMIN, save=False
        )
        return self.save(property)

    def delete(self, property):
        self.remove(property)

    def getPropertyById(self, id, user=None):
        return self.load(id, user=user)

    def compute(self, property, datasetId, params):
        image = property.get("image", None)
        if not image:
            raise RestException(code=500, message="Invalid property: no image")

        if property:
            return runJobRequest(image, datasetId, params, "compute")
        return {}
