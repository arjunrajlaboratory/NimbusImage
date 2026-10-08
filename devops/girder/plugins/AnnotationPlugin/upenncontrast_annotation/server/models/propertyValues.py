import re

import fastjsonschema

from bson.objectid import ObjectId
from pymongo import DeleteMany, UpdateOne
from pymongo.errors import BulkWriteError, DuplicateKeyError

from girder import events
from girder.constants import SortDir
from girder.exceptions import ValidationException
from girder.utility.acl_mixin import AccessControlMixin

from ..helpers.aggregation import AGGREGATION_MAX_TIME_MS
from ..helpers.customModel import bulkWriteErrorMessage
from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel
from ..helpers import valueProviders


DUPLICATE_KEY_ERROR = 11000
# Chunk $in queries so a large batch can't build a pathological query.
MAX_IDS_PER_QUERY = 50000


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
        return propertyValuesList

    def appendValues(self, values, annotationId, datasetId):
        return self.appendMultipleValues([{
            "annotationId": annotationId,
            "values": values,
            "datasetId": datasetId,
        }])[0]

    def appendMultipleValues(self, list_of_property_values):
        """Merge values into each annotation's single values document.

        Each entry becomes one atomic upsert that $sets only the property
        ids it carries, so the merge happens on the server. Reading the
        stored document, merging in Python and writing it back raced when
        sibling property workers wrote the same annotations at once: writers
        overwrote each other's values or failed with E11000 (issue #1356).

        Callers must ensure each entry's annotation belongs to its datasetId:
        the upsert matches by annotationId alone. API endpoints check this
        with requireAnnotationsInDatasets; the import creates the annotations
        in the dataset it writes to.

        :returns: The stored documents for the written annotations.
        """
        if len(list_of_property_values) == 0:
            return []
        self.validateMultiple(list_of_property_values)
        annotationIds = [
            entry["annotationId"] for entry in list_of_property_values
        ]
        if self.is_recording:
            for before in self.find({"annotationId": {"$in": annotationIds}}):
                self.record.changeDocument(before, None)

        operations = [
            self._upsertValues(entry) for entry in list_of_property_values
        ]
        try:
            self.collection.bulk_write(operations, ordered=False)
        except BulkWriteError as e:
            # A first write to an annotation inserts its document with
            # _id = annotationId, so concurrent first writes collide on _id
            # instead of creating two documents. The loser's retry matches
            # the winner's document and merges into it.
            retry = self._duplicateKeyRetries(e, operations)
            try:
                self.collection.bulk_write(retry, ordered=False)
            except BulkWriteError as retryError:
                raise ValidationException(
                    "Saving property values failed: %s"
                    % bulkWriteErrorMessage(retryError)
                ) from retryError

        documents = list(self.find({"annotationId": {"$in": annotationIds}}))
        if self.is_recording:
            for after in documents:
                self.record.changeDocument(None, after)
        return documents

    @staticmethod
    def _upsertValues(entry):
        annotationId = entry["annotationId"]
        # datasetId is $set, not only set on insert: callers verify the
        # annotation is in this dataset, and the pre-#1356 merge could move
        # a values document to whichever dataset the caller named.
        values = entry["values"]
        update = {
            "$set": {
                "datasetId": entry["datasetId"],
                **{
                    "values." + propertyId: value
                    for propertyId, value in values.items()
                },
            },
            "$setOnInsert": {"_id": annotationId},
        }
        if len(values) == 0:
            update["$setOnInsert"]["values"] = {}
        return UpdateOne({"annotationId": annotationId}, update, upsert=True)

    @staticmethod
    def _duplicateKeyRetries(error, operations):
        writeErrors = error.details.get("writeErrors") or []
        if not writeErrors or any(
            writeError.get("code") != DUPLICATE_KEY_ERROR
            for writeError in writeErrors
        ):
            raise ValidationException(
                "Saving property values failed: %s"
                % bulkWriteErrorMessage(error)
            ) from error
        return [operations[writeError["index"]] for writeError in writeErrors]

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
            # Identity is global, but datasetId follows the live annotation.
            # Join in Mongo rather than issuing one model load per group.
            {"$lookup": {
                "from": "upenn_annotation", "localField": "_id",
                "foreignField": "_id", "as": "annotation",
            }},
            {"$set": {"liveDatasetId": {
                "$arrayElemAt": ["$annotation.datasetId", 0],
            }}},
            {"$unset": "annotation"},
        ]
        operations = []
        for group in self.collection.aggregate(pipeline, allowDiskUse=True):
            documents = group["documents"]
            merged = documents[0]["values"].copy()
            for document in documents[1:]:
                self._mergeMissingValues(merged, document["values"])
            fields = {"values": merged}
            if group.get("liveDatasetId") is not None:
                fields["datasetId"] = group["liveDatasetId"]
            operations.extend([
                UpdateOne(
                    {"_id": documents[0]["_id"]},
                    {"$set": fields},
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
        for start in range(0, len(annotationIds), MAX_IDS_PER_QUERY):
            chunk = annotationIds[start:start + MAX_IDS_PER_QUERY]
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

    def distinctStringValues(self, datasetId, propertyPath, search, limit):
        """The distinct STRING values at propertyPath (a list of keys) with
        their annotation counts, most common first (ties by value), for the
        categorical property filter. Returns (entries, truncated), where
        entries is a list of {value, count} of at most `limit` and truncated
        says more distinct values exist than were returned.

        `search` (optional) keeps only values containing it,
        case-insensitively; it is matched literally, not as a pattern.
        Numeric values are excluded: those properties filter by range, and a
        mixed property's numbers would only crowd the list."""
        valueKey = "values." + ".".join(propertyPath)
        condition = {"$type": "string"}
        if search:
            condition["$regex"] = re.escape(search)
            condition["$options"] = "i"
        pipeline = [
            {"$match": {"datasetId": datasetId, valueKey: condition}},
            {"$group": {"_id": "$" + valueKey, "count": {"$sum": 1}}},
            {"$sort": {"count": -1, "_id": 1}},
            # One extra row tells "exactly limit" apart from "more exist".
            {"$limit": limit + 1},
            {"$project": {"_id": 0, "value": "$_id", "count": 1}},
        ]
        entries = list(self.collection.aggregate(
            pipeline, maxTimeMS=AGGREGATION_MAX_TIME_MS
        ))
        return entries[:limit], len(entries) > limit

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
                # Non-finite values (a stored Infinity, NaN) are left out of
                # the buckets: a bucket bound of Infinity would reach the
                # client as null and break the filter slider's range.
                valueKey: {"$exists": True, "$nin": [
                    None, float("inf"), float("-inf"), float("nan"),
                ]},
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
