from upenncontrast_annotation.server.models.annotation \
    import Annotation
from upenncontrast_annotation.server.models.connections \
    import AnnotationConnection
from upenncontrast_annotation.server.models.datasetView \
    import DatasetView
from upenncontrast_annotation.server.models.propertyValues \
    import AnnotationPropertyValues
from upenncontrast_annotation.server.models.collection import Collection

from girder.models.item import Item

Annotation().collection.update_many(
    {},
    [
        {"$set": {"datasetId": {"$toObjectId": "$datasetId"}}},
        {"$unset": "access"}
    ]
)

AnnotationConnection().collection.update_many(
    {},
    [
        {"$set": {
            "datasetId": {"$toObjectId": "$datasetId"},
            "parentId": {"$toObjectId": "$parentId"},
            "childId": {"$toObjectId": "$childId"},
        }},
        {"$unset": "access"}
    ]
)

AnnotationPropertyValues().collection.update_many(
    {},
    [
        {"$set": {
            "datasetId": {"$toObjectId": "$datasetId"},
            "annotationId": {"$toObjectId": "$annotationId"},
        }},
        {"$unset": "access"}
    ]
)

DatasetView().collection.update_many(
    {},
    [
        {"$set": {
            "datasetId": {"$toObjectId": "$datasetId"},
            "configurationId": {"$toObjectId": "$configurationId"},
        }}
    ]
)

nimbusCollections = Item().find({"meta.subtype": "contrastConfiguration"})
for oldCollection in nimbusCollections:
    newCollection = oldCollection.copy()
    collectionId = newCollection.pop("_id")
    collectionDatasetViews = list(
        DatasetView().find({"configurationId": collectionId}))
    newCollection["access"] = {
        "groups": [],
        "users": [
            {
                "id": newCollection["creatorId"],
                "level": 2,
                "flags": []
            }
        ]
    }
    newCollection = Collection().save(newCollection)
    for collectionDatasetView in collectionDatasetViews:
        collectionDatasetView["configurationId"] = newCollection['_id']
        if "lastLocation" not in collectionDatasetView:
            collectionDatasetView['lastLocation'] = {
                "time": 0,
                "xy": 0,
                "z": 0
            }
        DatasetView().save(collectionDatasetView)
    Item().collection.delete_one({'_id': oldCollection['_id']})
