"""One dataset_spatial document per dataset, with independently optional
expression-table, transcript-store and neighborhood-summary fields.

Access is the dataset folder's: API callers check it before using this model.
All writers use revision-checked updates so a concurrent writer of either
half (including table versions) cannot replace another writer's snapshot.
"""

import datetime
from copy import deepcopy

from bson import ObjectId
from pymongo import DeleteMany, UpdateOne
from pymongo.errors import BulkWriteError, DuplicateKeyError

from girder.models.model_base import Model


class DatasetSpatial(Model):
    TABLE_FIELDS = (
        'itemId', 'fileId', 'schemaVersion', 'nObs', 'nVar', 'obsColumns',
        'label', 'provenance', 'activated',
    )
    TRANSCRIPT_FIELDS = (
        'transcriptsItemId', 'transcriptsFileId', 'pixelSize', 'transform',
    )
    VERSION_FIELDS = (
        'itemId', 'fileId', 'schemaVersion', 'nObs', 'nVar', 'obsColumns',
    )

    def initialize(self):
        self.name = 'dataset_spatial'

    def __init__(self):
        super().__init__()
        index = self.collection.index_information().get('datasetId_1')
        if index and not index.get('unique'):
            self.collection.drop_index('datasetId_1')
        # ensureIndices swallows errors; uniqueness must hold before writes.
        try:
            self.collection.create_index('datasetId', unique=True)
        except DuplicateKeyError:
            self._coalesceDuplicates()
            self.collection.create_index('datasetId', unique=True)

    def validate(self, document):
        return document

    def forDataset(self, datasetId):
        return self.findOne({'datasetId': datasetId})

    def _edit(self, datasetId, edit, create=False):
        """Apply a pure in-memory edit, retrying only a competing write.

        The callback returns its result (usually the edited document), or
        None for no change. A revision guards every update AND deletion.
        New rows use a unique-key upsert; a competing insert is reread.
        """
        while True:
            before = self.forDataset(datasetId)
            if before is None and not create:
                return None
            document = deepcopy(before) if before else {
                'datasetId': datasetId, 'created': datetime.datetime.utcnow(),
            }
            result = edit(document)
            if result is None:
                return None
            query = ({'_id': before['_id'],
                      '_revision': before.get('_revision')} if before else {
                'datasetId': datasetId, '_id': ObjectId(),
            })
            if not any(key in document for key in (
                'fileId', 'transcriptsFileId', 'neighborhood',
            )):
                if before and not self.removeWithQuery(query).deleted_count:
                    continue
                return result
            document['updated'] = datetime.datetime.utcnow()
            document['_revision'] = (before or {}).get('_revision', 0) + 1
            changes = {'$set': {key: value for key, value in document.items()
                                if key != '_id'}}
            removed = set(before or {}) - set(document)
            if removed:
                changes['$unset'] = {key: '' for key in removed}
            if before:
                if not self.update(query, changes, multi=False).matched_count:
                    continue
            else:
                # Model.update cannot upsert. No raw reads or replacements.
                try:
                    self.collection.bulk_write([
                        UpdateOne(query, changes, upsert=True),
                    ])
                except BulkWriteError as error:
                    failures = error.details.get('writeErrors', [])
                    if (not failures or
                            any(e['code'] != 11000 for e in failures) or
                            error.details.get('writeConcernErrors')):
                        raise
                    continue
                document['_id'] = query['_id']
            return result

    def register(self, entry):
        def edit(document):
            document.update(entry)
            return document
        return self._edit(entry['datasetId'], edit, create=True)

    def unregister(self, datasetId):
        """Forget the table, retaining transcripts and neighborhood."""
        def edit(document):
            removed = document.copy()
            for key in (*self.TABLE_FIELDS, 'versions'):
                document.pop(key, None)
            # API callers invalidate the removed file's cache.
            return removed
        return self._edit(datasetId, edit)

    def registerTranscripts(self, datasetId, fields):
        def edit(document):
            document.update({key: fields[key]
                             for key in self.TRANSCRIPT_FIELDS})
            return document
        return self._edit(datasetId, edit, create=True)

    def unregisterTranscripts(self, datasetId):
        def edit(document):
            removed = document.copy()
            for key in self.TRANSCRIPT_FIELDS:
                document.pop(key, None)
            return removed
        return self._edit(datasetId, edit)

    def registerVersion(self, entry, label, provenance=None):
        """Activate a table, retaining the former table as a version."""
        def edit(document):
            versions = document.get('versions', []).copy()
            if 'fileId' in document:
                versions = [v for v in versions
                            if v['itemId'] != document['itemId']]
                versions.append(self._versionOf(document))
            document['versions'] = [v for v in versions
                                    if v['itemId'] != entry['itemId']]
            for key in self.TABLE_FIELDS:
                document.pop(key, None)
            document.update(entry)
            document.update(label=label, provenance=provenance or {},
                            activated=datetime.datetime.utcnow())
            return document
        return self._edit(entry['datasetId'], edit, create=True)

    def _versionOf(self, document):
        return {
            **{key: document[key] for key in self.VERSION_FIELDS
               if key in document},
            'label': document.get('label', 'Table'),
            'provenance': document.get('provenance', {}),
            'created': document.get('activated', document.get('updated')),
        }

    def activateVersion(self, datasetId, itemId):
        def edit(document):
            if document.get('itemId') == itemId:
                return document
            version = next((v for v in document.get('versions', [])
                            if v['itemId'] == itemId), None)
            if version is None:
                return None
            others = [v for v in document.get('versions', [])
                      if v['itemId'] != itemId]
            if 'fileId' in document:
                others.append(self._versionOf(document))
            for key in self.TABLE_FIELDS:
                document.pop(key, None)
            document.update({key: version[key] for key in self.VERSION_FIELDS
                             if key in version})
            document.update(label=version.get('label', 'Table'),
                            provenance=version.get('provenance', {}),
                            activated=datetime.datetime.utcnow(),
                            versions=others)
            return document
        return self._edit(datasetId, edit)

    def forgetVersion(self, datasetId, itemId):
        def edit(document):
            match = next((v for v in document.get('versions', [])
                          if v['itemId'] == itemId), None)
            if match is not None:
                document['versions'] = [v for v in document['versions']
                                        if v['itemId'] != itemId]
            return match
        return self._edit(datasetId, edit)

    def setNeighborhood(self, datasetId, result):
        def edit(document):
            document['neighborhood'] = result
            return document
        return self._edit(datasetId, edit, create=True)

    def _coalesceDuplicates(self):
        """Upgrade legacy duplicates before serving requests. Latest whole
        table/transcript bundles win; other tables remain as versions.
        """
        pipeline = [
            {'$sort': {'updated': 1, '_id': 1}},
            {'$group': {'_id': '$datasetId',
                        'documents': {'$push': '$$ROOT'},
                        'count': {'$sum': 1}}},
            {'$match': {'count': {'$gt': 1}}},
        ]
        operations = []
        for group in self.collection.aggregate(pipeline, allowDiskUse=True):
            documents = group['documents']
            merged = deepcopy(documents[0])
            versions = {}
            for document in documents:
                for version in document.get('versions', []):
                    versions[version['itemId']] = version
                if 'fileId' in document:
                    versions[document['itemId']] = self._versionOf(document)
                    for key in self.TABLE_FIELDS:
                        merged.pop(key, None)
                    merged.update({key: document[key]
                                   for key in self.TABLE_FIELDS
                                   if key in document})
                if 'transcriptsFileId' in document:
                    for key in self.TRANSCRIPT_FIELDS:
                        merged.pop(key, None)
                    merged.update({key: document[key]
                                   for key in self.TRANSCRIPT_FIELDS
                                   if key in document})
                if 'neighborhood' in document:
                    merged['neighborhood'] = document['neighborhood']
            versions.pop(merged.get('itemId'), None)
            merged['versions'] = list(versions.values())
            merged['updated'] = documents[-1].get('updated')
            removed = set(documents[0]) - set(merged)
            changes = {'$set': {
                key: value for key, value in merged.items() if key != '_id'
            }}
            if removed:
                changes['$unset'] = {key: '' for key in removed}
            operations.extend([
                UpdateOne({'_id': merged['_id']}, changes),
                DeleteMany({'_id': {'$in': [
                    d['_id'] for d in documents[1:]
                ]}}),
            ])
            if len(operations) >= 10000:
                self.collection.bulk_write(operations, ordered=True)
                operations = []
        if operations:
            self.collection.bulk_write(operations, ordered=True)
