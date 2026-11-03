from girder import events
from girder.exceptions import ValidationException
from girder.models import model_base
from girder.models.model_base import AccessControlledModel, Model

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

    def findRawBatches(self, query=None, offset=0, limit=0, timeout=None,
                       fields=None, sort=None, **kwargs):
        """`Model.find`, but the cursor yields raw BSON batches (concatenated
        documents, as bytes) instead of decoded documents.

        For endpoints that stream large result sets straight to JSON
        (`serialization.streamRawJsonArray`): decoding 100K annotations into
        dicts costs more than everything else in the request. It reaches the
        collection directly, the one exception besides aggregations to
        CLAUDE.md's "use Model().find(), not collection.find()" rule, so it
        repeats what Girder's `find` adds: the allowed extra find arguments,
        the cursor timeout, and the projection. Keep it in step with
        `girder.models.model_base.Model.find`
        (`testFindRawBatchesMatchesFind` compares the two).
        """
        query = query or {}
        kwargs = {
            k: kwargs[k] for k in kwargs if k in model_base._allowedFindArgs
        }
        timeout = timeout or model_base._MAX_CURSOR_TIMEOUT_MS
        cursor = self.collection.find_raw_batches(
            filter=query, skip=offset, limit=limit, projection=fields,
            no_cursor_timeout=timeout is None, sort=sort, **kwargs)
        if timeout:
            cursor.max_time_ms(timeout)
        return cursor

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


class UngatedAclFilterMixin:
    """For models whose documents carry a Girder ACL that does not decide
    who may read them -- a property is readable through the configurations
    that reference it, a worker interface or preview by any user.

    AccessControlledModel.filter() would report the caller's level on that
    ACL as `_accessLevel`, which is wrong for these documents (NONE for a
    collaborator who can read them), so filter by the exposed fields alone.
    Mix in ahead of the model base class.
    """

    def filter(self, doc, user=None, additionalKeys=None):
        return Model.filter(self, doc, user, additionalKeys)
