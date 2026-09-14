"""One dataset identity and no lost updates across registry writers."""
import datetime

import pytest
from bson import ObjectId
from pymongo.errors import OperationFailure

from upenncontrast_spatial.server.models.registry import DatasetSpatial


def table(datasetId):
    return {'datasetId': datasetId, 'itemId': ObjectId(),
            'fileId': ObjectId(), 'nObs': 2, 'nVar': 3,
            'schemaVersion': 1, 'obsColumns': []}


def transcripts():
    return {'transcriptsItemId': ObjectId(), 'transcriptsFileId': ObjectId(),
            'pixelSize': 0.2, 'transform': None}


@pytest.mark.usefixtures('unbindLargeImage', 'unbindAnnotation')
@pytest.mark.plugin('upenncontrast_spatial')
class TestAtomicRegistry:
    @pytest.mark.parametrize('half', ['table', 'transcripts'])
    def testUnregisterRetainsConcurrentSummaryAndReturnsRemovedFile(
        self, admin, monkeypatch, half,
    ):
        model = DatasetSpatial()
        datasetId = ObjectId()
        entry = (model.register(table(datasetId)) if half == 'table' else
                 model.registerTranscripts(datasetId, transcripts()))
        original = model.forDataset
        injected = False

        def concurrentRead(key):
            nonlocal injected
            snapshot = original(key)
            if not injected:
                injected = True
                model.setNeighborhood(key, {'concurrent': 1})
            return snapshot

        monkeypatch.setattr(model, 'forDataset', concurrentRead)
        removed = (model.unregister(datasetId) if half == 'table' else
                   model.unregisterTranscripts(datasetId))
        fileKey = 'fileId' if half == 'table' else 'transcriptsFileId'
        assert removed[fileKey] == entry[fileKey]
        assert fileKey not in original(datasetId)
        assert original(datasetId)['neighborhood'] == {'concurrent': 1}

    def testStartupPropagatesUniqueIndexFailure(self, admin, monkeypatch):
        model = DatasetSpatial()

        def failure(*args, **kwargs):
            raise OperationFailure('cannot create index')

        # __init__ obtains a fresh Collection handle, so patch the class.
        monkeypatch.setattr(type(model.collection), 'create_index', failure)
        with pytest.raises(OperationFailure, match='cannot create index'):
            model.__init__()

    @pytest.mark.parametrize('operation', ['register', 'version', 'neighbors'])
    def testConcurrentFirstRegistrationsShareIdentity(
        self, admin, monkeypatch, operation,
    ):
        model = DatasetSpatial()
        datasetId = ObjectId()
        fields = transcripts()
        original = model.forDataset
        injected = False

        def concurrentRead(key):
            nonlocal injected
            snapshot = original(key)
            if not injected:
                injected = True
                model.registerTranscripts(key, fields)
            return snapshot

        monkeypatch.setattr(model, 'forDataset', concurrentRead)
        if operation == 'register':
            model.register(table(datasetId))
        elif operation == 'version':
            model.registerVersion(table(datasetId), 'new')
        else:
            model.setNeighborhood(datasetId, {'test': 1})
        docs = list(model.find({'datasetId': datasetId}))
        assert len(docs) == 1
        assert docs[0]['transcriptsFileId'] == fields['transcriptsFileId']
        assert ('neighborhood' if operation == 'neighbors' else 'fileId') in (
            docs[0])

    @pytest.mark.parametrize('operation', [
        'register', 'version', 'activate', 'forget', 'unregister',
        'transcripts', 'removeTranscripts',
    ])
    def testConcurrentSiblingUpdateSurvives(
        self, admin, monkeypatch, operation,
    ):
        model = DatasetSpatial()
        datasetId = ObjectId()
        first = table(datasetId)
        model.registerVersion(first, 'first')
        model.registerVersion(table(datasetId), 'second')
        model.registerTranscripts(datasetId, transcripts())
        original = model.forDataset
        injected = False

        def concurrentRead(key):
            nonlocal injected
            snapshot = original(key)
            if not injected:
                injected = True
                model.setNeighborhood(key, {'concurrent': 1})
            return snapshot

        monkeypatch.setattr(model, 'forDataset', concurrentRead)
        actions = {
            'register': lambda: model.register(table(datasetId)),
            'version': lambda: model.registerVersion(table(datasetId), 'new'),
            'activate': lambda: model.activateVersion(datasetId,
                                                      first['itemId']),
            'forget': lambda: model.forgetVersion(datasetId, first['itemId']),
            'unregister': lambda: model.unregister(datasetId),
            'transcripts': lambda: model.registerTranscripts(
                datasetId, transcripts()),
            'removeTranscripts': lambda: model.unregisterTranscripts(
                datasetId),
        }
        actions[operation]()
        assert original(datasetId)['neighborhood'] == {'concurrent': 1}

    def testStartupMergesLegacyHalvesAndEnforcesUniqueIndex(self, admin):
        model = DatasetSpatial()
        model.collection.drop_index('datasetId_1')
        model.collection.create_index('datasetId')
        datasetId = ObjectId()
        now = datetime.datetime.utcnow()
        expression = table(datasetId)
        fields = transcripts()
        model.save({**expression, 'created': now, 'updated': now})
        model.save({'datasetId': datasetId, **fields,
                    'created': now, 'updated': now})
        model.__init__()
        docs = list(model.find({'datasetId': datasetId}))
        assert len(docs) == 1
        assert docs[0]['fileId'] == expression['fileId']
        assert docs[0]['transcriptsFileId'] == fields['transcriptsFileId']
        assert model.collection.index_information()['datasetId_1']['unique']
