import copy
import random

datasetMetadata = {"subtype": "contrastDataset"}

sampleAnnotationName = "sample annotation"
sampleAnnotation = {
    "tags": ["tag"],
    "shape": "point",
    "name": sampleAnnotationName,
    "channel": 0,
    "location": {"XY": 0, "Z": 0, "Time": 0},
    "coordinates": [{"x": 761.152955940129, "y": 792.514654689579, "z": 0}],
    "datasetId": None,
}


def getSampleAnnotation(datasetId):
    label = "Test Annotation {}".format(random.random())
    annotation = copy.deepcopy(sampleAnnotation)
    annotation["name"] = label
    annotation["datasetId"] = str(datasetId)
    return annotation


sampleConnection = {
    "tags": [],
    "childId": "61a4b2a3a8d45ec0d0709b04",
    "parentId": "61a4b2a0a8d45ec0d0709b02",
    "datasetId": "60f5c76ec6c95554b3e1e3e0",
}


def getSampleConnection(parentId, childId, datasetId):
    label = "Test Connection {}".format(random.random())

    return {
        "label": label,
        "tags": [],
        "parentId": str(parentId),
        "childId": str(childId),
        "datasetId": str(datasetId),
    }
