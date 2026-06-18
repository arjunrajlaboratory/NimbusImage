import fastjsonschema

from bson.objectid import ObjectId

from girder import events
from girder.constants import AccessType, SortDir
from girder.exceptions import AccessException, ValidationException
from girder.models.folder import Folder

from girder.utility.acl_mixin import AccessControlMixin

from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel
from ..helpers.tasks import runJobRequest


class AnnotationSchema:
    coordSchema = {
        "type": "object",
        "properties": {
            "x": {"type": "number"},
            "y": {"type": "number"},
            "z": {"type": "number"},
        },
        "name": "Coordinate",
        "description": "GeoJS point",
        "required": ["x", "y"],
    }

    coordsSchema = {"type": "array", "items": coordSchema, "minItems": 1}

    tagsSchema = {"type": "array", "items": {"type": "string"}}

    locationSchema = {
        "type": "object",
        "properties": {
            "XY": {"type": "integer"},
            "Z": {"type": "integer"},
            "Time": {"type": "integer"},
        },
    }

    shapeSchema = {
        "type": "string",
        "enum": ["point", "line", "polygon", "rectangle"],
    }

    annotationSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/annotation",
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
            },
            "coordinates": coordsSchema,
            "tags": tagsSchema,
            "channel": {"type": "integer"},
            "location": locationSchema,
            "shape": shapeSchema,
            "datasetId": {"type": "objectId"},
            "color": {
                "type": ["string", "null"],
            },
        },
        # color is optional (legacy, equivalent to null)
        "required": [
            "coordinates",
            "tags",
            "channel",
            "location",
            "shape",
            "datasetId",
        ],
    }


