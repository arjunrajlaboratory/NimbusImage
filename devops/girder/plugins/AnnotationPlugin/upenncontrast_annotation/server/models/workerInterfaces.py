from ..helpers.proxiedModel import ProxiedAccessControlledModel
from girder.exceptions import ValidationException
from girder.constants import AccessType
from ..helpers.tasks import runJobRequest

from ..helpers.fastjsonschema import customJsonSchemaCompile
import fastjsonschema


class InterfaceSchema:
    interfaceSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": (
            "/girder/plugins/upenncontrast_annotation/models/"
            "workerInterfaces"
        ),
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "image": {"type": "string"},
            "parameters": {
                "type": "object",
                "properties": {
                    "image": {"type": "string"},
                    "interface": {"type": "object"},
                },
            },
        },
        # 'additionalProperties': False
    }


class WorkerInterfaceModel(ProxiedAccessControlledModel):

    jsonValidate = staticmethod(
        customJsonSchemaCompile(InterfaceSchema.interfaceSchema)
    )

    def initialize(self):
        self.name = "worker_interface"

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)
        return document

    def create(self, creator, image, interface):
        created = {"image": image, "interface": interface}
        self.setUserAccess(
            created, user=creator, level=AccessType.ADMIN, save=False
        )
        return self.save(created)

    def delete(self, interface):
        self.remove(self.find(interface))

    def updateWorkerInterface(self, creator, image, interface):
        existing = self.findOne({"image": image})
        if existing is None:
            return self.create(creator, image, interface)
        existing["interface"] = interface
        return self.save(existing)

    def getImageInterface(self, image):
        query = {"image": image}
        result = self.findOne(query)
        return (
            None
            if result is None or "interface" not in result
            else result["interface"]
        )

    def requestWorkerUpdate(self, image):
        return runJobRequest(image, None, {"image": image}, "interface")
