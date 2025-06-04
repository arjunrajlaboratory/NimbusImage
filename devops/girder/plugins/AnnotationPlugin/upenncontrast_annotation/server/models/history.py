from girder.constants import SortDir, AccessType
from girder.exceptions import ValidationException
from girder.models.model_base import AccessControlledModel
from girder.utility.model_importer import ModelImporter

from .documentChange import DocumentChange as DocumentChangeModel
from ..helpers.customModel import CustomNimbusImageModel

from ..helpers.fastjsonschema import customJsonSchemaCompile
import fastjsonschema

from bson.objectid import ObjectId
import datetime


class HistorySchema:
    historySchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/history",
        "type": "object",
        "properties": {
            "actionName": {
                "type": "string",
            },
            # https://pymongo.readthedocs.io/en/stable/examples/datetimes.html
            "actionDate": {
                # Special type defined in a custom validator
                "type": "datetime",
            },
            "userId": {
                # Special type defined in a custom validator
                "type": "objectId",
            },
            "isUndone": {
                "type": "boolean",
            },
            "datasetId": {
                # Special type defined in a custom validator
                "type": "objectId",
            },
        },
        "required": ["actionName", "actionDate", "userId", "isUndone"],
    }


class History(CustomNimbusImageModel, AccessControlledModel):
    """
    Register actions on some endpoints using the ProxiedModel
    This class itself doesn't inherit the ProxiedModel
    """

    def __init__(self):
        super().__init__()
        self.ensureIndices(["name", "datasetId", "userId"])
        self.schema = HistorySchema.historySchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(HistorySchema.historySchema)
    )

    @staticmethod
    def now():
        return datetime.datetime.now(tz=datetime.timezone.utc)

    def initialize(self):
        self.name = "history"
        self.documentChangeModel: DocumentChangeModel = DocumentChangeModel()

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            print("Validation of an history document failed")
            raise ValidationException(exp)
        return document

    def getLastEntries(self, user, datasetId: ObjectId):
        """
        Get the history entries for this user, sorted by descending actionDate
        Only return some fields from the model, as the record can be heavy and
        the userId is useless
        """
        query = {"userId": user["_id"], "datasetId": datasetId}
        sort = [("actionDate", SortDir.DESCENDING)]
        fields = {"_id": 0, "actionName": 1, "actionDate": 1, "isUndone": 1}
        return self.findWithPermissions(
            query, sort=sort, fields=fields, user=user
        )

    def undo(self, user, datasetId):
        self.undoOrRedo(user, datasetId, True)

    def redo(self, user, datasetId):
        self.undoOrRedo(user, datasetId, False)

    def undoOrRedo(self, user, datasetId, undo: bool):
        # Get the most recent action which has (not) been undone
        query = {
            "userId": user["_id"],
            "datasetId": datasetId,
            "isUndone": not undo,
        }
        sort = [
            ("actionDate", SortDir.DESCENDING if undo else SortDir.ASCENDING)
        ]
        history_entry = next(
            self.findWithPermissions(
                query, sort=sort, user=user, level=AccessType.WRITE, limit=1
            ),
            None,
        )
        if history_entry is None:
            return

        # Find the document changes for this history entry
        # Would have to use an aggregation pipeline to group by model_name
        # This feature is not available in girder, use the sort instead
        document_changes = self.documentChangeModel.findWithPermissions(
            {"historyId": history_entry["_id"]},
            sort=[("model_name", SortDir.ASCENDING)],
            user=user,
            level=AccessType.READ,
        )

        # Undo or redo the action
        change_key = "before" if undo else "after"
        previous_model_name = ""
        model = None
        for change in document_changes:
            document_id = change["documentId"]
            model_name = change["modelName"]
            if model_name != previous_model_name:
                model: CustomNimbusImageModel = ModelImporter.model(
                    model_name, "upenncontrast_annotation"
                )
                previous_model_name = model_name
            # Use 'before' when undoing, and 'after' when redoing
            replacement = change[change_key]
            if replacement is None:
                model.collection.delete_one({"_id": document_id})
            else:
                model.collection.replace_one(
                    {"_id": document_id}, replacement, upsert=True
                )

        # Update the entry
        history_entry["isUndone"] = undo
        return self.save(history_entry)

    def cleanRemoveWithQuery(self, query, creator, **kwargs):
        # Find the ids of the docs to remove
        removed_docs = self.find(
            query=query,
            user=creator,
            level=AccessType.WRITE,
            fields={"_id": 1},
            **kwargs
        )
        removed_ids = [entry["_id"] for entry in removed_docs]
        if len(removed_ids) == 0:
            return
        # Remove the docs
        self.removeWithQuery({"_id": {"$in": removed_ids}})
        # Cleanup the document changes
        self.documentChangeModel.removeWithQuery(
            {"historyId": {"$in": removed_ids}}
        )

    def create(self, creator, entry, record):
        # Remove history entries older than 1 hour or that have been undone
        min_entry_date = History.now() - datetime.timedelta(hours=1)
        self.cleanRemoveWithQuery(
            {
                "$or": [
                    {"actionDate": {"$lt": min_entry_date}},
                    {"userId": creator["_id"], "isUndone": True},
                ]
            },
            creator,
        )

        # Cap the number of entries per user
        max_entries_per_user = 10
        self.cleanRemoveWithQuery(
            {"userId": creator["_id"]},
            creator,
            sort=[("actionDate", SortDir.DESCENDING)],
            offset=max_entries_per_user - 1,
        )

        self.setUserAccess(
            entry, user=creator, level=AccessType.ADMIN, save=False
        )
        new_history_entry = self.save(entry)
        self.documentChangeModel.createChangesFromRecord(
            new_history_entry["_id"], record, creator
        )

        return new_history_entry
