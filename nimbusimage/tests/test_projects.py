"""Tests for Project class."""

from nimbusimage.projects import Project


def _make_project(mock_gc):
    data = {
        "_id": "proj_001",
        "name": "Test Project",
        "description": "A test",
        "meta": {"status": "draft"},
    }
    return Project(mock_gc, data)


class TestProjectProperties:
    def test_id(self, mock_gc):
        proj = _make_project(mock_gc)
        assert proj.id == "proj_001"

    def test_name(self, mock_gc):
        proj = _make_project(mock_gc)
        assert proj.name == "Test Project"

    def test_status(self, mock_gc):
        proj = _make_project(mock_gc)
        assert proj.status == "draft"


class TestProjectDatasetManagement:
    def test_add_dataset(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.add_dataset("ds_001")
        mock_gc.post.assert_called_once()
        assert "dataset" in mock_gc.post.call_args[0][0]

    def test_remove_dataset(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.remove_dataset("ds_001")
        mock_gc.delete.assert_called_once()

    def test_add_configuration(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.add_configuration("cfg_001")
        mock_gc.post.assert_called_once()

    def test_remove_configuration(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.remove_configuration("cfg_001")
        mock_gc.delete.assert_called_once()


class TestProjectUpdate:
    def test_update(self, mock_gc):
        mock_gc.put.return_value = {
            "_id": "proj_001", "name": "New Name", "meta": {}
        }
        proj = _make_project(mock_gc)
        proj.update(name="New Name")
        mock_gc.put.assert_called_once()

    def test_set_status(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.set_status("exported")
        assert "status" in mock_gc.put.call_args[0][0]

    def test_delete(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.delete()
        mock_gc.delete.assert_called_with("project/proj_001")


class TestProjectSharing:
    def test_share(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.share("user@test.com", access="write")
        mock_gc.post.assert_called_once()

    def test_set_public(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.set_public(True)
        mock_gc.post.assert_called_once()

    def test_get_access(self, mock_gc):
        mock_gc.get.return_value = {"users": [], "public": False}
        proj = _make_project(mock_gc)
        result = proj.get_access()
        assert "public" in result
