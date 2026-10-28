"""Tests for Project class."""

import pytest

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
        # formData on the server: a JSON body is a 400.
        mock_gc.post.assert_called_once_with(
            "project/proj_001/dataset", parameters={"datasetId": "ds_001"}
        )

    def test_remove_dataset(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.remove_dataset("ds_001")
        mock_gc.delete.assert_called_once()

    def test_add_configuration(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.add_configuration("cfg_001")
        mock_gc.post.assert_called_once_with(
            "project/proj_001/collection",
            parameters={"collectionId": "cfg_001"},
        )

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
        mock_gc.put.assert_called_once_with(
            "project/proj_001/status", parameters={"status": "exported"}
        )

    def test_delete(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.delete()
        mock_gc.delete.assert_called_with("project/proj_001")


class TestProjectSharing:
    """Assert exact requests: these endpoints read query params, and a
    JSON body (what the old code sent) is a 400 on the live server."""

    @pytest.mark.parametrize(
        "access, access_type",
        [("read", 0), ("write", 1), ("admin", 2), ("remove", -1)],
    )
    def test_share_sends_query_params(self, mock_gc, access, access_type):
        _make_project(mock_gc).share("user@test.com", access=access)
        mock_gc.post.assert_called_once_with(
            "project/proj_001/share",
            parameters={
                "userMailOrUsername": "user@test.com",
                "accessType": access_type,
            },
        )

    def test_share_leaves_self_targeting_to_the_server(self, mock_gc):
        """One POST, no user/me lookup: the server decides whether the
        change is allowed, so a data-only API key can share too."""
        _make_project(mock_gc).share("owner", access="remove")
        mock_gc.get.assert_not_called()
        mock_gc.post.assert_called_once_with(
            "project/proj_001/share",
            parameters={"userMailOrUsername": "owner", "accessType": -1},
        )

    @pytest.mark.parametrize(
        "public, flag", [(True, "true"), (False, "false")]
    )
    def test_set_public_sends_query_params(self, mock_gc, public, flag):
        mock_gc.post.return_value = {"projectId": "proj_001", "public": public}
        result = _make_project(mock_gc).set_public(public)
        mock_gc.post.assert_called_once_with(
            "project/proj_001/set_public",
            parameters={"public": flag},
        )
        assert result == {"projectId": "proj_001", "public": public}

    def test_get_access(self, mock_gc):
        mock_gc.get.return_value = {"users": [], "public": False}
        result = _make_project(mock_gc).get_access()
        mock_gc.get.assert_called_once_with("project/proj_001/access")
        assert result == {"users": [], "public": False}
