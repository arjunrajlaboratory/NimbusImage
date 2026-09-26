from unittest.mock import Mock, patch

import pytest
from pymongo.errors import DuplicateKeyError, OperationFailure

from upenncontrast_annotation.server.helpers.proxiedModel import ProxiedModel
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)


def testStartupMigratesBeforeRetryingUniqueIndex():
    model = object.__new__(AnnotationPropertyValues)
    attempts = []

    def initialize(instance):
        instance._indices = []
        instance._connected = True
        instance.collection = Mock()

        def createIndex(*args, **kwargs):
            if kwargs.get('unique'):
                attempts.append('index')
                if attempts == ['index']:
                    raise DuplicateKeyError('duplicates', 11000, {
                        'codeName': 'DuplicateKey',
                    })

        instance.collection.create_index.side_effect = createIndex

    with patch.object(ProxiedModel, '__init__', initialize), patch.object(
        model, '_coalesceDuplicateDocuments',
        side_effect=lambda: attempts.append('migrate'),
    ):
        model.__init__()
    assert attempts == ['index', 'migrate', 'index']


def testStartupDoesNotSwallowUniqueIndexFailure():
    model = object.__new__(AnnotationPropertyValues)

    def initialize(instance):
        instance._indices = []
        instance._connected = True
        instance.collection = Mock()
        instance.collection.create_index.side_effect = OperationFailure(
            'storage unavailable', details={},
        )

    with patch.object(ProxiedModel, '__init__', initialize):
        with pytest.raises(OperationFailure, match='storage unavailable'):
            model.__init__()
