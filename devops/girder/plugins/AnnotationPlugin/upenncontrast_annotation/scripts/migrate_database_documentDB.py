from bson import ObjectId

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


for annotation in Annotation().collection.find({}):
    try:
        Annotation().collection.update_one(
            {'_id': annotation['_id']},
            {
                '$set': {'datasetId': ObjectId(annotation['datasetId'])},
                '$unset': {'access': ""}
            }
        )
    except Exception as e:
        print(f"Skipping {annotation['_id']} due to error: {e}")

for annotationConnection in AnnotationConnection().collection.find({}):
    try:
        update = {
            '$set': {
                'datasetId': ObjectId(annotationConnection['datasetId']),
                'parentId': ObjectId(annotationConnection['parentId']),
                'childId': ObjectId(annotationConnection['childId'])
            },
            '$unset': {'access': ""}
        }
        AnnotationConnection().collection.update_one(
            {'_id': annotationConnection['_id']}, update)
    except Exception as e:
        print(
            f"Skipping {annotationConnection['_id']} due to update error: {e}")


for annotationPropertyValue in AnnotationPropertyValues().collection.find({}):
    try:
        update = {
            '$set': {
                'datasetId': ObjectId(annotationPropertyValue['datasetId']),
                'annotationId': ObjectId(
                    annotationPropertyValue['annotationId']),
            },
            '$unset': {'access': ""}
        }
        AnnotationPropertyValues().collection.update_one(
            {'_id': annotationPropertyValue['_id']}, update)
    except Exception as e:
        print(
            f"Skipping {annotationPropertyValue['_id']}"
            f"due to update error: {e}")

for datasetView in DatasetView().collection.find({}):
    try:
        update = {
            '$set': {
                'datasetId': ObjectId(datasetView['datasetId']),
                'configurationId': ObjectId(datasetView['configurationId']),
            },
            '$unset': {'access': ""}
        }
        DatasetView().collection.update_one(
            {'_id': datasetView['_id']}, update)
    except Exception as e:
        print(
            f"Skipping {datasetView['_id']}"
            f"due to update error: {e}")

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
