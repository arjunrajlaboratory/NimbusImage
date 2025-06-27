import fastjsonschema
import numpy as np

from bson.objectid import ObjectId

from girder import events
from girder.constants import AccessType, SortDir
from girder.exceptions import ValidationException
from girder.models.folder import Folder

from .annotation import Annotation

from ..helpers.connections import annotationToAnnotationDistance
from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedAccessControlledModel


class ConnectionSchema:
    tagsSchema = {"type": "array", "items": {"type": "string"}}

    connectionSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": (
            "/girder/plugins/upenncontrast_annotation/models/"
            "annotation_connection"
        ),
        "type": "object",
        "properties": {
            "label": {"type": "string"},
            "parentId": {"type": "string"},
            "childId": {"type": "string"},
            "datasetId": {"type": "string"},
            "tags": tagsSchema,
        },
        "required": ["parentId", "childId", "datasetId", "tags"],
    }


class AnnotationConnection(ProxiedAccessControlledModel):
    # TODO: write lock

    def __init__(self):
        super().__init__()
        compoundSearchIndex = (
            ('_id', SortDir.ASCENDING),
            ('datasetId', SortDir.ASCENDING)
        )
        self.ensureIndices([(compoundSearchIndex, {}),
                            "parentId", "childId", "datasetId"])

    jsonValidate = staticmethod(
        customJsonSchemaCompile(ConnectionSchema.connectionSchema)
    )

    def annotationsRemovedEvent(self, event):
        # Clean connections orphaned by the deletion of the annotations
        annotationStringIds = event.info
        pipeline = [
            # Select the first annotation from the array
            {"$match": {"_id": annotationStringIds[0]}},
            # Bring up all connections who share the same datasetId
            {"$lookup":
                {
                    "from": "annotation_connection",
                    "localField": "datasetId",
                    "foreignField": "datasetId",
                    "as": "datasetConnections"
                }},
            # Replace root with connections (remove unnecessary annotation
            # information)
            {"$unwind": "$datasetConnections"},
            {"$replaceRoot": {"newRoot": "$datasetConnections"}},
            # Only match connections whose childId or parentId match one of
            # the annotations to remove
            {"$match": {"$or": [
                {"childId": {"$in": annotationStringIds}},
                {"parentId": {"$in": annotationStringIds}}
            ]}},
            # Only keep the necessary information
            {"$project": {"_id": 1}}
        ]
        connectionsToRemove = [
            connection["_id"]
            for connection in Annotation().collection.aggregate(pipeline)]
        self.removeWithQuery({"_id": {"$in": connectionsToRemove}})

    def folderRemovedEvent(self, event):
        if event.info and event.info["_id"]:
            folderId = str(event.info["_id"])
            query = {
                "datasetId": folderId,
            }
            self.removeWithQuery(query)

    def initialize(self):
        self.name = "annotation_connection"
        events.bind(
            "model.upenn_annotation.removeStringIds",
            "upenn.connections.annotationsRemovedEvent",
            self.annotationsRemovedEvent,
        )
        events.bind(
            "model.folder.remove",
            "upenn.connections.folderRemovedEvent",
            self.folderRemovedEvent,
        )

    def validate(self, document):
        return self.validateMultiple([document])[0]

    def validateMultiple(self, connections):
        try:
            for connection in connections:
                self.jsonValidate(connection)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)

        datasetIds = set(connection["datasetId"] for connection in connections)
        for datasetId in datasetIds:
            folder = Folder().load(datasetId, force=True)
            if folder is None or not (
                "meta" in folder
                and folder["meta"].get("subtype", None) == "contrastDataset"
            ):
                raise ValidationException("Connection dataset ID is invalid")

        annotationModel = Annotation()

        childIds = set(connection["childId"] for connection in connections)
        childObjectIds = [ObjectId(childId) for childId in childIds]
        nFoundChildren = annotationModel.collection.count_documents(
            {"_id": {"$in": childObjectIds}}
        )
        if nFoundChildren != len(childIds):
            raise ValidationException("A child annotation does not exist")

        parentIds = set(connection["parentId"] for connection in connections)
        parentObjectIds = [ObjectId(parentId) for parentId in parentIds]
        nFoundParents = annotationModel.collection.count_documents(
            {"_id": {"$in": parentObjectIds}}
        )
        if nFoundParents != len(parentIds):
            raise ValidationException("A parent annotation does not exist")

        return connections

    def create(self, creator, connection):
        self.setUserAccess(
            connection, user=creator, level=AccessType.ADMIN, save=False
        )
        return self.save(connection)

    def createMultiple(self, creator, connections):
        for connection in connections:
            self.setUserAccess(
                connection, user=creator, level=AccessType.ADMIN, save=False
            )
        return self.saveMany(connections)

    def delete(self, connection):
        self.remove(self.find(connection))

    def deleteMultiple(self, connectionStringIds):
        query = {
            "_id": {
                "$in": [ObjectId(stringId) for stringId in connectionStringIds]
            },
        }
        return self.removeWithQuery(query)

    def getClosestAnnotation(self, annotationRef, annotations):
        """Get the closest annotation based on its distance to a reference
        annotation.

        Args:
            annotationRef (any): the annotation of reference
            annotations (any): a list of annotations

        Returns:
            Tuple(Annotation, Number): Returns a tuple of 2 items: the closest
                annotation and the minimum distance
            None: if no closest annotation is found
        """

        filteredAnnotations = [
            annotation
            for annotation in annotations
            if annotation["_id"] != annotationRef["_id"]
        ]
        if len(filteredAnnotations) == 0:
            return None
        distances = np.array(
            [
                annotationToAnnotationDistance(annotationRef, annotation)
                for annotation in filteredAnnotations
            ]
        )
        closestAnnotationIdx = np.argmin(distances)
        return (
            filteredAnnotations[closestAnnotationIdx],
            distances[closestAnnotationIdx],
        )

    def connectToNearest(self, info, user=None):
        # annotation ids, a list of tags and a channel index.
        connections = []

        annotationsIdsToConnect = info["annotationsIds"]
        ids = [ObjectId(id) for id in annotationsIdsToConnect]

        # Get annotations that match selected tags and channel
        query = {
            "_id": {"$nin": ids},
        }
        # channelId can be None if not specify
        channelId = info["channelId"]
        channelQuery = (
            {"channel": int(channelId)} if channelId is not None else {}
        )
        query.update(channelQuery)

        tags = info["tags"]
        tagsQuery = (
            {"tags": {"$in": tags}}
            if tags is not None and len(tags) > 0
            else {}
        )
        query.update(tagsQuery)

        # Loop on each annotation to connect
        # Look for the closest annotation and connect to it
        for id in ids:
            annotation = Annotation().getAnnotationById(id, user)

            if annotation is None:
                print("Annotation not defined", id)
                continue

            # Only work on annotations that are placed in the same tile
            location = annotation["location"]
            tileQuery = {"location": location}
            query.update(tileQuery)

            # Only work on annotations that are placed in the same dataset
            datasetId = annotation["datasetId"]
            datasetQuery = {"datasetId": datasetId}
            query.update(datasetQuery)

            annotations = list(Annotation().find(query))

            # Find the closest annotation
            result = self.getClosestAnnotation(annotation, annotations)

            # Define connection
            if result is not None:
                connections.append(
                    self.create(
                        creator=user,
                        connection={
                            "tags": [],
                            "label": "A Connection -- automatic",
                            "parentId": str(result[0]["_id"]),
                            "childId": str(id),
                            "datasetId": annotation["datasetId"],
                        },
                    )
                )

        return connections
