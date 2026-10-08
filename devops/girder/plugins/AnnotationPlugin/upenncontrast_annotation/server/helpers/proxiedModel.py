from girder import events
from girder.api import rest
from girder.exceptions import AccessException
from .customModel import CustomNimbusImageModel

from ..models.history import History as HistoryModel

from functools import wraps
from bson.objectid import ObjectId


def memoizeBodyJson(func):
    """
    A decorator on rest.Resource methods to cache the result of
    self.getBodyJson()
    This is usefull when some decorators and the decorated function use it
    For example, when using @recordable with a findDatasetIdFn that uses
    bodyJson

    Use this decorator before any other decorator using memoizedBodyJson:
    ```
    @memoizeBodyJson
    @recordable('Foo', bar)
    def f(self, *args, **kwargs):
        pass
    ```
    """

    @wraps(func)
    def wrapped(self: rest.Resource, *args, **kwargs):
        return func(self, *args, **kwargs, memoizedBodyJson=self.getBodyJson())

    return wrapped


class recordable:
    """
    A decorator which makes a function able to record the write operations on
    the database
    """

    def __init__(self, actionName, findDatasetIdFn):
        # Don't cache HistoryModel() here: decorators run at import, and a
        # cached instance outlives the singleton (the test suite resets it
        # between tests). Look it up per call in wrapped_fun instead.
        self.actionName = actionName
        self.findDatasetIdFn = findDatasetIdFn

    def __call__(self, fun):
        @wraps(fun)
        def wrapped_fun(*args, **kwargs):
            actionDate = HistoryModel.now()

            # Find dataset ID
            datasetId = self.findDatasetIdFn(*args, **kwargs)
            if datasetId is None:
                return fun(*args, **kwargs)

            # Wrap original endpoint between a start and a stop recording.
            # The finally ensures stopRecording fires even on failure so the
            # model's recording state never leaks across requests.
            events.trigger("proxiedModel.startRecording")
            try:
                val = fun(*args, **kwargs)
            finally:
                record = events.trigger(
                    "proxiedModel.stopRecording", {}
                ).info

            # Create a new history document
            user = rest.getCurrentUser()
            if user is None:
                raise AccessException("You must be logged in.")
            document = {
                "actionName": self.actionName,
                "actionDate": actionDate,
                "userId": user["_id"],  # type: ignore
                "isUndone": False,
                "datasetId": ObjectId(datasetId),
            }
            HistoryModel().create(user, document, record)

            return val

        return wrapped_fun


class ModelRecord:
    """
    A record of changes made to the database
    "changes" associates a string id (not an ObjectId) with a dict:
    { 'before': document or None, 'after': document or None }
    """

    def __init__(self):
        self.changes = {}

    def changeDocument(self, before, after):
        doc_with_id = (
            before
            if before is not None
            else after if after is not None else None
        )
        if doc_with_id is None:
            return
        doc_id = doc_with_id["_id"]
        old_change = self.changes.get(doc_id, None)
        if old_change:
            # old_change['after'] == before
            old_change["after"] = after
        else:
            self.changes[doc_id] = {"before": before, "after": after}


class ProxiedModel(CustomNimbusImageModel):
    """
    Enable recording of changes made to the database
    """

    def __init__(self):
        events.bind(
            "proxiedModel.startRecording",
            "upenn.proxiedModel."
            + self.__class__.__name__
            + ".startRecording",
            self.startRecordingEvent,
        )
        events.bind(
            "proxiedModel.stopRecording",
            "upenn.proxiedModel." + self.__class__.__name__ + ".stopRecording",
            self.stopRecordingEvent,
        )
        super().__init__()
        self.is_recording = False
        self.record = ModelRecord()

    def startRecordingEvent(self, event):
        self.startRecording()
        # List all the models recording changes
        if event.info is None:
            event.info = []
        event.info.append(self.name)

    def stopRecordingEvent(self, event):
        record = self.stopRecording()
        # Map a model name with the changes
        if event.info is None:
            event.info = {}
        event.info[self.name] = record.changes

    def startRecording(self):
        self.is_recording = True
        self.record = ModelRecord()

    def stopRecording(self):
        self.is_recording = False
        record = self.record
        self.record = ModelRecord()
        return record

    def removeWithQuery(self, query):
        if self.is_recording:
            docs_before = self.find(query)
            for before in docs_before:
                self.record.changeDocument(before, None)
        return super().removeWithQuery(query)

    def remove(self, document, **kwargs):
        if self.is_recording:
            before = self.findOne({"_id": document["_id"]})
            self.record.changeDocument(before, None)
        return super().remove(document, **kwargs)

    def update(self, query, update, multi=True):
        if self.is_recording:
            docs_before = self.find(query)
            for before in docs_before:
                self.record.changeDocument(before, None)
            val = super().update(query, update, multi)
            docs_after = self.find(query)
            for after in docs_after:
                self.record.changeDocument(None, after)
            return val
        return super().update(query, update, multi)

    def save(self, document, validate=True, triggerEvents=True):
        if self.is_recording:
            if "_id" in document:
                before = self.findOne({"_id": document["_id"]})
                self.record.changeDocument(before, None)
            after = super().save(document, validate, triggerEvents)
            self.record.changeDocument(None, after)
            return after
        return super().save(document, validate, triggerEvents)

    def saveMany(self, documents, validate=True, triggerEvents=True):
        if not self.is_recording:
            return super().saveMany(documents, validate, triggerEvents)
        # saveMany replaces documents in place, so capture the versions it
        # overwrites before writing.
        replacedIds = [
            ObjectId(document["_id"])
            for document in documents
            if "_id" in document
        ]
        if replacedIds:
            for before in self.find({"_id": {"$in": replacedIds}}):
                self.record.changeDocument(before, None)
        new_documents = super().saveMany(documents, validate, triggerEvents)
        for after in new_documents:
            self.record.changeDocument(None, after)
        return new_documents
