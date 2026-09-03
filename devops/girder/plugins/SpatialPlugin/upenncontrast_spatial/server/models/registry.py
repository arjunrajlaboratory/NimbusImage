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
        "label", "provenance", "activated",
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
        document.pop("versions", None)
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

    # ---- versions (Phase 4) ------------------------------------------------

    VERSION_FIELDS = ("itemId", "fileId", "schemaVersion", "nObs", "nVar",
                      "obsColumns")

    def registerVersion(self, entry, label, provenance=None):
        """Make `entry` the active table and keep the previous active table
        (if any, and if it is a different item) as a version."""
        now = datetime.datetime.utcnow()
        document = self.forDataset(entry["datasetId"]) or {
            "datasetId": entry["datasetId"], "created": now,
        }
        versions = list(document.get("versions", []))
        if "fileId" in document and document["itemId"] != entry["itemId"]:
            versions = [
                v for v in versions if v["itemId"] != document["itemId"]
            ] + [self._versionOf(document)]
        versions = [v for v in versions if v["itemId"] != entry["itemId"]]
        document.update(entry)
        document["label"] = label
        document["provenance"] = provenance or {}
        document["activated"] = now
        document["versions"] = versions
        document["updated"] = now
        return self.save(document)

    def _versionOf(self, document):
        return {
            **{key: document[key] for key in self.VERSION_FIELDS
               if key in document},
            "label": document.get("label", "Table"),
            "provenance": document.get("provenance", {}),
            "created": document.get("activated", document.get("updated")),
        }

    def activateVersion(self, datasetId, itemId):
        """Swap the active table with the version `itemId`; the active one
        joins the versions. Returns the document, or None if unknown."""
        document = self.forDataset(datasetId)
        if document is None:
            return None
        if document.get("itemId") == itemId:
            return document
        match = [
            v for v in document.get("versions", []) if v["itemId"] == itemId
        ]
        if not match:
            return None
        version = match[0]
        others = [
            v for v in document.get("versions", []) if v["itemId"] != itemId
        ]
        if "fileId" in document:
            others.append(self._versionOf(document))
        for key in self.TABLE_FIELDS:
            document.pop(key, None)
        document.update({key: version[key] for key in self.VERSION_FIELDS
                         if key in version})
        document["label"] = version.get("label", "Table")
        document["provenance"] = version.get("provenance", {})
        document["activated"] = datetime.datetime.utcnow()
        document["versions"] = others
        document["updated"] = document["activated"]
        return self.save(document)

    def forgetVersion(self, datasetId, itemId):
        """Drop a non-active version. Returns the dropped version or None."""
        document = self.forDataset(datasetId)
        if document is None:
            return None
        match = [
            v for v in document.get("versions", []) if v["itemId"] == itemId
        ]
        if not match:
            return None
        document["versions"] = [
            v for v in document["versions"] if v["itemId"] != itemId
        ]
        document["updated"] = datetime.datetime.utcnow()
        self.save(document)
        return match[0]
