import json

import pytest
from bson import ObjectId
from girder.exceptions import ValidationException
from pytest_girder.assertions import assertStatus

from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)
from upenncontrast_annotation.server.models.annotation import Annotation
from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures('unbindLargeImage', 'unbindAnnotation')
@pytest.mark.plugin('upenncontrast_annotation')
class TestAtomicPropertyValues:
    @pytest.mark.parametrize('bulk', [False, True])
    def testCannotRehomeForeignValuesThroughWritableDataset(
        self, admin, user, server, bulk,
    ):
        source = utilities.createPrivateFolder(
            admin, 'owner dataset', upenn_utilities.datasetMetadata)
        destination = utilities.createFolder(
            user, 'caller dataset', upenn_utilities.datasetMetadata)
        foreign = Annotation().create(
            upenn_utilities.getSampleAnnotation(source['_id']))
        own = Annotation().create(
            upenn_utilities.getSampleAnnotation(destination['_id']))
        model = AnnotationPropertyValues()
        original = model.appendValues(
            {'private': 1}, foreign['_id'], source['_id'])
        params = {
            'annotationId': str(foreign['_id']),
            'datasetId': str(destination['_id']),
        }
        body = {'injected': 2}
        if bulk:
            # Validate the entire batch before any legitimate prefix is saved.
            body = [{
                'annotationId': str(own['_id']),
                'datasetId': str(destination['_id']), 'values': {'own': 1},
            }, {**params, 'values': body}]
        response = server.request(
            path='/annotation_property_values' + ('/multiple' if bulk else ''),
            method='POST', user=user, params={} if bulk else params,
            body=json.dumps(body), type='application/json',
        )
        assertStatus(response, 400)
        assert model.findOne({'_id': original['_id']}) == original
        assert model.findOne({'annotationId': own['_id']}) is None

    def testStartupCoalescesCrossDatasetDuplicates(self, admin):
        model = AnnotationPropertyValues()
        annotationId = ObjectId()
        model.collection.drop_index('annotationId_1')
        model.collection.create_index('annotationId')  # pre-upgrade index
        first = model.save({
            'annotationId': annotationId, 'datasetId': ObjectId(),
            'values': {'old': 1, 'nested': {'a': 1}},
        }, validate=False)
        model.save({
            'annotationId': annotationId, 'datasetId': ObjectId(),
            'values': {'new': 2, 'nested': {'b': 2}},
        }, validate=False)
        model.__init__()
        documents = list(model.find({'annotationId': annotationId}))
        assert len(documents) == 1
        assert documents[0]['_id'] == first['_id']
        assert documents[0]['values'] == {
            'old': 1, 'new': 2, 'nested': {'a': 1, 'b': 2},
        }
        assert model.collection.index_information()['annotationId_1']['unique']

    @pytest.mark.parametrize('nested', [False, True])
    def testMoveThenComputeKeepsOneValueDocument(self, admin, nested):
        source = utilities.createFolder(
            admin, 'source', upenn_utilities.datasetMetadata)
        destination = utilities.createFolder(
            admin, 'destination', upenn_utilities.datasetMetadata)
        annotation = Annotation().create(
            upenn_utilities.getSampleAnnotation(source['_id']))
        model = AnnotationPropertyValues()
        before = model.appendValues(
            {'existing': 1}, annotation['_id'], source['_id'])
        Annotation().updateMultiple({
            annotation['_id']: {'datasetId': destination['_id']},
        }, admin)
        if nested:
            model.setSubValuesMany(destination['_id'], 'new', [
                (annotation['_id'], {'gene': 2}),
            ])
        else:
            model.appendValues({'new': 2}, annotation['_id'],
                               destination['_id'])
        documents = list(model.find({'annotationId': annotation['_id']}))
        assert len(documents) == 1
        assert documents[0]['_id'] == before['_id']
        assert documents[0]['datasetId'] == destination['_id']
        assert documents[0]['values']['existing'] == 1
        assert documents[0]['values']['new'] == ({'gene': 2} if nested else 2)
        page = list(Annotation().listPage(
            destination['_id'], {}, None, [['existing'], ['new']], 0, 10))
        assert len(page) == 1
        assert page[0]['_id'] == annotation['_id']
        with pytest.raises(ValidationException, match='duplicate key'):
            model.save({
                'annotationId': annotation['_id'], 'datasetId': source['_id'],
                'values': {},
            }, validate=False)

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
