"""`dataset_spatial`: one document per dataset naming its registered store.

{datasetId, itemId, fileId, schemaVersion, nObs, nVar, obsColumns, created,
updated}. Access is the dataset folder's: the API loads the folder with the
required level before touching this collection, so the model carries no
access control of its own.
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

    def unregister(self, datasetId):
        document = self.forDataset(datasetId)
        if document is not None:
            self.remove(document)
        return document
