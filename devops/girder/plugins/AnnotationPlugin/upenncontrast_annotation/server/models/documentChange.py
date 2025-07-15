from girder.constants import AccessType
from girder.exceptions import ValidationException
from girder.models.model_base import AccessControlledModel

from ..helpers.customModel import CustomNimbusImageModel
from ..helpers.fastjsonschema import customJsonSchemaCompile
import fastjsonschema

from bson.objectid import ObjectId


class DocumentChangeSchema:
    documentChangeSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/documentChange",
        "type": "object",
        "properties": {
            "historyId": {
                # Special type defined in a custom validator
                "type": "objectId",
            },
            "modelName": {
                "type": "string",
            },
            "documentId": {
                "type": "objectId",
            },
            # Document before action, can be None
            "before": {
                "type": ["object", "null"],
            },
            # Document after action, can be None
            "after": {
                "type": ["object", "null"],
            },
        },
        "required": ["historyId", "modelName", "before", "after"],
    }


class DocumentChange(CustomNimbusImageModel, AccessControlledModel):
    """
    Register actions on some endpoints using the ProxiedModel
    This class itself doesn't inherit the ProxiedModel
    """

    def __init__(self):
        super().__init__()
        self.ensureIndices(["historyId", "documentId"])
        self.schema = DocumentChangeSchema.documentChangeSchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(DocumentChangeSchema.documentChangeSchema)
    )

    def initialize(self):
        self.name = "document_change"

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            print("Validation of an history document failed")
            raise ValidationException(exp)
        return document

    def createChangesFromRecord(self, history_id, record, creator):
        # The record is a dict:
        # { model_name: { document_id: { before: ..., after: ... } } }
        document_changes = []
        for model_name in record:
            for document_id in record[model_name]:
                raw_change = record[model_name][document_id]
                new_document_change = {
                    "historyId": history_id,
                    "modelName": model_name,
                    "documentId": ObjectId(document_id),
                    "before": raw_change["before"],
                    "after": raw_change["after"],
                }
                self.setUserAccess(
                    new_document_change, user=creator, level=AccessType.ADMIN
                )
                document_changes.append(new_document_change)
        self.saveMany(document_changes)
