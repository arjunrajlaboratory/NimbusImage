from unittest.mock import Mock

from bson import ObjectId

from upenncontrast_spatial.server import provider


def testTranscriptOnlyRegistryHasNoExpressionValues(monkeypatch):
    registry = Mock()
    registry.forDataset.return_value = {
        'datasetId': ObjectId(), 'transcriptsFileId': ObjectId(),
    }
    monkeypatch.setattr(provider, 'DatasetSpatial', lambda: registry)
    monkeypatch.setattr(provider, 'File', Mock())
    values = provider.SpatialValueProvider()
    datasetId, annotationId = ObjectId(), str(ObjectId())
    assert values.values(datasetId, ['spatial', 'CD3E']) == {}
    assert values.valuesForIds(datasetId, ['spatial', 'CD3E'],
                               [annotationId]) == [None]
    assert values.matchingIds(datasetId, ['spatial', 'CD3E'], {}) == []
