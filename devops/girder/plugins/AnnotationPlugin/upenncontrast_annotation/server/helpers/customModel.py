from girder import events
from girder.exceptions import ValidationException
from girder.models.model_base import AccessControlledModel

from pymongo import InsertOne, ReplaceOne
from pymongo.errors import BulkWriteError
from bson.objectid import ObjectId

from upenncontrast_annotation.server.helpers.serialization import \
    convertIdsToObjectIds


def bulkWriteErrorMessage(error):
    """Readable summary of a pymongo BulkWriteError.

    ``error.details`` is a dict, so it must be formatted rather than
    concatenated onto a message (issue #1357).
    """
    writeErrors = error.details.get("writeErrors") or []
    if not writeErrors:
        return str(error.details)
    return "; ".join(
        writeError.get("errmsg", str(writeError))
        for writeError in writeErrors[:3]
    )


class CustomNimbusImageModel(AccessControlledModel):
    def saveMany(self, documents, validate=True, triggerEvents=True):
        """
        Create or update several documents in the collection. If a single
        document fails the validation, no document is added or removed.
        This triggers two events; one prior to validation, and one prior to
        saving. Either of these events may have their default action
        prevented.

        :param documents: The list of document to save.
        :type documents: list of dict
        :param validate: Whether to call the model's validate() before saving.
        :type validate: bool
        :param triggerEvents: Whether to trigger events for validate and
            pre- and post-save hooks.
        :type triggerEvents: bool
        """
        if len(documents) == 0:
            return documents
        if validate and triggerEvents:
            event = events.trigger(
                ".".join(("model", self.name, "validateMultiple")), documents
            )
            if event.defaultPrevented:
                validate = False

        if validate:
            if getattr(self, "validateMultiple", None) is not None:
                documents = self.validateMultiple(documents)
            else:
                documents = [self.validate(document) for document in documents]

        if triggerEvents:
            event = events.trigger("model.%s.saveMany" % self.name, documents)
            if event.defaultPrevented:
                return documents

        # Replace existing documents in place and insert new ones in a single
        # bulk write. Each replacement is atomic per document: an earlier
        # delete-then-insert let concurrent writers of the same documents
        # race into E11000 duplicate-key errors after one had already
        # deleted its batch (issue #1356).
        replacedIds = [
            ObjectId(document["_id"])
            for document in documents
            if "_id" in document
        ]
        operations = []
        for document in documents:
            if "_id" in document:
                document["_id"] = ObjectId(document["_id"])
                operations.append(ReplaceOne(
                    {"_id": document["_id"]}, document, upsert=True
                ))
            else:
                # InsertOne sets the new _id on the document itself.
                operations.append(InsertOne(document))
        try:
            self.collection.bulk_write(operations)
        except BulkWriteError as e:
            raise ValidationException(
                "Database save many failed: %s" % bulkWriteErrorMessage(e)
            ) from e

        if triggerEvents:
            events.trigger(
                "model.%s.saveMany.after" % self.name,
                {"newDocuments": documents, "removedIds": replacedIds},
            )

        return documents

    def getUpdatableFields(self):
        """Return the set of fields that may be modified via update.

        Derived from the model's JSON schema ``properties``.  Internal
        fields (``_id``) are always excluded.  Models can override this
        to further restrict the set.
        """
        if not self.schema:
            raise NotImplementedError(
                "Need to define schema to get updatable fields"
            )
        return frozenset(
            self.schema["properties"].keys()
        ) - {"_id"}

    def filterUpdateFields(self, update):
        """Strip any keys from *update* that are not updatable.

        Returns a new dict containing only whitelisted keys.
        """
        allowed = self.getUpdatableFields()
        return {
            k: v for k, v in update.items()
            if k in allowed
        }

    def convertIdsToObjectIds(self, objOrObjs):
        if not self.schema:
            raise NotImplementedError(
                "Need to define schema to convert object ids to ObjectIds")
        keysToConvert = [
            key for key in self.schema["properties"]
            if self.schema["properties"][key].get("type") == "objectId"]
        return convertIdsToObjectIds(objOrObjs, keysToConvert)
