import fastjsonschema

from girder import events
from girder.constants import SortDir
from girder.exceptions import ValidationException
from girder.utility.acl_mixin import AccessControlMixin

from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel


class PropertySchema:
    recursiveValuesId = (
        "/girder/plugins/upenncontrast_annotation/models"
        "/propertyValues/recursiveValues"
    )

    annotationPropertySchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/propertyValues",
        "type": "object",
        "properties": {
            "annotationId": {"type": "objectId"},
            "datasetId": {"type": "objectId"},
            "values": {
                "id": recursiveValuesId,
                "type": "object",
                "additionalProperties": {
                    "anyOf": [
                        {
                            "type": ["number", "string", "null"],
                        },
                        {
                            "$ref": recursiveValuesId,
                        },
                    ],
                },
            },
        },
        # 'additionalProperties': False
    }


class AnnotationPropertyValues(ProxiedModel, AccessControlMixin):

    def __init__(self):
        super().__init__()
        compoundSearchIndex = (
            ('datasetId', SortDir.ASCENDING),
            ('_id', SortDir.ASCENDING)
        )
        self.ensureIndices([(compoundSearchIndex, {}),
                            "annotationId", "datasetId"])

        # Used by Girder to define what field are used to check permissions
        self.resourceColl = 'folder'
        self.resourceParent = 'datasetId'

        self.schema = PropertySchema.annotationPropertySchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(PropertySchema.annotationPropertySchema)
    )

    def annotationsRemovedEvent(self, event):
        # Clean property values orphaned by the deletion of the annotations
        annotationStringIds = event.info
        query = {"annotationId": {"$in": annotationStringIds}}
        self.removeWithQuery(query)

    def initialize(self):
        self.name = "annotation_property_values"
        events.bind(
            "model.upenn_annotation.removeStringIds",
            "upenn.annotation_values.annotationsRemovedEvent",
            self.annotationsRemovedEvent,
        )

    def validate(self, document):
        return self.validateMultiple([document])[0]

    def validateMultiple(self, propertyValuesList):
        try:
            for propertyValues in propertyValuesList:
                self.jsonValidate(propertyValues)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)

        # find existing property values using the annotation id
        annotationIds = [
            propertyValues["annotationId"]
            for propertyValues in propertyValuesList
        ]
        query = {"annotationId": {"$in": annotationIds}}
        existingDocuments = {}  # indexed by annotation id
        for existingDocument in self.find(query):
            annotationId = existingDocument["annotationId"]
            existingDocuments[annotationId] = existingDocument
        # if some property values exist with the same annotation id, merge them
        if len(existingDocuments) > 0:
            for propertyValues in propertyValuesList:
                annotationId = propertyValues["annotationId"]
                existingDocument = existingDocuments.get(annotationId, None)
                if existingDocument is not None:
                    propertyValues["values"].update(existingDocument["values"])
                    propertyValues["_id"] = existingDocument["_id"]

        # TODO(performance): create sparse index on properties if nonexisting
        # https://docs.mongodb.com/manual/reference/operator/query/exists/

        return propertyValuesList

    def appendValues(self, values, annotationId, datasetId):
        property_values = {
            "annotationId": annotationId,
            "values": values,
            "datasetId": datasetId,
        }
        return self.save(property_values)

    def appendMultipleValues(self, list_of_property_values):
        return self.saveMany(list_of_property_values)

    def delete(self, propertyId, datasetId):
        # Could use self.collection.updateMany but girder doesn't expose it
        for document in self.find(
            {
                "datasetId": datasetId,
                ".".join(["values", propertyId]): {"$exists": True},
            }
        ):
            document["values"].pop(propertyId, None)
            if len(document["values"]) == 0:
                self.remove(document)
            else:
                self.save(document, False)

    def histogram(self, propertyPath, datasetId, buckets=255):
        valueKey = "values." + propertyPath
        match = {
            "$match": {
                "datasetId": datasetId,
                # TODO(performance): sparse index see above
                valueKey: {"$exists": True, "$ne": None},
            }
        }

        bucket = {
            "$bucketAuto": {"groupBy": "$" + valueKey, "buckets": buckets}
        }

        project = {
            "$project": {
                "_id": False,
                "min": "$_id.min",
                "max": "$_id.max",
                "count": True,
            }
        }

        return self.collection.aggregate([match, bucket, project])

    # def SSE for property change, sends the whole annotation
