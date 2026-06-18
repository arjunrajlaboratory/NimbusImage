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
        pipeline = self._buildListMatchStages(datasetId, filters)
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

    def _sortStage(self, sort):
        """$sort stage for a field-type sort (property sort added in a
        later task). Always tie-break on _id for stable paging."""
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "field":
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            if key == "_id":
                return {"$sort": {"_id": direction}}
            return {"$sort": {key: direction, "_id": 1}}
        return {"$sort": {"_id": 1}}

    def listCount(self, datasetId, filters):
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append({"$count": "n"})
        result = list(self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        ))
        return result[0]["n"] if result else 0

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append(self._centroidAddFields())
        pipeline.append(self._sortStage(sort))
        pipeline.append({"$skip": max(0, offset)})
        pipeline.append({"$limit": limit})
        pipeline.append({"$project": {"coordinates": 0}})
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
