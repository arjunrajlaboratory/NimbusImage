"""Helpers for server-side import of exported annotation data.

Takes the data produced by the ``export`` endpoint (or a copy of it
loaded from a JSON file on the frontend) and recreates it under a
target dataset, remapping the old annotation/property ids referenced
by connections and property values to the ids of the newly created
documents.
"""

from girder.exceptions import ValidationException

from ..models.annotation import Annotation as AnnotationModel
from ..models.connections import AnnotationConnection as ConnectionModel
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)

# Fields copied verbatim from an imported annotation document.
# datasetId is always overwritten with the target dataset, and _id/id
# are never copied since imported annotations are always inserted as
# new documents.
ANNOTATION_IMPORT_FIELDS = (
    "name", "coordinates", "tags", "channel", "location", "shape", "color",
)


def _oldAnnotationId(annotation):
    """Return the old id (string) an imported annotation was saved as.

    Server-generated exports key the old id under "_id"; some legacy
    frontend exports use "id" instead. Returns None if neither key is
    present, in which case the annotation is still imported but has
    no old id to remap connections/property values against.
    """
    oldId = annotation.get("_id", annotation.get("id"))
    return str(oldId) if oldId is not None else None


def _createAnnotations(datasetId, annotations):
    """Create sanitized copies of the imported annotations.

    :returns: A tuple (createdDocs, oldIdToNewId), where oldIdToNewId
        maps each annotation's old id (string) to its new ObjectId,
        for annotations that carried an old id in the import data.
    """
    oldIds = []
    docs = []
    for annotation in annotations:
        if not isinstance(annotation, dict):
            raise ValidationException(
                "Each annotation must be a JSON object."
            )
        oldIds.append(_oldAnnotationId(annotation))
        # Null fields are dropped, not copied: exports contain e.g.
        # "name": null for unnamed annotations, but the annotation
        # schema only allows a string when the field is present.
        doc = {
            field: annotation[field]
            for field in ANNOTATION_IMPORT_FIELDS
            if annotation.get(field) is not None
        }
        doc["datasetId"] = datasetId
        docs.append(doc)

    # saveMany() inserts via insert_many(), which preserves list order,
    # so zipping the pre-creation old ids with the created docs lines
    # each new document up with the old id it came from.
    createdDocs = AnnotationModel().createMultiple(docs)

    oldIdToNewId = {}
    for oldId, createdDoc in zip(oldIds, createdDocs):
        if oldId is not None:
            oldIdToNewId[oldId] = createdDoc["_id"]
    return createdDocs, oldIdToNewId


def _remapAnnotationId(oldId, oldIdToNewId):
    newId = oldIdToNewId.get(str(oldId))
    if newId is None:
        raise ValidationException(
            "Import references unknown annotation id: %s" % oldId
        )
    return newId


def _createConnections(datasetId, connections, oldIdToNewId):
    """Remap and create the imported connections.

    :raises ValidationException: If a connection references an
        annotation id that is not in oldIdToNewId, i.e. was not part
        of the imported annotations.
    """
    docs = []
    for connection in connections:
        if not isinstance(connection, dict):
            raise ValidationException(
                "Each connection must be a JSON object."
            )
        doc = {
            "tags": connection.get("tags") or [],
            "parentId": _remapAnnotationId(
                connection.get("parentId"), oldIdToNewId
            ),
            "childId": _remapAnnotationId(
                connection.get("childId"), oldIdToNewId
            ),
            "datasetId": datasetId,
        }
        if "label" in connection:
            doc["label"] = connection["label"]
        docs.append(doc)
    return ConnectionModel().createMultiple(docs)


def _createPropertyValues(
    datasetId, propertyValues, propertyIdMap, oldIdToNewId
):
    """Remap and create the imported property values.

    Values whose old property id is missing from propertyIdMap are
    silently skipped: exports can contain values for properties that
    were not part of the property list included in that export, which
    is expected and not an error. An entry left with no values after
    skipping is dropped entirely.

    :raises ValidationException: If an entry references an annotation
        id that is not in oldIdToNewId.
    """
    docs = []
    for oldAnnotationId, valuesByOldPropertyId in propertyValues.items():
        if not isinstance(valuesByOldPropertyId, dict):
            raise ValidationException(
                "Each property value entry must be a JSON object."
            )
        newAnnotationId = oldIdToNewId.get(oldAnnotationId)
        if newAnnotationId is None:
            raise ValidationException(
                "Import references unknown annotation id: %s"
                % oldAnnotationId
            )
        remappedValues = {}
        for oldPropertyId, value in valuesByOldPropertyId.items():
            newPropertyId = propertyIdMap.get(oldPropertyId)
            if newPropertyId is None:
                continue
            remappedValues[newPropertyId] = value
        if not remappedValues:
            continue
        docs.append({
            "annotationId": newAnnotationId,
            "datasetId": datasetId,
            "values": remappedValues,
        })
    return PropertyValuesModel().appendMultipleValues(docs)


def _rollbackImport(annotationDocs, connectionDocs, annotationIds):
    """Best-effort cleanup of a partially completed import.

    Deletes explicitly rather than relying on the annotation-removal
    cascade (the "model.upenn_annotation.removeStringIds" event that
    normally cleans up connections/property values), so cleanup here
    is not dependent on that event graph doing the right thing for a
    failure that can happen at any step of the import.
    """
    if annotationIds:
        PropertyValuesModel().removeWithQuery(
            {"annotationId": {"$in": annotationIds}}
        )
    if connectionDocs:
        ConnectionModel().deleteMultiple(
            [str(doc["_id"]) for doc in connectionDocs]
        )
    if annotationDocs:
        AnnotationModel().deleteMultiple(
            [str(doc["_id"]) for doc in annotationDocs]
        )


def importAnnotationData(
    datasetId, annotations, connections, propertyValues, propertyIdMap
):
    """Import a batch of exported annotation data into a dataset.

    :param datasetId: ObjectId of the target dataset. The caller is
        responsible for verifying the current user has WRITE access.
    :param annotations: List of raw annotation dicts, keyed by "_id"
        or "id" for their old id (see _oldAnnotationId).
    :param connections: List of raw connection dicts referencing
        annotations above via their old parentId/childId.
    :param propertyValues: Dict of
        {oldAnnotationId: {oldPropertyId: value}}.
    :param propertyIdMap: Dict of {oldPropertyId: newPropertyId}.
    :returns: Dict with annotationCount, connectionCount, and
        propertyValueCount.
    :raises ValidationException: If a connection or property value
        entry references an annotation id outside the imported set.
    """
    createdAnnotations = []
    createdConnections = []
    newAnnotationIds = []
    try:
        createdAnnotations, oldIdToNewId = _createAnnotations(
            datasetId, annotations
        )
        newAnnotationIds = list(oldIdToNewId.values())
        createdConnections = _createConnections(
            datasetId, connections, oldIdToNewId
        )
        createdPropertyValues = _createPropertyValues(
            datasetId, propertyValues, propertyIdMap, oldIdToNewId
        )
    except Exception:
        # Cleanup-and-reraise: always re-raises, so this does not
        # swallow the original error.
        _rollbackImport(
            createdAnnotations, createdConnections, newAnnotationIds
        )
        raise

    return {
        "annotationCount": len(createdAnnotations),
        "connectionCount": len(createdConnections),
        "propertyValueCount": len(createdPropertyValues),
    }
