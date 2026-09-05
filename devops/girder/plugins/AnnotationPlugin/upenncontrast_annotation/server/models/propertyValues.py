import fastjsonschema

from bson.objectid import ObjectId
from pymongo import DeleteMany, UpdateOne
from pymongo.errors import DuplicateKeyError

from girder import events
from girder.constants import SortDir
from girder.exceptions import ValidationException
from girder.utility.acl_mixin import AccessControlMixin

from ..helpers.aggregation import AGGREGATION_MAX_TIME_MS
from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel
from ..helpers import valueProviders


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

    annotationIndex = (
        ('annotationId', SortDir.ASCENDING),
    )

    def __init__(self):
        super().__init__()
        compoundSearchIndex = (
            ('datasetId', SortDir.ASCENDING),
            ('_id', SortDir.ASCENDING)
        )
        self.ensureIndices([(compoundSearchIndex, {}),
                            "datasetId"])
        # Older installs have a non-unique annotationId index. Replace that
        # index before enforcing the original one-document-per-annotation
        # contract; datasetId is mutable when annotations move.
        previousIndex = self.collection.index_information().get(
            'annotationId_1')
        if previousIndex and not previousIndex.get('unique'):
            self.collection.drop_index('annotationId_1')
        # Unlike Girder's best-effort ensureIndices, this invariant must fail
        # startup if it cannot be established. Upserts rely on uniqueness.
        try:
            self.collection.create_index(self.annotationIndex,
                                         unique=True)
        except DuplicateKeyError:
            # Older deployments could create duplicates through concurrent
            # read/replace writes. Consolidate them once before enforcing the
            # invariant needed for race-safe upserts.
            self._coalesceDuplicateDocuments()
            self.collection.create_index(self.annotationIndex,
                                         unique=True)

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
        return self.appendMultipleValues([property_values])[0]

    def appendMultipleValues(self, list_of_property_values):
        # Preserve the existing append contract: an already computed property
        # wins as a whole. Do that merge AT WRITE TIME, never from a snapshot
        # that could erase another worker's intervening update.
        try:
            for document in list_of_property_values:
                self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)

        results = []
        for start in range(0, len(list_of_property_values), 5000):
            documents = list_of_property_values[start:start + 5000]
            keys = [{
                'annotationId': document['annotationId'],
            } for document in documents]
            query = {'$or': keys}
            if self.is_recording:
                for before in self.find(query):
                    self.record.changeDocument(before, None)
            self.collection.bulk_write([
                UpdateOne(key, [{'$set': {
                    **key,
                    'datasetId': document['datasetId'],
                    'values': {'$mergeObjects': [
                        {'$literal': document['values']},
                        {'$ifNull': ['$values', {}]},
                    ]},
                }}], upsert=True)
                for key, document in zip(keys, documents)
            ], ordered=True)
            saved = {
                document['annotationId']: document
                for document in self.find(query)
            }
            if self.is_recording:
                for after in saved.values():
                    self.record.changeDocument(None, after)
            results.extend(saved[key['annotationId']]
                           for key in keys)
        return results

    @staticmethod
    def _mergeMissingValues(target, source):
        """Recursively add missing values without replacing older leaves."""
        for key, value in source.items():
            if key not in target:
                target[key] = value
            elif isinstance(target[key], dict) and isinstance(value, dict):
                AnnotationPropertyValues._mergeMissingValues(
                    target[key], value
                )

    def _coalesceDuplicateDocuments(self):
        """Merge legacy duplicate annotation-value documents in bulk."""
        pipeline = [
            {"$sort": {"_id": 1}},
            {"$group": {
                "_id": "$annotationId",
                "documents": {"$push": {
                    "_id": "$_id",
                    "values": "$values",
                }},
                "count": {"$sum": 1},
            }},
            {"$match": {"count": {"$gt": 1}}},
        ]
        operations = []
        for group in self.collection.aggregate(pipeline, allowDiskUse=True):
            documents = group["documents"]
            merged = documents[0]["values"].copy()
            for document in documents[1:]:
                self._mergeMissingValues(merged, document["values"])
            operations.extend([
                UpdateOne(
                    {"_id": documents[0]["_id"]},
                    {"$set": {"values": merged}},
                ),
                DeleteMany({
                    "_id": {"$in": [
                        document["_id"] for document in documents[1:]
                    ]}
                }),
            ])
            if len(operations) >= 10_000:
                self.collection.bulk_write(operations, ordered=True)
                operations = []
        if operations:
            self.collection.bulk_write(operations, ordered=True)

    def setSubValuesMany(self, datasetId, propertyId, entries):
        """Atomically merge nested values for several annotations.

        Each update touches only one property's sub-dictionary, so concurrent
        jobs writing other properties or sub-keys cannot replace one another's
        snapshots. A pipeline also normalizes a legacy scalar property value
        to an object before merging.
        """
        propertyPath = "values.%s" % propertyId
        operations = []
        for annotationId, subValues in entries:
            operations.append(UpdateOne(
                {
                    "annotationId": annotationId,
                },
                [{"$set": {
                    "datasetId": datasetId,
                    "annotationId": annotationId,
                    propertyPath: {"$mergeObjects": [
                        {"$cond": [
                            {"$eq": [
                                {"$type": "$" + propertyPath}, "object"
                            ]},
                            "$" + propertyPath,
                            {},
                        ]},
                        {'$literal': subValues},
                    ]},
                }}],
                upsert=True,
            ))
        if operations:
            return self.collection.bulk_write(operations, ordered=False)
        return None

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
        virtualPaths = []
        if propertyPaths:
            propertyPaths, virtualPaths = valueProviders.splitPaths(
                propertyPaths
            )
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
            if propertyPaths or not virtualPaths:
                results.extend(self.find(query, fields=fields))
        # Virtual paths (valueProviders): merged into the returned documents
        # so a client working from this fetch sees a gene column exactly like
        # a stored value; an annotation without a value document gets one.
        if virtualPaths:
            byAnnotation = {doc["annotationId"]: doc for doc in results}
            for path in virtualPaths:
                provider = valueProviders.providerFor(path)
                values = provider.valuesForIds(
                    datasetId, path, [str(i) for i in annotationIds]
                )
                for annotationId, value in zip(annotationIds, values):
                    if value is None:
                        continue
                    doc = byAnnotation.get(annotationId)
                    if doc is None:
                        doc = {"annotationId": annotationId, "values": {}}
                        byAnnotation[annotationId] = doc
                        results.append(doc)
                    valueProviders.nestValue(
                        doc.setdefault("values", {}), path, value
                    )
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
        # Keep empty value documents: deleting an empty-looking snapshot can
        # remove another property's concurrent upsert. Consumers already
        # accept values={}, and annotation deletion cleans up the document.
        return self.update(
            {'datasetId': datasetId},
            {'$unset': {'values.' + propertyId: ''}},
        )

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
