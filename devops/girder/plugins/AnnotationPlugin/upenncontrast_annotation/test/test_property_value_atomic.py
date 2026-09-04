import pytest
from bson import ObjectId

from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)


@pytest.mark.usefixtures('unbindLargeImage', 'unbindAnnotation')
@pytest.mark.plugin('upenncontrast_annotation')
class TestAtomicPropertyValues:
    @pytest.mark.parametrize('bulk', [False, True])
    def testAppendDoesNotReplaceConcurrentValues(
        self, admin, monkeypatch, bulk,
    ):
        model = AnnotationPropertyValues()
        datasetId, annotationId = ObjectId(), ObjectId()
        model.setSubValuesMany(datasetId, 'spatialCopy', [
            (annotationId, {'CD3E': 9}),
        ])

        def noReplacement(*args, **kwargs):
            pytest.fail('append must not replace/delete/insert a snapshot')

        monkeypatch.setattr(model.collection, 'replace_one', noReplacement)
        monkeypatch.setattr(model.collection, 'insert_many', noReplacement)
        values = {'ordinary': '$literal', 'spatialCopy': {'CD3E': 0}}
        if bulk:
            result = model.appendMultipleValues([{
                'datasetId': datasetId, 'annotationId': annotationId,
                'values': values,
            }])[0]
        else:
            result = model.appendValues(values, annotationId, datasetId)
        assert result['values'] == {
            'ordinary': '$literal', 'spatialCopy': {'CD3E': 9},
        }
        assert model.findOne({'annotationId': annotationId}) == result

    def testDeleteOnlyUnsetsRequestedProperty(self, admin, monkeypatch):
        model = AnnotationPropertyValues()
        datasetId, annotationId = ObjectId(), ObjectId()
        model.appendValues({'remove': 1, 'keep': 2}, annotationId, datasetId)

        def noReplacement(*args, **kwargs):
            pytest.fail('delete must not replace a snapshot')

        monkeypatch.setattr(model, 'save', noReplacement)
        model.delete('remove', datasetId)
        assert model.findOne({'annotationId': annotationId})['values'] == {
            'keep': 2,
        }
