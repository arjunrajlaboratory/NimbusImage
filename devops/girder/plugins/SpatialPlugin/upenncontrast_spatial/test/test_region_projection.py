from unittest.mock import Mock

from bson import ObjectId

from upenncontrast_spatial.server import neighborhood


def testRectangleProjectionIncludesShape(monkeypatch):
    document = {
        '_id': ObjectId(), 'shape': 'rectangle', 'tags': ['region'],
        'coordinates': [{'x': 0, 'y': 0}, {'x': 20, 'y': 20}],
    }
    model = Mock()
    model.find.side_effect = lambda query, fields, **kwargs: [{
        key: value for key, value in document.items()
        if key == '_id' or key in fields
    }]
    monkeypatch.setattr(neighborhood, 'Annotation', lambda: model)
    result = neighborhood.regionPolygons(ObjectId(), regionTag='region')
    assert len(result) == 1
    assert result[0]['xy'].shape == (4, 2)
