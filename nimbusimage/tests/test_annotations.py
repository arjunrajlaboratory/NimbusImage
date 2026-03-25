"""Tests for AnnotationAccessor."""

from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.models import Annotation, Location


class TestAnnotationList:
    def test_list_all(self, mock_gc, sample_annotation_dict):
        mock_gc.get.return_value = [sample_annotation_dict]
        accessor = AnnotationAccessor(mock_gc, "dataset_001")

        result = accessor.list()
        assert len(result) == 1
        assert isinstance(result[0], Annotation)
        assert result[0].id == "ann_001"
        mock_gc.get.assert_called_once()
        call_url = mock_gc.get.call_args[0][0]
        assert "datasetId=dataset_001" in call_url
        assert "limit=0" in call_url

    def test_list_with_filters(self, mock_gc):
        mock_gc.get.return_value = []
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        accessor.list(shape="polygon", tags=["nucleus"], limit=100)
        call_url = mock_gc.get.call_args[0][0]
        assert "shape=polygon" in call_url
        assert "limit=100" in call_url


class TestAnnotationGet:
    def test_get_by_id(self, mock_gc, sample_annotation_dict):
        mock_gc.get.return_value = sample_annotation_dict
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = accessor.get("ann_001")
        assert isinstance(ann, Annotation)
        assert ann.id == "ann_001"
        mock_gc.get.assert_called_with("/upenn_annotation/ann_001")


class TestAnnotationCount:
    def test_count(self, mock_gc):
        mock_gc.get.return_value = {"count": 42}
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        result = accessor.count(shape="polygon")
        assert result == 42


class TestAnnotationCreate:
    def test_create_single(self, mock_gc, sample_annotation_dict):
        mock_gc.post.return_value = sample_annotation_dict
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = Annotation(
            id=None, shape="polygon", tags=["nucleus"], channel=0,
            location=Location(), coordinates=[{"x": 1, "y": 2}],
            dataset_id="ds_001",
        )
        result = accessor.create(ann)
        assert isinstance(result, Annotation)
        assert result.id == "ann_001"
        mock_gc.post.assert_called_once()

    def test_create_many(self, mock_gc, sample_annotation_dict):
        mock_gc.post.return_value = [sample_annotation_dict]
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), coordinates=[], dataset_id="ds_001",
        )
        result = accessor.create_many([ann])
        assert len(result) == 1
        mock_gc.post.assert_called_once()
        call_url = mock_gc.post.call_args[0][0]
        assert "multiple" in call_url

    def test_create_many_with_connect_to(
        self, mock_gc, sample_annotation_dict,
    ):
        # First call: create annotations
        mock_gc.post.side_effect = [
            [sample_annotation_dict],  # create multiple
            None,  # connect to nearest
        ]
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), coordinates=[], dataset_id="ds_001",
        )
        result = accessor.create_many(
            [ann], connect_to={"tags": ["cell"], "channel": 0}
        )
        assert len(result) == 1
        assert mock_gc.post.call_count == 2


class TestAnnotationUpdate:
    def test_update_single(self, mock_gc, sample_annotation_dict):
        updated = {**sample_annotation_dict, "tags": ["updated"]}
        mock_gc.put.return_value = updated
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        result = accessor.update("ann_001", {"tags": ["updated"]})
        assert isinstance(result, Annotation)
        assert result.tags == ["updated"]

    def test_update_many(self, mock_gc):
        mock_gc.put.return_value = []
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        accessor.update_many([
            ("id1", {"tags": ["a"]}),
            ("id2", {"tags": ["b"]}),
        ])
        call_url = mock_gc.put.call_args[0][0]
        assert "multiple" in call_url


class TestAnnotationDelete:
    def test_delete_single(self, mock_gc):
        accessor = AnnotationAccessor(mock_gc, "ds_001")
        accessor.delete("ann_001")
        mock_gc.delete.assert_called_with("/upenn_annotation/ann_001")

    def test_delete_many(self, mock_gc):
        accessor = AnnotationAccessor(mock_gc, "ds_001")
        accessor.delete_many(["id1", "id2", "id3"])
        mock_gc.sendRestRequest.assert_called_once()
        args = mock_gc.sendRestRequest.call_args
        assert args[0][0] == "DELETE"
        assert "multiple" in args[0][1]
