from ..helpers.proxiedModel import ProxiedAccessControlledModel
from girder.exceptions import ValidationException, RestException
from girder.constants import AccessType
from ..helpers.tasks import runJobRequest

from ..helpers.fastjsonschema import customJsonSchemaCompile
import fastjsonschema


from girder.models.folder import Folder


class PreviewSchema:
    previewSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/workerPreviews",
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "image": {"type": "string"},
            "preview": {
                "type": "object",
                "properties": {
                    "image": {"type": "string"},
                    "preview": {"type": "object"},
                },
            },
        },
        # 'additionalProperties': False
    }


class WorkerPreviewModel(ProxiedAccessControlledModel):

    jsonValidate = staticmethod(
        customJsonSchemaCompile(PreviewSchema.previewSchema)
    )

    def initialize(self):
        self.name = "worker_preview"

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)
        return document

    def create(self, creator, image, preview):
        created = {"image": image, "preview": preview}
        self.setUserAccess(
            created, user=creator, level=AccessType.ADMIN, save=False
        )
        return self.save(created)

    def delete(self, image):
        self.remove(self.getImagePreview(image))

    def updateWorkerPreview(self, creator, image, preview):
        existing = self.getImagePreview(image)
        if existing is None:
            return self.create(creator, image, preview)
        existing["preview"] = preview
        return self.save(existing)

    def getImagePreview(self, image):
        query = {"image": image}
        return self.findOne(query)

    def requestPreviewUpdate(self, image, datasetId, parameters, user):
        dataset = Folder().load(datasetId, user=user, level=AccessType.WRITE)
        if not dataset:
            raise RestException(
                code=500, message="Invalid dataset id in annotation"
            )

        return runJobRequest(image, datasetId, parameters, "preview")
