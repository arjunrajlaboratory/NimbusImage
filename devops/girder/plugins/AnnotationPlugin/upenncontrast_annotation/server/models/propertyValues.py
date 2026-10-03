import fastjsonschema

from bson.objectid import ObjectId

from girder import events
from girder.constants import SortDir
from girder.exceptions import ValidationException
from girder.utility.acl_mixin import AccessControlMixin

from ..helpers.aggregation import AGGREGATION_MAX_TIME_MS
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


# AccessControlMixin must precede ProxiedModel so its permission-aware
# find/load methods take MRO precedence over the unchecked base methods.
class AnnotationPropertyValues(AccessControlMixin, ProxiedModel):

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
        # Clean property values orphaned by the deletion of the annotations.
        # Ids arrive as strings from bulk deletes and as ObjectIds from
        # single deletes; annotationId is stored as an ObjectId, so normalize
        # before the $in query (a string $in never matches an ObjectId field,
        # which previously left bulk-deleted annotations' values orphaned).
        annotationIds = [ObjectId(str(i)) for i in event.info]
        self.removeWithQuery({"annotationId": {"$in": annotationIds}})

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

    def findByAnnotationIds(
        self, datasetId, annotationIds, propertyPaths=None
    ):
        # Values for a set of annotations in one dataset, optionally projecting
        # only the requested property paths (each path is a list of keys, e.g.
        # [propertyId, subId]). Used by viewport-scoped lazy loading so the
        # client never holds the whole dataset's values in memory.
        #
        # The returned docs carry a consistent minimal shape regardless of
        # whether propertyPaths is given: annotationId + values (the only
        # fields the client keys on), with datasetId/_id excluded.
        # propertyPaths only narrows which values keys are returned.
        if not annotationIds:
            return []
        # Dict projection so _id is explicitly excluded: a list (inclusion)
        # projection leaves Mongo's default _id:1 in place, leaking the value
        # doc's id the docstring promises not to return.
        if propertyPaths:
            fields = {"_id": 0, "annotationId": 1}
            for path in propertyPaths:
                fields["values." + ".".join(path)] = 1
        else:
            fields = {"_id": 0, "annotationId": 1, "values": 1}
        results = []
        # Chunk the $in so a large id set can't build a pathological query.
        chunkSize = 50000
        for start in range(0, len(annotationIds), chunkSize):
            chunk = annotationIds[start:start + chunkSize]
            query = {
                "datasetId": datasetId,
                "annotationId": {"$in": chunk},
            }
            results.extend(self.find(query, fields=fields))
        return results

    def valuesForPath(self, datasetId, propertyPath):
        """Yield (annotationId, value) for every property-value document in
        the dataset with a non-null value at propertyPath (a list of keys).

        Uses an aggregation rather than find() so the value can be projected
        FLAT (two scalar fields per document). A find() projection preserves
        the nested shape -- {values: {propertyId: {subKey: v}}} -- so pymongo
        builds three dicts per document and the caller re-walks the path;
        measured on a 708K-annotation dataset that cost 4.4s against 2.6s for
        the flat form, for byte-identical data. Girder's find() cannot express
        a computed projection, which is the sanctioned reason to reach for
        collection.aggregate (see histogram below).

        A path that runs through a scalar or is absent yields nothing:
        Mongo's dotted-path traversal resolves those to "missing", which the
        $match already excludes."""
        valueKey = "values." + ".".join(propertyPath)
        pipeline = [
            {
                "$match": {
                    "datasetId": datasetId,
                    valueKey: {"$exists": True, "$ne": None},
                }
            },
            {
                "$project": {
                    "_id": 0,
                    "annotationId": 1,
                    "value": "$" + valueKey,
                }
            },
        ]
        # No allowDiskUse: $match + $project are streaming stages with nothing
        # to spill, so asking for disk would only grant a capability this
        # pipeline cannot use. maxTimeMS still bounds it (this runs over every
        # property value in a dataset).
        cursor = self.collection.aggregate(
            pipeline, maxTimeMS=AGGREGATION_MAX_TIME_MS
        )
        for document in cursor:
            value = document.get("value")
            if value is not None:
                yield document["annotationId"], value

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