# AccessControlMixin must precede ProxiedModel so its permission-aware
# find/load methods (e.g. findWithPermissions) take MRO precedence over
# the unchecked methods on the base model.
class Annotation(AccessControlMixin, ProxiedModel):
    """
    Defines a model for storing and handling UPennContrast annotations in the
    database.
    """

    # TODO: write lock
    # TODO: save creatorId, creation and update dates

    def __init__(self):
        super().__init__()
        compoundSearchIndex = (
            ('datasetId', SortDir.ASCENDING),
            ('_id', SortDir.ASCENDING)
        )
        self.ensureIndices([(compoundSearchIndex, {}),
                            "name", "datasetId", "channel", "location"])

        # Used by Girder to define what field are used to check permissions
        self.resourceColl = 'folder'
        self.resourceParent = 'datasetId'

        self.schema = AnnotationSchema.annotationSchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(AnnotationSchema.annotationSchema)
    )

    def annotationRemovedEvent(self, event):
        if event.info and event.info["_id"]:
            events.trigger(
                "model.upenn_annotation.removeStringIds", [event.info["_id"]]
            )

    def multipleAnnotationsRemovedEvent(self, event):
        if event.info and len(event.info) > 0:
            annotationStringIds = event.info
            events.trigger(
                "model.upenn_annotation.removeStringIds", annotationStringIds
            )

    def initialize(self):
        self.name = "upenn_annotation"
        events.bind(
            "model.folder.remove",
            "upenn.annotations.clean.orphaned",
            self.cleanOrphaned,
        )
        # Cleaning the database when annotations are removed is done by a
        # custom event: model.upenn_annotation.removeStringIds
        events.bind(
            "model.upenn_annotation.remove",
            "upenn.connections.annotationRemovedEvent",
            self.annotationRemovedEvent,
        )
        events.bind(
            "model.upenn_annotation.removeMultiple",
            "upenn.connections.multipleAnnotationsRemovedEvent",
            self.multipleAnnotationsRemovedEvent,
        )
        self.ensureIndices(["datasetId"])

    def cleanOrphaned(self, event):
        if event.info and event.info["_id"]:
            query = {
                "datasetId": event.info["_id"],
            }
            self.removeWithQuery(query)

    def isDatasetId(self, datasetId):
        folder = Folder().load(datasetId, force=True)
        return (
            folder is not None
            and "meta" in folder
            and folder["meta"].get("subtype", None) == "contrastDataset"
        )

    def validate(self, document):
        return self.validateMultiple([document])[0]

    def validateMultiple(self, annotations):
        # Validate using the schema
        try:
            for annotation in annotations:
                self.jsonValidate(annotation)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)

        # Check if the datasets exist
        datasetIds = set(annotation["datasetId"] for annotation in annotations)

        for datasetId in datasetIds:
            if not self.isDatasetId(datasetId):
                raise ValidationException("Annotation dataset ID is invalid")

        return annotations

    def create(self, annotation):
        annotation.pop('_id', None)
        return self.save(annotation)

    def createMultiple(self, annotations):
        for annotation in annotations:
            annotation.pop('_id', None)
        return self.saveMany(annotations)

    def delete(self, annotation):
        self.remove(annotation)

    def deleteMultiple(self, annotationStringIds):
        events.trigger(
            "model.upenn_annotation.removeMultiple", annotationStringIds
        )
        query = {
            "_id": {
                "$in": [ObjectId(stringId) for stringId in annotationStringIds]
            },
        }
        self.removeWithQuery(query)

    def _buildListMatchStages(self, datasetId, filters):
        """Pipeline stages matching annotation-document fields.

        Tag semantics mirror the client tagCloudFilterFunction:
        inclusive -> $in (has any); exclusive -> exactly that set.
        """
        match = {"datasetId": datasetId}
        if filters.get("shape"):
            match["shape"] = filters["shape"]

        tags = filters.get("tags") or {}
        tagValues = tags.get("values") or []
        if tagValues:
            if tags.get("exclusive"):
                match["tags"] = {"$all": tagValues, "$size": len(tagValues)}
            else:
                match["tags"] = {"$in": tagValues}

        location = filters.get("location")
        if location:
            if location.get("XY") is not None:
                match["location.XY"] = location["XY"]
            if location.get("Z") is not None:
                match["location.Z"] = location["Z"]
            if location.get("Time") is not None:
                match["location.Time"] = location["Time"]

        # Each id constraint is an _id $in set; the annotation must match
        # ALL of them (AND of $in's). Mirrors the client selectionFilter
        # and annotationIdFilters membership semantics.
        idConstraints = filters.get("idConstraints")
        if idConstraints:
            match["$and"] = [
                {"_id": {"$in": [ObjectId(i) for i in ids]}}
                for ids in idConstraints
            ]

        stages = [{"$match": match}]

        idSubstring = filters.get("idSubstring")
        if idSubstring:
            stages.append({"$match": {"$expr": {"$regexMatch": {
                "input": {"$toString": "$_id"},
                "regex": idSubstring,
            }}}})
        return stages

    def listIds(self, datasetId, filters):
        """All annotation _ids (as strings) matching the filters."""
        pipeline = self._composePipeline(
            datasetId, filters, None, [], include_sort=False,
        )
        pipeline.append({"$project": {"_id": 1}})
        cursor = self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
        return [str(doc["_id"]) for doc in cursor]

    # Annotation fields allowed as a sort key (field-type sort).
    _SORTABLE_FIELDS = {"location.XY", "location.Z", "location.Time",
                        "name", "channel", "_id"}

    def _centroidAddFields(self):
        return {"$addFields": {"centroid": {
            "x": {"$avg": "$coordinates.x"},
            "y": {"$avg": "$coordinates.y"},
        }}}

    PROPERTY_VALUES_COLLECTION = "annotation_property_values"

    def _needsLookup(self, filters, sort, propertyPaths):
        if propertyPaths:
            return True
        if sort and sort.get("type") == "property":
            return True
        return bool(filters.get("propertyFilters"))

    def _lookupStages(self):
        return [
            {"$lookup": {
                "from": self.PROPERTY_VALUES_COLLECTION,
                "localField": "_id",
                "foreignField": "annotationId",
                "as": "_pv",
            }},
            {"$unwind": {
                "path": "$_pv", "preserveNullAndEmptyArrays": True,
            }},
        ]

    def _propertyFilterStages(self, filters):
        stages = []
        for pf in filters.get("propertyFilters") or []:
            valueKey = "_pv.values." + ".".join(pf["path"])
            if pf.get("mode") == "values":
                values = pf.get("values") or []
                if values:
                    stages.append({"$match": {valueKey: {"$in": values}}})
            else:  # range
                cond = {}
                if pf.get("min") is not None:
                    cond["$gte"] = pf["min"]
                if pf.get("max") is not None:
                    cond["$lte"] = pf["max"]
                if cond:
                    stages.append({"$match": {valueKey: cond}})
        return stages

    def _projectStage(self, propertyPaths):
        project = {"coordinates": 0, "_pv": 0, "_sortValue": 0,
                   "_hasSortValue": 0}
        stages = []
        if propertyPaths:
            valuesExpr = {}
            for path in propertyPaths:
                ref = "$_pv.values." + ".".join(path)
                node = valuesExpr
                for key in path[:-1]:
                    node = node.setdefault(key, {})
                node[path[-1]] = {"$ifNull": [ref, "$$REMOVE"]}
            stages.append({"$addFields": {"values": valuesExpr}})
        stages.append({"$project": project})
        return stages

    def _propertySortAddFields(self, sort):
        if sort and sort.get("type") == "property":
            ref = "$_pv.values." + ".".join(sort["key"])
            return [{"$addFields": {
                "_sortValue": ref,
                "_hasSortValue": {"$cond": [
                    {"$ne": [{"$ifNull": [ref, None]}, None]}, 1, 0,
                ]},
            }}]
        return []

    def _sortStage(self, sort):
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "property":
            # _hasSortValue desc puts present-values first (so missing
            # always lands last regardless of direction).
            return {"$sort": {
                "_hasSortValue": -1, "_sortValue": direction, "_id": 1,
            }}
        if sort and sort.get("type") == "field":
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            if key == "_id":
                return {"$sort": {"_id": direction}}
            return {"$sort": {key: direction, "_id": 1}}
        return {"$sort": {"_id": 1}}

    def _composePipeline(self, datasetId, filters, sort, propertyPaths,
                         include_sort):
        pipeline = self._buildListMatchStages(datasetId, filters)
        if self._needsLookup(filters, sort, propertyPaths):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
        if include_sort:
            pipeline += self._propertySortAddFields(sort)
            pipeline.append(self._centroidAddFields())
            pipeline.append(self._sortStage(sort))
        return pipeline

    def listCount(self, datasetId, filters):
        # Count only needs the lookup when a property FILTER is active
        # (sorting never changes the count).
        pipeline = self._buildListMatchStages(datasetId, filters)
        if filters.get("propertyFilters"):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
        pipeline.append({"$count": "n"})
        result = list(self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        ))
        return result[0]["n"] if result else 0

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        pipeline = self._composePipeline(
            datasetId, filters, sort, propertyPaths, include_sort=True,
        )
        pipeline.append({"$skip": max(0, offset)})
        pipeline.append({"$limit": limit})
        pipeline += self._projectStage(propertyPaths)
        return self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )

    def getAnnotationById(self, id, user=None):
        return self.load(id, user=user, level=AccessType.READ)

    def updateMultiple(self, annotationIdToUpdate, user):
        """Update multiple annotations.

        :param annotationIdToUpdate: dict mapping ObjectId -> update dict.
            Each update dict should already have 'id'/'_id' removed and
            datasetId converted to ObjectId if present.
        :param user: The current user (for permission checks).
        :returns: List of saved annotation documents.
        """
        if not annotationIdToUpdate:
            return []

        query = {
            "_id": {
                "$in": list(annotationIdToUpdate.keys())
            },
        }
        cursor = self.findWithPermissions(
            query, user=user, level=AccessType.WRITE
        )
        expectedIds = set(annotationIdToUpdate.keys())
        foundIds = set()
        updatedAnnotations = []
        for annotation in cursor:
            annotationId = annotation["_id"]
            updateDoc = annotationIdToUpdate[annotationId]
            annotation.update(updateDoc)
            foundIds.add(annotationId)
            updatedAnnotations.append(annotation)
        if foundIds != expectedIds:
            raise AccessException(
                "Write access was denied for one or more annotations."
            )
        return self.saveMany(updatedAnnotations)

    def compute(self, datasetId, tool, user=None):
        dataset = Folder().load(
            datasetId, user=user, level=AccessType.WRITE
        )
        if not dataset:
            raise ValidationException(
                "Invalid dataset id in annotation"
            )
        image = tool.get("image", None)
        if not image:
            raise ValidationException(
                "Invalid segmentation tool: no image"
            )
        return runJobRequest(image, datasetId, tool, "compute")
