from girder import events
from girder.exceptions import ValidationException
from girder.models.model_base import AccessControlledModel

from pymongo.errors import BulkWriteError, WriteError
from bson.objectid import ObjectId


class CustomAccessControlledModel(AccessControlledModel):
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

        idsToRemove = [
            ObjectId(document["_id"])
            for document in documents
            if "_id" in document
        ]
        if len(idsToRemove) > 0:
            try:
                self.removeWithQuery({"_id": {"$in": idsToRemove}})
            except WriteError as e:
                raise ValidationException(
                    "Database save many failed while deleting duplicate keys: "
                    + e.details
                )

        try:
            documentIds = self.collection.insert_many(documents).inserted_ids
        except BulkWriteError as e:
            raise ValidationException(
                "Database save many failed: " + e.details
            )

        for document, documentId in zip(documents, documentIds):
            document["_id"] = documentId

        if triggerEvents:
            events.trigger(
                "model.%s.saveMany.after" % self.name,
                {"newDocuments": documents, "removedIds": idsToRemove},
            )

        return documents
