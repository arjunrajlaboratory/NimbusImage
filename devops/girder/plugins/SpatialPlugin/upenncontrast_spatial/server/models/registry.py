"""`dataset_spatial`: one document per dataset naming its registered store.

{datasetId, itemId, fileId, schemaVersion, nObs, nVar, obsColumns, created,
updated} for the expression table, plus {transcriptsItemId,
transcriptsFileId, pixelSize, transform} once a transcript store is
registered (Phase 3); either half may be absent. Access is the dataset
folder's: the API loads the folder with the required level before touching
this collection, so the model carries no access control of its own.
"""

import datetime

from girder.models.model_base import Model


class DatasetSpatial(Model):
    def initialize(self):
        self.name = "dataset_spatial"
        self.ensureIndices(["datasetId"])

    def validate(self, document):
        return document

    def forDataset(self, datasetId):
        return self.findOne({"datasetId": datasetId})

    def register(self, entry):
        """Create or replace the dataset's registration with `entry` (from
        store.registryEntry)."""
        now = datetime.datetime.utcnow()
        document = self.forDataset(entry["datasetId"]) or {"created": now}
        document.update(entry)
        document["updated"] = now
        return self.save(document)

    TABLE_FIELDS = (
        "itemId", "fileId", "schemaVersion", "nObs", "nVar", "obsColumns",
    )

    def unregister(self, datasetId):
        """Forget the expression table; a transcript store registered on the
        same dataset stays."""
        document = self.forDataset(datasetId)
        if document is None:
            return None
        if "transcriptsFileId" not in document:
            self.remove(document)
            return document
        for key in self.TABLE_FIELDS:
            document.pop(key, None)
        return self.save(document)

    TRANSCRIPT_FIELDS = (
        "transcriptsItemId", "transcriptsFileId", "pixelSize", "transform",
    )

    def registerTranscripts(self, datasetId, fields):
        """Attach (or replace) the transcript store on the dataset's
        registration. The expression table may be registered later or not at
        all; a document holding only transcript fields is valid."""
        now = datetime.datetime.utcnow()
        document = self.forDataset(datasetId) or {
            "datasetId": datasetId, "created": now,
        }
        document.update({key: fields[key] for key in self.TRANSCRIPT_FIELDS})
        document["updated"] = now
        return self.save(document)

    def unregisterTranscripts(self, datasetId):
        document = self.forDataset(datasetId)
        if document is None:
            return None
        for key in self.TRANSCRIPT_FIELDS:
            document.pop(key, None)
        if "fileId" not in document:
            self.remove(document)
            return document
        return self.save(document)
